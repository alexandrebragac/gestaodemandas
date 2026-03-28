const express = require('express');
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');
const { parsear, COMANDOS, normalizarData, mensagemAjuda } = require('../services/comandos');
const { getSessao, setSessao, clearSessao } = require('../services/sessoes');
const whatsappService = require('../services/whatsapp');
const lembreteService = require('../services/lembretes');
const iaService = require('../services/ia');

const router = express.Router();

// ── Entry point ───────────────────────────────────────────────────────────────

router.post('/whatsapp', async (req, res) => {
  const { From, Body } = req.body;
  if (!From || !Body) return res.status(400).send('Campos obrigatórios ausentes');

  const telefone = From.replace('whatsapp:', '');
  const texto = Body.trim();
  console.log(`[Webhook] ${telefone}: "${texto}"`);

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
  const { comando, parametros } = parsear(texto);

  // ── Fluxos multi-etapa ativos ─────────────────────────────────────────────

  if (sessao?.fluxo) {
    await continuarFluxo(usuario, texto, comando, parametros, sessao, telefone, res);
    return;
  }

  // ── Número do menu sem fluxo ativo ────────────────────────────────────────

  if (comando === COMANDOS.NUMERO_MENU) {
    await handleNumeroMenu(usuario, parametros.numero, null, telefone, res);
    return;
  }

  // ── Comandos de texto ─────────────────────────────────────────────────────

  switch (comando) {
    case COMANDOS.STATUS:       await handleStatus(usuario, res); break;
    case COMANDOS.AJUDA:        await whatsappService.enviarMensagem(usuario, mensagemAjuda()); res.status(200).send('OK'); break;
    case COMANDOS.ACEITAR:      await handleAceitar(usuario, telefone, res); break;
    case COMANDOS.NOVO_PRAZO:   await handleNovoPrazoComData(usuario, null, parametros?.data, telefone, res); break;
    case COMANDOS.CONCLUIR:     await handleConcluir(usuario, telefone, res); break;
    case COMANDOS.BAIXA:        await handleBaixa(usuario, telefone, res); break;
    case COMANDOS.NOVA_DEMANDA: await iniciarCriacaoDemanda(usuario, telefone, res); break;
    case COMANDOS.EDITAR_DEMANDA: await iniciarEdicaoDemanda(usuario, telefone, res); break;
    default:
      await handlePerguntaIA(usuario, texto, res);
      return;
  }
});

// Fluxos que esperam texto livre ou data (não seleção de lista por número)
const FLUXOS_TEXTO = new Set(['criar_prazo', 'editar_nova_descricao', 'editar_novo_prazo', 'aguardando_data_prazo']);

// ── Google Calendar ───────────────────────────────────────────────────────────

