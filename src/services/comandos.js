/**
 * Parser de comandos recebidos via WhatsApp.
 * Interpreta texto livre e retorna { comando, parametros }
 */

const COMANDOS = {
  ACEITAR: 'aceitar',
  NOVO_PRAZO: 'novo_prazo',
  CONCLUIR: 'concluir',
  BAIXA: 'baixa',
  STATUS: 'status',
  AJUDA: 'ajuda',
  DESCONHECIDO: 'desconhecido',
};

function parsear(texto) {
  const msg = (texto || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // aceito / ok / aceitar
  if (/^(aceito|ok|aceitar|sim|confirmado)$/i.test(msg)) {
    return { comando: COMANDOS.ACEITAR };
  }

  // concluido / feito / concluir / terminei / pronto
  if (/^(conclu[ií]do|feito|concluir|terminei|pronto|finalizado|finalizar)$/i.test(msg)) {
    return { comando: COMANDOS.CONCLUIR };
  }

  // baixa / confirmo / confirmei / validado
  if (/^(baixa|confirmo|confirmei|validado|validar)$/i.test(msg)) {
    return { comando: COMANDOS.BAIXA };
  }

  // status / minhas demandas / listar
  if (/^(status|minhas demandas|demandas|listar|lista)$/i.test(msg)) {
    return { comando: COMANDOS.STATUS };
  }

  // ajuda / help / comandos
  if (/^(ajuda|help|comandos|\?)$/i.test(msg)) {
    return { comando: COMANDOS.AJUDA };
  }

  // novo prazo: DD/MM ou DD/MM/AAAA ou AAAA-MM-DD
  const prazoMatch = msg.match(/novo\s+prazo[:\s]+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})/);
  if (prazoMatch) {
    const dataRaw = prazoMatch[1];
    const data = normalizarData(dataRaw);
    if (data) return { comando: COMANDOS.NOVO_PRAZO, parametros: { data } };
  }

  return { comando: COMANDOS.DESCONHECIDO };
}

function normalizarData(raw) {
  // AAAA-MM-DD já está normalizado
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // DD/MM ou DD/MM/AAAA
  const partes = raw.split('/');
  if (partes.length >= 2) {
    const dia = partes[0].padStart(2, '0');
    const mes = partes[1].padStart(2, '0');
    const ano = partes[2] ? (partes[2].length === 2 ? `20${partes[2]}` : partes[2]) : new Date().getFullYear();
    return `${ano}-${mes}-${dia}`;
  }
  return null;
}

function mensagemAjuda() {
  return (
    `📖 *Comandos disponíveis:*\n\n` +
    `• *aceito* — aceitar demanda/prazo proposto\n` +
    `• *novo prazo: DD/MM/AAAA* — propor novo prazo\n` +
    `• *concluído* — marcar tarefa como concluída\n` +
    `• *baixa* — confirmar conclusão (solicitante)\n` +
    `• *status* — ver suas demandas pendentes\n` +
    `• *ajuda* — exibir esta mensagem`
  );
}

module.exports = { parsear, COMANDOS, mensagemAjuda };
