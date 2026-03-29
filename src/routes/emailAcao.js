/**
 * Rotas para ações disparadas por links em emails.
 * GET /api/email-acao/:demandaId/:acao?token=xxx
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');
const { verificarTokenAcao } = require('../services/email');
const whatsappService = require('../services/whatsapp');
const emailService = require('../services/email');

const router = express.Router();

const STATUS = {
  PENDENTE_ACEITE: 'pendente_aceite',
  EM_NEGOCIACAO: 'em_negociacao',
  ACEITA: 'aceita',
  CONCLUIDA_AGUARDANDO_BAIXA: 'concluida_aguardando_baixa',
  FINALIZADA: 'finalizada',
};

function html(titulo, msg, cor = '#00c875') {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <style>body{font-family:Arial,sans-serif;background:#13131f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:#1e1e2e;border:1px solid #3a3a52;border-radius:12px;padding:32px 36px;text-align:center;max-width:400px}
  h2{color:${cor};margin-bottom:12px}p{color:#8888aa;font-size:.9rem}
  a{display:inline-block;margin-top:18px;padding:10px 22px;background:#7c5cfc;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style>
  </head><body><div class="box"><h2>${titulo}</h2><p>${msg}</p>
  <a href="${process.env.APP_URL || 'http://localhost:3000'}">Abrir sistema</a></div></body></html>`;
}

router.get('/:demandaId/:acao', async (req, res) => {
  const { demandaId, acao } = req.params;
  const { token } = req.query;

  if (!verificarTokenAcao(demandaId, acao, token)) {
    return res.status(403).send(html('❌ Link inválido', 'Este link expirou ou é inválido.', '#ff5b5b'));
  }

  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(demandaId);
  if (!demanda) return res.status(404).send(html('❌ Não encontrado', 'Atividade não encontrada.', '#ff5b5b'));

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.responsavel_id);
  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);

  async function notificarAmbos(fn, ...args) {
    for (const u of [responsavel, solicitante].filter(Boolean)) {
      if (u.canal === 'whatsapp' || u.canal === 'ambos' || !u.canal) {
        try { await whatsappService[fn](...args); } catch (_) {}
      }
      if (u.canal === 'email' || u.canal === 'ambos') {
        try { await emailService[fn](...args); } catch (_) {}
      }
    }
  }

  try {
    if (acao === 'aceitar') {
      if (![STATUS.PENDENTE_ACEITE, STATUS.EM_NEGOCIACAO].includes(demanda.status)) {
        return res.send(html('ℹ️ Já processado', `Esta atividade já foi aceita (status: ${demanda.status}).`, '#ffcb00'));
      }
      const dataAcordada = demanda.data_entrega;
      db.prepare(`UPDATE demandas SET status='aceita', data_acordada=?, atualizado_em=datetime('now') WHERE id=?`).run(dataAcordada, demandaId);
      db.prepare(`INSERT INTO mensagens (id, demanda_id, remetente_id, tipo, conteudo) VALUES (?,?,?,'resposta',?)`).run(uuidv4(), demandaId, demanda.responsavel_id, `${responsavel?.nome} aceitou via email.`);
      try { await whatsappService.notificarAceite(solicitante, responsavel, { ...demanda, data_acordada: dataAcordada }); } catch (_) {}
      try { await emailService.notificarAceite(solicitante, responsavel, { ...demanda, data_acordada: dataAcordada }); } catch (_) {}
      return res.send(html('✅ Aceito com sucesso!', `A atividade "${demanda.descricao}" foi aceita.`));
    }

    if (acao === 'baixa') {
      if (demanda.status !== STATUS.CONCLUIDA_AGUARDANDO_BAIXA) {
        return res.send(html('ℹ️ Já processado', `Esta atividade não está aguardando baixa (status: ${demanda.status}).`, '#ffcb00'));
      }
      db.prepare(`UPDATE demandas SET status='finalizada', atualizado_em=datetime('now') WHERE id=?`).run(demandaId);
      db.prepare(`INSERT INTO mensagens (id, demanda_id, remetente_id, tipo, conteudo) VALUES (?,?,?,'baixa',?)`).run(uuidv4(), demandaId, demanda.solicitante_id, `Baixa confirmada via email por ${solicitante?.nome}.`);
      try { await whatsappService.notificarBaixa(responsavel, solicitante, demanda); } catch (_) {}
      try { await emailService.notificarBaixa(responsavel, solicitante, demanda); } catch (_) {}
      return res.send(html('✔️ Baixa confirmada!', `A atividade "${demanda.descricao}" foi finalizada.`));
    }

    return res.status(400).send(html('❌ Ação inválida', `Ação "${acao}" não reconhecida.`, '#ff5b5b'));
  } catch (err) {
    console.error('[EmailAcao]', err.message);
    return res.status(500).send(html('❌ Erro', err.message, '#ff5b5b'));
  }
});

module.exports = router;
