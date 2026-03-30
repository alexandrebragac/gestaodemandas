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

    if (acao === 'pedir-prazo') {
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      // Mostra formulário para o responsável propor nova data
      return res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
      <style>
        body{font-family:Arial,sans-serif;background:#0f0f0f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#e8e8e8}
        .box{background:#191919;border:1px solid #2e2e2e;border-radius:12px;padding:32px 36px;max-width:420px;width:90%}
        h2{color:#4f8ef7;margin:0 0 6px;font-size:1.1rem}
        .desc{color:#737373;font-size:.85rem;margin-bottom:24px}
        .atividade{background:#212121;border:1px solid #2e2e2e;border-radius:8px;padding:12px;margin-bottom:20px;font-size:.9rem;color:#e8e8e8}
        label{display:block;font-size:.75rem;color:#737373;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;font-weight:600}
        input,textarea{width:100%;padding:10px;background:#212121;border:1px solid #2e2e2e;border-radius:7px;color:#e8e8e8;font-size:.9rem;font-family:inherit;box-sizing:border-box;margin-bottom:16px}
        input:focus,textarea:focus{outline:none;border-color:#4f8ef7}
        button{width:100%;padding:11px;background:#4f8ef7;color:#fff;border:none;border-radius:7px;font-size:.95rem;font-weight:700;cursor:pointer;font-family:inherit}
        button:hover{background:#6aa0f8}
        .msg{font-size:.82rem;margin-top:10px;text-align:center;min-height:18px}
        .msg.ok{color:#22c55e}.msg.err{color:#ef4444}
        a{color:#4f8ef7;text-decoration:none;font-size:.82rem}
      </style></head><body>
      <div class="box">
        <h2>📅 Propor novo prazo</h2>
        <p class="desc">Informe a data que você consegue entregar:</p>
        <div class="atividade">"${demanda.descricao}"</div>
        <label>Nova data de entrega</label>
        <input type="date" id="nova-data" min="${new Date().toISOString().slice(0,10)}" />
        <label>Motivo (opcional)</label>
        <textarea id="motivo" rows="3" placeholder="Explique brevemente o motivo..."></textarea>
        <button id="btn-enviar">Enviar proposta</button>
        <div class="msg" id="msg"></div>
        <p style="text-align:center;margin-top:16px"><a href="${appUrl}">Abrir sistema</a></p>
      </div>
      <script>
        document.getElementById('btn-enviar').addEventListener('click', async () => {
          const novaData = document.getElementById('nova-data').value;
          const motivo   = document.getElementById('motivo').value;
          const msg = document.getElementById('msg');
          if (!novaData) { msg.textContent = 'Selecione uma data.'; msg.className='msg err'; return; }
          const btn = document.getElementById('btn-enviar');
          btn.disabled = true; btn.textContent = 'Enviando...';
          try {
            const res = await fetch('/api/email-acao/${demandaId}/pedir-prazo-confirmar', {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ token: '${token}', nova_data: novaData, motivo })
            });
            const data = await res.json();
            if (res.ok) {
              document.querySelector('.box').innerHTML = '<h2 style="color:#22c55e;margin-bottom:10px">✅ Proposta enviada!</h2><p style="color:#737373">O solicitante foi notificado com sua proposta de novo prazo.</p><p style="margin-top:16px"><a href="${appUrl}" style="color:#4f8ef7">Abrir sistema</a></p>';
            } else {
              msg.textContent = data.erro || 'Erro ao enviar.'; msg.className='msg err';
              btn.disabled=false; btn.textContent='Enviar proposta';
            }
          } catch(e) { msg.textContent='Erro de conexão.'; msg.className='msg err'; btn.disabled=false; btn.textContent='Enviar proposta'; }
        });
      </script></body></html>`);
    }

    if (acao === 'pedir-prazo-confirmar') {
      // Endpoint POST chamado pelo formulário acima
      return res.status(405).send(html('❌ Método inválido', 'Use o formulário do email.', '#ff5b5b'));
    }

    return res.status(400).send(html('❌ Ação inválida', `Ação "${acao}" não reconhecida.`, '#ff5b5b'));
  } catch (err) {
    console.error('[EmailAcao]', err.message);
    return res.status(500).send(html('❌ Erro', err.message, '#ff5b5b'));
  }
});

// POST /api/email-acao/:demandaId/pedir-prazo-confirmar
router.post('/:demandaId/pedir-prazo-confirmar', async (req, res) => {
  const { demandaId } = req.params;
  const { token, nova_data, motivo } = req.body;

  if (!verificarTokenAcao(demandaId, 'pedir-prazo', token)) {
    return res.status(403).json({ erro: 'Token inválido ou expirado.' });
  }
  if (!nova_data) return res.status(400).json({ erro: 'nova_data é obrigatória.' });

  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(demandaId);
  if (!demanda) return res.status(404).json({ erro: 'Atividade não encontrada.' });

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.responsavel_id);
  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);

  db.prepare(`UPDATE demandas SET status='em_negociacao', atualizado_em=datetime('now') WHERE id=?`).run(demandaId);
  db.prepare(`INSERT INTO mensagens (id, demanda_id, remetente_id, tipo, conteudo) VALUES (?,?,?,'resposta',?)`).run(
    uuidv4(), demandaId, demanda.responsavel_id,
    `Novo prazo proposto via email: ${nova_data}${motivo ? `. Motivo: ${motivo}` : ''}`
  );

  const demandaAtualizada = { ...demanda, nova_data, observacao: motivo };
  try { await whatsappService.notificarNovoPrazo(solicitante, responsavel, demandaAtualizada, motivo); } catch (_) {}
  try { await emailService.notificarNovoPrazo(solicitante, responsavel, demandaAtualizada); } catch (_) {}

  res.json({ ok: true });
});

module.exports = router;