function gerarLinkCalendario(descricao, dataIso) {
  const inicio = dataIso.replace(/-/g, '');
  const fim = (() => {
    const d = new Date(dataIso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  })();
  const titulo = encodeURIComponent(descricao.substring(0, 80));
  const detalhes = encodeURIComponent('Prazo de atividade — Gestão de Demandas');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${titulo}&dates=${inicio}/${fim}&details=${detalhes}`;
}

// ── Roteador de fluxos ativos ─────────────────────────────────────────────────

async function continuarFluxo(usuario, texto, comando, parametros, sessao, telefone, res) {
  // Interceção: usuário digitou um comando de menu (número) enquanto está em um
  // fluxo que espera texto livre. Reenvia a pergunta atual para não perder o contexto.
  if (
    FLUXOS_TEXTO.has(sessao.fluxo) &&
    texto !== '0' &&
    comando === COMANDOS.NUMERO_MENU
  ) {
    const pergunta = sessao.pergunta_atual || 'Responda a pergunta acima.';
    await whatsappService.enviarMensagem(
      usuario,
      `⚠️ *Ação em andamento!*\n\nVocê tem uma ação que precisa de resposta:\n\n${pergunta}\n\n_Digite *0* para cancelar._`
    );
    return res.status(200).send('OK');
  }

  switch (sessao.fluxo) {
    case 'criar_descricao':       await fluxoCriarDescricao(usuario, texto, telefone, res); break;
    case 'criar_responsavel':     await fluxoCriarResponsavel(usuario, texto, comando, parametros, sessao, telefone, res); break;
    case 'criar_prazo':           await fluxoCriarPrazo(usuario, texto, comando, parametros, sessao, telefone, res); break;
    case 'criar_confirmacao':     await fluxoCriarConfirmacao(usuario, texto, comando, parametros, sessao, telefone, res); break;
    case 'editar_selecionar':     await fluxoEditarSelecionar(usuario, texto, comando, parametros, sessao, telefone, res); break;
    case 'editar_campo':          await fluxoEditarCampo(usuario, texto, comando, parametros, sessao, telefone, res); break;
    case 'editar_nova_descricao': await fluxoEditarNovaDescricao(usuario, texto, sessao, telefone, res); break;
    case 'editar_novo_prazo':     await fluxoEditarNovoPrazo(usuario, texto, comando, parametros, sessao, telefone, res); break;
    case 'aguardando_calendario': await fluxoCalendario(usuario, texto, sessao, telefone, res); break;
    case 'aguardando_data_prazo': {
      const dataExtraida = extrairData(texto, comando, parametros);
      if (!dataExtraida && texto !== '0') {
        await whatsappService.enviarMensagem(usuario,
          `❓ Data inválida. Use *DD/MM/AAAA*\nEx: 15/04/2026\n\n` +
          `📅 *Qual é o novo prazo?*\n_Digite a data ou *0* para cancelar._`
        );
        return res.status(200).send('OK');
      }
      await handleNovoPrazoComData(usuario, sessao.demandaId, dataExtraida, telefone, res);
      break;
    }
    default:
      clearSessao(telefone);
      await whatsappService.enviarMensagem(usuario, 'Sessão expirada. Digite *6* para ver os comandos.');
      res.status(200).send('OK');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUXO: CRIAR DEMANDA
// ══════════════════════════════════════════════════════════════════════════════

async function iniciarCriacaoDemanda(usuario, telefone, res) {
  setSessao(telefone, { fluxo: 'criar_descricao' });
  await whatsappService.enviarMensagem(usuario,
    `📝 *Criar Nova Demanda*\n\nQual é a descrição da tarefa?\n\n_Digite o texto ou *0* para cancelar_`
  );
  res.status(200).send('OK');
}

async function fluxoCriarDescricao(usuario, texto, telefone, res) {
  if (texto === '0') { clearSessao(telefone); await whatsappService.enviarMensagem(usuario, '❌ Criação cancelada.'); return res.status(200).send('OK'); }

  const db = getDb();
  const todos = db.prepare('SELECT * FROM usuarios ORDER BY nome').all();

  if (todos.length === 0) {
    clearSessao(telefone);
    await whatsappService.enviarMensagem(usuario, '⚠️ Nenhum usuário cadastrado no sistema.');
    return res.status(200).send('OK');
  }

  setSessao(telefone, { fluxo: 'criar_responsavel', descricao: texto, usuarios: todos });

  let msg = `👤 *Para quem é essa tarefa?*\n\n`;
  todos.forEach((u, i) => {
    const sufixo = u.id === usuario.id ? ' _(você)_' : '';
    msg += `*${i + 1}* — ${u.nome}${sufixo}\n`;
  });
  msg += `\n*0* — Cancelar`;

  await whatsappService.enviarMensagem(usuario, msg);
  res.status(200).send('OK');
}

async function fluxoCriarResponsavel(usuario, texto, comando, parametros, sessao, telefone, res) {
  if (texto === '0') { clearSessao(telefone); await whatsappService.enviarMensagem(usuario, '❌ Criação cancelada.'); return res.status(200).send('OK'); }

  let responsavel = null;
  if (comando === COMANDOS.NUMERO_MENU) {
    responsavel = sessao.usuarios[parametros.numero - 1];
  }

  if (!responsavel) {
    let msg = `⚠️ Opção inválida. Escolha:\n\n`;
    sessao.usuarios.forEach((u, i) => { msg += `*${i + 1}* — ${u.nome}\n`; });
    await whatsappService.enviarMensagem(usuario, msg);
    return res.status(200).send('OK');
  }

  const perguntaPrazo = `📅 *Qual é o prazo?*\n\nResponda no formato *DD/MM/AAAA*\nEx: 30/04/2026\n\n*0* — Cancelar`;
  setSessao(telefone, { ...sessao, fluxo: 'criar_prazo', responsavel, pergunta_atual: perguntaPrazo });
  await whatsappService.enviarMensagem(usuario, perguntaPrazo);
  res.status(200).send('OK');
}

async function fluxoCriarPrazo(usuario, texto, comando, parametros, sessao, telefone, res) {
  if (texto === '0') { clearSessao(telefone); await whatsappService.enviarMensagem(usuario, '❌ Criação cancelada.'); return res.status(200).send('OK'); }

  const data = extrairData(texto, comando, parametros);
  if (!data) {
    await whatsappService.enviarMensagem(usuario,
      `❓ Data inválida. Use o formato *DD/MM/AAAA*\nEx: 30/04/2026\n\n` +
      `📅 *Qual é o prazo?*\n_Digite a data ou *0* para cancelar._`
    );
    return res.status(200).send('OK');
  }

  setSessao(telefone, { ...sessao, fluxo: 'criar_confirmacao', data_esperada: data });
  await whatsappService.enviarMensagem(usuario,
    `✅ *Confirmar criação?*\n\n` +
    `📋 Tarefa: ${sessao.descricao}\n` +
    `👤 Responsável: ${sessao.responsavel.nome}\n` +
    `📅 Prazo: ${formatarData(data)}\n\n` +
    `*1* — Confirmar e criar\n` +
    `*0* — Cancelar`
  );
  res.status(200).send('OK');
}

async function fluxoCriarConfirmacao(usuario, texto, comando, parametros, sessao, telefone, res) {
  const confirmou = texto === '1' || comando === COMANDOS.NUMERO_MENU && parametros.numero === 1
    || /^(sim|confirmar|ok|aceito)$/i.test(texto);

  if (texto === '0' || !confirmou) {
    clearSessao(telefone);
    await whatsappService.enviarMensagem(usuario, '❌ Criação cancelada.');
    return res.status(200).send('OK');
  }

  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO demandas (id, solicitante_id, responsavel_id, descricao, data_esperada) VALUES (?, ?, ?, ?, ?)`)
    .run(id, usuario.id, sessao.responsavel.id, sessao.descricao.trim(), sessao.data_esperada);

  db.prepare(`INSERT INTO mensagens (id, demanda_id, remetente_id, tipo, conteudo) VALUES (?, ?, ?, 'criacao', ?)`)
    .run(uuidv4(), id, usuario.id, `Nova demanda criada por ${usuario.nome}:\n\n"${sessao.descricao}"\n\nPrazo esperado: ${sessao.data_esperada}`);

  lembreteService.agendarLembretes(id, sessao.data_esperada);

  const responsavelCompleto = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(sessao.responsavel.id);
  await whatsappService.notificarNovaDeamanda(responsavelCompleto, usuario, {
    id, descricao: sessao.descricao, data_esperada: sessao.data_esperada,
  });

  clearSessao(telefone);
  await whatsappService.enviarMensagem(usuario,
    `🎉 *Demanda criada com sucesso!*\n\n` +
    `📋 ${sessao.descricao}\n` +
    `👤 Responsável: ${sessao.responsavel.nome}\n` +
    `📅 Prazo: ${formatarData(sessao.data_esperada)}\n\n` +
    `${sessao.responsavel.nome} foi notificado(a).`
  );
  res.status(200).send('OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUXO: EDITAR DEMANDA
// ══════════════════════════════════════════════════════════════════════════════

async function iniciarEdicaoDemanda(usuario, telefone, res) {
  const db = getDb();
  const demandas = db.prepare(`
    SELECT * FROM demandas
    WHERE solicitante_id = ? AND status NOT IN ('finalizada')
    ORDER BY criado_em DESC
  `).all(usuario.id);

  if (demandas.length === 0) {
    await whatsappService.enviarMensagem(usuario, '📭 Nenhuma demanda ativa para editar.');
    return res.status(200).send('OK');
  }

  setSessao(telefone, { fluxo: 'editar_selecionar', demandas });

  let msg = `✏️ *Editar Demanda*\n\nQual demanda deseja editar?\n\n`;
  demandas.forEach((d, i) => {
    const prazo = formatarData(d.data_acordada || d.data_esperada);
    msg += `*${i + 1}* — ${d.descricao.substring(0, 40)} (${prazo})\n`;
  });
  msg += `\n*0* — Cancelar`;

  await whatsappService.enviarMensagem(usuario, msg);
  res.status(200).send('OK');
}

async function fluxoEditarSelecionar(usuario, texto, comando, parametros, sessao, telefone, res) {
  if (texto === '0') { clearSessao(telefone); await whatsappService.enviarMensagem(usuario, '❌ Edição cancelada.'); return res.status(200).send('OK'); }

  let demanda = null;
  if (comando === COMANDOS.NUMERO_MENU) {
    demanda = sessao.demandas[parametros.numero - 1];
  }

  if (!demanda) {
    await whatsappService.enviarMensagem(usuario, `⚠️ Opção inválida. Digite o número da demanda.`);
    return res.status(200).send('OK');
  }

  setSessao(telefone, { fluxo: 'editar_campo', demanda });
  await whatsappService.enviarMensagem(usuario,
    `✏️ *${demanda.descricao.substring(0, 50)}*\n\nO que deseja alterar?\n\n` +
    `*1* — Descrição\n` +
    `*2* — Prazo\n` +
    `*0* — Cancelar`
  );
  res.status(200).send('OK');
}

async function fluxoEditarCampo(usuario, texto, comando, parametros, sessao, telefone, res) {
  if (texto === '0') { clearSessao(telefone); await whatsappService.enviarMensagem(usuario, '❌ Edição cancelada.'); return res.status(200).send('OK'); }

  const num = comando === COMANDOS.NUMERO_MENU ? parametros.numero : parseInt(texto);

  if (num === 1) {
    setSessao(telefone, { ...sessao, fluxo: 'editar_nova_descricao' });
    await whatsappService.enviarMensagem(usuario,
      `📝 Digite a nova descrição:\n\n_Atual: ${sessao.demanda.descricao}_\n\n*0* — Cancelar`
    );
  } else if (num === 2) {
    const prazoAtual = formatarData(sessao.demanda.data_acordada || sessao.demanda.data_esperada);
    const perguntaNovoPrazo = `📅 *Novo prazo* (*DD/MM/AAAA*):\n\n_Atual: ${prazoAtual}_\n\n*0* — Cancelar`;
    setSessao(telefone, { ...sessao, fluxo: 'editar_novo_prazo', pergunta_atual: perguntaNovoPrazo });
    await whatsappService.enviarMensagem(usuario, perguntaNovoPrazo);
  } else {
    await whatsappService.enviarMensagem(usuario, `⚠️ Opção inválida.\n*1* — Descrição\n*2* — Prazo\n*0* — Cancelar`);
  }
  res.status(200).send('OK');
}

async function fluxoEditarNovaDescricao(usuario, texto, sessao, telefone, res) {
  if (texto === '0') { clearSessao(telefone); await whatsappService.enviarMensagem(usuario, '❌ Edição cancelada.'); return res.status(200).send('OK'); }

  const db = getDb();
  db.prepare(`UPDATE demandas SET descricao = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(texto.trim(), sessao.demanda.id);

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(sessao.demanda.responsavel_id);
  await whatsappService.enviarMensagem(responsavel,
    `✏️ *Demanda atualizada*\n\n${usuario.nome} alterou a descrição:\n"${texto.trim()}"\nPrazo: ${formatarData(sessao.demanda.data_acordada || sessao.demanda.data_esperada)}`
  );

  clearSessao(telefone);
  await whatsappService.enviarMensagem(usuario, `✅ Descrição atualizada!\n\n"${texto.trim()}"`);
  res.status(200).send('OK');
}

async function fluxoEditarNovoPrazo(usuario, texto, comando, parametros, sessao, telefone, res) {
  if (texto === '0') { clearSessao(telefone); await whatsappService.enviarMensagem(usuario, '❌ Edição cancelada.'); return res.status(200).send('OK'); }

  const data = extrairData(texto, comando, parametros);
  if (!data) {
    const prazoAtual = formatarData(sessao.demanda.data_acordada || sessao.demanda.data_esperada);
    await whatsappService.enviarMensagem(usuario,
      `❓ Data inválida. Use *DD/MM/AAAA*\nEx: 30/04/2026\n\n` +
      `📅 *Novo prazo para:* "${sessao.demanda.descricao.substring(0, 40)}"\n_Atual: ${prazoAtual}_\n_Digite a data ou *0* para cancelar._`
    );
    return res.status(200).send('OK');
  }

  const db = getDb();
  db.prepare(`UPDATE demandas SET data_esperada = ?, data_acordada = ?, status = 'em_negociacao', atualizado_em = datetime('now') WHERE id = ?`)
    .run(data, data, sessao.demanda.id);

  db.prepare('DELETE FROM lembretes WHERE demanda_id = ? AND enviado = 0').run(sessao.demanda.id);
  lembreteService.agendarLembretes(sessao.demanda.id, data);

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(sessao.demanda.responsavel_id);
  await whatsappService.enviarMensagem(responsavel,
    `📅 *Prazo alterado*\n\n${usuario.nome} alterou o prazo de:\n"${sessao.demanda.descricao}"\n\nNovo prazo: *${formatarData(data)}*\n\n*1* — Aceitar\n*2* — Propor outro prazo`
  );

  clearSessao(telefone);
  await whatsappService.enviarMensagem(usuario, `✅ Prazo atualizado para *${formatarData(data)}*!\n\n${responsavel.nome} foi notificado(a).`);
  res.status(200).send('OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLERS DE AÇÕES EXISTENTES
// ══════════════════════════════════════════════════════════════════════════════

async function handleNumeroMenu(usuario, numero, sessao, telefone, res) {
  const mapa = {
    1: COMANDOS.ACEITAR,
    2: 'pedir_prazo',
    3: COMANDOS.CONCLUIR,
    4: COMANDOS.BAIXA,
    5: COMANDOS.STATUS,
    6: COMANDOS.AJUDA,
    7: COMANDOS.NOVA_DEMANDA,
    8: COMANDOS.EDITAR_DEMANDA,
  };

  const acao = mapa[numero];

  if (!acao) {
    await whatsappService.enviarMensagem(usuario, `Opção *${numero}* inválida. Digite *6* para ver os comandos.`);
    return res.status(200).send('OK');
  }

  if (acao === COMANDOS.AJUDA)          { await whatsappService.enviarMensagem(usuario, mensagemAjuda()); return res.status(200).send('OK'); }
  if (acao === COMANDOS.STATUS)          { return handleStatus(usuario, res); }
  if (acao === COMANDOS.ACEITAR)         { return handleAceitar(usuario, telefone, res); }
  if (acao === COMANDOS.CONCLUIR)        { return handleConcluir(usuario, telefone, res); }
  if (acao === COMANDOS.BAIXA)           { return handleBaixa(usuario, telefone, res); }
  if (acao === COMANDOS.NOVA_DEMANDA)    { return iniciarCriacaoDemanda(usuario, telefone, res); }
  if (acao === COMANDOS.EDITAR_DEMANDA)  { return iniciarEdicaoDemanda(usuario, telefone, res); }

  if (acao === 'pedir_prazo') {
    const perguntaPrazoNovo = `📅 *Qual é o novo prazo?*\nResponda no formato *DD/MM/AAAA*\nEx: 15/04/2026\n\n*0* — Cancelar`;
    setSessao(telefone, { fluxo: 'aguardando_data_prazo', demandaId: sessao?.demandaId || null, pergunta_atual: perguntaPrazoNovo });
    await whatsappService.enviarMensagem(usuario, perguntaPrazoNovo);
    return res.status(200).send('OK');
  }

  res.status(200).send('OK');
}

async function handleStatus(usuario, res) {
  const db = getDb();

  const comoResponsavel = db.prepare(`
    SELECT * FROM demandas WHERE responsavel_id = ? AND status NOT IN ('finalizada') ORDER BY data_esperada ASC
  `).all(usuario.id);

  const comoSolicitante = db.prepare(`
    SELECT * FROM demandas WHERE solicitante_id = ? AND status NOT IN ('finalizada') ORDER BY data_esperada ASC
  `).all(usuario.id);

  let msg = `📊 *Suas Demandas*\n\n`;

  if (comoResponsavel.length > 0) {
    msg += `*Você é responsável (${comoResponsavel.length}):*\n`;
    for (const d of comoResponsavel) {
      msg += `• ${d.descricao.substring(0, 45)} — ${statusEmoji(d.status)} ${formatarData(d.data_acordada || d.data_esperada)}\n`;
    }
    msg += '\n';
  }

  if (comoSolicitante.length > 0) {
    msg += `*Você solicitou (${comoSolicitante.length}):*\n`;
    for (const d of comoSolicitante) {
      const resp = db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(d.responsavel_id);
      msg += `• ${d.descricao.substring(0, 35)} (${resp?.nome?.split(' ')[0]}) — ${statusEmoji(d.status)} ${formatarData(d.data_acordada || d.data_esperada)}\n`;
    }
    msg += '\n';
  }

  if (comoResponsavel.length === 0 && comoSolicitante.length === 0) {
    msg += 'Nenhuma demanda ativa. ✅\n\n';
  }

  msg += `*7* — Criar nova demanda\n*8* — Editar demanda`;

  await whatsappService.enviarMensagem(usuario, msg);
  res.status(200).send('OK');
}

async function handleAceitar(usuario, telefone, res) {
  const db = getDb();

  // Caso 1: usuário é RESPONSÁVEL aceitando demanda nova ou prazo proposto
  let demanda = db.prepare(`
    SELECT * FROM demandas WHERE responsavel_id = ? AND status IN ('pendente_aceite','em_negociacao')
    ORDER BY criado_em DESC LIMIT 1
  `).get(usuario.id);

  // Caso 2: usuário é SOLICITANTE aceitando prazo proposto pelo responsável
  if (!demanda) {
    demanda = db.prepare(`
      SELECT * FROM demandas WHERE solicitante_id = ? AND status = 'em_negociacao'
      ORDER BY atualizado_em DESC LIMIT 1
    `).get(usuario.id);
  }

  if (!demanda) {
    await whatsappService.enviarMensagem(usuario, '⚠️ Nenhuma demanda aguardando seu aceite no momento.');
    return res.status(200).send('OK');
  }

  const dataAcordada = demanda.data_acordada || demanda.data_esperada;
  db.prepare(`UPDATE demandas SET status='aceita', data_acordada=?, atualizado_em=datetime('now') WHERE id=?`)
    .run(dataAcordada, demanda.id);

  db.prepare('DELETE FROM lembretes WHERE demanda_id=? AND enviado=0').run(demanda.id);
  lembreteService.agendarLembretes(demanda.id, dataAcordada);

  // Notifica a outra parte
  const ehResponsavel = demanda.responsavel_id === usuario.id;
  const outraParteId = ehResponsavel ? demanda.solicitante_id : demanda.responsavel_id;
  const outraParte = db.prepare('SELECT * FROM usuarios WHERE id=?').get(outraParteId);

  if (ehResponsavel) {
    await whatsappService.notificarAceite(outraParte, usuario, { ...demanda, data_acordada: dataAcordada });
  } else {
    await whatsappService.enviarMensagem(outraParte,
      `✅ *Prazo aceito!*\n\n${usuario.nome} aceitou o prazo de *${formatarData(dataAcordada)}*\n` +
      `"${demanda.descricao}"\n\n💬 Falar com ${usuario.nome.split(' ')[0]}: ${whatsappService.linkWhatsApp(usuario)}`
    );
  }

  // Pergunta sobre Google Calendar
  setSessao(telefone, {
    fluxo: 'aguardando_calendario',
    descricao: demanda.descricao,
    data: dataAcordada,
  });

  await whatsappService.enviarMensagem(usuario,
    `✅ *Aceito!*\n"${demanda.descricao}"\nPrazo: ${formatarData(dataAcordada)}\n\n` +
    `📅 Deseja adicionar ao *Google Agenda*?\n\n*1* — Sim, enviar link\n*2* — Não`
  );
  res.status(200).send('OK');
}

async function fluxoCalendario(usuario, texto, sessao, telefone, res) {
  clearSessao(telefone);

  if (texto === '1') {
    const link = gerarLinkCalendario(sessao.descricao, sessao.data);
    await whatsappService.enviarMensagem(usuario,
      `📅 *Adicionar ao Google Agenda:*\n\n${link}\n\n_Clique no link para abrir e salvar o evento._`
    );
  } else {
    await whatsappService.enviarMensagem(usuario, `👍 Ok! A demanda foi aceita.`);
  }
  res.status(200).send('OK');
}

async function handleNovoPrazoComData(usuario, demandaId, novaData, telefone, res) {
  const db = getDb();

  let demanda = demandaId ? db.prepare('SELECT * FROM demandas WHERE id=?').get(demandaId) : null;
  if (!demanda) {
    demanda = db.prepare(`SELECT * FROM demandas WHERE responsavel_id=? AND status IN ('pendente_aceite','em_negociacao') ORDER BY criado_em DESC LIMIT 1`).get(usuario.id);
  }
  if (!demanda) {
    demanda = db.prepare(`SELECT * FROM demandas WHERE solicitante_id=? AND status='em_negociacao' ORDER BY criado_em DESC LIMIT 1`).get(usuario.id);
  }

  if (!demanda || !novaData) {
    await whatsappService.enviarMensagem(usuario, 'Nenhuma demanda em negociação encontrada.');
    clearSessao(telefone);
    return res.status(200).send('OK');
  }

  db.prepare(`UPDATE demandas SET status='em_negociacao', data_acordada=?, atualizado_em=datetime('now') WHERE id=?`)
    .run(novaData, demanda.id);

  const ehResponsavel = demanda.responsavel_id === usuario.id;
  const outro = db.prepare('SELECT * FROM usuarios WHERE id=?').get(ehResponsavel ? demanda.solicitante_id : demanda.responsavel_id);

  await whatsappService.enviarMensagem(outro,
    `🔄 *Novo prazo proposto*\n\n${usuario.nome} propôs: *${formatarData(novaData)}*\nTarefa: "${demanda.descricao}"\n\n*1* — Aceitar\n*2* — Propor outro prazo`
  );
  await whatsappService.enviarMensagem(usuario, `📅 Novo prazo *${formatarData(novaData)}* proposto. Aguardando confirmação.`);
  clearSessao(telefone);
  res.status(200).send('OK');
}

async function handleConcluir(usuario, telefone, res) {
  const db = getDb();
  const demanda = db.prepare(`SELECT * FROM demandas WHERE responsavel_id=? AND status IN ('aceita','em_andamento') ORDER BY data_esperada ASC LIMIT 1`).get(usuario.id);

  if (!demanda) {
    await whatsappService.enviarMensagem(usuario, 'Nenhuma demanda em andamento encontrada.');
    return res.status(200).send('OK');
  }

  db.prepare(`UPDATE demandas SET status='concluida_aguardando_baixa', atualizado_em=datetime('now') WHERE id=?`).run(demanda.id);
  db.prepare('DELETE FROM lembretes WHERE demanda_id=? AND enviado=0').run(demanda.id);
  lembreteService.agendarLembretesAguardandoBaixa(demanda.id);

  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id=?').get(demanda.solicitante_id);
  await whatsappService.notificarConclusao(solicitante, usuario, demanda);
  await whatsappService.enviarMensagem(usuario, `✅ Marcado como concluído!\n"${demanda.descricao}"\nAguardando confirmação do solicitante.`);
  clearSessao(telefone);
  res.status(200).send('OK');
}

async function handleBaixa(usuario, telefone, res) {
  const db = getDb();
  const demanda = db.prepare(`SELECT * FROM demandas WHERE solicitante_id=? AND status='concluida_aguardando_baixa' ORDER BY atualizado_em DESC LIMIT 1`).get(usuario.id);

  if (!demanda) {
    await whatsappService.enviarMensagem(usuario, 'Nenhuma demanda aguardando sua confirmação.');
    return res.status(200).send('OK');
  }

  db.prepare(`UPDATE demandas SET status='finalizada', atualizado_em=datetime('now') WHERE id=?`).run(demanda.id);
  db.prepare('DELETE FROM lembretes WHERE demanda_id=? AND enviado=0').run(demanda.id);

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id=?').get(demanda.responsavel_id);
  await whatsappService.notificarBaixa(responsavel, usuario, demanda);
  await whatsappService.enviarMensagem(usuario, `✔️ Baixa confirmada!\n"${demanda.descricao}"\nDemanda finalizada!`);
  clearSessao(telefone);
  res.status(200).send('OK');
}

// ── Assistente IA ─────────────────────────────────────────────────────────────

async function handlePerguntaIA(usuario, texto, res) {
  // Entradas muito curtas ou que parecem comandos não reconhecidos
  if (texto.length <= 3) {
    await whatsappService.enviarMensagem(usuario, `Não entendi "*${texto}*". Digite *6* para ver os comandos ou faça uma pergunta sobre suas atividades.`);
    return res.status(200).send('OK');
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    await whatsappService.enviarMensagem(usuario, `Não entendi. Digite *6* para ver os comandos.`);
    return res.status(200).send('OK');
  }

  try {
    await whatsappService.enviarMensagem(usuario, `🤖 Consultando IA...`);
    const resposta = await iaService.responderPergunta(usuario, texto);
    await whatsappService.enviarMensagem(usuario, `🤖 *Assistente IA*\n\n${resposta}`);
  } catch (e) {
    console.error('[IA] Erro:', e.message);
    await whatsappService.enviarMensagem(usuario, `Não consegui processar sua pergunta. Tente novamente ou use os comandos numéricos.`);
  }
  res.status(200).send('OK');
}

// ── Utilitários ───────────────────────────────────────────────────────────────

function extrairData(texto, comando, parametros) {
  if (comando === COMANDOS.DATA || comando === COMANDOS.NOVO_PRAZO) return parametros?.data;
  return normalizarData(texto);
}

function statusEmoji(s) {
  return { pendente_aceite:'⏳', em_negociacao:'🔄', aceita:'✅', em_andamento:'🔨', concluida_aguardando_baixa:'🎉', finalizada:'✔️' }[s] || '•';
}

function formatarData(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

module.exports = router;
