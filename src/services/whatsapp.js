require('dotenv').config();

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

// Gera link wa.me para abrir conversa com o usuário
function linkWhatsApp(usuario) {
  const numero = usuario.telefone_whatsapp.replace(/\D/g, '');
  return `https://wa.me/${numero}`;
}

// Menu completo de opções (substitui "ajuda")
const MENU_COMPLETO =
  `\n─────────────────\n` +
  `*O que posso fazer:*\n` +
  `*1* — Aceitar demanda/prazo\n` +
  `*2* — Propor novo prazo\n` +
  `*3* — Marcar como concluído\n` +
  `*4* — Dar baixa (confirmar conclusão)\n` +
  `*5* — Ver minhas demandas\n` +
  `*7* — Criar nova demanda\n` +
  `*8* — Editar demanda`;

async function enviarMensagem(destinatario, mensagem) {
  const from = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
  const to = formatPhone(destinatario.telefone_whatsapp);
  const client = getClient();

  // Sempre exibe o menu completo no final, evitando duplicatas
  const corpo = mensagem.includes('*O que posso fazer:*')
    ? mensagem
    : mensagem + MENU_COMPLETO;

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
    `📋 *Nova Demanda Recebida*\n\n` +
    `De: ${solicitante.nome}\n` +
    `Tarefa: ${demanda.descricao}\n` +
    `Prazo: ${formatarData(demanda.data_esperada)}\n\n` +
    `💬 Falar com ${solicitante.nome.split(' ')[0]}: ${linkWhatsApp(solicitante)}\n` +
    `─────────────────\n` +
    `*Responda com:*\n` +
    `*1* — Aceitar\n` +
    `*2* — Propor novo prazo`;
  await enviarMensagem(responsavel, msg);
}

async function notificarAceite(solicitante, responsavel, demanda) {
  const msg =
    `✅ *Demanda Aceita!*\n\n` +
    `${responsavel.nome} aceitou:\n` +
    `"${demanda.descricao}"\n` +
    `Prazo acordado: ${formatarData(demanda.data_acordada)}\n\n` +
    `💬 Falar com ${responsavel.nome.split(' ')[0]}: ${linkWhatsApp(responsavel)}`;
  await enviarMensagem(solicitante, msg);
}

async function notificarNovoPrazo(solicitante, responsavel, demanda) {
  const msg =
    `🔄 *Novo Prazo Proposto*\n\n` +
    `${responsavel.nome} sugeriu:\n` +
    `"${demanda.descricao}"\n` +
    `Novo prazo: *${formatarData(demanda.nova_data)}*` +
    (demanda.observacao ? `\nObs: ${demanda.observacao}` : '') + `\n\n` +
    `💬 Falar com ${responsavel.nome.split(' ')[0]}: ${linkWhatsApp(responsavel)}\n` +
    `─────────────────\n` +
    `*Responda com:*\n` +
    `*1* — Aceitar o novo prazo\n` +
    `*2* — Propor outro prazo`;
  await enviarMensagem(solicitante, msg);
}

async function notificarConclusao(solicitante, responsavel, demanda) {
  const msg =
    `🎉 *Tarefa Concluída!*\n\n` +
    `${responsavel.nome} concluiu:\n` +
    `"${demanda.descricao}"\n\n` +
    `💬 Falar com ${responsavel.nome.split(' ')[0]}: ${linkWhatsApp(responsavel)}\n` +
    `─────────────────\n` +
    `*Responda com:*\n` +
    `*4* — Confirmar e dar baixa`;
  await enviarMensagem(solicitante, msg);
}

async function notificarBaixa(responsavel, solicitante, demanda) {
  const msg =
    `✔️ *Baixa Confirmada!*\n\n` +
    `${solicitante.nome} confirmou a conclusão de:\n` +
    `"${demanda.descricao}"\n\n` +
    `Demanda finalizada com sucesso!`;
  await enviarMensagem(responsavel, msg);
}

async function enviarLembrete(destinatario, demanda, tipoLembrete, solicitante = null) {
  const prazo = formatarData(demanda.data_acordada || demanda.data_esperada);

  const linkSolicitante = solicitante
    ? `\n💬 Falar com ${solicitante.nome.split(' ')[0]}: ${linkWhatsApp(solicitante)}`
    : '';

  const opcoesPrazo =
    `─────────────────\n` +
    `*Responda com:*\n` +
    `*3* — Marcar como concluído\n` +
    `*2* — Propor novo prazo`;

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

    aguardando_baixa:
      `⏳ *Aguardando sua confirmação*\n\n` +
      `"${demanda.descricao}" foi concluída.\n\n` +
      `─────────────────\n` +
      `*Responda com:*\n` +
      `*4* — Confirmar e dar baixa`,
  };

  await enviarMensagem(destinatario, mensagens[tipoLembrete] || `Lembrete: "${demanda.descricao}"`);
}

// ── Relatório diário ──────────────────────────────────────────────────────────

async function enviarRelatorioDiario(usuario, { vencidas, vencem_hoje, vencem_em_3_dias, total_ativas }) {
  const hoje = formatarData(new Date().toISOString().slice(0, 10));
  let msg = `📊 *Relatório Diário — ${hoje}*\n\nOlá, ${usuario.nome.split(' ')[0]}!\n\n`;

  if (total_ativas === 0) {
    msg += `✅ Nenhuma demanda ativa. Ótimo trabalho!`;
  } else {
    msg += `Você tem *${total_ativas}* demanda(s) ativa(s):\n\n`;

    if (vencidas.length > 0) {
      msg += `🔴 *Vencidas (${vencidas.length}):*\n`;
      for (const d of vencidas) msg += `• ${d.descricao.substring(0, 40)} — ${formatarData(d.data_acordada || d.data_esperada)}\n`;
      msg += '\n';
    }
    if (vencem_hoje.length > 0) {
      msg += `🟡 *Vencem hoje (${vencem_hoje.length}):*\n`;
      for (const d of vencem_hoje) msg += `• ${d.descricao.substring(0, 40)}\n`;
      msg += '\n';
    }
    if (vencem_em_3_dias.length > 0) {
      msg += `🟠 *Vencem em até 3 dias (${vencem_em_3_dias.length}):*\n`;
      for (const d of vencem_em_3_dias) msg += `• ${d.descricao.substring(0, 40)} — ${formatarData(d.data_acordada || d.data_esperada)}\n`;
      msg += '\n';
    }
  }

  await enviarMensagem(usuario, msg);
}

// ── Utilitário ────────────────────────────────────────────────────────────────

function formatarData(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

module.exports = {
  enviarMensagem,
  notificarNovaDeamanda,
  notificarAceite,
  notificarNovoPrazo,
  notificarConclusao,
  notificarBaixa,
  enviarLembrete,
  enviarRelatorioDiario,
  linkWhatsApp,
};
