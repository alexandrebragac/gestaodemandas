// Helpers compartilhados pelas páginas do módulo de Atividades.
// Independente de app.js (que assume o DOM específico do dashboard de Demandas).

const ATIV_AUTH_KEY = 'gestao_auth';

function getAuth() {
  try { return JSON.parse(localStorage.getItem(ATIV_AUTH_KEY) || 'null'); } catch { return null; }
}
function getCurrentUser() { return getAuth()?.usuario || null; }
function getToken()       { return getAuth()?.token   || null; }

function requireAuth() {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = `/login.html?redirect=${encodeURIComponent(window.location.pathname)}`;
    return null;
  }
  return user;
}

function logout() {
  localStorage.removeItem(ATIV_AUTH_KEY);
  window.location.href = '/login.html';
}

async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { logout(); return; }
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

function showToast(msg, type = 'ok') {
  let toast = document.getElementById('toast-global');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast-global';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:10px 18px;border-radius:8px;font-size:.85rem;font-weight:500;z-index:9999;transition:opacity .3s;box-shadow:0 4px 16px rgba(0,0,0,.4);border:1px solid';
    document.body.appendChild(toast);
  }
  const colors = {
    ok:   { bg: 'rgba(34,197,94,.15)',   color: '#22c55e', border: 'rgba(34,197,94,.3)'  },
    err:  { bg: 'rgba(239,68,68,.15)',   color: '#ef4444', border: 'rgba(239,68,68,.3)'  },
    warn: { bg: 'rgba(245,158,11,.15)',  color: '#f59e0b', border: 'rgba(245,158,11,.3)' },
  };
  const c = colors[type] || colors.ok;
  toast.style.background = c.bg;
  toast.style.color = c.color;
  toast.style.borderColor = c.border;
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}

// Badge "Olá, Nome" + Sair no header, e destaque do link Admin — igual ao app.js do dashboard.
function montarHeaderUsuario() {
  const user = getCurrentUser();
  if (!user) return;
  if (user.perfil === 'admin') {
    const navAdmin = document.getElementById('nav-admin');
    if (navAdmin) navAdmin.style.display = '';
  }
  const headerInner = document.querySelector('.header-inner');
  if (headerInner && !headerInner.querySelector('.user-badge')) {
    const badge = document.createElement('div');
    badge.className = 'user-badge';
    badge.style.cssText = 'display:flex;align-items:center;gap:10px;margin-left:auto';
    badge.innerHTML = `
      <span style="font-size:.85rem;color:var(--text-muted)">Olá, <strong style="color:var(--text)">${user.nome.split(' ')[0]}</strong></span>
      <button onclick="logout()" style="padding:5px 12px;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:.8rem;cursor:pointer;font-family:inherit">Sair</button>
    `;
    headerInner.appendChild(badge);
  }
}
