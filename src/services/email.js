/**
 * Serviço de notificações por email.
 * Usa Resend (API HTTP) se RESEND_API_KEY estiver definido,
 * caso contrário usa nodemailer SMTP (para desenvolvimento local).
 */

const nodemailer = require('nodemailer');
const crypto = require('crypto');

let _transport = null;
let _resend = null;

function getResend() {
  if (_resend) return _resend;
  if (!process.env.RESEND_API_KEY) return null;
  const { Resend } = require('resend');
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

function getTransport() {
  if (_transport) return _transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('[Email] SMTP não configurado — emails simulados no log.');
    return null;
  }
  _transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return _transport;
}

function fromAddr() {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@gestaodemandas.local';
}

function appBaseUrl() {
  return process.env.APP_URL || 'http://localhost:3000';
}

// Gera token HMAC para links de ação por email (evita spam)
function gerarTokenAcao(demandaId, acao) {
  const secret = process.env.JWT_SECRET || 'gestao-secret';
  return crypto.createHmac('sha256', secret).update(`${demandaId}:${acao}`).digest('hex').slice(0, 32);
}

function linkAcao(demandaId, acao) {
  const token = gerarTokenAcao(demandaId, acao);
  return `${appBaseUrl()}/api/email-acao/${demandaId}/${acao}?token=${token}`;
}

function verificarTokenAcao(demandaId, acao, token) {
  return token === gerarTokenAcao(demandaId, acao);
}

// ── Templates HTML ────────────────────────────────────────────────────────────

