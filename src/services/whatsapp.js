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
  // Garante formato whatsapp:+5511999...
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

async function notificarNovaDeamanda(responsavel, solicitante, demanda) {
  const msg =
    `📋 *Nova Demanda Recebida*\n\n` +
    `Solicitante: ${solicitante.nome}\n` +
    `Descrição: ${demanda.descricao}\n` +
    `Prazo esperado: ${demanda.data_esperada}\n\n` +
    `Responda com:\n` +
    `• *aceito* — aceitar com o prazo proposto\n` +
    `• *novo prazo: DD/MM/AAAA* — sugerir outro prazo\n` +
    `• *ajuda* — ver todos os comandos`;
  await enviarMensagem(responsavel, msg);
}

async function notificarAceite(solicitante, responsavel, demanda) {
  const msg =
    `✅ *Demanda Aceita*\n\n` +
    `${responsavel.nome} aceitou sua demanda:\n` +
    `"${demanda.descricao}"\n\n` +
    `Prazo acordado: ${demanda.data_acordada}`;
  await enviarMensagem(solicitante, msg);
}

async function notificarNovoPrazo(solicitante, responsavel, demanda) {
  const msg =
    `🔄 *Novo Prazo Proposto*\n\n` +
    `${responsavel.nome} sugeriu um novo prazo para:\n` +
    `"${demanda.descricao}"\n\n` +
    `Novo prazo: ${demanda.nova_data}` +
    (demanda.observacao ? `\nObs: ${demanda.observacao}` : '') +
    `\n\nResponda com:\n` +
    `• *aceito* — aceitar o novo prazo\n` +
    `• *novo prazo: DD/MM/AAAA* — contra-propor`;
  await enviarMensagem(solicitante, msg);
}

async function notificarConclusao(solicitante, responsavel, demanda) {
  const msg =
    `🎉 *Demanda Concluída*\n\n` +
    `${responsavel.nome} marcou como concluída:\n` +
    `"${demanda.descricao}"\n\n` +
    `Para finalizar, responda com:\n` +
    `• *baixa* ou *confirmo* — confirmar conclusão`;
  await enviarMensagem(solicitante, msg);
}

async function notificarBaixa(responsavel, solicitante, demanda) {
  const msg =
    `✔️ *Baixa Confirmada*\n\n` +
    `${solicitante.nome} confirmou a conclusão de:\n` +
    `"${demanda.descricao}"\n\n` +
    `Demanda finalizada com sucesso!`;
  await enviarMensagem(responsavel, msg);
}

async function enviarLembrete(destinatario, demanda, tipoLembrete) {
  const mensagens = {
    antes_vencimento_3: `⏰ *Lembrete: 3 dias para o prazo*\n\n"${demanda.descricao}"\nPrazo: ${demanda.data_acordada || demanda.data_esperada}\n\nResponda *status* para ver suas demandas.`,
    antes_vencimento_1: `⚠️ *Lembrete: 1 dia para o prazo*\n\n"${demanda.descricao}"\nPrazo: ${demanda.data_acordada || demanda.data_esperada}\n\nResponda *concluído* quando finalizar.`,
    no_vencimento: `🔴 *HOJE é o prazo!*\n\n"${demanda.descricao}"\n\nResponda *concluído* quando finalizar ou *novo prazo: DD/MM/AAAA* para renegociar.`,
    apos_vencimento: `❗ *Prazo vencido*\n\n"${demanda.descricao}"\nPrazo era: ${demanda.data_acordada || demanda.data_esperada}\n\nResponda *concluído* quando finalizar.`,
    aguardando_baixa: `⏳ *Aguardando sua confirmação*\n\n"${demanda.descricao}" foi marcada como concluída.\n\nResponda *baixa* ou *confirmo* para finalizar.`,
  };

  const msg = mensagens[tipoLembrete] || `Lembrete sobre: "${demanda.descricao}"`;
  await enviarMensagem(destinatario, msg);
}

module.exports = {
  enviarMensagem,
  notificarNovaDeamanda,
  notificarAceite,
  notificarNovoPrazo,
  notificarConclusao,
  notificarBaixa,
  enviarLembrete,
};
