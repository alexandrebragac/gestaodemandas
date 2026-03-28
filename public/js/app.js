const API = '';

// ── Utilitários ──────────────────────────────────────────────────────────────

function gerarLinkCalendario(descricao, dataIso, horario) {
  if (!dataIso) return null;
  const titulo = encodeURIComponent(descricao.substring(0, 80));
  const detalhes = encodeURIComponent('Prazo de atividade — Gestão de Demandas');
  if (horario) {
    const base = dataIso.slice(0, 10).replace(/-/g, '');
    const [h, m] = horario.split(':');
    const hInicio = `${String(h).padStart(2,'0')}${String(m).padStart(2,'0')}00`;
    const hFim = `${String(parseInt(h)+1).padStart(2,'0')}${String(m).padStart(2,'0')}00`;
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${titulo}&dates=${base}T${hInicio}/${base}T${hFim}&details=${detalhes}&ctz=America%2FSao_Paulo`;
  } else {
    const base = dataIso.slice(0, 10).replace(/-/g, '');
    const d = new Date(dataIso.slice(0,10) + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const proximo = d.toISOString().slice(0,10).replace(/-/g,'');
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${titulo}&dates=${base}/${proximo}&details=${detalhes}`;
  }
}

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
  renderUsuariosOverview();
  atualizarStats();
}

// ── Render: Visão por Usuário ────────────────────────────────────────────────

