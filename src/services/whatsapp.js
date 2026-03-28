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

async function enviarMensagem(destinatario, mensagem) {
  const from = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
  const to = formatPhone(destinatario.telefone_whatsapp);
  const client = getClient();

  if (!client) {
    console.log(`[WhatsApp SIMULADO] Para: ${to}\n${mensagem}\n${'─'.repeat(50)}`);
    return;
  }

  try {
    const msg = await client.messages.create({ from, to, body: mensagem });
    console.log(`[WhatsApp] Mensagem enviada para ${to}: ${msg.sid}`);
  } catch (err) {
    console.error(`[WhatsApp] Erro ao enviar para ${to}:`, err.message);
  }
}

// ── Notificações ─────────────────────────────────────────────────────────────

async function notificarNovaDeamanda(responsavel, solicitante, demanda) {
  const msg =
    `📋 *Nova Demanda Recebida*\n\n` +
    `De: ${solicitante.nome}\n` +
    `Tarefa: ${demanda.descricao}\n` +
    `Prazo: ${formatarData(demanda.data_esperada)}\n\n` +
    `Responda com:\n` +
    `*1* — Aceitar\n` +
    `*2* — Propor novo prazo\n` +
    `*6* — Ajuda`;
  await enviarMensagem(responsavel, msg);
}

async function notificarAceite(solicitante, responsavel, demanda) {
  const msg =
    `✅ *Demanda Aceita!*\n\n` +
    `${responsavel.nome} aceitou:\n` +
    `"${demanda.descricao}"\n\n` +
    `Prazo acordado: ${formatarData(demanda.data_acordada)}`;
  await enviarMensagem(solicitante, msg);
}

async function notificarNovoPrazo(solicitante, responsavel, demanda) {
  const msg =
    `🔄 *Novo Prazo Proposto*\n\n` +
    `${responsavel.nome} sugeriu novo prazo para:\n` +
    `"${demanda.descricao}"\n\n` +
    `Novo prazo: ${formatarData(demanda.nova_data)}` +
    (demanda.observacao ? `\nObs: ${demanda.observacao}` : '') +
    `\n\nResponda com:\n` +
    `*1* — Aceitar o novo prazo\n` +
    `*2* — Propor outro prazo`;
  await enviarMensagem(solicitante, msg);
}

async function notificarConclusao(solicitante, responsavel, demanda) {
  const msg =
    `🎉 *Tarefa Concluída!*\n\n` +
    `${responsavel.nome} concluiu:\n` +
    `"${demanda.descricao}"\n\n` +
    `Responda com:\n` +
    `*1* — Confirmar e dar baixa`;
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

async function enviarLembrete(destinatario, demanda, tipoLembrete) {
  const prazo = formatarData(demanda.data_acordada || demanda.data_esperada);
  const mensagens = {
    antes_vencimento_3:
      `⏰ *Lembrete: 3 dias para o prazo*\n\n` +
      `"${demanda.descricao}"\n` +
      `Prazo: ${prazo}\n\n` +
      `*3* — Marcar como concluído\n` +
      `*2* — Propor novo prazo`,
    antes_vencimento_1:
      `⚠️ *Atenção: amanhã é o prazo!*\n\n` +
      `"${demanda.descricao}"\n` +
      `Prazo: ${prazo}\n\n` +
      `*3* — Marcar como concluído\n` +
      `*2* — Propor novo prazo`,
    no_vencimento:
      `🔴 *HOJE é o prazo!*\n\n` +
      `"${demanda.descricao}"\n\n` +
      `*3* — Marcar como concluído\n` +
      `*2* — Propor novo prazo`,
    apos_vencimento:
      `❗ *Prazo vencido!*\n\n` +
      `"${demanda.descricao}"\n` +
      `Prazo era: ${prazo}\n\n` +
      `*3* — Marcar como concluído\n` +
      `*2* — Propor novo prazo`,
    aguardando_baixa:
      `⏳ *Aguardando sua confirmação*\n\n` +
      `"${demanda.descricao}" foi concluída.\n\n` +
      `*1* — Confirmar e dar baixa`,
  };

  const msg = mensagens[tipoLembrete] || `Lembrete sobre: "${demanda.descricao}"`;
  await enviarMensagem(destinatario, msg);
}

// ── Relatório diário ─────────────────────────────────────────────────────────

async function enviarRelatorioDiario(usuario, { vencidas, vencem_hoje, vencem_em_3_dias, total_ativas }) {
  const hoje = formatarData(new Date().toISOString().slice(0, 10));
  let msg = `📊 *Relatório Diário — ${hoje}*\n\nOlá, ${usuario.nome.split(' ')[0]}!\n\n`;

  if (total_ativas === 0) {
    msg += `✅ Nenhuma demanda ativa no momento. Ótimo trabalho!`;
  } else {
    msg += `Você tem *${total_ativas}* demanda(s) ativa(s):\n\n`;

    if (vencidas.length > 0) {
      msg += `🔴 *Vencidas (${vencidas.length}):*\n`;
      for (const d of vencidas) {
        msg += `• ${d.descricao.substring(0, 40)} — ${formatarData(d.data_acordada || d.data_esperada)}\n`;
      }
      msg += '\n';
    }

    if (vencem_hoje.length > 0) {
      msg += `🟡 *Vencem hoje (${vencem_hoje.length}):*\n`;
      for (const d of vencem_hoje) {
        msg += `• ${d.descricao.substring(0, 40)}\n`;
      }
      msg += '\n';
    }

    if (vencem_em_3_dias.length > 0) {
      msg += `🟠 *Vencem em até 3 dias (${vencem_em_3_dias.length}):*\n`;
      for (const d of vencem_em_3_dias) {
        msg += `• ${d.descricao.substring(0, 40)} — ${formatarData(d.data_acordada || d.data_esperada)}\n`;
      }
      msg += '\n';
    }

    msg += `Digite *5* para ver todas as demandas.`;
  }

  await enviarMensagem(usuario, msg);
}

// ── Utilitário ───────────────────────────────────────────────────────────────

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
};
