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

const ISSUE_TYPE_LABELS = { epic: 'Epic', user_story: 'User Story', task: 'Task', bug: 'Bug' };

function currentFilters() {
  return {
    type: $('#filter-type').value,
    status: $('#filter-status').value,
    label: $('#filter-label').value.trim(),
    epic_only: $('#filter-epic-only').checked,
  };
}

function taskMatchesFilter(t, f) {
  if (f.epic_only && t.issue_type !== 'epic') return false;
  if (f.type && t.issue_type !== f.type) return false;
  if (f.status && t.status !== f.status) return false;
  if (f.label && !(t.labels || []).includes(f.label)) return false;
  return true;
}

function renderTaskList(tasks, readonly, projectId) {
  const list = $('#task-list');
  list.innerHTML = '';
  if (!tasks.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Keine Issues gefunden.</small></li>';
    return;
  }
  for (const t of tasks) {
    const li = document.createElement('li');
    const labelsHtml = (t.labels || []).map(l => `<span class="badge badge-todo" style="margin-right:0.25rem;">${l}</span>`).join('');
    const dueHtml = t.due_date ? ` <small>📅 ${t.due_date}</small>` : '';
    const typeBadge = `<span class="badge">${ISSUE_TYPE_LABELS[t.issue_type] || t.issue_type}</span>`;
    li.innerHTML = `<span>${typeBadge} ${t.title}${t.assignee_name ? ` <small>(${t.assignee_name})</small>` : ''}${dueHtml}<br>${labelsHtml}</span>`;
    if (!readonly) {
      const select = document.createElement('select');
      for (const s of ['todo', 'in_progress', 'review', 'done']) {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        if (t.status === s) opt.selected = true;
        select.appendChild(opt);
      }
      select.onchange = async () => {
        await api(`/api/projects/${projectId}/tasks/${t.id}`, { method: 'PUT', body: { status: select.value } });
        await loadProject(projectId);
      };
      li.appendChild(select);
    } else {
      const badge = document.createElement('span');
      badge.className = `badge ${badgeClass(t.status)}`;
      badge.textContent = t.status;
      li.appendChild(badge);
    }
    list.appendChild(li);
  }
}

function renderBoard(tasks, readonly, projectId) {
  for (const status of ['todo', 'in_progress', 'review', 'done']) {
    const col = $(`#col-${status}`);
    col.innerHTML = '';
    $('#count-' + status).textContent = '0';
  }
  const visible = tasks;
  for (const t of visible) {
    const col = $(`#col-${t.status}`);
    if (!col) continue;
    $('#count-' + t.status).textContent = String(Number($('#count-' + t.status).textContent) + 1);
    const card = document.createElement('div');
    card.className = 'board-card';
    card.draggable = !readonly;
    const labelsHtml = (t.labels || []).map(l => `<span class="badge badge-todo">${l}</span>`).join(' ');
    card.innerHTML = `<span class="badge">${ISSUE_TYPE_LABELS[t.issue_type] || t.issue_type}</span> ${t.title}<br>
      <small>${t.assignee_name || ''}${t.due_date ? ' · 📅 ' + t.due_date : ''}</small>${labelsHtml ? '<br>' + labelsHtml : ''}`;
    if (!readonly) {
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(t.id));
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    }
    col.appendChild(card);
  }
}

