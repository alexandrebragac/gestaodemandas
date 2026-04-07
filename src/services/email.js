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
  const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

  function secao(cor, label, lista) {
    const vazia = !lista.length;
    const itens = vazia
      ? `<p style="margin:0;color:#999;font-size:.83rem;font-style:italic">Nenhuma atividade</p>`
      : lista.map(d => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0">
            <span style="font-size:.88rem;color:#222;flex:1;padding-right:12px">${d.descricao}</span>
            <span style="font-size:.78rem;color:#888;white-space:nowrap;font-weight:600">${formatarData(d.data_acordada || d.data_entrega)}</span>
          </div>`).join('');
    return `
      <div style="margin-bottom:20px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e8e8e8">
        <div style="padding:10px 16px;background:${cor}12;border-left:4px solid ${cor};display:flex;align-items:center;gap:8px">
          <span style="font-size:.78rem;font-weight:700;color:${cor};text-transform:uppercase;letter-spacing:.06em">${label}</span>
          <span style="margin-left:auto;background:${cor};color:#fff;border-radius:20px;font-size:.72rem;font-weight:700;padding:1px 8px">${lista.length}</span>
        </div>
        <div style="padding:${vazia ? '12px 16px' : '0 16px'}">${itens}</div>
      </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:Inter,Arial,sans-serif">
  <div style="max-width:520px;margin:32px auto;padding:0 16px">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:.7rem;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Gestão de Demandas</div>
      <h1 style="margin:0;font-size:1.25rem;font-weight:700;color:#1a1a2e">Relatório Diário</h1>
      <div style="font-size:.88rem;color:#888;margin-top:4px">${hoje}</div>
    </div>

    <!-- Resumo -->
    <div style="background:#fff;border-radius:12px;border:1px solid #e8e8e8;padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:8px">
      <div style="font-size:.88rem;color:#555">Total de atividades ativas:</div>
      <div style="font-size:1.1rem;font-weight:700;color:#1a1a2e;margin-left:auto">${total_ativas}</div>
    </div>

    <!-- Seções -->
    ${secao('#e53e3e', '🔴 Vencidas', vencidas)}
    ${secao('#d69e2e', '🟡 Vencem hoje', vencem_hoje)}
    ${secao('#3182ce', '🔵 Vencem em até 3 dias', vencem_em_3_dias)}

    <!-- CTA -->
    <div style="text-align:center;margin:24px 0 8px">
      <a href="${appBaseUrl()}" style="display:inline-block;padding:12px 32px;background:#7c5cfc;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:.95rem">Ver todas no sistema →</a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:20px;font-size:.75rem;color:#bbb;padding-bottom:32px">
      Mensagem automática · <a href="${appBaseUrl()}" style="color:#7c5cfc;text-decoration:none">Gestão de Demandas</a>
    </div>

  </div>
</body></html>`;

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

async function enviarBoasVindas(usuario) {
  const link = 'https://wa.me/14155238886?text=join%20gather-meant';
  const html = layout('👋 Bem-vindo ao Gestão de Demandas', `
    <p style="margin:0 0 12px;color:#c0c0d0">Olá, <strong>${usuario.nome}</strong>! Seu cadastro está ativo.</p>
    <p style="margin:0 0 16px;font-size:.9rem;color:#8888aa">Para ativar o recebimento de notificações pelo WhatsApp, clique no botão abaixo e envie a mensagem que aparecerá preenchida:</p>
    <a href="${link}" class="btn btn-green">📲 Ativar WhatsApp</a>
    <div style="margin-top:18px;padding:14px;background:#13131f;border-radius:8px;font-size:.82rem;color:#8888aa">
      <strong style="color:#e2e2ee;display:block;margin-bottom:6px">Ou copie o link:</strong>
      <span style="word-break:break-all">${link}</span>
    </div>
    <p style="margin-top:16px;font-size:.82rem;color:#8888aa">Após enviar a mensagem, você começará a receber as notificações do sistema diretamente pelo WhatsApp.</p>
  `);
  await enviarEmail(usuario, '📲 Ative seu WhatsApp — Gestão de Demandas', html);
}

module.exports = {
  enviarEmail,
  enviarBoasVindas,
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
