const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');

/**
 * Agenda lembretes para um responsável dado o prazo da demanda.
 * Lembretes: 3 dias antes, 1 dia antes, no dia, e diariamente após vencimento.
 */
function agendarLembretes(demandaId, dataPrazo) {
  const db = getDb();
  const prazo = new Date(dataPrazo + 'T00:00:00');

  const lembretes = [
    { diasAntes: 3, tipo: 'antes_vencimento' },
    { diasAntes: 1, tipo: 'antes_vencimento' },
    { diasAntes: 0, tipo: 'no_vencimento' },
  ];

  for (const { diasAntes, tipo } of lembretes) {
    const agendadoPara = new Date(prazo);
    agendadoPara.setDate(agendadoPara.getDate() - diasAntes);

    // Só agenda se ainda está no futuro
    if (agendadoPara >= new Date()) {
      db.prepare(`
        INSERT INTO lembretes (id, demanda_id, tipo, agendado_para)
        VALUES (?, ?, ?, ?)
      `).run(uuidv4(), demandaId, tipo, agendadoPara.toISOString().slice(0, 10));
    }
  }

  // Lembretes diários após vencimento — pré-agenda para os próximos 30 dias
  for (let i = 1; i <= 30; i++) {
    const dia = new Date(prazo);
    dia.setDate(dia.getDate() + i);
    db.prepare(`
      INSERT INTO lembretes (id, demanda_id, tipo, agendado_para)
      VALUES (?, ?, 'apos_vencimento', ?)
    `).run(uuidv4(), demandaId, dia.toISOString().slice(0, 10));
  }
}

/**
 * Agenda lembretes para o SOLICITANTE enquanto aguarda a baixa.
 * Frequência: imediato + a cada 2 dias (até 30 dias).
 */
function agendarLembretesAguardandoBaixa(demandaId) {
  const db = getDb();
  const hoje = new Date();

  // Lembrete imediato (hoje)
  db.prepare(`
    INSERT INTO lembretes (id, demanda_id, tipo, agendado_para)
    VALUES (?, ?, 'aguardando_baixa', ?)
  `).run(uuidv4(), demandaId, hoje.toISOString().slice(0, 10));

  // A cada 2 dias
  for (let i = 1; i <= 15; i++) {
    const dia = new Date(hoje);
    dia.setDate(dia.getDate() + i * 2);
    db.prepare(`
      INSERT INTO lembretes (id, demanda_id, tipo, agendado_para)
      VALUES (?, ?, 'aguardando_baixa', ?)
    `).run(uuidv4(), demandaId, dia.toISOString().slice(0, 10));
  }
}

module.exports = { agendarLembretes, agendarLembretesAguardandoBaixa };
