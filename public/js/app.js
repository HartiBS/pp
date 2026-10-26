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

const VIEWS = ['auth-view', 'dashboard-view', 'project-detail-view', 'profile-view', 'admin-view', 'gitlab-issue-view'];

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
    const roleBadge = p.my_role ? `<span class="badge">${PROJECT_ROLE_LABELS[p.my_role] || p.my_role}</span>` : '';
    li.innerHTML = `<span>${p.name} <small>(${p.task_count} Tasks)</small></span><span style="display:flex; gap:0.4rem;">${roleBadge}<span class="badge ${badgeClass(p.status)}">${p.status}</span></span>`;
    li.onclick = () => loadProject(p.id);
    list.appendChild(li);
  }
  show('dashboard-view');
}

const PROJECT_ROLE_LABELS = {
  projektmanager: 'Projektmanager',
  entwickler: 'Entwickler',
  beobachter: 'Beobachter',
  admin: 'Admin',
};

const canEdit = (role) => role === 'admin' || role === 'projektmanager' || role === 'entwickler';
const canManageMembers = (role) => role === 'admin' || role === 'projektmanager';

function renderMembers(members, project, myRole) {
  const list = $('#member-list');
  list.innerHTML = '';

  const ownerLi = document.createElement('li');
  ownerLi.innerHTML = `<span>${project.owner_name || 'Owner'} <small>(Owner)</small></span><span class="badge">Projektmanager</span>`;
  list.appendChild(ownerLi);

  for (const m of members) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${m.name} <small>${m.email}</small></span><span class="badge">${PROJECT_ROLE_LABELS[m.role] || m.role}</span>`;
    if (canManageMembers(myRole)) {
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Entfernen';
      removeBtn.className = 'btn-secondary';
      removeBtn.onclick = async () => {
        if (!confirm(`${m.name} aus dem Projekt entfernen?`)) return;
        await api(`/api/projects/${project.id}/members/${m.id}`, { method: 'DELETE' });
        await loadProject(project.id);
      };
      li.appendChild(removeBtn);
    }
    list.appendChild(li);
  }

  $('#add-member-btn').hidden = !canManageMembers(myRole);
  $('#member-form').hidden = true;
}

async function loadProject(id) {
  const { project, tasks, members } = await api(`/api/projects/${id}`);
  state.currentProject = project;
  state.myProjectRole = project.my_role;
  $('#detail-name').textContent = project.name;
  $('#detail-description').textContent = project.description || '';
  const statusBadge = $('#detail-status');
  statusBadge.textContent = project.status;
  statusBadge.className = `badge ${badgeClass(project.status)}`;
  const roleBadge = $('#my-role-badge');
  roleBadge.textContent = PROJECT_ROLE_LABELS[project.my_role] || project.my_role;

  renderMembers(members || [], project, project.my_role);

  const readonly = !canEdit(project.my_role);
  $('#task-form').hidden = readonly;

  const gitlabBlock = $('#gitlab-block');
  gitlabBlock.hidden = false;
  $('#gitlab-project-id-input').value = project.gitlab_project_id || '';
  $('#sync-gitlab-btn').disabled = !project.gitlab_project_id;
  $('#new-gitlab-issue-btn').hidden = readonly || !project.gitlab_project_id;
  loadGitLabIssues(id);

  const list = $('#task-list');
  list.innerHTML = '';
  for (const t of tasks) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${t.title}${t.assignee_name ? ` <small>(${t.assignee_name})</small>` : ''}</span>`;
    if (!readonly) {
      const select = document.createElement('select');
      for (const s of ['todo', 'in_progress', 'review', 'done']) {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        if (t.status === s) opt.selected = true;
        select.appendChild(opt);
      }
      select.onchange = () => api(`/api/projects/${id}/tasks/${t.id}`, { method: 'PUT', body: { status: select.value } });
      li.appendChild(select);
    } else {
      const badge = document.createElement('span');
      badge.className = `badge ${badgeClass(t.status)}`;
      badge.textContent = t.status;
      li.appendChild(badge);
    }
    list.appendChild(li);
  }
  show('project-detail-view');
}

