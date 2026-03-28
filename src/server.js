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
    data_esperada TEXT NOT NULL,
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
};
const insertCfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
for (const [chave, valor] of Object.entries(defaults)) insertCfg.run(chave, valor);

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