function layout(titulo, conteudo) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><style>
  body{font-family:Inter,Arial,sans-serif;background:#13131f;color:#e2e2ee;margin:0;padding:20px}
  .card{background:#1e1e2e;border:1px solid #3a3a52;border-radius:12px;max-width:540px;margin:0 auto;padding:28px 32px}
  h2{color:#7c5cfc;margin:0 0 16px;font-size:1.1rem}
  .field{margin:8px 0;font-size:.9rem}
  .field strong{color:#e2e2ee}
  .field span{color:#8888aa}
  .btn{display:inline-block;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.9rem;margin:6px 4px 0 0}
  .btn-green{background:#00c875;color:#000}
  .btn-red{background:#ff5b5b;color:#fff}
  .btn-blue{background:#4d9eff;color:#fff}
  .btn-purple{background:#7c5cfc;color:#fff}
  .footer{margin-top:20px;font-size:.75rem;color:#555;border-top:1px solid #2d2d42;padding-top:14px}
</style></head>
<body><div class="card">
  <div style="font-size:.75rem;color:#8888aa;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em">📋 Gestão de Demandas</div>
  <h2>${titulo}</h2>
  ${conteudo}
  <div class="footer">Esta mensagem foi enviada automaticamente. <a href="${appBaseUrl()}" style="color:#7c5cfc">Abrir sistema</a></div>
</div></body></html>`;
}

function campo(label, valor) {
  return `<div class="field"><strong>${label}:</strong> <span>${valor || '—'}</span></div>`;
}

function formatarData(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// ── Envio ─────────────────────────────────────────────────────────────────────

async function enviarEmail(destinatario, assunto, html) {
  const to = destinatario.email;
  if (!to) return;

  // Prioriza Resend (API HTTP) — funciona em qualquer servidor
  const resend = getResend();
  if (resend) {
    try {
      const { error } = await resend.emails.send({ from: fromAddr(), to, subject: assunto, html });
      if (error) throw new Error(error.message);
      console.log(`[Email] Enviado via Resend para ${to}`);
    } catch (err) {
      console.error(`[Email] Erro Resend para ${to}:`, err.message);
    }
    return;
  }

  // Fallback: SMTP (desenvolvimento local)
  const transport = getTransport();
  if (!transport) {
    console.log(`[Email SIMULADO] Para: ${to} | Assunto: ${assunto}`);
    return;
  }
  try {
    const info = await transport.sendMail({ from: fromAddr(), to, subject: assunto, html });
    console.log(`[Email] Enviado via SMTP para ${to}: ${info.messageId}`);
  } catch (err) {
    console.error(`[Email] Erro ao enviar para ${to}:`, err.message);
  }
}

// ── Notificações (espelham whatsapp.js) ──────────────────────────────────────

async function notificarNovaDemanda(responsavel, solicitante, demanda) {
  const html = layout('📋 Nova Atividade Recebida', `
    ${campo('De', solicitante.nome)}
    ${campo('Tarefa', demanda.descricao)}
    ${campo('Prazo', `${formatarData(demanda.data_entrega)}${demanda.horario_entrega ? ` às ${demanda.horario_entrega}` : ''}`)}
    <div style="margin-top:18px">
      <a href="${linkAcao(demanda.id, 'aceitar')}" class="btn btn-green">✅ Aceitar</a>
      <a href="${linkAcao(demanda.id, 'pedir-prazo')}" class="btn btn-blue">📅 Pedir novo prazo</a>
      <a href="${appBaseUrl()}" class="btn btn-purple">🖥️ Abrir sistema</a>
    </div>
  `);
  await enviarEmail(responsavel, `📋 Nova atividade: ${demanda.descricao.slice(0, 60)}`, html);
}

async function notificarAceite(solicitante, responsavel, demanda) {
  const html = layout('✅ Atividade Aceita!', `
    ${campo('Responsável', responsavel.nome)}
    ${campo('Atividade', demanda.descricao)}
    ${campo('Prazo acordado', formatarData(demanda.data_acordada))}
    <div style="margin-top:18px">
      <a href="${appBaseUrl()}" class="btn btn-purple">Ver no sistema</a>
    </div>
  `);
  await enviarEmail(solicitante, `✅ Aceita: ${demanda.descricao.slice(0, 60)}`, html);
}

async function notificarConclusao(solicitante, responsavel, demanda) {
  const html = layout('🎉 Atividade Concluída — Aguardando Baixa', `
    ${campo('Concluída por', responsavel.nome)}
    ${campo('Atividade', demanda.descricao)}
    <div style="margin-top:18px">
      <a href="${linkAcao(demanda.id, 'baixa')}" class="btn btn-green">✔️ Confirmar e dar baixa</a>
      <a href="${appBaseUrl()}" class="btn btn-purple">Ver no sistema</a>
    </div>
  `);
  await enviarEmail(solicitante, `🎉 Concluída: ${demanda.descricao.slice(0, 60)}`, html);
}

async function notificarBaixa(responsavel, solicitante, demanda) {
  const html = layout('✔️ Baixa Confirmada', `
    ${campo('Confirmada por', solicitante.nome)}
    ${campo('Atividade', demanda.descricao)}
    <p style="color:#00c875;font-weight:600;margin-top:12px">Atividade finalizada com sucesso!</p>
  `);
  await enviarEmail(responsavel, `✔️ Finalizada: ${demanda.descricao.slice(0, 60)}`, html);
}

async function notificarNovoPrazo(solicitante, responsavel, demanda) {
  const html = layout('📅 Novo Prazo Proposto', `
    ${campo('Proposto por', responsavel.nome)}
    ${campo('Atividade', demanda.descricao)}
    ${campo('Novo prazo', formatarData(demanda.nova_data))}
    ${demanda.observacao ? campo('Observação', demanda.observacao) : ''}
    <div style="margin-top:18px">
      <a href="${linkAcao(demanda.id, 'aceitar')}" class="btn btn-green">✅ Aceitar novo prazo</a>
      <a href="${appBaseUrl()}" class="btn btn-purple">Ver no sistema</a>
    </div>
  `);
  await enviarEmail(solicitante, `📅 Novo prazo: ${demanda.descricao.slice(0, 60)}`, html);
}

async function enviarLembrete(usuario, demanda, tipo) {
  const msgs = {
    vencimento_proximo: `⚠️ Atenção: a atividade "${demanda.descricao}" vence em breve (${formatarData(demanda.data_acordada || demanda.data_entrega)}).`,
    vencida: `🔴 A atividade "${demanda.descricao}" está VENCIDA desde ${formatarData(demanda.data_acordada || demanda.data_entrega)}.`,
    aguardando_baixa: `⏳ Aguardando sua confirmação de baixa na atividade "${demanda.descricao}".`,
  };
  const html = layout('🔔 Lembrete de Atividade', `
    <p style="font-size:.95rem;margin-bottom:16px">${msgs[tipo] || tipo}</p>
    <a href="${appBaseUrl()}" class="btn btn-purple">Abrir sistema</a>
  `);
  await enviarEmail(usuario, `🔔 Lembrete: ${demanda.descricao.slice(0, 60)}`, html);
}

async function notificarSolicitacaoAtualizacao(responsavel, solicitante, demanda) {
  const html = layout('📩 Solicitação de Atualização', `
    ${campo('Solicitado por', solicitante.nome)}
    ${campo('Atividade', demanda.descricao)}
    ${campo('Status atual', demanda.status)}
    <div style="margin-top:18px">
      <a href="${appBaseUrl()}" class="btn btn-purple">Responder no sistema</a>
    </div>
  `);
  await enviarEmail(responsavel, `📩 Atualização solicitada: ${demanda.descricao.slice(0, 60)}`, html);
}

async function enviarRelatorioEmail(usuario, { vencidas, vencem_hoje, vencem_em_3_dias, total_ativas }) {
  function listaHtml(lista) {
    if (!lista.length) return '<p style="color:#8888aa;font-size:.85rem">Nenhuma.</p>';
    return `<ul style="margin:6px 0 0 16px;padding:0">${lista.map(d => `<li style="margin-bottom:4px;font-size:.88rem">${d.descricao} — ${formatarData(d.data_acordada || d.data_entrega)}</li>`).join('')}</ul>`;
  }

  const hoje = new Date().toLocaleDateString('pt-BR');
  const html = layout(`📊 Relatório Diário — ${hoje}`, `
    ${campo('Total de atividades ativas', total_ativas)}
    <div style="margin-top:14px">
      <div style="color:#ff5b5b;font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">🔴 Vencidas</div>
      ${listaHtml(vencidas)}
    </div>
    <div style="margin-top:12px">
      <div style="color:#ffcb00;font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">🟡 Vencem Hoje</div>
      ${listaHtml(vencem_hoje)}
    </div>
    <div style="margin-top:12px">
      <div style="color:#4d9eff;font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">🔵 Vencem em até 3 dias</div>
      ${listaHtml(vencem_em_3_dias)}
    </div>
    <div style="margin-top:18px">
      <a href="${appBaseUrl()}" class="btn btn-purple">Ver todas no sistema</a>
    </div>
  `);
  await enviarEmail(usuario, `📊 Relatório Diário — ${hoje}`, html);
}

async function notificarExclusao(destinatario, autor, demanda) {
  const html = layout('🗑️ Atividade Cancelada', `
    ${campo('Atividade', demanda.descricao)}
    ${campo('Cancelada por', autor.nome)}
    <p style="color:#8888aa;font-size:.85rem;margin-top:12px">Esta atividade foi removida do sistema.</p>
  `);
  await enviarEmail(destinatario, `🗑️ Atividade cancelada: ${demanda.descricao.slice(0, 50)}`, html);
}

module.exports = {
  enviarEmail,
  notificarExclusao,
  notificarNovaDemanda,
  notificarAceite,
  notificarConclusao,
  notificarBaixa,
  notificarNovoPrazo,
  enviarLembrete,
  notificarSolicitacaoAtualizacao,
  enviarRelatorioEmail,
  verificarTokenAcao,
  linkAcao,
};