function renderGitLabIssues(issues) {
  const list = $('#gitlab-issue-list');
  list.innerHTML = '';
  if (!issues.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Keine Issues synchronisiert. Jetzt synchronisieren oder neu anlegen.</small></li>';
    return;
  }
  for (const issue of issues) {
    const li = document.createElement('li');
    const stateBadge = issue.state === 'opened'
      ? '<span class="badge badge-active">offen</span>'
      : '<span class="badge badge-done">geschlossen</span>';
    li.innerHTML = `<span>#${issue.gitlab_iid} ${issue.title}</span>${stateBadge}`;
    li.style.cursor = 'pointer';
    li.onclick = () => loadGitLabIssue(issue);
    list.appendChild(li);
  }
}

async function loadGitLabIssues(projectId) {
  try {
    const { issues } = await api(`/api/gitlab/projects/${projectId}/issues`);
    renderGitLabIssues(issues);
  } catch (err) {
    console.error('GitLab-Issues konnten nicht geladen werden:', err.message);
  }
}

async function loadGitLabSettings() {
  try {
    const s = await api('/api/gitlab/settings');
    $('#gitlab-settings-form').base_url.value = s.base_url || '';
    $('#gitlab-settings-form').access_token.value = '';
    $('#gitlab-settings-msg').textContent = s.configured
      ? `Konfiguriert: ${s.base_url} (Token gesetzt)`
      : 'Noch nicht konfiguriert.';
  } catch (err) {
    $('#gitlab-settings-msg').textContent = err.message;
  }
}

