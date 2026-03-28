const express = require('express');
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');

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
  const { nome, telefone_whatsapp } = req.body;
  if (!nome || !telefone_whatsapp) {
    return res.status(400).json({ erro: 'nome e telefone_whatsapp são obrigatórios' });
  }

  const db = getDb();
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO usuarios (id, nome, telefone_whatsapp) VALUES (?, ?, ?)')
      .run(id, nome.trim(), telefone_whatsapp.trim());
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    res.status(201).json(usuario);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Telefone já cadastrado' });
    }
    throw err;
  }
});

// PUT /usuarios/:id
router.put('/:id', (req, res) => {
  const db = getDb();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });

  const nome = req.body.nome ?? usuario.nome;
  const telefone = req.body.telefone_whatsapp ?? usuario.telefone_whatsapp;

  try {
    db.prepare('UPDATE usuarios SET nome = ?, telefone_whatsapp = ? WHERE id = ?')
      .run(nome.trim(), telefone.trim(), req.params.id);
    res.json(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Telefone já cadastrado' });
    }
    throw err;
  }
});

// DELETE /usuarios/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });

  const demandas = db.prepare(
    'SELECT COUNT(*) as total FROM demandas WHERE solicitante_id = ? OR responsavel_id = ?'
  ).get(req.params.id, req.params.id);

  if (demandas.total > 0) {
    return res.status(409).json({
      erro: `Não é possível excluir "${usuario.nome}" pois possui ${demandas.total} demanda(s) vinculada(s). Finalize ou reatribua as demandas antes de excluir.`
    });
  }

  db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
