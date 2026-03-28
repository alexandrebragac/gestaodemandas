const API = '';

// ── Utilitários ──────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ erro: 'Erro desconhecido' }));
    throw new Error(err.erro || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function statusLabel(s) {
  const labels = {
    pendente_aceite: 'Aguardando Aceite',
    em_negociacao: 'Em Negociação',
    aceita: 'Aceita',
    em_andamento: 'Em Andamento',
    concluida_aguardando_baixa: 'Aguardando Baixa',
    finalizada: 'Finalizada',
  };
  return labels[s] || s;
}

function iniciais(nome) {
  return nome.split(' ').slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

function prazoInfo(demanda) {
  const prazo = demanda.data_acordada || demanda.data_entrega;
  if (!prazo) return '';
  const hoje = new Date().toISOString().slice(0, 10);
  if (demanda.status === 'finalizada') return formatDate(prazo);
  if (prazo < hoje) return `<span class="vencido">⚠ ${formatDate(prazo)} (vencido)</span>`;
  if (prazo === hoje) return `<span class="vence-hoje">🔴 Hoje!</span>`;
  return formatDate(prazo);
}

function showMsg(elId, msg, type = 'ok') {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = `form-msg ${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'form-msg'; }, 4000);
}

// ── Estado ───────────────────────────────────────────────────────────────────

let usuarios = [];
let demandas = [];
let filtroStatus = '';

// ── Carregamento inicial ─────────────────────────────────────────────────────

async function carregarUsuarios() {
  usuarios = await api('/api/usuarios');
  renderUsuarios();
  popularSelects();
}

async function carregarDemandas() {
  const qs = filtroStatus ? `?status=${filtroStatus}` : '';
  demandas = await api(`/api/demandas${qs}`);
  if (!filtroStatus) {
    demandas = demandas.filter(d => d.status !== 'finalizada');
  }
  renderDemandas();
  atualizarStats();
}

// ── Render: Usuários ─────────────────────────────────────────────────────────

function renderUsuarios() {
  const ul = document.getElementById('lista-usuarios');
  ul.innerHTML = usuarios.map(u => `
    <li>
      <div class="user-avatar">${iniciais(u.nome)}</div>
      <div style="flex:1">
        <div style="font-weight:500">${u.nome}</div>
        <div style="color:var(--muted);font-size:.75rem">${u.telefone_whatsapp}</div>
      </div>
      <div style="display:flex;gap:4px">
        <button class="btn-user-action" data-acao="editar" data-id="${u.id}" title="Editar">✏️</button>
        <button class="btn-user-action" data-acao="excluir" data-id="${u.id}" title="Excluir">🗑️</button>
      </div>
    </li>
  `).join('');
}

// Delegação de eventos para botões de usuário
document.getElementById('lista-usuarios').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-acao]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.acao === 'editar') abrirEdicaoUsuario(id);
  if (btn.dataset.acao === 'excluir') await excluirUsuario(id);
});

function abrirEdicaoUsuario(id) {
  const u = usuarios.find(x => x.id === id);
  if (!u) return;
  document.getElementById('edit-usuario-id').value = u.id;
  document.getElementById('edit-usuario-nome').value = u.nome;
  document.getElementById('edit-usuario-telefone').value = u.telefone_whatsapp;
  document.getElementById('edit-usuario-msg').textContent = '';
  document.getElementById('modal-usuario').classList.remove('hidden');
  document.getElementById('edit-usuario-nome').focus();
}

async function excluirUsuario(id) {
  const u = usuarios.find(x => x.id === id);
  if (!u) return;
  if (!confirm(`Excluir o usuário "${u.nome}"?\n\nIsso removerá também todos os dados vinculados a ele.`)) return;
  try {
    await api(`/api/usuarios/${id}`, { method: 'DELETE' });
    await carregarUsuarios();
  } catch (e) {
    alert('Erro ao excluir usuário:\n' + e.message);
  }
}

function popularSelects() {
  const opts = usuarios.map(u => `<option value="${u.id}">${u.nome}</option>`).join('');
  document.getElementById('solicitante').innerHTML = `<option value="">Selecionar...</option>${opts}`;
  document.getElementById('responsavel').innerHTML = `<option value="">Selecionar...</option>${opts}`;
}

// ── Render: Demandas ─────────────────────────────────────────────────────────

function renderDemandas() {
  const container = document.getElementById('lista-demandas');

  if (demandas.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">📭</div>
        <p>Nenhuma demanda encontrada.</p>
      </div>`;
    return;
  }

  container.innerHTML = demandas.map(d => `
    <div class="demanda-card status-${d.status}" data-id="${d.id}" style="cursor:pointer">
      <div class="demanda-header">
        <div class="demanda-descricao">${d.descricao}</div>
        <span class="demanda-badge badge-${d.status}">${statusLabel(d.status)}</span>
      </div>
      <div class="demanda-meta">
        <span>👤 ${d.solicitante?.nome || '—'} → ${d.responsavel?.nome || '—'}</span>
        <span>📅 ${prazoInfo(d)}</span>
      </div>
    </div>
  `).join('');
}

// Delegação de eventos para cards de demanda
document.getElementById('lista-demandas').addEventListener('click', async (e) => {
  const card = e.target.closest('.demanda-card');
  if (!card) return;
  await abrirModal(card.dataset.id);
});

// ── Stats ────────────────────────────────────────────────────────────────────

async function atualizarStats() {
  try {
    const todas = await api('/api/demandas');
    const ativas = todas.filter(d => d.status !== 'finalizada');
    document.getElementById('total-demandas').textContent = ativas.length;
    document.getElementById('pendentes').textContent = ativas.filter(d => d.status === 'pendente_aceite').length;
    document.getElementById('em-andamento').textContent = ativas.filter(d => ['aceita', 'em_andamento'].includes(d.status)).length;
    document.getElementById('aguardando-baixa').textContent = ativas.filter(d => d.status === 'concluida_aguardando_baixa').length;
  } catch (e) { /* silencioso */ }
}

// ── Modal de demanda ─────────────────────────────────────────────────────────

let demandaAtualId = null;

async function abrirModal(id) {
  demandaAtualId = id;
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<p style="color:var(--muted)">Carregando...</p>';

  try {
    const [demanda, mensagens] = await Promise.all([
      api(`/api/demandas/${id}`),
      api(`/api/demandas/${id}/mensagens`),
    ]);

    body.innerHTML = `
      <div class="modal-title">${demanda.descricao}</div>
      <div style="margin-top:6px">
        <span class="demanda-badge badge-${demanda.status}" style="display:inline-block">${statusLabel(demanda.status)}</span>
      </div>

      <div class="modal-section">
        <h3>Detalhes</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:.88rem">
          <div><strong>Solicitante:</strong> ${demanda.solicitante?.nome}</div>
          <div><strong>Responsável:</strong> ${demanda.responsavel?.nome}</div>
          <div><strong>Prazo de entrega:</strong> ${formatDate(demanda.data_entrega)}${demanda.horario_entrega ? ` às ${demanda.horario_entrega}` : ''}</div>
          <div><strong>Prazo acordado:</strong> ${formatDate(demanda.data_acordada)}</div>
          <div><strong>Criado em:</strong> ${formatDate(demanda.criado_em)}</div>
          <div><strong>Atualizado:</strong> ${formatDate(demanda.atualizado_em)}</div>
        </div>
      </div>

      <div class="modal-section">
        <h3>Histórico</h3>
        ${mensagens.length === 0
          ? '<p style="color:var(--muted);font-size:.85rem">Sem mensagens ainda.</p>'
          : `<ul class="timeline">${mensagens.map(m => `
            <li>
              <span class="msg-tipo">${m.tipo}</span>
              <span class="msg-data">${formatDate(m.enviado_em)}</span>
              <div class="msg-texto">${m.conteudo}</div>
            </li>`).join('')}</ul>`
        }
      </div>

      <div class="action-row" id="acoes-demanda">
        ${renderAcoes(demanda)}
      </div>
    `;

    // Eventos dos botões de ação (via delegação)
    document.getElementById('acoes-demanda').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-acao]');
      if (!btn) return;
      const acao = btn.dataset.acao;
      if (acao === 'excluir-demanda') {
        await excluirDemanda(demanda.id, demanda.descricao);
      } else {
        await executarAcao(demanda.id, acao);
      }
    });

  } catch (e) {
    body.innerHTML = `<p style="color:#c0392b">Erro: ${e.message}</p>`;
  }
}

