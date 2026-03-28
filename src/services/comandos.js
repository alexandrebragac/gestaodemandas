/**
 * Parser de comandos recebidos via WhatsApp.
 * Aceita tanto texto livre quanto números do menu.
 */

const COMANDOS = {
  ACEITAR: 'aceitar',
  NOVO_PRAZO: 'novo_prazo',
  CONCLUIR: 'concluir',
  BAIXA: 'baixa',
  STATUS: 'status',
  AJUDA: 'ajuda',
  DATA: 'data',             // usuário enviou uma data após escolher "novo prazo"
  NUMERO_MENU: 'numero_menu', // usuário digitou um número do menu
  DESCONHECIDO: 'desconhecido',
};

function parsear(texto) {
  const msg = (texto || '').trim();
  const msgLower = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Número do menu (1, 2, 3...)
  if (/^\d+$/.test(msg)) {
    return { comando: COMANDOS.NUMERO_MENU, parametros: { numero: parseInt(msg) } };
  }

  // aceito / ok / aceitar
  if (/^(aceito|ok|aceitar|sim|confirmado)$/i.test(msgLower)) {
    return { comando: COMANDOS.ACEITAR };
  }

  // concluido / feito
  if (/^(conclu[ií]do|feito|concluir|terminei|pronto|finalizado|finalizar)$/i.test(msgLower)) {
    return { comando: COMANDOS.CONCLUIR };
  }

  // baixa / confirmo
  if (/^(baixa|confirmo|confirmei|validado|validar)$/i.test(msgLower)) {
    return { comando: COMANDOS.BAIXA };
  }

  // status / listar
  if (/^(status|minhas demandas|demandas|listar|lista)$/i.test(msgLower)) {
    return { comando: COMANDOS.STATUS };
  }

  // ajuda
  if (/^(ajuda|help|comandos|\?)$/i.test(msgLower)) {
    return { comando: COMANDOS.AJUDA };
  }

  // novo prazo: DD/MM ou DD/MM/AAAA
  const prazoMatch = msgLower.match(/novo\s+prazo[:\s]+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})/);
  if (prazoMatch) {
    const data = normalizarData(prazoMatch[1]);
    if (data) return { comando: COMANDOS.NOVO_PRAZO, parametros: { data } };
  }

  // Data isolada (ex: "28/04/2026") — usada após menu "2 - Novo Prazo"
  const dataMatch = msg.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})$/);
  if (dataMatch) {
    const data = normalizarData(dataMatch[1]);
    if (data) return { comando: COMANDOS.DATA, parametros: { data } };
  }

  return { comando: COMANDOS.DESCONHECIDO };
}

function normalizarData(raw) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const partes = raw.split('/');
  if (partes.length >= 2) {
    const dia = partes[0].padStart(2, '0');
    const mes = partes[1].padStart(2, '0');
    const ano = partes[2]
      ? (partes[2].length === 2 ? `20${partes[2]}` : partes[2])
      : new Date().getFullYear();
    return `${ano}-${mes}-${dia}`;
  }
  return null;
}

function mensagemAjuda() {
  return (
    `📖 *Comandos disponíveis:*\n\n` +
    `*1* ou *aceito* — aceitar demanda/prazo proposto\n` +
    `*2* ou *novo prazo: DD/MM/AAAA* — propor novo prazo\n` +
    `*3* ou *concluído* — marcar tarefa como concluída\n` +
    `*4* ou *baixa* — confirmar conclusão (solicitante)\n` +
    `*5* ou *status* — ver suas demandas pendentes\n` +
    `*6* ou *ajuda* — exibir esta mensagem`
  );
}

module.exports = { parsear, COMANDOS, normalizarData, mensagemAjuda };
