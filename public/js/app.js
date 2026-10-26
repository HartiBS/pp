const state = { user: null, currentProject: null };

const $ = (sel) => document.querySelector(sel);

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
  $('#user-box').hidden = false;
  $('#admin-btn').hidden = user.role !== 'admin';
}

function show(view) {
  for (const v of ['auth', 'dashboard', 'project-detail', 'profile', 'admin']) {
    $(`#${v}-view`).hidden = v !== view;
  }
}

async function init() {
  try {
    const { user } = await api('/api/auth/me');
    setUser(user);
    await loadDashboard();
  } catch {
    show('auth');
  }
}

async function loadDashboard() {
  const { projects } = await api('/api/projects');
  const list = $('#project-list');
  list.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name} <small>(${p.task_count} Tasks)</small></span><span class="badge">${p.status}</span>`;
    li.onclick = () => loadProject(p.id);
    list.appendChild(li);
  }
  show('dashboard');
}

async function loadProject(id) {
  const { project, tasks } = await api(`/api/projects/${id}`);
  state.currentProject = project;
  $('#detail-name').textContent = project.name;
  $('#detail-description').textContent = project.description || '';
  $('#detail-status').textContent = project.status;
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
  show('project-detail');
}

async function loadProfile() {
  const { user } = await api('/api/auth/me');
  const form = $('#profile-form');
  form.name.value = user.name;
  form.email.value = user.email;
  form.currentPassword.value = '';
  form.newPassword.value = '';
  $('#profile-msg').textContent = '';
  show('profile');
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
  show('admin');
}

function editUser(u) {
  const form = $('#user-form');
  form.id.value = u.id;
  form.name.value = u.name;
  form.email.value = u.email;
  form.role.value = u.role;
  form.is_active.checked = u.is_active;
  form.password.value = '';
  form.password.required = false;
  form.hidden = false;
}

$('#login-form').onsubmit = async (e) => {
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
};

$('#register-form').onsubmit = async (e) => {
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
};

$('#logout-btn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  $('#user-box').hidden = true;
  show('auth');
};

$('#profile-btn').onclick = () => loadProfile();
$('#profile-back-btn').onclick = () => loadDashboard();

$('#profile-form').onsubmit = async (e) => {
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
};

$('#admin-btn').onclick = () => loadAdmin();
$('#admin-back-btn').onclick = () => loadDashboard();

$('#new-user-btn').onclick = () => {
  const form = $('#user-form');
  form.reset();
  form.id.value = '';
  form.password.required = true;
  form.hidden = false;
};
$('#cancel-user-btn').onclick = () => { $('#user-form').hidden = true; };

$('#user-form').onsubmit = async (e) => {
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
};

$('#new-project-btn').onclick = () => { $('#project-form').hidden = false; };
$('#cancel-project-btn').onclick = () => { $('#project-form').hidden = true; };

$('#project-form').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/projects', { method: 'POST', body: Object.fromEntries(fd) });
  $('#project-form').hidden = true;
  e.target.reset();
  await loadDashboard();
};

$('#task-form').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api(`/api/projects/${state.currentProject.id}/tasks`, { method: 'POST', body: Object.fromEntries(fd) });
  e.target.reset();
  await loadProject(state.currentProject.id);
};

$('#back-btn').onclick = () => loadDashboard();

init();
