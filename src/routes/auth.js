/**
 * Rotas de autenticação:
 *   POST /api/auth/login          — email + senha → JWT
 *   POST /api/auth/setup-senha    — admin define/reseta senha de usuário
 *   GET  /api/auth/me             — retorna usuário logado (via JWT)
 *   PUT  /api/auth/alterar-senha  — usuário altera a própria senha
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const getDb   = require('../database/db');

const router = express.Router();

const JWT_SECRET  = process.env.JWT_SECRET  || 'gestao-jwt-secret-dev';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30d';

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, nome: usuario.nome, perfil: usuario.perfil },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

// Middleware — verifica JWT no header Authorization
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Não autenticado' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
}

// Middleware — exige perfil admin
function adminOnly(req, res, next) {
  if (req.auth?.perfil !== 'admin') return res.status(403).json({ erro: 'Acesso restrito a administradores' });
  next();
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'email e senha são obrigatórios' });

  const db = getDb();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email.trim().toLowerCase());
  if (!usuario || !usuario.senha_hash) {
    return res.status(401).json({ erro: 'Email ou senha incorretos' });
  }

  const ok = await bcrypt.compare(senha, usuario.senha_hash);
  if (!ok) return res.status(401).json({ erro: 'Email ou senha incorretos' });

  const { senha_hash, ...safe } = usuario;
  res.json({ token: gerarToken(usuario), usuario: safe });
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.auth.id);
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado' });
  const { senha_hash, ...safe } = u;
  res.json(safe);
});

// POST /api/auth/setup-senha — admin define senha para qualquer usuário
router.post('/setup-senha', authMiddleware, adminOnly, async (req, res) => {
  const { usuario_id, senha } = req.body;
  if (!usuario_id || !senha) return res.status(400).json({ erro: 'usuario_id e senha são obrigatórios' });
  if (senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter pelo menos 6 caracteres' });

  const db = getDb();
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuario_id);
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado' });

  const hash = await bcrypt.hash(senha, 10);
  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hash, usuario_id);
  res.json({ ok: true });
});

// PUT /api/auth/alterar-senha — usuário altera a própria senha
router.put('/alterar-senha', authMiddleware, async (req, res) => {
  const { senha_atual, nova_senha } = req.body;
  if (!senha_atual || !nova_senha) return res.status(400).json({ erro: 'senha_atual e nova_senha são obrigatórios' });
  if (nova_senha.length < 6) return res.status(400).json({ erro: 'Nova senha deve ter pelo menos 6 caracteres' });

  const db = getDb();
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.auth.id);
  if (!u || !u.senha_hash) return res.status(400).json({ erro: 'Nenhuma senha definida para este usuário' });

  const ok = await bcrypt.compare(senha_atual, u.senha_hash);
  if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta' });

  const hash = await bcrypt.hash(nova_senha, 10);
  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hash, req.auth.id);
  res.json({ ok: true });
});

// POST /api/auth/recuperar-senha — solicita link de redefinição
router.post('/recuperar-senha', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'email é obrigatório' });

  const db = getDb();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email.trim().toLowerCase());

  // Sempre retorna OK para não revelar se o email existe
  if (!usuario) return res.json({ ok: true, mensagem: 'Se o email existir, você receberá as instruções.' });

  // Invalida tokens anteriores do usuário
  db.prepare('UPDATE tokens_recuperacao SET usado = 1 WHERE usuario_id = ?').run(usuario.id);

  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora

  db.prepare('INSERT INTO tokens_recuperacao (token, usuario_id, expira_em) VALUES (?, ?, ?)').run(token, usuario.id, expira);

  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const link = `${appUrl}/redefinir-senha.html?token=${token}`;
  const msg = `🔑 *Redefinição de Senha*\n\nOlá ${usuario.nome}! Clique no link abaixo para redefinir sua senha:\n\n${link}\n\n_O link expira em 1 hora._`;

  // Envia via email e/ou WhatsApp conforme canal
  const canal = usuario.canal || 'whatsapp';
  try {
    if (canal === 'email' || canal === 'ambos') {
      const emailService = require('../services/email');
      const html = `<!DOCTYPE html><html><body style="font-family:Arial;background:#13131f;color:#e2e2ee;padding:20px">
        <div style="background:#1e1e2e;border:1px solid #3a3a52;border-radius:12px;max-width:500px;margin:0 auto;padding:28px">
          <h2 style="color:#7c5cfc">🔑 Redefinição de Senha</h2>
          <p>Olá <strong>${usuario.nome}</strong>!</p>
          <p>Clique no botão abaixo para redefinir sua senha. O link expira em <strong>1 hora</strong>.</p>
          <a href="${link}" style="display:inline-block;padding:12px 24px;background:#7c5cfc;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0">Redefinir Senha</a>
          <p style="font-size:.8rem;color:#888">Se você não solicitou isso, ignore este email.</p>
        </div>
      </body></html>`;
      await emailService.enviarEmail(usuario, '🔑 Redefinição de Senha — Gestão de Demandas', html);
    }
    if (canal === 'whatsapp' || canal === 'ambos') {
      const whatsappService = require('../services/whatsapp');
      await whatsappService.enviarMensagem(usuario, msg).catch(() => {});
    }
  } catch (_) {}

  res.json({ ok: true, mensagem: 'Se o email existir, você receberá as instruções.' });
});

// POST /api/auth/redefinir-senha — redefine senha com token
router.post('/redefinir-senha', async (req, res) => {
  const { token, nova_senha } = req.body;
  if (!token || !nova_senha) return res.status(400).json({ erro: 'token e nova_senha são obrigatórios' });
  if (nova_senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter pelo menos 6 caracteres' });

  const db = getDb();
  const registro = db.prepare('SELECT * FROM tokens_recuperacao WHERE token = ?').get(token);

  if (!registro || registro.usado) return res.status(400).json({ erro: 'Link inválido ou já utilizado.' });
  if (new Date(registro.expira_em) < new Date()) return res.status(400).json({ erro: 'Link expirado. Solicite um novo.' });

  const hash = await bcrypt.hash(nova_senha, 10);
  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hash, registro.usuario_id);
  db.prepare('UPDATE tokens_recuperacao SET usado = 1 WHERE token = ?').run(token);

  res.json({ ok: true, mensagem: 'Senha redefinida com sucesso!' });
});

// PUT /api/auth/perfil/:id — admin altera perfil de usuário
router.put('/perfil/:id', authMiddleware, adminOnly, (req, res) => {
  const { perfil } = req.body;
  if (!['admin','usuario'].includes(perfil)) return res.status(400).json({ erro: 'perfil deve ser "admin" ou "usuario"' });

  const db = getDb();
  db.prepare('UPDATE usuarios SET perfil = ? WHERE id = ?').run(perfil, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
module.exports.adminOnly = adminOnly;
