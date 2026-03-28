const cron = require('node-cron');
const getDb = require('../database/db');
const whatsappService = require('./whatsapp');

let jobRelatorio = null;

function getConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT chave, valor FROM configuracoes').all();
  return Object.fromEntries(rows.map(r => [r.chave, r.valor]));
}

function iniciarScheduler() {
  console.log('[Scheduler] Iniciando jobs...');
  agendarJobRelatorio();

  // Job horário: alerta para demandas pendentes sem resposta
  cron.schedule('0 * * * *', async () => {
    const cfg = getConfig();
    if (cfg.alerta_pendente_sem_resposta === '1') {
      await verificarPendentesNaoRespondidos();
    }
  }, { timezone: 'America/Sao_Paulo' });

  if (process.env.NODE_ENV !== 'production') {
    setTimeout(async () => {
      console.log('[Scheduler] Verificação inicial de lembretes (dev)...');
      await processarLembretes();
    }, 30_000);
  }
}

function agendarJobRelatorio() {
  if (jobRelatorio) {
    jobRelatorio.stop();
    jobRelatorio = null;
  }

  const cfg = getConfig();
  const horario = cfg.horario_relatorio || '08:00';
  const [hora, minuto] = horario.split(':');
  const cronExpr = `${minuto} ${hora} * * *`;

  console.log(`[Scheduler] Relatório diário agendado para ${horario} (cron: ${cronExpr})`);

  jobRelatorio = cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Executando relatório das ${horario}...`);
    try {
      await enviarRelatoriosDiarios();
      await processarLembretes();
      // Registra timestamp do último relatório enviado
      const db = getDb();
      db.prepare(`UPDATE configuracoes SET valor = datetime('now'), atualizado_em = datetime('now') WHERE chave = 'ultimo_relatorio'`).run();
    } catch (err) {
      console.error('[Scheduler] Erro no relatório diário:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });
}

function reconfigurarScheduler() {
  console.log('[Scheduler] Reconfigurando horário...');
  agendarJobRelatorio();
}

// ── Relatório diário ─────────────────────────────────────────────────────────

async function enviarRelatoriosDiarios() {
  const db = getDb();
  const hoje = new Date().toISOString().slice(0, 10);
  const em3dias = new Date();
  em3dias.setDate(em3dias.getDate() + 3);
  const em3diasStr = em3dias.toISOString().slice(0, 10);

  const usuarios = db.prepare(`
    SELECT DISTINCT u.* FROM usuarios u
    JOIN demandas d ON d.responsavel_id = u.id OR d.solicitante_id = u.id
    WHERE d.status NOT IN ('finalizada', 'concluida_aguardando_baixa')
  `).all();

  console.log(`[Scheduler] Enviando relatório para ${usuarios.length} usuário(s)...`);

  for (const usuario of usuarios) {
    const demandasResp = db.prepare(`
      SELECT d.*, u.nome AS outro_nome FROM demandas d
      JOIN usuarios u ON u.id = d.solicitante_id
      WHERE d.responsavel_id = ? AND d.status NOT IN ('finalizada', 'concluida_aguardando_baixa')
      ORDER BY d.data_entrega ASC
    `).all(usuario.id);

    const demandasSol = db.prepare(`
      SELECT d.*, u.nome AS outro_nome FROM demandas d
      JOIN usuarios u ON u.id = d.responsavel_id
      WHERE d.solicitante_id = ? AND d.status NOT IN ('finalizada', 'concluida_aguardando_baixa')
      ORDER BY d.data_entrega ASC
    `).all(usuario.id);

    const prazo = d => d.data_acordada || d.data_entrega;
    const demandasAtivas = [...demandasResp, ...demandasSol.filter(d => !demandasResp.find(r => r.id === d.id))];
    const vencidas         = demandasAtivas.filter(d => prazo(d) < hoje);
    const vencem_hoje      = demandasAtivas.filter(d => prazo(d) === hoje);
    const vencem_em_3_dias = demandasAtivas.filter(d => prazo(d) > hoje && prazo(d) <= em3diasStr);

    await whatsappService.enviarRelatorioDiario(usuario, {
      vencidas, vencem_hoje, vencem_em_3_dias,
      total_ativas: demandasAtivas.length,
    });
  }
}

// ── Lembretes individuais ────────────────────────────────────────────────────

async function processarLembretes() {
  const db = getDb();
  const cfg = getConfig();
  const hoje = new Date().toISOString().slice(0, 10);

  const lembretesPendentes = db.prepare(`
    SELECT l.*, d.descricao, d.data_entrega, d.horario_entrega, d.data_acordada, d.status,
           d.responsavel_id, d.solicitante_id
    FROM lembretes l
    JOIN demandas d ON d.id = l.demanda_id
    WHERE l.enviado = 0 AND l.agendado_para <= ? AND d.status NOT IN ('finalizada')
    ORDER BY l.agendado_para ASC
  `).all(hoje);

  console.log(`[Scheduler] ${lembretesPendentes.length} lembrete(s) para processar.`);

  for (const lembrete of lembretesPendentes) {
    // Verifica se o tipo de alerta está habilitado nas configurações
    if (lembrete.tipo === 'antes_vencimento' && cfg.alerta_3_dias !== '1' && cfg.alerta_1_dia !== '1') {
      db.prepare('UPDATE lembretes SET enviado = 1 WHERE id = ?').run(lembrete.id);
      continue;
    }
    if (lembrete.tipo === 'no_vencimento' && cfg.alerta_no_dia !== '1') {
      db.prepare('UPDATE lembretes SET enviado = 1 WHERE id = ?').run(lembrete.id);
      continue;
    }
    if (lembrete.tipo === 'apos_vencimento' && cfg.alerta_apos_vencimento !== '1') {
      db.prepare('UPDATE lembretes SET enviado = 1 WHERE id = ?').run(lembrete.id);
      continue;
    }
    if (lembrete.tipo === 'aguardando_baixa' && cfg.alerta_aguardando_baixa !== '1') {
      db.prepare('UPDATE lembretes SET enviado = 1 WHERE id = ?').run(lembrete.id);
      continue;
    }

    try {
      await enviarLembrete(lembrete, db);
      db.prepare('UPDATE lembretes SET enviado = 1 WHERE id = ?').run(lembrete.id);
    } catch (err) {
      console.error(`[Scheduler] Erro no lembrete ${lembrete.id}:`, err.message);
    }
  }
}

async function enviarLembrete(lembrete, db) {
  const demanda = {
    id: lembrete.demanda_id,
    descricao: lembrete.descricao,
    data_entrega: lembrete.data_entrega,
    horario_entrega: lembrete.horario_entrega,
    data_acordada: lembrete.data_acordada,
    status: lembrete.status,
  };

  if (lembrete.tipo === 'aguardando_baixa') {
    const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(lembrete.solicitante_id);
    if (solicitante) await whatsappService.enviarLembrete(solicitante, demanda, 'aguardando_baixa');
  } else {
    const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(lembrete.responsavel_id);
    if (!responsavel) return;
    if (!['aceita', 'em_andamento', 'pendente_aceite', 'em_negociacao'].includes(demanda.status)) return;

    let tipo;
    if (lembrete.tipo === 'antes_vencimento') {
      const diff = Math.round(
        (new Date(demanda.data_acordada || demanda.data_entrega) - new Date(lembrete.agendado_para))
        / (1000 * 60 * 60 * 24)
      );
      tipo = diff >= 3 ? 'antes_vencimento_3' : 'antes_vencimento_1';
    } else if (lembrete.tipo === 'no_vencimento') {
      tipo = 'no_vencimento';
    } else {
      tipo = 'apos_vencimento';
    }
    const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(lembrete.solicitante_id);
    await whatsappService.enviarLembrete(responsavel, demanda, tipo, solicitante || null);
  }
}

// ── Alertas horários: demandas pendentes sem resposta ────────────────────────

async function verificarPendentesNaoRespondidos() {
  const db = getDb();
  const cfg = getConfig();
  const intervaloHoras = parseInt(cfg.intervalo_alerta_pendente_horas || '1');

  const limite = new Date();
  limite.setHours(limite.getHours() - intervaloHoras);
  const limiteISO = limite.toISOString();

  const pendentes = db.prepare(`
    SELECT d.*,
           u.id AS resp_id, u.nome AS resp_nome, u.telefone_whatsapp AS resp_tel
    FROM demandas d
    JOIN usuarios u ON u.id = d.responsavel_id
    WHERE d.status = 'pendente_aceite' AND d.criado_em <= ?
  `).all(limiteISO);

  if (pendentes.length > 0) {
    console.log(`[Scheduler] ${pendentes.length} demanda(s) pendente(s) sem resposta há ${intervaloHoras}h+`);
  }

  for (const d of pendentes) {
    const responsavel = { id: d.resp_id, nome: d.resp_nome, telefone_whatsapp: d.resp_tel };
    const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(d.solicitante_id);
    const demanda = { id: d.id, descricao: d.descricao, data_entrega: d.data_entrega, horario_entrega: d.horario_entrega, data_acordada: d.data_acordada, status: d.status };
    try {
      await whatsappService.enviarLembrete(responsavel, demanda, 'pendente_aceite', solicitante);
    } catch (err) {
      console.error(`[Scheduler] Erro ao enviar alerta pendente ${d.id}:`, err.message);
    }
  }
}

module.exports = { iniciarScheduler, reconfigurarScheduler, processarLembretes, enviarRelatoriosDiarios, verificarPendentesNaoRespondidos };
