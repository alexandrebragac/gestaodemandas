const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');

function agendarLembretes(demandaId, dataPrazo) {
  const db = getDb();
  const prazo = new Date(dataPrazo + 'T00:00:00');

  // Antes do vencimento: 3 dias antes e 1 dia antes
  const antecipados = [3, 1];
  for (const diasAntes of antecipados) {
    const agendado = new Date(prazo);
    agendado.setDate(agendado.getDate() - diasAntes);
    if (agendado >= new Date()) {
      db.prepare(`INSERT INTO lembretes (id, demanda_id, tipo, agendado_para) VALUES (?, ?, 'antes_vencimento', ?)`)
        .run(uuidv4(), demandaId, agendado.toISOString().slice(0, 10));
    }
  }

  // No dia do vencimento
  if (prazo >= new Date()) {
    db.prepare(`INSERT INTO lembretes (id, demanda_id, tipo, agendado_para) VALUES (?, ?, 'no_vencimento', ?)`)
      .run(uuidv4(), demandaId, prazo.toISOString().slice(0, 10));
  }

  // Após vencimento: dias 1, 3 e 7 apenas
  for (const diasDepois of [1, 3, 7]) {
    const dia = new Date(prazo);
    dia.setDate(dia.getDate() + diasDepois);
    db.prepare(`INSERT INTO lembretes (id, demanda_id, tipo, agendado_para) VALUES (?, ?, 'apos_vencimento', ?)`)
      .run(uuidv4(), demandaId, dia.toISOString().slice(0, 10));
  }
}

function agendarLembretesAguardandoBaixa(demandaId) {
  const db = getDb();
  const hoje = new Date();

  // Imediato + 3 dias + 7 dias
  for (const diasDepois of [0, 3, 7]) {
    const dia = new Date(hoje);
    dia.setDate(dia.getDate() + diasDepois);
    db.prepare(`INSERT INTO lembretes (id, demanda_id, tipo, agendado_para) VALUES (?, ?, 'aguardando_baixa', ?)`)
      .run(uuidv4(), demandaId, dia.toISOString().slice(0, 10));
  }
}

module.exports = { agendarLembretes, agendarLembretesAguardandoBaixa };