function renderUsuariosOverview() {
  const container = document.getElementById('usuarios-overview');
  if (!container || usuarios.length === 0) return;

  const hoje = new Date().toISOString().slice(0, 10);
  const STATUSES_ATIVAS = ['pendente_aceite', 'em_negociacao', 'aceita', 'em_andamento', 'concluida_aguardando_baixa'];

  // Compute per-user stats from current demandas in memory
  const stats = usuarios.map(u => {
    // As responsável: count by status from active demands
    const comoResp = demandas.filter(d => d.responsavel_id === u.id && STATUSES_ATIVAS.includes(d.status));
    const vencidas = comoResp.filter(d => {
      const prazo = d.data_acordada || d.data_entrega;
      return prazo && prazo < hoje;
    }).length;
    const pendenteAceite = comoResp.filter(d => d.status === 'pendente_aceite').length;
    const emAndamento = comoResp.filter(d => ['aceita', 'em_andamento', 'em_negociacao'].includes(d.status)).length;

    // As solicitante: aguardando_baixa
    const aguardandoBaixa = demandas.filter(d =>
      d.solicitante_id === u.id && d.status === 'concluida_aguardando_baixa'
    ).length;

    // Determine border color: red > orange > green > gray
    let borderClass = 'border-gray';
    if (vencidas > 0) borderClass = 'border-red';
    else if (pendenteAceite > 0) borderClass = 'border-orange';
    else if (emAndamento > 0 || aguardandoBaixa > 0) borderClass = 'border-green';

    return { u, vencidas, pendenteAceite, emAndamento, aguardandoBaixa, borderClass };
  });

  // Only show users with at least one active demand
  const ativos = stats.filter(s =>
    s.vencidas > 0 || s.pendenteAceite > 0 || s.emAndamento > 0 || s.aguardandoBaixa > 0
  );

  if (ativos.length === 0) {
    container.innerHTML = '';
    return;
  }

  // Sort: red first, then orange, green, gray
  const order = { 'border-red': 0, 'border-orange': 1, 'border-green': 2, 'border-gray': 3 };
  ativos.sort((a, b) => order[a.borderClass] - order[b.borderClass]);

  const cards = ativos.map(s => `
    <div class="usuario-ov-card ${s.borderClass}">
      <div class="usuario-ov-header">
        <div class="usuario-ov-avatar">${iniciais(s.u.nome)}</div>
        <div class="usuario-ov-nome" title="${s.u.nome}">${s.u.nome}</div>
      </div>
      <div class="ov-section-label">Como responsável</div>
      <div class="ov-stats-row">
        <div class="ov-stat red">
          <span class="ov-stat-num">${s.vencidas}</span>
          <span class="ov-stat-label">Vencidas</span>
        </div>
        <div class="ov-stat yellow">
          <span class="ov-stat-num">${s.pendenteAceite}</span>
          <span class="ov-stat-label">Pend. Aceite</span>
        </div>
        <div class="ov-stat green">
          <span class="ov-stat-num">${s.emAndamento}</span>
          <span class="ov-stat-label">Em Andamento</span>
        </div>
      </div>
      <div class="ov-section-label">Como solicitante</div>
      <div class="ov-stats-row">
        <div class="ov-stat purple">
          <span class="ov-stat-num">${s.aguardandoBaixa}</span>
          <span class="ov-stat-label">Ag. Baixa</span>
        </div>
      </div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="usuarios-overview-header">Visão por Usuário</div>
    <div class="usuario-overview-grid">${cards}</div>
  `;
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
    const hoje = new Date().toISOString().slice(0, 10);
    const vencidas = ativas.filter(d => {
      const prazo = d.data_acordada || d.data_entrega;
      return prazo && prazo < hoje;
    }).length;
    document.getElementById('total-demandas').textContent = ativas.length;
    document.getElementById('pendentes').textContent = ativas.filter(d => d.status === 'pendente_aceite').length;
    document.getElementById('em-andamento').textContent = ativas.filter(d => ['aceita', 'em_andamento'].includes(d.status)).length;
    document.getElementById('aguardando-baixa').textContent = ativas.filter(d => d.status === 'concluida_aguardando_baixa').length;
    document.getElementById('vencidas').textContent = vencidas;
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

      ${(() => {
        const prazoData = demanda.data_acordada || demanda.data_entrega;
        const calLink = gerarLinkCalendario(demanda.descricao, prazoData, demanda.horario_entrega);
        const cuLink = demanda.clickup_url || null;
        const links = [];
        if (calLink) links.push(`<a href="${calLink}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;font-size:.85rem;color:#1a73e8;text-decoration:none;font-weight:500">📅 Google Agenda</a>`);
        if (cuLink) links.push(`<a href="${cuLink}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;font-size:.85rem;color:#7b68ee;text-decoration:none;font-weight:500">🟣 Abrir no ClickUp</a>`);
        return links.length ? `<div style="display:flex;gap:16px;margin:10px 0 4px;flex-wrap:wrap">${links.join('')}</div>` : '';
      })()}

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

document.getElementById('btn-enviar-relatorio').addEventListener('click', async () => {
  const btn = document.getElementById('btn-enviar-relatorio');
  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';
  try {
    await api('/api/configuracoes/testar-relatorio', { method: 'POST', body: {} });
    btn.textContent = '✅ Enviado!';
    setTimeout(() => {
      btn.textContent = '📨 Enviar Relatório Agora';
      btn.disabled = false;
    }, 3000);
  } catch (e) {
    btn.textContent = '❌ Erro: ' + e.message;
    setTimeout(() => {
      btn.textContent = '📨 Enviar Relatório Agora';
      btn.disabled = false;
    }, 4000);
  }
});

async function carregarProximoRelatorio() {
  try {
    const config = await api('/api/configuracoes');
    const horario = config?.horario_relatorio;
    if (!horario) return;
    const badge = document.getElementById('proximo-relatorio');
    badge.textContent = `Próximo relatório: ${horario}`;
    badge.classList.add('visible');
  } catch (e) { /* silencioso */ }
}

document.getElementById('modal-close').addEventListener('click', fecharModal);
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) fecharModal();
});

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await carregarUsuarios();
  await carregarDemandas();
  carregarProximoRelatorio();

  // Auto-refresh a cada 30 segundos
  setInterval(async () => {
    await carregarDemandas();
  }, 30_000);
})();
