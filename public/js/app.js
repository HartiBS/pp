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

function show(view) {
  $('#auth-view').hidden = view !== 'auth';
  $('#dashboard-view').hidden = view !== 'dashboard';
  $('#project-detail-view').hidden = view !== 'detail';
}

async function init() {
  try {
    const { userId } = await api('/api/auth/me');
    state.user = { id: userId };
    $('#user-box').hidden = false;
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
  show('detail');
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const { user } = await api('/api/auth/login', { method: 'POST', body: Object.fromEntries(fd) });
    state.user = user;
    $('#user-name').textContent = user.name;
    $('#user-box').hidden = false;
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
    state.user = user;
    $('#user-name').textContent = user.name;
    $('#user-box').hidden = false;
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
