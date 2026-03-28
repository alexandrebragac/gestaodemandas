require('dotenv').config();
const getDb = require('../database/db');

let twilioClient = null;

function getClient() {
  if (twilioClient) return twilioClient;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.warn('[WhatsApp] Twilio não configurado — mensagens simuladas no log.');
    return null;
  }
  const twilio = require('twilio');
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return twilioClient;
}

function formatPhone(telefone) {
  const numero = telefone.replace(/\D/g, '');
  return `whatsapp:+${numero}`;
}

function linkWhatsApp(usuario) {
  const numero = usuario.telefone_whatsapp.replace(/\D/g, '');
  return `https://wa.me/${numero}`;
}

// ── Menu dinâmico contextual ──────────────────────────────────────────────────
// Cache simples: evita query repetida no mesmo segundo
const _menuCache = new Map(); // userId → { menu, ts }
const MENU_TTL = 5000; // 5 segundos

function gerarMenuContextual(usuario) {
  if (!usuario || !usuario.id) return '';
  const cached = _menuCache.get(usuario.id);
  if (cached && Date.now() - cached.ts < MENU_TTL) return cached.menu;
  try {
    const db = getDb();
    const demandas = db.prepare(`
      SELECT status, responsavel_id, solicitante_id
      FROM demandas
      WHERE (responsavel_id = ? OR solicitante_id = ?)
        AND status NOT IN ('finalizada')
    `).all(usuario.id, usuario.id);

    const asResp = d => d.responsavel_id === usuario.id;
    const asSol  = d => d.solicitante_id === usuario.id;

    const pendenteAceite = demandas.filter(d => asResp(d) && d.status === 'pendente_aceite').length;
    const emAtividade    = demandas.filter(d => asResp(d) && ['aceita', 'em_andamento'].includes(d.status)).length;
    const negResp        = demandas.filter(d => asResp(d) && d.status === 'em_negociacao').length;
    const negSol         = demandas.filter(d => asSol(d) && d.status === 'em_negociacao').length;
    const aguardaBaixa   = demandas.filter(d => asSol(d) && d.status === 'concluida_aguardando_baixa').length;

    const urgentes = [];
    const acoes = [];
    const uteis = [];

    // ── Urgentes (topo) ──────────────────────────────────────────────────────
    if (pendenteAceite > 0 || negSol > 0) {
      const cnt = pendenteAceite + negSol;
      urgentes.push(`✅ *1* — Aceitar atividade _(${cnt})_`);
    } else if (negResp > 0) {
      urgentes.push(`✅ *1* — Aceitar prazo proposto`);
    }

    if (aguardaBaixa > 0) {
      urgentes.push(`🎉 *4* — Confirmar conclusão _(${aguardaBaixa})_`);
    }

    // ── Ações de andamento ───────────────────────────────────────────────────
    if (emAtividade > 0) {
      acoes.push(`✔️ *3* — Concluir atividade`);
    }

    if (pendenteAceite > 0 || emAtividade > 0) {
      acoes.push(`🚧 *9* — Reportar impedimento`);
    }

    if (pendenteAceite > 0 || emAtividade > 0 || negResp > 0) {
      acoes.push(`📅 *2* — Solicitar novo prazo`);
    }

    // ── Utilitários (sempre visíveis) ────────────────────────────────────────
    uteis.push(`📋 *5* — Ver minhas atividades`);
    uteis.push(`➕ *7* — Criar nova atividade`);
    uteis.push(`✏️ *8* — Editar atividade`);

    const linhas = [...urgentes, ...acoes, ...uteis];
    const menu = `\n─────────────────\n${linhas.join('\n')}`;
    _menuCache.set(usuario.id, { menu, ts: Date.now() });
    return menu;
  } catch (e) {
    console.error('[WhatsApp] Erro ao gerar menu:', e.message);
    return `\n─────────────────\n📋 *5* — Ver atividades\n➕ *7* — Criar atividade\n✏️ *8* — Editar`;
  }
}

// ── Envio de mensagem ─────────────────────────────────────────────────────────

