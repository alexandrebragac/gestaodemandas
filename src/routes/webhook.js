const express = require('express');
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');
const { parsear, COMANDOS, mensagemAjuda } = require('../services/comandos');
const whatsappService = require('../services/whatsapp');
const lembreteService = require('../services/lembretes');

const router = express.Router();

// POST /webhook/whatsapp  — recebe mensagens do Twilio
router.post('/whatsapp', async (req, res) => {
  const { From, Body } = req.body;

  if (!From || !Body) {
    return res.status(400).send('Campos From e Body obrigatórios');
  }

  // Normaliza número (remove "whatsapp:" prefix)
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

  const { comando, parametros } = parsear(textoMensagem);
  console.log(`[Webhook] Comando interpretado: ${comando}`, parametros || '');

  switch (comando) {
    case COMANDOS.STATUS:
      await handleStatus(usuario, res);
      break;

    case COMANDOS.AJUDA:
      await whatsappService.enviarMensagem(usuario, mensagemAjuda());
      res.status(200).send('OK');
      break;

    case COMANDOS.ACEITAR:
      await handleAceitar(usuario, res);
      break;

    case COMANDOS.NOVO_PRAZO:
      await handleNovoPrazo(usuario, parametros.data, res);
      break;

    case COMANDOS.CONCLUIR:
      await handleConcluir(usuario, res);
      break;

    case COMANDOS.BAIXA:
      await handleBaixa(usuario, res);
      break;

    default:
      await whatsappService.enviarMensagem(
        usuario,
        `Não entendi sua mensagem. Digite *ajuda* para ver os comandos disponíveis.`
      );
      res.status(200).send('OK');
  }
});

async function handleStatus(usuario, res) {
  const db = getDb();

  const comoResponsavel = db.prepare(`
    SELECT * FROM demandas
    WHERE responsavel_id = ? AND status NOT IN ('finalizada')
    ORDER BY data_esperada ASC
  `).all(usuario.id);

  const comoSolicitante = db.prepare(`
    SELECT * FROM demandas
    WHERE solicitante_id = ? AND status NOT IN ('finalizada')
    ORDER BY data_esperada ASC
  `).all(usuario.id);

  let msg = `📊 *Suas Demandas*\n\n`;

  if (comoResponsavel.length > 0) {
    msg += `*Como responsável (${comoResponsavel.length}):*\n`;
    for (const d of comoResponsavel) {
      const prazo = d.data_acordada || d.data_esperada;
      msg += `• ${d.descricao.substring(0, 50)} — ${statusEmoji(d.status)} ${prazo}\n`;
    }
    msg += '\n';
  }

  if (comoSolicitante.length > 0) {
    msg += `*Como solicitante (${comoSolicitante.length}):*\n`;
    for (const d of comoSolicitante) {
      const prazo = d.data_acordada || d.data_esperada;
      const resp = db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(d.responsavel_id);
      msg += `• ${d.descricao.substring(0, 50)} (${resp?.nome}) — ${statusEmoji(d.status)} ${prazo}\n`;
    }
  }

  if (comoResponsavel.length === 0 && comoSolicitante.length === 0) {
    msg += 'Nenhuma demanda ativa no momento.';
  }

  await whatsappService.enviarMensagem(usuario, msg);
  res.status(200).send('OK');
}

async function handleAceitar(usuario, res) {
  const db = getDb();

  // Busca a demanda mais recente pendente para este responsável
  const demanda = db.prepare(`
    SELECT * FROM demandas
    WHERE responsavel_id = ? AND status IN ('pendente_aceite', 'em_negociacao')
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
  await whatsappService.enviarMensagem(usuario, `✅ Você aceitou a demanda:\n"${demanda.descricao}"\nPrazo: ${dataAcordada}`);

  res.status(200).send('OK');
}

async function handleNovoPrazo(usuario, novaData, res) {
  const db = getDb();

  // Pode ser responsável propondo ou solicitante contra-propondo
  let demanda = db.prepare(`
    SELECT * FROM demandas
    WHERE responsavel_id = ? AND status IN ('pendente_aceite', 'em_negociacao')
    ORDER BY criado_em DESC LIMIT 1
  `).get(usuario.id);

  let ehResponsavel = true;

  if (!demanda) {
    demanda = db.prepare(`
      SELECT * FROM demandas
      WHERE solicitante_id = ? AND status = 'em_negociacao'
      ORDER BY criado_em DESC LIMIT 1
    `).get(usuario.id);
    ehResponsavel = false;
  }

  if (!demanda) {
    await whatsappService.enviarMensagem(usuario, 'Nenhuma demanda em negociação encontrada.');
    return res.status(200).send('OK');
  }

  db.prepare(`UPDATE demandas SET status = 'em_negociacao', data_acordada = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(novaData, demanda.id);

  const outroUsuarioId = ehResponsavel ? demanda.solicitante_id : demanda.responsavel_id;
  const outroUsuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(outroUsuarioId);

  const msgParaOutro =
    `🔄 *Novo prazo proposto*\n\n` +
    `${usuario.nome} propôs novo prazo para:\n"${demanda.descricao}"\n\nNovo prazo: ${novaData}\n\n` +
    `Responda *aceito* para confirmar ou *novo prazo: DD/MM/AAAA* para contra-propor.`;

  await whatsappService.enviarMensagem(outroUsuario, msgParaOutro);
  await whatsappService.enviarMensagem(usuario, `📅 Novo prazo ${novaData} proposto. Aguardando confirmação.`);

  res.status(200).send('OK');
}

async function handleConcluir(usuario, res) {
  const db = getDb();

  const demanda = db.prepare(`
    SELECT * FROM demandas
    WHERE responsavel_id = ? AND status IN ('aceita', 'em_andamento')
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
  await whatsappService.enviarMensagem(usuario, `✅ Demanda marcada como concluída:\n"${demanda.descricao}"\n\nAguardando confirmação do solicitante.`);

  res.status(200).send('OK');
}

async function handleBaixa(usuario, res) {
  const db = getDb();

  const demanda = db.prepare(`
    SELECT * FROM demandas
    WHERE solicitante_id = ? AND status = 'concluida_aguardando_baixa'
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
  await whatsappService.enviarMensagem(usuario, `✔️ Baixa confirmada!\n"${demanda.descricao}"\n\nDemanda finalizada com sucesso.`);

  res.status(200).send('OK');
}

function statusEmoji(status) {
  const emojis = {
    pendente_aceite: '⏳',
    em_negociacao: '🔄',
    aceita: '✅',
    em_andamento: '🔨',
    concluida_aguardando_baixa: '🎉',
    finalizada: '✔️',
  };
  return emojis[status] || '•';
}

module.exports = router;
