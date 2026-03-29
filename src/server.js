require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Garante que as tabelas existem antes de qualquer coisa
const getDb = require('./database/db');
const db = getDb();
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    telefone_whatsapp TEXT NOT NULL UNIQUE,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS demandas (
    id TEXT PRIMARY KEY,
    solicitante_id TEXT NOT NULL REFERENCES usuarios(id),
    responsavel_id TEXT NOT NULL REFERENCES usuarios(id),
    descricao TEXT NOT NULL,
    data_entrega TEXT NOT NULL,
    data_acordada TEXT,
    status TEXT NOT NULL DEFAULT 'pendente_aceite'
      CHECK(status IN ('pendente_aceite','em_negociacao','aceita','em_andamento','concluida_aguardando_baixa','finalizada')),
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS mensagens (
    id TEXT PRIMARY KEY,
    demanda_id TEXT NOT NULL REFERENCES demandas(id),
    remetente_id TEXT NOT NULL REFERENCES usuarios(id),
    tipo TEXT NOT NULL CHECK(tipo IN ('criacao','resposta','lembrete','conclusao','baixa')),
    conteudo TEXT NOT NULL,
    enviado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS lembretes (
    id TEXT PRIMARY KEY,
    demanda_id TEXT NOT NULL REFERENCES demandas(id),
    tipo TEXT NOT NULL CHECK(tipo IN ('antes_vencimento','no_vencimento','apos_vencimento','aguardando_baixa')),
    agendado_para TEXT NOT NULL,
    enviado INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL,
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration: rename data_esperada → data_entrega
try { db.prepare('ALTER TABLE demandas RENAME COLUMN data_esperada TO data_entrega').run(); console.log('[Migration] Coluna data_esperada → data_entrega'); } catch (_) {}
// Migration: add horario_entrega
try { db.prepare('ALTER TABLE demandas ADD COLUMN horario_entrega TEXT').run(); console.log('[Migration] Adicionada coluna horario_entrega'); } catch (_) {}
// Migration: add clickup_url
try { db.prepare('ALTER TABLE demandas ADD COLUMN clickup_url TEXT').run(); console.log('[Migration] Adicionada coluna clickup_url'); } catch (_) {}
// Migration: add origem
try { db.prepare("ALTER TABLE demandas ADD COLUMN origem TEXT NOT NULL DEFAULT 'web'").run(); console.log('[Migration] Adicionada coluna origem'); } catch (_) {}
// Migration: email + canal
try { db.prepare("ALTER TABLE usuarios ADD COLUMN email TEXT").run(); console.log('[Migration] Adicionada coluna email'); } catch (_) {}
try { db.prepare("ALTER TABLE usuarios ADD COLUMN canal TEXT NOT NULL DEFAULT 'whatsapp'").run(); console.log('[Migration] Adicionada coluna canal'); } catch (_) {}
// Migration: senha_hash + perfil para auth web
try { db.prepare("ALTER TABLE usuarios ADD COLUMN senha_hash TEXT").run(); console.log('[Migration] Adicionada coluna senha_hash'); } catch (_) {}
try { db.prepare("ALTER TABLE usuarios ADD COLUMN perfil TEXT NOT NULL DEFAULT 'usuario'").run(); console.log('[Migration] Adicionada coluna perfil'); } catch (_) {}

// Insere configurações padrão se ainda não existirem
const defaults = {
  horario_relatorio: '08:00',
  alerta_3_dias: '1',
  alerta_1_dia: '1',
  alerta_no_dia: '1',
  alerta_apos_vencimento: '1',
  frequencia_apos_vencimento: '1',
  alerta_aguardando_baixa: '1',
  frequencia_aguardando_baixa: '2',
  alerta_pendente_sem_resposta: '0',
  intervalo_alerta_pendente_horas: '1',
  ultimo_relatorio: '',
};
const insertCfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
for (const [chave, valor] of Object.entries(defaults)) insertCfg.run(chave, valor);

// Se não há admin, promove o primeiro usuário cadastrado para admin
const adminExistente = db.prepare("SELECT id FROM usuarios WHERE perfil = 'admin' LIMIT 1").get();
if (!adminExistente) {
  const primeiro = db.prepare('SELECT id FROM usuarios ORDER BY criado_em ASC LIMIT 1').get();
  if (primeiro) {
    db.prepare("UPDATE usuarios SET perfil = 'admin' WHERE id = ?").run(primeiro.id);
    console.log('[Setup] Primeiro usuário promovido a admin automaticamente.');
  }
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // para webhooks Twilio

// Static files (dashboard)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/demandas', require('./routes/demandas'));
app.use('/api/configuracoes', require('./routes/configuracoes'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/email-acao', require('./routes/emailAcao'));
app.use('/webhook', require('./routes/webhook'));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ erro: err.message || 'Erro interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 Webhook WhatsApp: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`📡 Health: http://localhost:${PORT}/health\n`);
});

// Inicia scheduler de lembretes
const { iniciarScheduler } = require('./services/scheduler');
iniciarScheduler();
