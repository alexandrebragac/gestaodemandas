const express = require('express');
const getDb = require('../database/db');
const { parsear, COMANDOS, normalizarData, mensagemAjuda } = require('../services/comandos');
const { getSessao, setSessao, clearSessao } = require('../services/sessoes');
const whatsappService = require('../services/whatsapp');
const lembreteService = require('../services/lembretes');

const router = express.Router();

// POST /webhook/whatsapp
router.post('/whatsapp', async (req, res) => {
  const { From, Body } = req.body;
  if (!From || !Body) return res.status(400).send('Campos From e Body obrigatórios');

  const telefone = From.replace('whatsapp:', '');
  const textoMensagem = Body.trim();
  console.log(`[Webhook] Mensagem de ${telefone}: "${textoMensagem}"`);

  const db = getDb();
  const usuario = db.prepare('SELECT * FROM usuarios WHERE telefone_whatsapp = ?').get(telefone);

  if (!usuario) {
    await whatsappService.enviarMensagem(
      { telefone_whatsapp: telefone },
      '❌ Seu número não está cadastrado no sistema. Fale com o administrador.'
    );
    return res.status(200).send('OK');
  }

  const sessao = getSessao(telefone);
  const { comando, parametros } = parsear(textoMensagem);

  // ── Fluxo multi-etapa: aguardando data para novo prazo ──────────────────────
  if (sessao?.aguardando === 'data_prazo') {
    let data = null;

    if (comando === COMANDOS.DATA || comando === COMANDOS.NOVO_PRAZO) {
      data = parametros?.data;
    } else if (comando === COMANDOS.DESCONHECIDO) {
      // Tenta interpretar como data diretamente
      data = normalizarData(textoMensagem);
    }

    if (data) {
      await handleNovoPrazoComData(usuario, sessao.demandaId, data, telefone, res);
      return;
    } else {
      await whatsappService.enviarMensagem(usuario,
        `❓ Não entendi a data. Use o formato *DD/MM/AAAA*\nEx: 15/04/2026`
      );
      return res.status(200).send('OK');
    }
  }

  // ── Número do menu ──────────────────────────────────────────────────────────
  if (comando === COMANDOS.NUMERO_MENU) {
    await handleNumeroMenu(usuario, parametros.numero, sessao, telefone, res);
    return;
  }

  // ── Comandos de texto ───────────────────────────────────────────────────────
  switch (comando) {
    case COMANDOS.STATUS:
      await handleStatus(usuario, res);
      break;
    case COMANDOS.AJUDA:
      await whatsappService.enviarMensagem(usuario, mensagemAjuda());
      res.status(200).send('OK');
      break;
    case COMANDOS.ACEITAR:
      await handleAceitar(usuario, telefone, res);
      break;
    case COMANDOS.NOVO_PRAZO:
      await handleNovoPrazoComData(usuario, sessao?.demandaId, parametros?.data, telefone, res);
      break;
    case COMANDOS.CONCLUIR:
      await handleConcluir(usuario, telefone, res);
      break;
    case COMANDOS.BAIXA:
      await handleBaixa(usuario, telefone, res);
      break;
    default:
      await whatsappService.enviarMensagem(usuario,
        `Não entendi. Digite *6* para ver os comandos disponíveis.`
      );
      res.status(200).send('OK');
  }
});

// ── Handler: menu numerado ────────────────────────────────────────────────────

async function handleNumeroMenu(usuario, numero, sessao, telefone, res) {
  // Mapa padrão quando não há sessão específica
  const mapaGlobal = {
    1: COMANDOS.ACEITAR,
    2: 'pedir_prazo',
    3: COMANDOS.CONCLUIR,
    4: COMANDOS.BAIXA,
    5: COMANDOS.STATUS,
    6: COMANDOS.AJUDA,
  };

  // Se há sessão com mapa de opções customizado, usa ele
  const mapa = sessao?.opcoes || mapaGlobal;
  const acao = mapa[numero];

  if (!acao) {
    await whatsappService.enviarMensagem(usuario, `Opção *${numero}* inválida. Digite *6* para ver os comandos.`);
    return res.status(200).send('OK');
  }

  if (acao === COMANDOS.AJUDA) {
    await whatsappService.enviarMensagem(usuario, mensagemAjuda());
    return res.status(200).send('OK');
  }

  if (acao === COMANDOS.STATUS) {
    await handleStatus(usuario, res);
    return;
  }

  if (acao === 'pedir_prazo') {
    // Guarda demandaId na sessão se houver
    setSessao(telefone, { aguardando: 'data_prazo', demandaId: sessao?.demandaId || null });
    await whatsappService.enviarMensagem(usuario,
      `📅 Qual é o novo prazo?\nResponda no formato *DD/MM/AAAA*\nEx: 15/04/2026`
    );
    return res.status(200).send('OK');
  }

  if (acao === COMANDOS.ACEITAR) {
    await handleAceitar(usuario, telefone, res);
    return;
  }

  if (acao === COMANDOS.CONCLUIR) {
    await handleConcluir(usuario, telefone, res);
    return;
  }

  if (acao === COMANDOS.BAIXA) {
    await handleBaixa(usuario, telefone, res);
    return;
  }

  res.status(200).send('OK');
}