async function enviarMensagem(destinatario, mensagem) {
  const from = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
  const to = formatPhone(destinatario.telefone_whatsapp);
  const client = getClient();

  // Anexa menu dinâmico se a mensagem não tiver seção de ações própria
  const menu = mensagem.includes('─────────────────') ? '' : gerarMenuContextual(destinatario);
  const corpo = mensagem + menu;

  if (!client) {
    console.log(`[WhatsApp SIMULADO] Para: ${to}\n${corpo}\n${'─'.repeat(50)}`);
    return;
  }

  try {
    const msg = await client.messages.create({ from, to, body: corpo });
    console.log(`[WhatsApp] Mensagem enviada para ${to}: ${msg.sid}`);
  } catch (err) {
    console.error(`[WhatsApp] Erro ao enviar para ${to}:`, err.message);
  }
}

// ── Notificações ──────────────────────────────────────────────────────────────

async function notificarNovaDeamanda(responsavel, solicitante, demanda) {
  const msg =
    `📋 *Nova Atividade Recebida*\n\n` +
    `De: ${solicitante.nome}\n` +
    `Tarefa: ${demanda.descricao}\n` +
    `Prazo: ${formatarDataHora(demanda.data_entrega, demanda.horario_entrega)}\n\n` +
    `💬 Falar com ${solicitante.nome.split(' ')[0]}: ${linkWhatsApp(solicitante)}\n` +
    `─────────────────\n` +
    `✅ *1* — Aceitar\n` +
    `📅 *2* — Solicitar novo prazo\n` +
    `🚧 *9* — Reportar impedimento`;
  await enviarMensagem(responsavel, msg);
}

async function notificarAceite(solicitante, responsavel, demanda) {
  const msg =
    `✅ *Atividade Aceita!*\n\n` +
    `${responsavel.nome} aceitou:\n` +
    `"${demanda.descricao}"\n` +
    `Prazo acordado: ${formatarData(demanda.data_acordada)}\n\n` +
    `💬 Falar com ${responsavel.nome.split(' ')[0]}: ${linkWhatsApp(responsavel)}`;
  await enviarMensagem(solicitante, msg);
}

async function notificarNovoPrazo(solicitante, responsavel, demanda, justificativa) {
  const motivo = justificativa ? `\nMotivo: _${justificativa}_` : '';
  const msg =
    `🔄 *Novo Prazo Solicitado*\n\n` +
    `${responsavel.nome} propôs: *${formatarData(demanda.nova_data)}*\n` +
    `Tarefa: "${demanda.descricao}"${motivo}\n\n` +
    `💬 Falar com ${responsavel.nome.split(' ')[0]}: ${linkWhatsApp(responsavel)}\n` +
    `─────────────────\n` +
    `✅ *1* — Aceitar novo prazo\n` +
    `📅 *2* — Propor outro prazo`;
  await enviarMensagem(solicitante, msg);
}

async function notificarConclusao(solicitante, responsavel, demanda) {
  const msg =
    `🎉 *Atividade Concluída!*\n\n` +
    `${responsavel.nome} concluiu:\n` +
    `"${demanda.descricao}"\n\n` +
    `💬 Falar com ${responsavel.nome.split(' ')[0]}: ${linkWhatsApp(responsavel)}\n` +
    `─────────────────\n` +
    `🎉 *4* — Confirmar conclusão`;
  await enviarMensagem(solicitante, msg);
}

async function notificarBaixa(responsavel, solicitante, demanda) {
  const msg =
    `✔️ *Baixa Confirmada!*\n\n` +
    `${solicitante.nome} confirmou a conclusão de:\n` +
    `"${demanda.descricao}"\n\n` +
    `Atividade finalizada com sucesso! 🎯`;
  await enviarMensagem(responsavel, msg);
}

async function notificarImpedimento(solicitante, responsavel, demanda, descricao) {
  const msg =
    `🚧 *Impedimento Reportado*\n\n` +
    `${responsavel.nome} reportou um bloqueio em:\n` +
    `"${demanda.descricao}"\n\n` +
    `Motivo: _${descricao}_\n\n` +
    `💬 Falar com ${responsavel.nome.split(' ')[0]}: ${linkWhatsApp(responsavel)}\n` +
    `─────────────────\n` +
    `📅 *2* — Propor novo prazo\n` +
    `➕ *7* — Criar nova atividade`;
  await enviarMensagem(solicitante, msg);
}

