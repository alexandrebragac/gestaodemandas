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
  console.log(`[Notificações] dispatch → ${usuario?.nome} | canal: ${canal} | tel: ${usuario?.telefone_whatsapp} | email: ${usuario?.email}`);
  const resultado = { whatsapp: null, email: null };

  if (canal === 'whatsapp' || canal === 'ambos') {
    try { await fnWhatsapp(...args); resultado.whatsapp = { ok: true }; }
    catch (e) { resultado.whatsapp = { ok: false, erro: e.message }; console.error('[Notificações] WhatsApp:', e.message); }
  }
  if (canal === 'email' || canal === 'ambos') {
    try { await fnEmail(...args); resultado.email = { ok: true }; }
    catch (e) { resultado.email = { ok: false, erro: e.message }; console.error('[Notificações] Email:', e.message); }
  }

  return resultado;
}

// ── Wrappers por notificação ──────────────────────────────────────────────────

// Notifica o RESPONSÁVEL sobre nova demanda
async function novaDemanda(responsavel, solicitante, demanda) {
  return dispatch(
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

// Notifica ambos quando uma demanda é excluída
async function exclusao(responsavel, solicitante, autor, demanda) {
  const notificar = async (dest) => {
    await dispatch(
      dest,
      () => whatsappService.notificarExclusao(dest, autor, demanda),
      () => emailService.notificarExclusao ? emailService.notificarExclusao(dest, autor, demanda) : Promise.resolve()
    );
  };
  // Notifica responsável (se diferente do autor)
  if (responsavel.id !== autor.id) await notificar(responsavel);
  // Notifica solicitante (se diferente do autor e diferente do responsável)
  if (solicitante.id !== autor.id && solicitante.id !== responsavel.id) await notificar(solicitante);
}

module.exports = { novaDemanda, aceite, conclusao, baixa, novoPrazo, lembrete, solicitarAtualizacao, exclusao };
