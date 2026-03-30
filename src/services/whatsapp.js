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

function primeiroNome(nome) {
  return (nome || '').split(' ')[0];
}

// ── Menu dinâmico (apenas para respostas do bot, não notificações) ────────────
const _menuCache = new Map();
const MENU_TTL = 5000;

function gerarMenuContextual(usuario) {
  if (!usuario?.id) return '';
  const cached = _menuCache.get(usuario.id);
  if (cached && Date.now() - cached.ts < MENU_TTL) return cached.menu;
  try {
    const db = getDb();
    const demandas = db.prepare(`
      SELECT status, responsavel_id, solicitante_id FROM demandas
      WHERE (responsavel_id = ? OR solicitante_id = ?) AND status NOT IN ('finalizada')
    `).all(usuario.id, usuario.id);

    const asResp = d => d.responsavel_id === usuario.id;
    const asSol  = d => d.solicitante_id === usuario.id;
    const pendenteAceite = demandas.filter(d => asResp(d) && d.status === 'pendente_aceite').length;
    const emAtividade    = demandas.filter(d => asResp(d) && ['aceita', 'em_andamento'].includes(d.status)).length;
    const aguardaBaixa   = demandas.filter(d => asSol(d)  && d.status === 'concluida_aguardando_baixa').length;

    const linhas = [];
    if (pendenteAceite > 0) linhas.push(`✅ *1* — Aceitar atividade _(${pendenteAceite})_`);
    if (aguardaBaixa > 0)   linhas.push(`🎉 *2* — Confirmar conclusão _(${aguardaBaixa})_`);
    if (emAtividade > 0)    linhas.push(`✔️ *3* — Concluir atividade`);
    linhas.push(`📋 *4* — Ver minhas atividades`);
    linhas.push(`➕ *5* — Criar nova atividade`);

    const menu = `\n─────────────────\n${linhas.join('\n')}`;
    _menuCache.set(usuario.id, { menu, ts: Date.now() });
    return menu;
  } catch (e) {
    return `\n─────────────────\n📋 *4* — Ver atividades\n➕ *5* — Criar atividade`;
  }
}

// ── Envio ─────────────────────────────────────────────────────────────────────

async function enviarMensagem(destinatario, mensagem, { comMenu = false } = {}) {
  const from = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
  const to = formatPhone(destinatario.telefone_whatsapp);
  const client = getClient();

  const menu = comMenu ? gerarMenuContextual(destinatario) : '';
  const corpo = mensagem + menu;

  if (!client) {
    console.log(`[WhatsApp SIMULADO] Para: ${to}\n${corpo}\n${'─'.repeat(40)}`);
    return;
  }
  try {
    const msg = await client.messages.create({ from, to, body: corpo });
    console.log(`[WhatsApp] Mensagem enviada para ${to}: ${msg.sid}`);
  } catch (err) {
    console.error(`[WhatsApp] Erro ao enviar para ${to}:`, err.message);
    throw err;
  }
}

// ── Notificações ──────────────────────────────────────────────────────────────

async function notificarNovaDeamanda(responsavel, solicitante, demanda) {
  const prazo = formatarDataHora(demanda.data_entrega, demanda.horario_entrega);
  const msg =
    `📋 *Nova atividade para você*\n\n` +
    `"${demanda.descricao}"\n\n` +
    `📅 Prazo: ${prazo}\n` +
    `👤 De: ${solicitante.nome}`;
  await enviarMensagem(responsavel, msg, { comMenu: true });
}

async function notificarAceite(solicitante, responsavel, demanda) {
  const msg =
    `✅ *${primeiroNome(responsavel.nome)} aceitou sua atividade*\n\n` +
    `"${demanda.descricao}"\n\n` +
    `📅 Prazo acordado: ${formatarData(demanda.data_acordada)}`;
  await enviarMensagem(solicitante, msg);
}

async function notificarConclusao(solicitante, responsavel, demanda) {
  const msg =
    `🎉 *${primeiroNome(responsavel.nome)} concluiu a atividade*\n\n` +
    `"${demanda.descricao}"\n\n` +
    `Acesse o sistema para confirmar a baixa.`;
  await enviarMensagem(solicitante, msg, { comMenu: true });
}