// ── Handler: status ───────────────────────────────────────────────────────────

async function handleStatus(usuario, res) {
  const db = getDb();

  const comoResponsavel = db.prepare(`
    SELECT * FROM demandas WHERE responsavel_id = ? AND status NOT IN ('finalizada')
    ORDER BY data_esperada ASC
  `).all(usuario.id);

  const comoSolicitante = db.prepare(`
    SELECT * FROM demandas WHERE solicitante_id = ? AND status NOT IN ('finalizada')
    ORDER BY data_esperada ASC
  `).all(usuario.id);

  let msg = `📊 *Suas Demandas*\n\n`;

  if (comoResponsavel.length > 0) {
    msg += `*Você é responsável (${comoResponsavel.length}):*\n`;
    for (const d of comoResponsavel) {
      const prazo = d.data_acordada || d.data_esperada;
      msg += `• ${d.descricao.substring(0, 45)} — ${statusEmoji(d.status)} ${formatarData(prazo)}\n`;
    }
    msg += '\n';
  }

  if (comoSolicitante.length > 0) {
    msg += `*Você solicitou (${comoSolicitante.length}):*\n`;
    for (const d of comoSolicitante) {
      const prazo = d.data_acordada || d.data_esperada;
      const resp = db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(d.responsavel_id);
      msg += `• ${d.descricao.substring(0, 35)} (${resp?.nome?.split(' ')[0]}) — ${statusEmoji(d.status)} ${formatarData(prazo)}\n`;
    }
  }

  if (comoResponsavel.length === 0 && comoSolicitante.length === 0) {
    msg += 'Nenhuma demanda ativa no momento. ✅';
  }

  await whatsappService.enviarMensagem(usuario, msg);
  res.status(200).send('OK');
}

// ── Handler: aceitar ─────────────────────────────────────────────────────────

