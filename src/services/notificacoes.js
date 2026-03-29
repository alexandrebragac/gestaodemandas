/**
 * Dispatcher de notificações — roteia para WhatsApp, Email ou ambos
 * conforme o campo `canal` de cada usuário.
 */

const whatsappService = require('./whatsapp');
const emailService    = require('./email');

// canal: 'whatsapp' | 'email' | 'ambos'
// Se canal não estiver definido, usa whatsapp por padrão (retrocompatibilidade)

async function dispatch(usuario, fnWhatsapp, fnEmail, ...args) {
  const canal = usuario?.canal || 'whatsapp';
  const erros = [];

  if (canal === 'whatsapp' || canal === 'ambos') {
    try { await fnWhatsapp(...args); } catch (e) { erros.push(`WhatsApp: ${e.message}`); }
  }
  if (canal === 'email' || canal === 'ambos') {
    try { await fnEmail(...args); } catch (e) { erros.push(`Email: ${e.message}`); }
  }

  if (erros.length) console.error('[Notificações] Erros:', erros.join(' | '));
}

// ── Wrappers por notificação ──────────────────────────────────────────────────

// Notifica o RESPONSÁVEL sobre nova demanda
async function novaDemanda(responsavel, solicitante, demanda) {
  await dispatch(
    responsavel,
    () => whatsappService.notificarNovaDeamanda(responsavel, solicitante, demanda),
    () => emailService.notificarNovaDemanda(responsavel, solicitante, demanda)
  );
}

// Notifica o SOLICITANTE sobre aceite
async function aceite(solicitante, responsavel, demanda) {
  await dispatch(
    solicitante,
    () => whatsappService.notificarAceite(solicitante, responsavel, demanda),
    () => emailService.notificarAceite(solicitante, responsavel, demanda)
  );
}

// Notifica o SOLICITANTE sobre conclusão
async function conclusao(solicitante, responsavel, demanda) {
  await dispatch(
    solicitante,
    () => whatsappService.notificarConclusao(solicitante, responsavel, demanda),
    () => emailService.notificarConclusao(solicitante, responsavel, demanda)
  );
}

// Notifica o RESPONSÁVEL sobre baixa
async function baixa(responsavel, solicitante, demanda) {
  await dispatch(
    responsavel,
    () => whatsappService.notificarBaixa(responsavel, solicitante, demanda),
    () => emailService.notificarBaixa(responsavel, solicitante, demanda)
  );
}

// Notifica o SOLICITANTE sobre novo prazo
async function novoPrazo(solicitante, responsavel, demanda) {
  await dispatch(
    solicitante,
    () => whatsappService.notificarNovoPrazo(solicitante, responsavel, demanda),
    () => emailService.notificarNovoPrazo(solicitante, responsavel, demanda)
  );
}

// Lembrete — usa canal do próprio usuário
async function lembrete(usuario, demanda, tipo) {
  await dispatch(
    usuario,
    () => whatsappService.enviarLembrete(usuario, demanda, tipo),
    () => emailService.enviarLembrete(usuario, demanda, tipo)
  );
}

// Solicitar atualização ao responsável
async function solicitarAtualizacao(responsavel, solicitante, demanda) {
  const msg =
    `📩 *Solicitação de Atualização*\n\n` +
    `${solicitante?.nome || 'Solicitante'} pediu uma atualização sobre:\n` +
    `"${demanda.descricao}"\n\nStatus atual: ${demanda.status}`;
  await dispatch(
    responsavel,
    () => whatsappService.enviarMensagem(responsavel, msg),
    () => emailService.notificarSolicitacaoAtualizacao(responsavel, solicitante, demanda)
  );
}

module.exports = { novaDemanda, aceite, conclusao, baixa, novoPrazo, lembrete, solicitarAtualizacao };