function renderAcoes(d) {
  const acoes = [];

  if (['pendente_aceite', 'em_negociacao'].includes(d.status)) {
    acoes.push(`<button class="btn-aceitar" data-acao="aceitar">✅ Aceitar</button>`);
  }
  if (['aceita', 'em_andamento'].includes(d.status)) {
    acoes.push(`<button class="btn-concluir" data-acao="concluir">🎉 Concluir</button>`);
  }
  if (d.status === 'concluida_aguardando_baixa') {
    acoes.push(`<button class="btn-baixa" data-acao="baixa">✔️ Dar Baixa</button>`);
  }
  if (d.status !== 'finalizada') {
    acoes.push(`<button class="btn-excluir-demanda" data-acao="excluir-demanda">🗑️ Excluir</button>`);
  }

  return acoes.join('');
}

async function executarAcao(id, tipo) {
  try {
    await api(`/api/demandas/${id}/${tipo}`, { method: 'POST', body: {} });
    fecharModal();
    await carregarDemandas();
  } catch (e) {
    alert('Erro: ' + e.message);
  }
}

async function excluirDemanda(id, descricao) {
  if (!confirm(`Excluir a demanda:\n"${descricao}"?\n\nEsta ação não pode ser desfeita.`)) return;
  try {
    await api(`/api/demandas/${id}`, { method: 'DELETE' });
    fecharModal();
    await carregarDemandas();
  } catch (e) {
    alert('Erro ao excluir demanda:\n' + e.message);
  }
}

