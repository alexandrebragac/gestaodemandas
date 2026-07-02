const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');

// Gera as ocorrências do dia para toda atividade ativa vigente, e marca como
// 'atrasada' as ocorrências de dias anteriores que ainda estavam pendentes.
// Idempotente: usa a constraint UNIQUE(atividade_id, responsavel_id, data_referencia).
function processarAtividadesDoDia(dataReferencia) {
  const db = getDb();
  const hoje = dataReferencia || new Date().toISOString().slice(0, 10);
  const diaSemana = new Date(hoje + 'T12:00:00').getDay(); // 0=domingo..6=sábado
  const diaMes = parseInt(hoje.slice(8, 10), 10);

  const atividades = db.prepare(`
    SELECT * FROM atividades
    WHERE ativo = 1 AND data_inicio <= ? AND (data_fim IS NULL OR data_fim >= ?)
  `).all(hoje, hoje);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO atividade_ocorrencias (id, atividade_id, responsavel_id, data_referencia, status)
    VALUES (?, ?, ?, ?, 'pendente')
  `);

  let geradas = 0;
  for (const a of atividades) {
    let deveGerarHoje = false;
    if (a.recorrencia_tipo === 'diaria') deveGerarHoje = true;
    else if (a.recorrencia_tipo === 'semanal') {
      const dias = JSON.parse(a.recorrencia_dias_semana || '[]');
      deveGerarHoje = dias.includes(diaSemana);
    } else if (a.recorrencia_tipo === 'mensal') {
      deveGerarHoje = a.recorrencia_dia_mes === diaMes;
    } else if (a.recorrencia_tipo === 'unica') {
      deveGerarHoje = a.data_inicio === hoje;
    }
    if (!deveGerarHoje) continue;

    const info = insert.run(uuidv4(), a.id, a.responsavel_id, hoje);
    if (info.changes > 0) geradas++;
  }

  // Ocorrências de dias anteriores ainda pendentes/em andamento → atrasadas.
  // Se houve replanejamento aprovado, usa a nova data prevista como referência.
  const atraso = db.prepare(`
    UPDATE atividade_ocorrencias
    SET status = 'atrasada', atualizado_em = datetime('now')
    WHERE COALESCE(nova_data_prevista, data_referencia) < ? AND status IN ('pendente','em_andamento')
  `).run(hoje);

  console.log(`[AtividadesScheduler] ${geradas} ocorrência(s) gerada(s) para ${hoje}, ${atraso.changes} marcada(s) como atrasada(s).`);
  return { geradas, atrasadas: atraso.changes };
}

function iniciarSchedulerAtividades() {
  console.log('[AtividadesScheduler] Iniciando job diário (00:05)...');
  cron.schedule('5 0 * * *', () => {
    try { processarAtividadesDoDia(); } catch (err) { console.error('[AtividadesScheduler] Erro:', err.message); }
  }, { timezone: 'America/Sao_Paulo' });

  // Garante que o dia de hoje já tenha ocorrências geradas ao subir o servidor
  try { processarAtividadesDoDia(); } catch (err) { console.error('[AtividadesScheduler] Erro na geração inicial:', err.message); }
}

module.exports = { iniciarSchedulerAtividades, processarAtividadesDoDia };
