const express = require('express');
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');
const { authMiddleware, adminOnly } = require('./auth');

const router = express.Router();

// GET /usuarios
router.get('/', (req, res) => {
  const db = getDb();
  const usuarios = db.prepare('SELECT * FROM usuarios ORDER BY nome').all();
  res.json(usuarios);
});

// GET /usuarios/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
  res.json(usuario);
});

// POST /usuarios
router.post('/', (req, res) => {
  const { nome, telefone_whatsapp, email, canal } = req.body;
  if (!nome || !telefone_whatsapp) {
    return res.status(400).json({ erro: 'nome e telefone_whatsapp são obrigatórios' });
  }
  const db = getDb();
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO usuarios (id, nome, telefone_whatsapp, email, canal) VALUES (?, ?, ?, ?, ?)')
      .run(id, nome.trim(), telefone_whatsapp.trim(), email?.trim() || null, canal || 'whatsapp');
    res.status(201).json(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ erro: 'Telefone ou email já cadastrado' });
    throw err;
  }
});

// PUT /usuarios/:id
router.put('/:id', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado' });

  const nome     = req.body.nome              ?? u.nome;
  const telefone = req.body.telefone_whatsapp ?? u.telefone_whatsapp;
  const email    = req.body.email !== undefined ? (req.body.email?.trim() || null) : u.email;
  const canal    = req.body.canal             ?? u.canal ?? 'whatsapp';

  try {
    db.prepare('UPDATE usuarios SET nome=?, telefone_whatsapp=?, email=?, canal=? WHERE id=?')
      .run(nome.trim(), telefone.trim(), email, canal, req.params.id);
    res.json(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ erro: 'Telefone ou email já cadastrado' });
    throw err;
  }
});

// POST /usuarios/:id/boas-vindas — admin: reenvia link de ativação do WhatsApp
router.post('/:id/boas-vindas', authMiddleware, adminOnly, async (req, res) => {
  const db = getDb();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
  try {
    const notificacoes = require('../services/notificacoes');
    const resultado = await notificacoes.boasVindas(usuario);
    res.json({ ok: true, resultado });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// DELETE /usuarios/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });

  // Bloqueia exclusão se houver demandas ATIVAS (não finalizadas)
  const { total: ativas } = db.prepare(`
    SELECT COUNT(*) as total FROM demandas
    WHERE (solicitante_id = ? OR responsavel_id = ?) AND status != 'finalizada'
  `).get(req.params.id, req.params.id);

  if (ativas > 0) {
    return res.status(409).json({
      erro: `Não é possível excluir "${usuario.nome}" pois possui ${ativas} demanda(s) ativa(s). Finalize todas as demandas antes de excluir.`
    });
  }

  // Cascade delete: remove todos os dados vinculados antes de excluir o usuário
  const excluirTudo = db.transaction(() => {
    // IDs de demandas finalizadas onde o usuário participou
    const demandaIds = db.prepare(`
      SELECT id FROM demandas WHERE solicitante_id = ? OR responsavel_id = ?
    `).all(req.params.id, req.params.id).map(d => d.id);

    for (const demandaId of demandaIds) {
      db.prepare('DELETE FROM lembretes WHERE demanda_id = ?').run(demandaId);
      db.prepare('DELETE FROM mensagens WHERE demanda_id = ?').run(demandaId);
    }
    db.prepare('DELETE FROM demandas WHERE solicitante_id = ? OR responsavel_id = ?')
      .run(req.params.id, req.params.id);

    // Remove mensagens avulsas do usuário (ex: mensagens em demandas de outros)
    db.prepare('DELETE FROM mensagens WHERE remetente_id = ?').run(req.params.id);

    db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  });

  excluirTudo();
  res.status(204).end();
});

module.exports = router;
