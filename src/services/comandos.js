/**
 * Parser de comandos recebidos via WhatsApp.
 * Aceita números do menu e texto livre.
 */

const COMANDOS = {
  ACEITAR: 'aceitar',
  NOVO_PRAZO: 'novo_prazo',
  CONCLUIR: 'concluir',
  BAIXA: 'baixa',
  STATUS: 'status',
  AJUDA: 'ajuda',
  NOVA_DEMANDA: 'nova_demanda',
  EDITAR_DEMANDA: 'editar_demanda',
  DATA: 'data',
  NUMERO_MENU: 'numero_menu',
  DESCONHECIDO: 'desconhecido',
};

function parsear(texto) {
  const msg = (texto || '').trim();
  const norm = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Número do menu
  if (/^\d+$/.test(msg)) {
    return { comando: COMANDOS.NUMERO_MENU, parametros: { numero: parseInt(msg) } };
  }

  if (/^(aceito|ok|aceitar|sim|confirmado)$/i.test(norm))
    return { comando: COMANDOS.ACEITAR };

  if (/^(conclu[ií]do|feito|concluir|terminei|pronto|finalizado|finalizar)$/i.test(norm))
    return { comando: COMANDOS.CONCLUIR };

  if (/^(baixa|confirmo|confirmei|validado|validar)$/i.test(norm))
    return { comando: COMANDOS.BAIXA };

  if (/^(status|minhas demandas|demandas|listar|lista)$/i.test(norm))
    return { comando: COMANDOS.STATUS };

  if (/^(ajuda|help|comandos|\?)$/i.test(norm))
    return { comando: COMANDOS.AJUDA };

  if (/\b(criar|nova|novo|cadastrar|adicionar)\b.*\b(atividade|demanda|tarefa|task)\b/i.test(norm) ||
      /\b(quero|preciso|vou)\b.*\b(criar|cadastrar|adicionar)\b/i.test(norm) ||
      /^(nova|nova demanda|criar|criar demanda|novo)$/i.test(norm))
    return { comando: COMANDOS.NOVA_DEMANDA };

  if (/^(editar|editar demanda|alterar|modificar)$/i.test(norm))
    return { comando: COMANDOS.EDITAR_DEMANDA };

  // novo prazo: DD/MM/AAAA
  const prazoMatch = norm.match(/novo\s+prazo[:\s]+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})/);
  if (prazoMatch) {
    const data = normalizarData(prazoMatch[1]);
    if (data) return { comando: COMANDOS.NOVO_PRAZO, parametros: { data } };
  }

  // Data isolada
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
    `*1* — Aceitar demanda/prazo\n` +
    `*2* — Propor novo prazo\n` +
    `*3* — Marcar como concluído\n` +
    `*4* — Dar baixa (confirmar conclusão)\n` +
    `*5* — Ver minhas demandas\n` +
    `*7* — Criar nova demanda\n` +
    `*8* — Editar demanda\n` +
    `*6* — Ajuda`
  );
}

module.exports = { parsear, COMANDOS, normalizarData, mensagemAjuda };
