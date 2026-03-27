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
  const prazo = demanda.data_acordada || demanda.data_esperada;
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
    // Exibe todas exceto finalizadas por padrão
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
      <div>
        <div style="font-weight:500">${u.nome}</div>
        <div style="color:var(--muted);font-size:.75rem">${u.telefone_whatsapp}</div>
      </div>
    </li>
  `).join('');
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
    <div class="demanda-card status-${d.status}" onclick="abrirModal('${d.id}')">
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

// ── Modal ────────────────────────────────────────────────────────────────────

async function abrirModal(id) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<p style="color:var(--muted)">Carregando...</p>';

  try {
    const [demanda, mensagens] = await Promise.all([
      api(`/api/demandas/${id}`),
      api(`/api/demandas/${id}/mensagens`),
    ]);

    const prazo = demanda.data_acordada || demanda.data_esperada;

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
          <div><strong>Prazo esperado:</strong> ${formatDate(demanda.data_esperada)}</div>
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

      ${renderAcoes(demanda)}
    `;
  } catch (e) {
    body.innerHTML = `<p style="color:#c0392b">Erro: ${e.message}</p>`;
  }
}

function renderAcoes(d) {
  const acoes = [];

  if (['pendente_aceite', 'em_negociacao'].includes(d.status)) {
    acoes.push(`<button class="btn-aceitar" onclick="acao('${d.id}', 'aceitar')">✅ Aceitar</button>`);
  }
  if (['aceita', 'em_andamento'].includes(d.status)) {
    acoes.push(`<button class="btn-concluir" onclick="acao('${d.id}', 'concluir')">🎉 Concluir</button>`);
  }
  if (d.status === 'concluida_aguardando_baixa') {
    acoes.push(`<button class="btn-baixa" onclick="acao('${d.id}', 'baixa')">✔️ Dar Baixa</button>`);
  }

  if (acoes.length === 0) return '';
  return `<div class="action-row">${acoes.join('')}</div>`;
}

async function acao(id, tipo) {
  try {
    await api(`/api/demandas/${id}/${tipo}`, { method: 'POST', body: {} });
    fecharModal();
    await carregarDemandas();
  } catch (e) {
    alert('Erro: ' + e.message);
  }
}

function fecharModal() {
  document.getElementById('modal').classList.add('hidden');
}

// ── Formulários ──────────────────────────────────────────────────────────────

document.getElementById('form-demanda').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    solicitante_id: document.getElementById('solicitante').value,
    responsavel_id: document.getElementById('responsavel').value,
    descricao: document.getElementById('descricao').value,
    data_esperada: document.getElementById('data-esperada').value,
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
