const cron = require('node-cron');
const getDb = require('../database/db');
const whatsappService = require('./whatsapp');

/**
 * Job principal: roda todo dia às 08:00
 * Verifica lembretes pendentes e os envia.
 */
function iniciarScheduler() {
  console.log('[Scheduler] Iniciando job de lembretes...');

  // Roda todo dia às 08:00
  cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] Executando verificação de lembretes...');
    await processarLembretes();
  });

  // Em desenvolvimento, roda também 30s após iniciar para facilitar testes
  if (process.env.NODE_ENV !== 'production') {
    setTimeout(async () => {
      console.log('[Scheduler] Verificação inicial (dev)...');
      await processarLembretes();
    }, 30_000);
  }
}

async function processarLembretes() {
  const db = getDb();
  const hoje = new Date().toISOString().slice(0, 10);

  // Busca lembretes pendentes com data <= hoje
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

  console.log(`[Scheduler] ${lembretesPendentes.length} lembrete(s) para processar.`);

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
    // Lembrete vai para o SOLICITANTE
    const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(lembrete.solicitante_id);
    if (solicitante) {
      await whatsappService.enviarLembrete(solicitante, demanda, 'aguardando_baixa');
    }
  } else {
    // Lembretes de prazo vão para o RESPONSÁVEL
    const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(lembrete.responsavel_id);
    if (!responsavel) return;

    // Só envia lembretes de prazo se a demanda ainda não foi concluída
    if (['aceita', 'em_andamento', 'pendente_aceite', 'em_negociacao'].includes(demanda.status)) {
      let tipoLembrete;
      if (lembrete.tipo === 'antes_vencimento') {
        // Determina se é 3 dias ou 1 dia antes pelo agendamento vs data esperada
        const prazo = new Date(demanda.data_acordada || demanda.data_esperada);
        const agendado = new Date(lembrete.agendado_para);
        const diff = Math.round((prazo - agendado) / (1000 * 60 * 60 * 24));
        tipoLembrete = diff >= 3 ? 'antes_vencimento_3' : 'antes_vencimento_1';
      } else if (lembrete.tipo === 'no_vencimento') {
        tipoLembrete = 'no_vencimento';
      } else {
        tipoLembrete = 'apos_vencimento';
      }
      await whatsappService.enviarLembrete(responsavel, demanda, tipoLembrete);
    }
  }
}

module.exports = { iniciarScheduler, processarLembretes };
