/**
 * Gerencia o contexto de conversa de cada usuário no WhatsApp.
 * Permite menus numerados e fluxos multi-etapa (ex: pedir data após escolher "2 - Novo Prazo").
 * Sessões expiram em 30 minutos sem interação.
 */

const TRINTA_MINUTOS = 30 * 60 * 1000;

const sessoes = new Map();

function setSessao(telefone, dados) {
  sessoes.set(telefone, { ...dados, ts: Date.now() });
}

function getSessao(telefone) {
  const s = sessoes.get(telefone);
  if (!s) return null;
  if (Date.now() - s.ts > TRINTA_MINUTOS) {
    sessoes.delete(telefone);
    return null;
  }
  return s;
}

function clearSessao(telefone) {
  sessoes.delete(telefone);
}

module.exports = { setSessao, getSessao, clearSessao };
