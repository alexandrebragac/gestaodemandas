const cron = require('node-cron');
const getDb = require('../database/db');
const whatsappService = require('./whatsapp');

function iniciarScheduler() {
  console.log('[Scheduler] Iniciando jobs...');

  // Relatório diário + lembretes: todo dia às 08:00
  cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] Executando relatório diário e lembretes...');
    await enviarRelatoriosDiarios();
    await processarLembretes();
  });

  // Em desenvolvimento, roda verificação 30s após iniciar
  if (process.env.NODE_ENV !== 'production') {
    setTimeout(async () => {
      console.log('[Scheduler] Verificação inicial (dev)...');
      await processarLembretes();
    }, 30_000);
  }
}

// ── Relatório diário ─────────────────────────────────────────────────────────

async function enviarRelatoriosDiarios() {
  const db = getDb();
  const hoje = new Date().toISOString().slice(0, 10);
  const em3dias = new Date();
  em3dias.setDate(em3dias.getDate() + 3);
  const em3diasStr = em3dias.toISOString().slice(0, 10);

  // Busca todos os usuários que têm demandas ativas como responsável
  const usuarios = db.prepare(`
    SELECT DISTINCT u.* FROM usuarios u
    JOIN demandas d ON d.responsavel_id = u.id
    WHERE d.status NOT IN ('finalizada', 'concluida_aguardando_baixa')
  `).all();

  console.log(`[Scheduler] Enviando relatório diário para ${usuarios.length} usuário(s)...`);

  for (const usuario of usuarios) {
    const demandasAtivas = db.prepare(`
      SELECT * FROM demandas
      WHERE responsavel_id = ? AND status NOT IN ('finalizada', 'concluida_aguardando_baixa')
      ORDER BY data_esperada ASC
    `).all(usuario.id);

    const prazo = d => d.data_acordada || d.data_esperada;

    const vencidas        = demandasAtivas.filter(d => prazo(d) < hoje);
    const vencem_hoje     = demandasAtivas.filter(d => prazo(d) === hoje);
    const vencem_em_3_dias = demandasAtivas.filter(d => prazo(d) > hoje && prazo(d) <= em3diasStr);

    await whatsappService.enviarRelatorioDiario(usuario, {
      vencidas,
      vencem_hoje,
      vencem_em_3_dias,
      total_ativas: demandasAtivas.length,
    });
  }
}

// ── Lembretes individuais ────────────────────────────────────────────────────

async function processarLembretes() {
  const db = getDb();
  const hoje = new Date().toISOString().slice(0, 10);

  const lembretesPendentes = db.prepare(`
    SELECT l.*, d.descricao, d.data_esperada, d.data_acordada, d.status,
           d.responsavel_id, d.solicitante_id
    FROM lembretes l
    JOIN demandas d ON d.id = l.demanda_id
    WHERE l.enviado = 0
      AND l.agendado_para <= ?
      AND d.status NOT IN ('finalizada')
    ORDER BY l.agendado_para ASC
  `).all(hoje);

  console.log(`[Scheduler] ${lembretesPendentes.length} lembrete(s) individual(is) para processar.`);

  for (const lembrete of lembretesPendentes) {
    try {
      await enviarLembrete(lembrete, db);
      db.prepare('UPDATE lembretes SET enviado = 1 WHERE id = ?').run(lembrete.id);
    } catch (err) {
      console.error(`[Scheduler] Erro ao enviar lembrete ${lembrete.id}:`, err.message);
    }
  }
}

async function enviarLembrete(lembrete, db) {
  const demanda = {
    id: lembrete.demanda_id,
    descricao: lembrete.descricao,
    data_esperada: lembrete.data_esperada,
    data_acordada: lembrete.data_acordada,
    status: lembrete.status,
  };

  if (lembrete.tipo === 'aguardando_baixa') {
    const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(lembrete.solicitante_id);
    if (solicitante) await whatsappService.enviarLembrete(solicitante, demanda, 'aguardando_baixa');
  } else {
    const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(lembrete.responsavel_id);
    if (!responsavel) return;

    if (['aceita', 'em_andamento', 'pendente_aceite', 'em_negociacao'].includes(demanda.status)) {
      let tipo;
      if (lembrete.tipo === 'antes_vencimento') {
        const diff = Math.round(
          (new Date(demanda.data_acordada || demanda.data_esperada) - new Date(lembrete.agendado_para))
          / (1000 * 60 * 60 * 24)
        );
        tipo = diff >= 3 ? 'antes_vencimento_3' : 'antes_vencimento_1';
      } else if (lembrete.tipo === 'no_vencimento') {
        tipo = 'no_vencimento';
      } else {
        tipo = 'apos_vencimento';
      }
      await whatsappService.enviarLembrete(responsavel, demanda, tipo);
    }
  }
}

module.exports = { iniciarScheduler, processarLembretes, enviarRelatoriosDiarios };