function renderTimeline(tasks) {
  const track = $('#timeline-track');
  track.innerHTML = '';
  const dated = tasks.filter(t => t.due_date);
  const undated = tasks.filter(t => !t.due_date);
  if (!dated.length && !undated.length) {
    track.innerHTML = '<p style="color:var(--text-muted);">Keine Issues für die Timeline vorhanden.</p>';
    return;
  }
  if (dated.length) {
    const min = new Date(Math.min(...dated.map(t => new Date(t.due_date))));
    const max = new Date(Math.max(...dated.map(t => new Date(t.due_date))));
    const today = new Date(); today.setHours(0,0,0,0);
    const start = new Date(Math.min(min, today));
    const end = new Date(Math.max(max, today));
    end.setDate(end.getDate() + 1);
    const totalDays = Math.max(1, Math.round((end - start) / 86400000));

    const header = document.createElement('div');
    header.className = 'timeline-header';
    for (let i = 0; i <= totalDays; i += Math.max(1, Math.floor(totalDays / 10))) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const cell = document.createElement('div');
      cell.className = 'timeline-date-cell';
      cell.textContent = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      header.appendChild(cell);
    }
    track.appendChild(header);

    const pos = (dateStr) => {
      const d = new Date(dateStr);
      return Math.min(100, Math.max(0, ((d - start) / 86400000 / totalDays) * 100));
    };

    for (const t of dated) {
      const row = document.createElement('div');
      row.className = 'timeline-row';
      const bar = document.createElement('div');
      bar.className = `timeline-bar ${badgeClass(t.status)}`;
      const left = pos(t.created_at ? t.created_at.slice(0, 10) : t.due_date);
      const width = Math.max(2, pos(t.due_date) - left);
      bar.style.left = left + '%';
      bar.style.width = width + '%';
      bar.title = `${t.title} (fällig: ${t.due_date})`;
      const label = document.createElement('span');
      label.className = 'timeline-label';
      label.textContent = `${ISSUE_TYPE_LABELS[t.issue_type] || ''} ${t.title}`;
      row.appendChild(label);
      row.appendChild(bar);
      track.appendChild(row);
    }
  }
  if (undated.length) {
    const section = document.createElement('div');
    section.style.marginTop = '1rem';
    section.innerHTML = '<h4>Ohne Fälligkeitsdatum</h4>';
    const ul = document.createElement('ul');
    ul.className = 'dash-list';
    for (const t of undated) {
      const li = document.createElement('li');
      li.innerHTML = `<span><span class="badge">${ISSUE_TYPE_LABELS[t.issue_type] || t.issue_type}</span> ${t.title}</span><span class="badge ${badgeClass(t.status)}">${t.status}</span>`;
      ul.appendChild(li);
    }
    section.appendChild(ul);
    track.appendChild(section);
  }
}

function renderDashboard(data) {
  const k = data.kpis;
  $('#kpi-open').textContent = k.open_tasks;
  $('#kpi-done').textContent = k.done_tasks;
  $('#kpi-progress').textContent = k.in_progress;
  $('#kpi-overdue').textContent = k.overdue;
  $('#kpi-epics').textContent = k.epics;
  $('#kpi-bugs').textContent = k.bugs;

  renderSimpleBars('#dash-status-list', data.byStatus, 'status');
  renderSimpleBars('#dash-type-list', data.byType, 'issue_type', ISSUE_TYPE_LABELS);

  const actList = $('#dash-activity-list');
  actList.innerHTML = '';
  for (const a of data.activity) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${a.title}</span><small>${a.actor || ''} · ${new Date(a.updated_at).toLocaleString('de-DE')}</small>`;
    actList.appendChild(li);
  }

  const upList = $('#dash-upcoming-list');
  upList.innerHTML = '';
  if (!data.upcoming.length) {
    upList.innerHTML = '<li><small style="color:var(--text-muted);">Keine Fälligkeiten.</small></li>';
  }
  for (const u of data.upcoming) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${u.title}</span><small>📅 ${u.due_date}</small>`;
    upList.appendChild(li);
  }

  drawBurndown(data.burndown);
}

function renderSimpleBars(selector, rows, keyField, labelMap) {
  const list = $(selector);
  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Keine Daten.</small></li>';
    return;
  }
  const max = Math.max(...rows.map(r => r.count));
  for (const r of rows) {
    const li = document.createElement('li');
    const label = labelMap ? (labelMap[r[keyField]] || r[keyField]) : r[keyField];
    const pct = max ? Math.round((r.count / max) * 100) : 0;
    li.innerHTML = `<span>${label} (${r.count})</span><div class="dash-bar"><div style="width:${pct}%;"></div></div>`;
    list.appendChild(li);
  }
}

