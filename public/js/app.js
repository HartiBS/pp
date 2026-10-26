const state = { user: null, currentProject: null };

const $ = (sel) => document.querySelector(sel);

/* ===== THEME TOGGLE ===== */
function initTheme() {
  const toggle = $('#theme-toggle');
  const isLight = document.body.classList.contains('light');
  toggle.textContent = isLight ? '🌙' : '☀️';
  toggle.onclick = () => {
    document.body.classList.toggle('light');
    const nowLight = document.body.classList.contains('light');
    toggle.textContent = nowLight ? '🌙' : '☀️';
    localStorage.setItem('pp-theme', nowLight ? 'light' : 'dark');
  };
}

function badgeClass(status) {
  const map = {
    todo: 'badge-todo',
    in_progress: 'badge-in_progress',
    review: 'badge-review',
    done: 'badge-done',
    active: 'badge-active',
    planning: 'badge-planning',
  };
  return map[status] || 'badge-todo';
}

function avatarInitials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler');
  return data;
}

function setUser(user) {
  state.user = user;
  $('#user-name').textContent = user.name;
  $('#user-avatar').textContent = avatarInitials(user.name);
  $('#user-box').hidden = false;
  const adminBtn = $('#admin-btn');
  if (adminBtn) adminBtn.hidden = user.role !== 'admin';
}

const VIEWS = ['auth-view', 'dashboard-view', 'project-detail-view', 'profile-view', 'admin-view'];

function show(viewId) {
  for (const id of VIEWS) {
    $(`#${id}`).hidden = id !== viewId;
  }
}

async function init() {
  initTheme();
  try {
    const { user } = await api('/api/auth/me');
    setUser(user);
    await loadDashboard();
  } catch {
    show('auth-view');
  }
}