async function enviarLembrete(destinatario, demanda, tipoLembrete, solicitante = null) {
  const prazo = formatarDataHora(demanda.data_acordada || demanda.data_entrega, demanda.horario_entrega);

  const linkSolicitante = solicitante
    ? `\n💬 Falar com ${solicitante.nome.split(' ')[0]}: ${linkWhatsApp(solicitante)}`
    : '';

  const opcoesPrazo =
    `─────────────────\n` +
    `✔️ *3* — Concluir atividade\n` +
    `📅 *2* — Solicitar novo prazo\n` +
    `🚧 *9* — Reportar impedimento`;

  const mensagens = {
    antes_vencimento_3:
      `⏰ *Lembrete: 3 dias para o prazo*\n\n` +
      `"${demanda.descricao}"\n` +
      `Prazo: ${prazo}${linkSolicitante}\n\n` + opcoesPrazo,

    antes_vencimento_1:
      `⚠️ *Atenção: amanhã é o prazo!*\n\n` +
      `"${demanda.descricao}"\n` +
      `Prazo: ${prazo}${linkSolicitante}\n\n` + opcoesPrazo,

    no_vencimento:
      `🔴 *HOJE é o prazo!*\n\n` +
      `"${demanda.descricao}"${linkSolicitante}\n\n` + opcoesPrazo,

    apos_vencimento:
      `❗ *Prazo vencido!*\n\n` +
      `"${demanda.descricao}"\n` +
      `Prazo era: ${prazo}${linkSolicitante}\n\n` + opcoesPrazo,

    pendente_aceite:
      `⏰ *Atividade aguardando sua resposta*\n\n` +
      `"${demanda.descricao}"\n` +
      `Prazo: ${prazo}${linkSolicitante}\n\n` +
      `─────────────────\n` +
      `✅ *1* — Aceitar\n` +
      `📅 *2* — Solicitar novo prazo\n` +
      `🚧 *9* — Reportar impedimento`,

    aguardando_baixa:
      `⏳ *Aguardando sua confirmação*\n\n` +
      `"${demanda.descricao}" foi concluída.\n\n` +
      `─────────────────\n` +
      `🎉 *4* — Confirmar conclusão`,
  };

  await enviarMensagem(destinatario, mensagens[tipoLembrete] || `Lembrete: "${demanda.descricao}"`);
}

// ── Relatório diário ──────────────────────────────────────────────────────────

async function enviarRelatorioDiario(usuario, { vencidas, vencem_hoje, vencem_em_3_dias, total_ativas }) {
  const hoje = formatarData(new Date().toISOString().slice(0, 10));
  let msg = `📊 *Relatório Diário — ${hoje}*\n\nOlá, ${usuario.nome.split(' ')[0]}!\n\n`;

  if (total_ativas === 0) {
    msg += `✅ Nenhuma atividade ativa. Ótimo trabalho!`;
  } else {
    msg += `Você tem *${total_ativas}* atividade(s) ativa(s):\n\n`;

    if (vencidas.length > 0) {
      msg += `🔴 *Vencidas (${vencidas.length}):*\n`;
      for (const d of vencidas) msg += `• ${d.descricao.substring(0, 40)} — ${formatarDataHora(d.data_acordada || d.data_entrega, d.horario_entrega)}\n`;
      msg += '\n';
    }
    if (vencem_hoje.length > 0) {
      msg += `🟡 *Vencem hoje (${vencem_hoje.length}):*\n`;
      for (const d of vencem_hoje) msg += `• ${d.descricao.substring(0, 40)}\n`;
      msg += '\n';
    }
    if (vencem_em_3_dias.length > 0) {
      msg += `🟠 *Vencem em até 3 dias (${vencem_em_3_dias.length}):*\n`;
      for (const d of vencem_em_3_dias) msg += `• ${d.descricao.substring(0, 40)} — ${formatarDataHora(d.data_acordada || d.data_entrega, d.horario_entrega)}\n`;
      msg += '\n';
    }
  }

  await enviarMensagem(usuario, msg);
}

// ── Utilitários ───────────────────────────────────────────────────────────────

function formatarData(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function formatarDataHora(dataIso, horario) {
  if (!dataIso) return '—';
  const [y, m, d] = dataIso.slice(0, 10).split('-');
  return horario ? `${d}/${m}/${y} às ${horario}` : `${d}/${m}/${y}`;
}

module.exports = {
  enviarMensagem,
  notificarNovaDeamanda,
  notificarAceite,
  notificarNovoPrazo,
  notificarConclusao,
  notificarBaixa,
  notificarImpedimento,
  enviarLembrete,
  enviarRelatorioDiario,
  linkWhatsApp,
};