function fecharModal() {
  document.getElementById('modal').classList.add('hidden');
  demandaAtualId = null;
}

// ── Formulários ──────────────────────────────────────────────────────────────

document.getElementById('form-editar-usuario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('edit-usuario-id').value;
  const body = {
    nome: document.getElementById('edit-usuario-nome').value.trim(),
    telefone_whatsapp: document.getElementById('edit-usuario-telefone').value.trim(),
  };
  try {
    await api(`/api/usuarios/${id}`, { method: 'PUT', body });
    document.getElementById('modal-usuario').classList.add('hidden');
    await carregarUsuarios();
  } catch (err) {
    showMsg('edit-usuario-msg', '❌ ' + err.message, 'err');
  }
});

document.getElementById('form-demanda').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    solicitante_id: document.getElementById('solicitante').value,
    responsavel_id: document.getElementById('responsavel').value,
    descricao: document.getElementById('descricao').value,
    data_entrega: document.getElementById('data-entrega').value,
    horario_entrega: document.getElementById('horario-entrega').value || null,
  };
  try {
    await api('/api/demandas', { method: 'POST', body });
    showMsg('form-msg', '✅ Demanda criada! Notificação WhatsApp enviada ao responsável.', 'ok');
    e.target.reset();
    await carregarDemandas();
  } catch (err) {
    showMsg('form-msg', '❌ ' + err.message, 'err');
  }
});

document.getElementById('form-usuario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    nome: document.getElementById('u-nome').value,
    telefone_whatsapp: document.getElementById('u-telefone').value,
  };
  try {
    await api('/api/usuarios', { method: 'POST', body });
    showMsg('form-usuario-msg', '✅ Usuário adicionado!', 'ok');
    e.target.reset();
    await carregarUsuarios();
  } catch (err) {
    showMsg('form-usuario-msg', '❌ ' + err.message, 'err');
  }
});

document.getElementById('filtro-status').addEventListener('change', async (e) => {
  filtroStatus = e.target.value;
  await carregarDemandas();
});

document.getElementById('btn-refresh').addEventListener('click', async () => {
  await carregarDemandas();
});

document.getElementById('modal-close').addEventListener('click', fecharModal);
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) fecharModal();
});

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await carregarUsuarios();
  await carregarDemandas();
})();
