/**
 * Integração com ClickUp API v2
 * Requer: CLICKUP_API_TOKEN e CLICKUP_LIST_ID no .env
 */

function isConfigurado() {
  return !!(process.env.CLICKUP_API_TOKEN && process.env.CLICKUP_LIST_ID);
}

/**
 * Converte data ISO (YYYY-MM-DD) + horário opcional (HH:MM) em Unix ms (UTC)
 * ClickUp usa horário de Brasília (UTC-3) quando enviamos sem timezone
 */
function toUnixMs(dataIso, horario) {
  const hora = horario || '23:59';
  const [h, m] = hora.split(':');
  // Brasília = UTC-3 → somamos 3h para converter para UTC
  const d = new Date(`${dataIso.slice(0, 10)}T${h.padStart(2,'0')}:${m.padStart(2,'0')}:00-03:00`);
  return d.getTime();
}

async function criarTarefa({ descricao, data_entrega, horario_entrega, solicitante, responsavel }) {
  if (!isConfigurado()) return null;

  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env.CLICKUP_LIST_ID;

  const body = {
    name: descricao,
    description: `Solicitante: ${solicitante?.nome || '—'}\nResponsável: ${responsavel?.nome || '—'}\n\nCriado via Gestão de Demandas (WhatsApp)`,
    due_date: toUnixMs(data_entrega, horario_entrega),
    due_date_time: !!horario_entrega,
  };

  const resp = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`ClickUp API error ${resp.status}: ${err}`);
  }

  const task = await resp.json();
  return `https://app.clickup.com/t/${task.id}`;
}

module.exports = { criarTarefa, isConfigurado };