async function loadGitLabIssue(issue) {
  state.currentGitLabIssue = issue;
  $('#gi-title').textContent = `#${issue.gitlab_iid} ${issue.title}`;
  $('#gi-description').textContent = issue.description || '(keine Beschreibung)';
  const stateBadge = $('#gi-state');
  stateBadge.textContent = issue.state === 'opened' ? 'offen' : 'geschlossen';
  stateBadge.className = `badge ${issue.state === 'opened' ? 'badge-active' : 'badge-done'}`;
  $('#gi-close-btn').hidden = issue.state !== 'opened';
  $('#gi-reopen-btn').hidden = issue.state !== 'closed';
  $('#gi-web-link').href = issue.web_url || '#';
  const commentList = $('#gi-comment-list');
  commentList.innerHTML = '<li><small>Lade Kommentare...</small></li>';
  show('gitlab-issue-view');
  try {
    const { comments } = await api(`/api/gitlab/projects/${state.currentProject.id}/issues/${issue.gitlab_iid}/comments`);
    commentList.innerHTML = '';
    if (!comments.length) {
      commentList.innerHTML = '<li><small style="color:var(--text-muted);">Noch keine Kommentare.</small></li>';
    }
    for (const c of comments) {
      const li = document.createElement('li');
      li.innerHTML = `<small>${c.author && c.author.name ? c.author.name : 'Unbekannt'} · ${new Date(c.created_at).toLocaleString('de-DE')}</small><br>${c.body}`;
      commentList.appendChild(li);
    }
  } catch (err) {
    commentList.innerHTML = `<li><small class="error">Kommentare konnten nicht geladen werden: ${err.message}</small></li>`;
  }
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
  loadGitLabSettings();
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
    const userId = body.id;
    delete body.id;
    try {
      if (userId) {
        await api(`/api/admin/users/${userId}`, { method: 'PUT', body });
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

bind('#test-gitlab-btn', async () => {
  const msg = $('#gitlab-settings-msg');
  msg.textContent = 'Teste Verbindung...';
  try {
    const fd = new FormData($('#gitlab-settings-form'));
    await api('/api/gitlab/settings', { method: 'PUT', body: Object.fromEntries(fd) });
    const { ok } = await api('/api/gitlab/settings/test', { method: 'POST' });
    if (ok) msg.textContent = 'Verbindung erfolgreich! ✅';
  } catch (err) {
    msg.textContent = `Fehler: ${err.message}`;
  }
});

bind('#sync-gitlab-btn', async () => {
  const btn = $('#sync-gitlab-btn');
  btn.disabled = true;
  btn.textContent = 'Synchronisiere...';
  try {
    const { issues } = await api(`/api/gitlab/projects/${state.currentProject.id}/sync`, { method: 'POST' });
    renderGitLabIssues(issues);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Synchronisieren';
  }
});

bind('#new-gitlab-issue-btn', () => { $('#gitlab-issue-form').hidden = false; });
bind('#cancel-gitlab-issue-btn', () => { $('#gitlab-issue-form').hidden = true; });

bind('#gitlab-issue-back-btn', () => loadProject(state.currentProject.id));

bind('#gi-close-btn', async () => {
  const issue = state.currentGitLabIssue;
  try {
    await api(`/api/gitlab/projects/${state.currentProject.id}/issues/${issue.gitlab_iid}`, {
      method: 'PUT', body: { state_event: 'close' },
    });
    await loadGitLabIssue({ ...issue, state: 'closed' });
    await loadGitLabIssues(state.currentProject.id);
  } catch (err) { alert(err.message); }
});

bind('#gi-reopen-btn', async () => {
  const issue = state.currentGitLabIssue;
  try {
    await api(`/api/gitlab/projects/${state.currentProject.id}/issues/${issue.gitlab_iid}`, {
      method: 'PUT', body: { state_event: 'reopen' },
    });
    await loadGitLabIssue({ ...issue, state: 'opened' });
    await loadGitLabIssues(state.currentProject.id);
  } catch (err) { alert(err.message); }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'gitlab-settings-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/gitlab/settings', { method: 'PUT', body: Object.fromEntries(fd) });
      $('#gitlab-settings-msg').textContent = 'GitLab-Einstellungen gespeichert.';
      e.target.access_token.value = '';
    } catch (err) {
      $('#gitlab-settings-msg').textContent = err.message;
    }
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'gitlab-project-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const value = fd.get('gitlab_project_id');
    try {
      await api(`/api/projects/${state.currentProject.id}`, {
        method: 'PUT',
        body: { gitlab_project_id: value === '' ? null : Number(value) },
      });
      await loadProject(state.currentProject.id);
    } catch (err) { alert(err.message); }
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'gitlab-issue-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/gitlab/projects/${state.currentProject.id}/issues`, {
        method: 'POST', body: Object.fromEntries(fd),
      });
      $('#gitlab-issue-form').hidden = true;
      e.target.reset();
      await loadGitLabIssues(state.currentProject.id);
    } catch (err) { alert(err.message); }
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'gi-comment-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/gitlab/projects/${state.currentProject.id}/issues/${state.currentGitLabIssue.gitlab_iid}/comments`, {
        method: 'POST', body: { note: fd.get('note') },
      });
      e.target.reset();
      await loadGitLabIssue(state.currentGitLabIssue);
    } catch (err) { alert(err.message); }
  }
});

bind('#add-member-btn', async () => {
  const select = $('#member-user-select');
  select.innerHTML = '';
  try {
    const { users } = await api('/api/admin/users');
    const memberIds = (state.currentProject.members || []).map(m => m.id);
    for (const u of users) {
      if (!u.is_active) continue;
      if (u.id === state.currentProject.owner_id) continue;
      if (memberIds.includes(u.id)) continue;
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = `${u.name} (${u.email})`;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error(err);
  }
  $('#member-form').hidden = false;
});
bind('#cancel-member-btn', () => { $('#member-form').hidden = true; });

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'member-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/projects/${state.currentProject.id}/members`, {
        method: 'POST',
        body: { user_id: Number(fd.get('user_id')), role: fd.get('role') },
      });
      await loadProject(state.currentProject.id);
    } catch (err) {
      alert(err.message);
    }
  }
});

init();