function drawBurndown(rows) {
  const svg = $('#burndown-chart');
  svg.innerHTML = '';
  if (!rows || rows.length < 2) {
    svg.innerHTML = '<text x="20" y="100" fill="var(--text-muted)" font-size="13">Zu wenig Daten für Burndown.</text>';
    return;
  }
  const W = 560, H = 200, padL = 40, padB = 24, padT = 12, padR = 10;
  const maxVal = Math.max(...rows.map(r => r.open), 1);
  const stepX = (W - padL - padR) / (rows.length - 1);
  const points = rows.map((r, i) => {
    const x = padL + i * stepX;
    const y = padT + (H - padT - padB) * (1 - r.open / maxVal);
    return [x, y];
  });
  const line = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', line);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--accent-light)');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);
  for (const [x, y] of points) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 3);
    c.setAttribute('fill', 'var(--accent-light)');
    svg.appendChild(c);
  }
  const firstDate = new Date(rows[0].date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const lastDate = new Date(rows[rows.length - 1].date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const t1 = document.createElementNS(ns, 'text');
  t1.setAttribute('x', padL); t1.setAttribute('y', H - 6); t1.setAttribute('fill', 'var(--text-muted)'); t1.setAttribute('font-size', '11');
  t1.textContent = firstDate;
  svg.appendChild(t1);
  const t2 = document.createElementNS(ns, 'text');
  t2.setAttribute('x', W - padR - 30); t2.setAttribute('y', H - 6); t2.setAttribute('fill', 'var(--text-muted)'); t2.setAttribute('font-size', '11');
  t2.textContent = lastDate;
  svg.appendChild(t2);
  const t3 = document.createElementNS(ns, 'text');
  t3.setAttribute('x', 4); t3.setAttribute('y', padT + 4); t3.setAttribute('fill', 'var(--text-muted)'); t3.setAttribute('font-size', '11');
  t3.textContent = maxVal;
  svg.appendChild(t3);
}

function setProjectTab(tab) {
  state.projectTab = tab;
  for (const [name, btnId, viewId] of [
    ['dashboard', 'tab-dashboard-btn', 'proj-dashboard-view'],
    ['list', 'tab-list-btn', 'proj-list-view'],
    ['board', 'tab-board-btn', 'proj-board-view'],
    ['timeline', 'tab-timeline-btn', 'proj-timeline-view'],
  ]) {
    $(`#${btnId}`).classList.toggle('active', name === tab);
    $(`#${viewId}`).hidden = name !== tab;
  }
}

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

  state.allTasks = tasks;
  renderCurrentProjectView(readonly, id);
  if (state.projectTab === 'dashboard') {
    loadProjectDashboard(id);
  }
  show('project-detail-view');
}

function renderCurrentProjectView(readonly, projectId) {
  const tasks = state.allTasks || [];
  const f = currentFilters();
  const filtered = tasks.filter(t => taskMatchesFilter(t, f));
  $('#filter-bar').hidden = state.projectTab === 'dashboard';

  if (state.projectTab === 'list') {
    renderTaskList(filtered, readonly, projectId);
  } else if (state.projectTab === 'board') {
    renderBoard(filtered, readonly, projectId);
  } else if (state.projectTab === 'timeline') {
    renderTimeline(filtered);
  }
}

async function loadProjectDashboard(projectId) {
  try {
    const data = await api(`/api/projects/${projectId}/dashboard`);
    renderDashboard(data);
  } catch (err) {
    console.error('Dashboard konnte nicht geladen werden:', err.message);
  }
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
    const labels = (fd.get('labels') || '').split(',').map(s => s.trim()).filter(Boolean);
    const body = {
      title: fd.get('title'),
      issue_type: fd.get('issue_type') || 'task',
      labels,
      due_date: fd.get('due_date') || null,
    };
    await api(`/api/projects/${state.currentProject.id}/tasks`, { method: 'POST', body });
    e.target.reset();
    await loadProject(state.currentProject.id);
  }
});

bind('#back-btn', () => loadDashboard());

bind('#tab-dashboard-btn', () => { setProjectTab('dashboard'); loadProjectDashboard(state.currentProject.id); });
bind('#tab-list-btn', () => { setProjectTab('list'); renderCurrentProjectView(!canEdit(state.myProjectRole), state.currentProject.id); });
bind('#tab-board-btn', () => { setProjectTab('board'); renderCurrentProjectView(!canEdit(state.myProjectRole), state.currentProject.id); });
bind('#tab-timeline-btn', () => { setProjectTab('timeline'); renderCurrentProjectView(!canEdit(state.myProjectRole), state.currentProject.id); });

for (const el of ['#filter-type', '#filter-status', '#filter-label', '#filter-epic-only']) {
  const node = $(el);
  if (node) node.addEventListener('change', () => renderCurrentProjectView(!canEdit(state.myProjectRole), state.currentProject.id));
}
bind('#filter-reset-btn', () => {
  $('#filter-type').value = '';
  $('#filter-status').value = '';
  $('#filter-label').value = '';
  $('#filter-epic-only').checked = false;
  renderCurrentProjectView(!canEdit(state.myProjectRole), state.currentProject.id);
});

for (const status of ['todo', 'in_progress', 'review', 'done']) {
  const col = $(`#col-${status}`);
  if (!col) continue;
  col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
  col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
  col.addEventListener('drop', async (e) => {
    e.preventDefault();
    col.classList.remove('drag-over');
    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId || !state.currentProject) return;
    try {
      await api(`/api/projects/${state.currentProject.id}/tasks/${taskId}`, { method: 'PUT', body: { status } });
      await loadProject(state.currentProject.id);
    } catch (err) {
      alert(err.message);
    }
  });
}

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