async function handleAceitar(usuario, telefone, res) {
  const db = getDb();
  const demanda = db.prepare(`
    SELECT * FROM demandas WHERE responsavel_id = ? AND status IN ('pendente_aceite', 'em_negociacao')
    ORDER BY criado_em DESC LIMIT 1
  `).get(usuario.id);

  if (!demanda) {
    await whatsappService.enviarMensagem(usuario, 'Nenhuma demanda pendente de aceite encontrada.');
    return res.status(200).send('OK');
  }

  const dataAcordada = demanda.data_acordada || demanda.data_esperada;
  db.prepare(`UPDATE demandas SET status = 'aceita', data_acordada = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(dataAcordada, demanda.id);

  db.prepare('DELETE FROM lembretes WHERE demanda_id = ? AND enviado = 0').run(demanda.id);
  lembreteService.agendarLembretes(demanda.id, dataAcordada);

  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);
  await whatsappService.notificarAceite(solicitante, usuario, { ...demanda, data_acordada: dataAcordada });
  await whatsappService.enviarMensagem(usuario,
    `✅ Você aceitou!\n"${demanda.descricao}"\nPrazo: ${formatarData(dataAcordada)}`
  );

  clearSessao(telefone);
  res.status(200).send('OK');
}

// ── Handler: novo prazo com data ─────────────────────────────────────────────

async function handleNovoPrazoComData(usuario, demandaId, novaData, telefone, res) {
  const db = getDb();

  let demanda = null;

  if (demandaId) {
    demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(demandaId);
  }

  // Se não tiver demandaId na sessão, busca a mais recente em negociação
  if (!demanda) {
    demanda = db.prepare(`
      SELECT * FROM demandas WHERE responsavel_id = ? AND status IN ('pendente_aceite', 'em_negociacao')
      ORDER BY criado_em DESC LIMIT 1
    `).get(usuario.id);
  }

  if (!demanda) {
    demanda = db.prepare(`
      SELECT * FROM demandas WHERE solicitante_id = ? AND status = 'em_negociacao'
      ORDER BY criado_em DESC LIMIT 1
    `).get(usuario.id);
  }

  if (!demanda || !novaData) {
    await whatsappService.enviarMensagem(usuario, 'Nenhuma demanda em negociação encontrada.');
    clearSessao(telefone);
    return res.status(200).send('OK');
  }

  db.prepare(`UPDATE demandas SET status = 'em_negociacao', data_acordada = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(novaData, demanda.id);

  const ehResponsavel = demanda.responsavel_id === usuario.id;
  const outroId = ehResponsavel ? demanda.solicitante_id : demanda.responsavel_id;
  const outro = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(outroId);

  const msgParaOutro =
    `🔄 *Novo prazo proposto*\n\n` +
    `${usuario.nome} propôs: *${formatarData(novaData)}*\n` +
    `Tarefa: "${demanda.descricao}"\n\n` +
    `*1* — Aceitar\n` +
    `*2* — Propor outro prazo`;

  await whatsappService.enviarMensagem(outro, msgParaOutro);
  await whatsappService.enviarMensagem(usuario,
    `📅 Novo prazo *${formatarData(novaData)}* proposto. Aguardando confirmação.`
  );

  clearSessao(telefone);
  res.status(200).send('OK');
}

// ── Handler: concluir ────────────────────────────────────────────────────────

async function handleConcluir(usuario, telefone, res) {
  const db = getDb();
  const demanda = db.prepare(`
    SELECT * FROM demandas WHERE responsavel_id = ? AND status IN ('aceita', 'em_andamento')
    ORDER BY data_esperada ASC LIMIT 1
  `).get(usuario.id);

  if (!demanda) {
    await whatsappService.enviarMensagem(usuario, 'Nenhuma demanda em andamento encontrada.');
    return res.status(200).send('OK');
  }

  db.prepare(`UPDATE demandas SET status = 'concluida_aguardando_baixa', atualizado_em = datetime('now') WHERE id = ?`)
    .run(demanda.id);

  db.prepare('DELETE FROM lembretes WHERE demanda_id = ? AND enviado = 0').run(demanda.id);
  lembreteService.agendarLembretesAguardandoBaixa(demanda.id);

  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);
  await whatsappService.notificarConclusao(solicitante, usuario, demanda);
  await whatsappService.enviarMensagem(usuario,
    `✅ Marcado como concluído!\n"${demanda.descricao}"\n\nAguardando confirmação do solicitante.`
  );

  clearSessao(telefone);
  res.status(200).send('OK');
}

// ── Handler: baixa ───────────────────────────────────────────────────────────

async function handleBaixa(usuario, telefone, res) {
  const db = getDb();
  const demanda = db.prepare(`
    SELECT * FROM demandas WHERE solicitante_id = ? AND status = 'concluida_aguardando_baixa'
    ORDER BY atualizado_em DESC LIMIT 1
  `).get(usuario.id);

  if (!demanda) {
    await whatsappService.enviarMensagem(usuario, 'Nenhuma demanda aguardando sua confirmação.');
    return res.status(200).send('OK');
  }

  db.prepare(`UPDATE demandas SET status = 'finalizada', atualizado_em = datetime('now') WHERE id = ?`)
    .run(demanda.id);

  db.prepare('DELETE FROM lembretes WHERE demanda_id = ? AND enviado = 0').run(demanda.id);

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.responsavel_id);
  await whatsappService.notificarBaixa(responsavel, usuario, demanda);
  await whatsappService.enviarMensagem(usuario,
    `✔️ Baixa confirmada!\n"${demanda.descricao}"\n\nDemanda finalizada!`
  );

  clearSessao(telefone);
  res.status(200).send('OK');
}

// ── Utilitário ───────────────────────────────────────────────────────────────

function statusEmoji(status) {
  const emojis = {
    pendente_aceite: '⏳', em_negociacao: '🔄', aceita: '✅',
    em_andamento: '🔨', concluida_aguardando_baixa: '🎉', finalizada: '✔️',
  };
  return emojis[status] || '•';
}

function formatarData(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

module.exports = router;