async function notificarBaixa(responsavel, solicitante, demanda) {
  const msg =
    `✔️ *Atividade finalizada!*\n\n` +
    `"${demanda.descricao}"\n\n` +
    `Baixa confirmada por ${primeiroNome(solicitante.nome)}.`;
  await enviarMensagem(responsavel, msg);
}

async function notificarExclusao(destinatario, autor, demanda) {
  const msg =
    `🗑️ *Atividade cancelada*\n\n` +
    `"${demanda.descricao}"\n\n` +
    `Cancelada por: ${autor.nome}`;
  await enviarMensagem(destinatario, msg);
}

async function notificarNovoPrazo(solicitante, responsavel, demanda, justificativa) {
  const motivo = justificativa ? `\nMotivo: _${justificativa}_` : '';
  const msg =
    `📅 *${primeiroNome(responsavel.nome)} propôs novo prazo*\n\n` +
    `"${demanda.descricao}"\n` +
    `Novo prazo: *${formatarData(demanda.nova_data)}*${motivo}\n\n` +
    `Acesse o sistema para aceitar ou negociar.`;
  await enviarMensagem(solicitante, msg);
}

async function notificarImpedimento(solicitante, responsavel, demanda, descricao) {
  const msg =
    `🚧 *${primeiroNome(responsavel.nome)} reportou um impedimento*\n\n` +
    `"${demanda.descricao}"\n\n` +
    `Motivo: _${descricao}_`;
  await enviarMensagem(solicitante, msg);
}

async function enviarLembrete(destinatario, demanda, tipoLembrete) {
  const prazo = formatarDataHora(demanda.data_acordada || demanda.data_entrega, demanda.horario_entrega);

  const textos = {
    antes_vencimento_3: `⏰ *Lembrete: prazo em 3 dias*\n\n"${demanda.descricao}"\n📅 ${prazo}`,
    antes_vencimento_1: `⚠️ *Atenção: prazo amanhã!*\n\n"${demanda.descricao}"\n📅 ${prazo}`,
    no_vencimento:      `🔴 *Prazo hoje!*\n\n"${demanda.descricao}"`,
    apos_vencimento:    `❗ *Prazo vencido*\n\n"${demanda.descricao}"\nPrazo era: ${prazo}`,
    pendente_aceite:    `⏰ *Aguardando seu aceite*\n\n"${demanda.descricao}"\n📅 ${prazo}`,
    aguardando_baixa:   `⏳ *Aguardando sua confirmação de baixa*\n\n"${demanda.descricao}"`,
  };

  const msg = textos[tipoLembrete] || `Lembrete: "${demanda.descricao}"`;
  await enviarMensagem(destinatario, msg, { comMenu: true });
}

async function enviarRelatorioDiario(usuario, { vencidas, vencem_hoje, vencem_em_3_dias, total_ativas }) {
  const hoje = formatarData(new Date().toISOString().slice(0, 10));
  let msg = `📊 *Relatório — ${hoje}*\nOlá, ${primeiroNome(usuario.nome)}!\n\n`;

  if (total_ativas === 0) {
    msg += `✅ Nenhuma atividade ativa.`;
  } else {
    msg += `*${total_ativas}* atividade(s) ativa(s)\n`;
    if (vencidas.length)        msg += `\n🔴 Vencidas: ${vencidas.length}\n`        + vencidas.map(d => `• ${d.descricao.slice(0,45)}`).join('\n');
    if (vencem_hoje.length)     msg += `\n🟡 Vencem hoje: ${vencem_hoje.length}\n`  + vencem_hoje.map(d => `• ${d.descricao.slice(0,45)}`).join('\n');
    if (vencem_em_3_dias.length) msg += `\n🟠 Próximos 3 dias: ${vencem_em_3_dias.length}\n` + vencem_em_3_dias.map(d => `• ${d.descricao.slice(0,45)}`).join('\n');
  }

  await enviarMensagem(usuario, msg);
}

module.exports = {
  enviarMensagem,
  notificarNovaDeamanda,
  notificarAceite,
  notificarNovoPrazo,
  notificarConclusao,
  notificarBaixa,
  notificarExclusao,
  notificarImpedimento,
  enviarLembrete,
  enviarRelatorioDiario,
  linkWhatsApp,
  gerarMenuContextual,
};
