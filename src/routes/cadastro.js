/**
 * Rotas de solicitação de cadastro (auto-registro com aprovação admin):
 *   POST /api/cadastro/solicitar          — público: envia pedido de cadastro
 *   GET  /api/cadastro/pendentes          — admin: lista pendentes
 *   POST /api/cadastro/aprovar/:id        — admin: aprova e cria o usuário
 *   POST /api/cadastro/rejeitar/:id       — admin: rejeita com nota opcional
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const getDb   = require('../database/db');
const { authMiddleware, adminOnly } = require('./auth');

const router = express.Router();

// ── Normaliza telefone brasileiro ─────────────────────────────────────────────
// Remove tudo que não for dígito, garante +55 + DDD + 8 dígitos (sem o 9 móvel)
function normalizarTelefone(raw) {
  const digits = raw.replace(/\D/g, '');

  // Garante prefixo 55
  const comCodigo = digits.startsWith('55') ? digits : `55${digits}`;

  // comCodigo = 55 + DDD(2) + numero
  // Ex: 55 85 9 12345678  → deve virar 55 85 12345678
  if (comCodigo.length === 13) {
    // 55 + DDD(2) + 9(1) + 8 dígitos = 13 → remove o 9 após DDD
    const prefixo = comCodigo.slice(0, 4);   // '5585'
    const resto   = comCodigo.slice(4);       // '912345678'
    if (resto.startsWith('9') && resto.length === 9) {
      return `+${prefixo}${resto.slice(1)}`; // '+558512345678'
    }
  }

  return `+${comCodigo}`;
}

// POST /api/cadastro/solicitar — público
router.post('/solicitar', async (req, res) => {
  const { nome, email, telefone, canal } = req.body;
  if (!nome || !email || !telefone) {
    return res.status(400).json({ erro: 'nome, email e telefone são obrigatórios' });
  }

  const db = getDb();
  const telNorm = normalizarTelefone(telefone);

  // Verifica duplicata em usuarios ou em solicitações pendentes
  const usuarioExistente = db.prepare('SELECT id FROM usuarios WHERE email = ? OR telefone_whatsapp = ?').get(email.trim().toLowerCase(), telNorm);
  if (usuarioExistente) return res.status(409).json({ erro: 'Email ou telefone já cadastrado no sistema.' });

  const solicitacaoExistente = db.prepare("SELECT id, status FROM solicitacoes_cadastro WHERE email = ?").get(email.trim().toLowerCase());
  if (solicitacaoExistente) {
    if (solicitacaoExistente.status === 'pendente') return res.status(409).json({ erro: 'Já existe uma solicitação pendente com este email.' });
    if (solicitacaoExistente.status === 'aprovado')  return res.status(409).json({ erro: 'Este email já foi aprovado. Faça login.' });
    // rejeitado → permite nova tentativa, remove a antiga
    db.prepare('DELETE FROM solicitacoes_cadastro WHERE email = ?').run(email.trim().toLowerCase());
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO solicitacoes_cadastro (id, nome, email, telefone_whatsapp, canal)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, nome.trim(), email.trim().toLowerCase(), telNorm, canal || 'whatsapp');

  // Notifica admins
  try {
    const admins = db.prepare("SELECT * FROM usuarios WHERE perfil = 'admin'").all();
    const notificacoes = require('../services/notificacoes');
    for (const admin of admins) {
      const msg = `👤 *Nova solicitação de cadastro*\n\nNome: ${nome}\nEmail: ${email}\nTelefone: ${telNorm}\n\nAcesse o painel admin para aprovar ou rejeitar.`;
      try {
        const whatsappService = require('../services/whatsapp');
        if (admin.canal === 'whatsapp' || admin.canal === 'ambos' || !admin.canal) {
          await whatsappService.enviarMensagem(admin, msg);
        }
      } catch (_) {}
    }
  } catch (_) {}

  res.status(201).json({ ok: true, mensagem: 'Solicitação enviada com sucesso! Aguarde a aprovação do administrador.' });
});

// GET /api/cadastro/pendentes — admin
router.get('/pendentes', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const pendentes = db.prepare(`
    SELECT * FROM solicitacoes_cadastro
    WHERE status = 'pendente'
    ORDER BY criado_em DESC
  `).all();
  res.json(pendentes);
});

// GET /api/cadastro/todas — admin
router.get('/todas', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const todas = db.prepare(`
    SELECT * FROM solicitacoes_cadastro
    ORDER BY criado_em DESC
    LIMIT 100
  `).all();
  res.json(todas);
});

// POST /api/cadastro/aprovar/:id — admin
router.post('/aprovar/:id', authMiddleware, adminOnly, async (req, res) => {
  const db = getDb();
  const sol = db.prepare('SELECT * FROM solicitacoes_cadastro WHERE id = ?').get(req.params.id);
  if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
  if (sol.status !== 'pendente') return res.status(400).json({ erro: `Solicitação já ${sol.status}` });

  // Senha provisória = primeiros 6 chars do email (sem @)
  const senhaProvisoria = req.body.senha || sol.email.split('@')[0].slice(0, 8);
  const hash = await bcrypt.hash(senhaProvisoria, 10);

  const usuarioId = uuidv4();
  try {
    db.prepare(`
      INSERT INTO usuarios (id, nome, telefone_whatsapp, email, canal, perfil, senha_hash)
      VALUES (?, ?, ?, ?, ?, 'usuario', ?)
    `).run(usuarioId, sol.nome, sol.telefone_whatsapp, sol.email, sol.canal, hash);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ erro: 'Email ou telefone já existe nos usuários.' });
    throw err;
  }

  db.prepare(`
    UPDATE solicitacoes_cadastro
    SET status = 'aprovado', processado_em = datetime('now'), nota_admin = ?
    WHERE id = ?
  `).run(req.body.nota || null, req.params.id);

  // Notifica o novo usuário
  try {
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId);
    const whatsappService = require('../services/whatsapp');
    const notificacoes = require('../services/notificacoes');
    const msg = `✅ *Cadastro Aprovado!*\n\nOlá ${sol.nome}! Seu cadastro no sistema de Gestão de Demandas foi aprovado.\n\nAcesse: ${process.env.APP_URL || 'http://localhost:3000'}/login.html\n\nEmail: ${sol.email}\nSenha provisória: ${senhaProvisoria}\n\n_Recomendamos alterar sua senha após o primeiro acesso._`;
    if (sol.canal === 'whatsapp' || sol.canal === 'ambos') {
      await whatsappService.enviarMensagem(usuario, msg).catch(() => {});
    }
    // Envia link de ativação do WhatsApp (boas-vindas)
    await notificacoes.boasVindas(usuario).catch(() => {});
  } catch (_) {}

  res.json({ ok: true, usuario_id: usuarioId, senha_provisoria: senhaProvisoria });
});

// POST /api/cadastro/rejeitar/:id — admin
router.post('/rejeitar/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const sol = db.prepare('SELECT * FROM solicitacoes_cadastro WHERE id = ?').get(req.params.id);
  if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
  if (sol.status !== 'pendente') return res.status(400).json({ erro: `Solicitação já ${sol.status}` });

  db.prepare(`
    UPDATE solicitacoes_cadastro
    SET status = 'rejeitado', processado_em = datetime('now'), nota_admin = ?
    WHERE id = ?
  `).run(req.body.nota || 'Solicitação rejeitada pelo administrador.', req.params.id);

  res.json({ ok: true });
});

module.exports = router;
