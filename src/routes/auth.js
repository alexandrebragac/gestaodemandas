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
