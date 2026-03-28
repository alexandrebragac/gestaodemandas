const express = require('express');
const getDb = require('../database/db');
const { enviarRelatoriosDiarios, reconfigurarScheduler } = require('../services/scheduler');

const router = express.Router();

// GET /api/configuracoes
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT chave, valor FROM configuracoes').all();
  const cfg = Object.fromEntries(rows.map(r => [r.chave, r.valor]));
  res.json(cfg);
});

// PUT /api/configuracoes
router.put('/', (req, res) => {
  const db = getDb();
  const campos = [
    'horario_relatorio',
    'alerta_3_dias',
    'alerta_1_dia',
    'alerta_no_dia',
    'alerta_apos_vencimento',
    'frequencia_apos_vencimento',
    'alerta_aguardando_baixa',
    'frequencia_aguardando_baixa',
    'alerta_pendente_sem_resposta',
    'intervalo_alerta_pendente_horas',
  ];

  const update = db.prepare(`
    UPDATE configuracoes SET valor = ?, atualizado_em = datetime('now') WHERE chave = ?
  `);

  const salvar = db.transaction(() => {
    for (const campo of campos) {
      if (req.body[campo] !== undefined) {
        update.run(String(req.body[campo]), campo);
      }
    }
  });

  salvar();

  // Reaplica o scheduler com o novo horário
  reconfigurarScheduler();

  const rows = db.prepare('SELECT chave, valor FROM configuracoes').all();
  res.json(Object.fromEntries(rows.map(r => [r.chave, r.valor])));
});

// POST /api/configuracoes/testar-relatorio
router.post('/testar-relatorio', async (req, res) => {
  try {
    console.log('[Configurações] Disparando relatório de teste...');
    await enviarRelatoriosDiarios();
    const db = getDb();
    db.prepare(`UPDATE configuracoes SET valor = datetime('now'), atualizado_em = datetime('now') WHERE chave = 'ultimo_relatorio'`).run();
    res.json({ ok: true, mensagem: 'Relatório enviado com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
