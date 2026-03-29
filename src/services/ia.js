const Anthropic = require('@anthropic-ai/sdk');
const getDb = require('../database/db');

function formatarDataIso(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function traduzirStatus(s) {
  return {
    pendente_aceite: 'aguardando aceite',
    em_negociacao: 'em negociação de prazo',
    aceita: 'aceita / em andamento',
    em_andamento: 'em andamento',
    concluida_aguardando_baixa: 'concluída, aguardando confirmação',
    finalizada: 'finalizada',
  }[s] || s;
}

async function responderPergunta(usuario, pergunta) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada');

  const client = new Anthropic({ apiKey });
  const db = getDb();

  const hoje = new Date().toISOString().slice(0, 10);

  const comoResponsavel = db.prepare(`
    SELECT d.*, u.nome AS solicitante_nome
    FROM demandas d
    JOIN usuarios u ON u.id = d.solicitante_id
    WHERE d.responsavel_id = ?
    ORDER BY d.data_entrega ASC
  `).all(usuario.id);

  const comoSolicitante = db.prepare(`
    SELECT d.*, u.nome AS responsavel_nome
    FROM demandas d
    JOIN usuarios u ON u.id = d.responsavel_id
    WHERE d.solicitante_id = ?
    ORDER BY d.data_entrega ASC
  `).all(usuario.id);

  const listar = (lista, nomeCampo) =>
    lista.length === 0
      ? 'Nenhuma'
      : lista.map(d =>
          `  • "${d.descricao}" | ${nomeCampo}: ${d[nomeCampo + '_nome']} | Prazo: ${formatarDataIso(d.data_acordada || d.data_entrega)} | Status: ${traduzirStatus(d.status)}`
        ).join('\n');

  const contexto =
    `Data de hoje: ${formatarDataIso(hoje)}\n` +
    `Usuário consultando: ${usuario.nome}\n\n` +
    `DEMANDAS ONDE SOU RESPONSÁVEL:\n${listar(comoResponsavel, 'solicitante')}\n\n` +
    `DEMANDAS QUE EU SOLICITEI:\n${listar(comoSolicitante, 'responsavel')}`;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('IA timeout')), 8000)
  );

  const response = await Promise.race([
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      system:
        'Você é um assistente de gestão de tarefas integrado ao WhatsApp. ' +
        'Responda de forma direta e concisa. Use *asteriscos* para negrito. ' +
        'Máximo 150 palavras. Não repita o contexto.',
      messages: [
        {
          role: 'user',
          content: `Contexto das minhas demandas:\n${contexto}\n\nPergunta: ${pergunta}`,
        },
      ],
    }),
    timeout,
  ]);

  return response.content[0].text;
}

/**
 * Tenta extrair campos de criação de demanda a partir de texto livre.
 * Retorna { descricao, responsavel, data, horario } ou null.
 */
async function extrairCamposCriacao(texto, usuarios) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });
  const hoje = new Date().toLocaleDateString('pt-BR');
  const listaUsuarios = usuarios.map(u => u.nome).join(', ');

  const prompt =
    `Extraia dados de criação de atividade do texto abaixo.\n` +
    `Usuários disponíveis: ${listaUsuarios}\n` +
    `Data de hoje: ${hoje}\n\n` +
    `Texto: "${texto}"\n\n` +
    `Retorne SOMENTE JSON (sem markdown), com null nos campos não encontrados:\n` +
    `{"descricao":"o que deve ser feito","responsavel":"nome de um dos usuários ou null","data":"DD/MM/AAAA ou null","horario":"HH:MM ou null"}\n\n` +
    `Regras: descricao não deve incluir nome do responsável nem data. ` +
    `responsavel deve ser o nome mais próximo da lista fornecida. ` +
    `Converta datas relativas (amanhã, próxima semana) usando a data de hoje. ` +
    `Se não houver descrição clara, retorne null no campo descricao.`;

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 6000)
    );
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
      timeout,
    ]);

    // Remove possíveis blocos markdown antes de parsear
    const raw = response.content[0].text.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
    const json = JSON.parse(raw);
    if (!json || !json.descricao) return null;
    return json;
  } catch (e) {
    console.error('[IA] extrairCamposCriacao:', e.message);
    return null;
  }
}

module.exports = { responderPergunta, extrairCamposCriacao };
