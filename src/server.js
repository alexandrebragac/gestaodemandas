require('dotenv').config();

// Força IPv4 em todas as conexões de rede (Railway não suporta IPv6 externo)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

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
// Migration: codigo sequencial
try { db.prepare("ALTER TABLE demandas ADD COLUMN codigo TEXT").run(); console.log('[Migration] Adicionada coluna codigo'); } catch (_) {}
// Preenche codigos faltantes nas demandas existentes
const semCodigo = db.prepare("SELECT id FROM demandas WHERE codigo IS NULL ORDER BY criado_em ASC").all();
semCodigo.forEach((d, i) => {
  const max = db.prepare("SELECT MAX(CAST(REPLACE(codigo,'#','') AS INTEGER)) as m FROM demandas WHERE codigo IS NOT NULL").get();
  const next = (max?.m || 0) + 1;
  db.prepare("UPDATE demandas SET codigo = ? WHERE id = ?").run(`#${String(next).padStart(4,'0')}`, d.id);
});

// Tabela de tokens de recuperação de senha
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens_recuperacao (
    token TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL REFERENCES usuarios(id),
    expira_em TEXT NOT NULL,
    usado INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Tabelas do módulo de comparação de preços de supermercado
db.exec(`
  CREATE TABLE IF NOT EXISTS listas_mercado (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    descricao TEXT,
    status TEXT NOT NULL DEFAULT 'ativa' CHECK(status IN ('ativa','arquivada')),
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS itens_lista_mercado (
    id TEXT PRIMARY KEY,
    lista_id TEXT NOT NULL REFERENCES listas_mercado(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    quantidade REAL NOT NULL DEFAULT 1,
    unidade TEXT NOT NULL DEFAULT 'un',
    observacao TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS comparacoes_mercado (
    id TEXT PRIMARY KEY,
    lista_id TEXT NOT NULL REFERENCES listas_mercado(id) ON DELETE CASCADE,
    cep TEXT,
    lat REAL,
    lon REAL,
    resultado_json TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Tabelas do módulo de Atividades (rotina diária)
db.exec(`
  CREATE TABLE IF NOT EXISTS atividades (
    id TEXT PRIMARY KEY,
    titulo TEXT NOT NULL,
    descricao TEXT,
    area TEXT NOT NULL DEFAULT 'operacoes'
      CHECK(area IN ('comercial','operacoes','financeiro','pessoas','performance','outro')),
    tipo TEXT NOT NULL CHECK(tipo IN ('pontual','recorrente')),
    formato TEXT NOT NULL DEFAULT 'simples' CHECK(formato IN ('simples','checklist')),
    prioridade TEXT NOT NULL DEFAULT 'media' CHECK(prioridade IN ('baixa','media','alta','critica')),
    criado_por TEXT NOT NULL REFERENCES usuarios(id),
    responsavel_id TEXT NOT NULL REFERENCES usuarios(id),
    recorrencia_tipo TEXT NOT NULL DEFAULT 'unica' CHECK(recorrencia_tipo IN ('unica','diaria','semanal','mensal')),
    recorrencia_dias_semana TEXT,
    recorrencia_dia_mes INTEGER CHECK(recorrencia_dia_mes IS NULL OR (recorrencia_dia_mes BETWEEN 1 AND 31)),
    data_inicio TEXT NOT NULL,
    data_fim TEXT,
    horario_limite TEXT,
    exige_aprovacao INTEGER NOT NULL DEFAULT 1,
    exige_foto INTEGER NOT NULL DEFAULT 0,
    permite_replanejamento INTEGER NOT NULL DEFAULT 1,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS atividade_checklist_itens (
    id TEXT PRIMARY KEY,
    atividade_id TEXT NOT NULL REFERENCES atividades(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL,
    ordem INTEGER NOT NULL DEFAULT 0,
    foto_obrigatoria INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS atividade_campos (
    id TEXT PRIMARY KEY,
    atividade_id TEXT NOT NULL REFERENCES atividades(id) ON DELETE CASCADE,
    rotulo TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK(tipo IN ('texto','numero','boolean','foto','selecao')),
    obrigatorio INTEGER NOT NULL DEFAULT 0,
    exige_foto INTEGER NOT NULL DEFAULT 0,
    opcoes TEXT,
    ordem INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS atividade_ocorrencias (
    id TEXT PRIMARY KEY,
    atividade_id TEXT NOT NULL REFERENCES atividades(id) ON DELETE CASCADE,
    responsavel_id TEXT NOT NULL REFERENCES usuarios(id),
    data_referencia TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente'
      CHECK(status IN ('pendente','em_andamento','aguardando_validacao','concluida','atrasada','recusada')),
    iniciada_em TEXT,
    submetida_em TEXT,
    concluida_em TEXT,
    validada_por TEXT REFERENCES usuarios(id),
    validada_em TEXT,
    motivo_recusa TEXT,
    justificativa_atraso TEXT,
    comentario_execucao TEXT,
    evidencia_url TEXT,
    nova_data_prevista TEXT,
    novo_horario_previsto TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(atividade_id, responsavel_id, data_referencia)
  );
  CREATE TABLE IF NOT EXISTS ocorrencia_checklist_itens (
    id TEXT PRIMARY KEY,
    ocorrencia_id TEXT NOT NULL REFERENCES atividade_ocorrencias(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES atividade_checklist_itens(id),
    concluido INTEGER NOT NULL DEFAULT 0,
    concluido_em TEXT,
    evidencia_url TEXT,
    comentario TEXT,
    UNIQUE(ocorrencia_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS ocorrencia_campo_valores (
    id TEXT PRIMARY KEY,
    ocorrencia_id TEXT NOT NULL REFERENCES atividade_ocorrencias(id) ON DELETE CASCADE,
    campo_id TEXT NOT NULL REFERENCES atividade_campos(id),
    valor TEXT,
    evidencia_url TEXT,
    UNIQUE(ocorrencia_id, campo_id)
  );
  CREATE TABLE IF NOT EXISTS ocorrencia_replanejamentos (
    id TEXT PRIMARY KEY,
    ocorrencia_id TEXT NOT NULL REFERENCES atividade_ocorrencias(id) ON DELETE CASCADE,
    solicitante_id TEXT NOT NULL REFERENCES usuarios(id),
    nova_data TEXT NOT NULL,
    novo_horario TEXT,
    motivo TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','aprovada','recusada')),
    aprovador_id TEXT REFERENCES usuarios(id),
    decidido_em TEXT,
    motivo_recusa TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ativ_ocorrencias_resp_data ON atividade_ocorrencias(responsavel_id, data_referencia);
  CREATE INDEX IF NOT EXISTS idx_ativ_ocorrencias_status ON atividade_ocorrencias(status);
  CREATE INDEX IF NOT EXISTS idx_ativ_atividades_resp ON atividades(responsavel_id, ativo);
`);
try { db.prepare("ALTER TABLE usuarios ADD COLUMN pode_criar_atividades INTEGER NOT NULL DEFAULT 0").run(); console.log('[Migration] Adicionada coluna pode_criar_atividades'); } catch (_) {}

// Tabela de solicitações de cadastro
db.exec(`
  CREATE TABLE IF NOT EXISTS solicitacoes_cadastro (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    telefone_whatsapp TEXT NOT NULL,
    canal TEXT NOT NULL DEFAULT 'whatsapp',
    status TEXT NOT NULL DEFAULT 'pendente'
      CHECK(status IN ('pendente','aprovado','rejeitado')),
    nota_admin TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    processado_em TEXT
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
app.use('/api/cadastro', require('./routes/cadastro'));
app.use('/webhook', require('./routes/webhook'));
app.use('/api/mercado', require('./routes/mercado'));
app.use('/api/atividades', require('./routes/atividades'));

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

// Cria admin inicial se INIT_ADMIN_EMAIL e INIT_ADMIN_SENHA estiverem definidos e não houver nenhum admin
async function criarAdminInicial() {
  const email = process.env.INIT_ADMIN_EMAIL;
  const senha = process.env.INIT_ADMIN_SENHA;
  if (!email || !senha) return;
  const jaTemAdmin = db.prepare("SELECT id FROM usuarios WHERE perfil = 'admin' LIMIT 1").get();
  if (jaTemAdmin) return;
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  const hash = await bcrypt.hash(senha, 10);
  const nome = process.env.INIT_ADMIN_NOME || 'Admin';
  const telefone = process.env.INIT_ADMIN_TELEFONE || '00000000000';
  db.prepare('INSERT INTO usuarios (id, nome, email, telefone_whatsapp, senha_hash, perfil, canal) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), nome, email, telefone, hash, 'admin', 'email');
  console.log(`[Setup] Admin criado: ${email}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 Webhook WhatsApp: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`📡 Health: http://localhost:${PORT}/health\n`);
  await criarAdminInicial();
});

// Inicia scheduler de lembretes
const { iniciarScheduler } = require('./services/scheduler');
iniciarScheduler();

// Inicia scheduler de atividades (geração diária de ocorrências + marcação de atraso)
const { iniciarSchedulerAtividades } = require('./services/atividadesScheduler');
iniciarSchedulerAtividades();