async function loadDashboard() {
  const { projects } = await api('/api/projects');
  const list = $('#project-list');
  list.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name} <small>(${p.task_count} Tasks)</small></span><span class="badge ${badgeClass(p.status)}">${p.status}</span>`;
    li.onclick = () => loadProject(p.id);
    list.appendChild(li);
  }
  show('dashboard-view');
}

async function loadProject(id) {
  const { project, tasks } = await api(`/api/projects/${id}`);
  state.currentProject = project;
  $('#detail-name').textContent = project.name;
  $('#detail-description').textContent = project.description || '';
  const statusBadge = $('#detail-status');
  statusBadge.textContent = project.status;
  statusBadge.className = `badge ${badgeClass(project.status)}`;
  const list = $('#task-list');
  list.innerHTML = '';
  for (const t of tasks) {
    const li = document.createElement('li');
    const select = document.createElement('select');
    for (const s of ['todo', 'in_progress', 'review', 'done']) {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      if (t.status === s) opt.selected = true;
      select.appendChild(opt);
    }
    select.onchange = () => api(`/api/projects/${id}/tasks/${t.id}`, { method: 'PUT', body: { status: select.value } });
    li.innerHTML = `<span>${t.title}</span>`;
    li.appendChild(select);
    list.appendChild(li);
  }
  show('project-detail-view');
}

async function loadProfile() {
  const { user } = await api('/api/auth/me');
  const form = $('#profile-form');
  form.firstName.value = user.first_name || '';
  form.lastName.value = user.last_name || '';
  form.username.value = user.username || '';
  form.email.value = user.email;
  form.currentPassword.value = '';
  form.newPassword.value = '';
  $('#profile-msg').textContent = '';
  show('profile-view');
}

async function loadAdmin() {
  const { users } = await api('/api/admin/users');
  const tbody = $('#user-table tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    const roleLabel = { admin: 'Admin', projektmanager: 'Projektmanager', entwickler: 'Entwickler', beobachter: 'Beobachter' }[u.role] || u.role;
    tr.innerHTML = `
      <td>${u.name}</td>
      <td>@${u.username}</td>
      <td>${u.email}</td>
      <td><span class="badge">${roleLabel}</span></td>
      <td>${u.is_active ? 'aktiv' : 'deaktiviert'}</td>
      <td>
        <button class="edit-user-btn">Bearbeiten</button>
        <button class="toggle-user-btn">${u.is_active ? 'Deaktivieren' : 'Aktivieren'}</button>
        <button class="delete-user-btn">Löschen</button>
      </td>`;
    tr.querySelector('.edit-user-btn').onclick = () => editUser(u);
    tr.querySelector('.toggle-user-btn').onclick = async () => {
      await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { is_active: !u.is_active } });
      await loadAdmin();
    };
    tr.querySelector('.delete-user-btn').onclick = async () => {
      if (!confirm(`Benutzer ${u.name} wirklich löschen?`)) return;
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      await loadAdmin();
    };
    tbody.appendChild(tr);
  }
  show('admin-view');
}

function editUser(u) {
  const form = $('#user-form');
  form.id.value = u.id;
  form.firstName.value = u.first_name || '';
  form.lastName.value = u.last_name || '';
  form.username.value = u.username || '';
  form.email.value = u.email;
  form.role.value = u.role;
  form.is_active.checked = u.is_active;
  form.password.value = '';
  form.password.required = false;
  form.hidden = false;
}

function bind(id, handler) {
  const el = $(id);
  if (!el) {
    console.error(`Element nicht gefunden: ${id}`);
    return;
  }
  el.onclick = handler;
}

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'login-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: Object.fromEntries(fd) });
      setUser(user);
      $('#auth-error').hidden = true;
      await loadDashboard();
    } catch (err) {
      $('#auth-error').textContent = err.message;
      $('#auth-error').hidden = false;
    }
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'register-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { user } = await api('/api/auth/register', { method: 'POST', body: Object.fromEntries(fd) });
      setUser(user);
      $('#auth-error').hidden = true;
      await loadDashboard();
    } catch (err) {
      $('#auth-error').textContent = err.message;
      $('#auth-error').hidden = false;
    }
  }
});

bind('#logout-btn', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  $('#user-box').hidden = true;
  show('auth-view');
});

bind('#profile-btn', () => loadProfile());
bind('#profile-back-btn', () => loadDashboard());

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'profile-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd);
    if (!body.currentPassword) delete body.currentPassword;
    if (!body.newPassword) delete body.newPassword;
    try {
      const { user } = await api('/api/auth/profile', { method: 'PUT', body });
      setUser(user);
      $('#profile-msg').textContent = 'Profil gespeichert.';
    } catch (err) {
      $('#profile-msg').textContent = err.message;
    }
  }
});

bind('#admin-btn', () => loadAdmin());
bind('#admin-back-btn', () => loadDashboard());

bind('#new-user-btn', () => {
  const form = $('#user-form');
  form.reset();
  form.id.value = '';
  form.password.required = true;
  form.hidden = false;
});
bind('#cancel-user-btn', () => { $('#user-form').hidden = true; });

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'user-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd);
    body.is_active = fd.get('is_active') === 'on';
    if (!body.password) delete body.password;
    try {
      if (body.id) {
        delete body.id;
        await api(`/api/admin/users/${e.target.id.value}`, { method: 'PUT', body });
      } else {
        await api('/api/admin/users', { method: 'POST', body });
      }
      $('#user-form').hidden = true;
      await loadAdmin();
    } catch (err) {
      alert(err.message);
    }
  }
});

bind('#new-project-btn', () => { $('#project-form').hidden = false; });
bind('#cancel-project-btn', () => { $('#project-form').hidden = true; });

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'project-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/projects', { method: 'POST', body: Object.fromEntries(fd) });
    $('#project-form').hidden = true;
    e.target.reset();
    await loadDashboard();
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'task-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api(`/api/projects/${state.currentProject.id}/tasks`, { method: 'POST', body: Object.fromEntries(fd) });
    e.target.reset();
    await loadProject(state.currentProject.id);
  }
});

bind('#back-btn', () => loadDashboard());

init();
