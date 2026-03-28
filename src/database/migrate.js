const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_URL || './data/demandas.db';
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
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
    horario_entrega TEXT,
    data_acordada TEXT,
    status TEXT NOT NULL DEFAULT 'pendente_aceite'
      CHECK(status IN (
        'pendente_aceite',
        'em_negociacao',
        'aceita',
        'em_andamento',
        'concluida_aguardando_baixa',
        'finalizada'
      )),
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
`);

console.log('Migrations executadas com sucesso.');
db.close();
