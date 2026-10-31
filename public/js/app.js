const state = { user: null, currentProject: null, currentProjectCustomFieldDefs: [] };

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

async function api(path, options = {}, isRetry = false) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const isWrite = options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase());
  if (isWrite && state.csrfToken) {
    headers['X-CSRF-Token'] = state.csrfToken;
  }
  const res = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && data.error === 'Ungültiges oder fehlendes CSRF-Token' && !isRetry) {
      state.csrfToken = null;
      await fetchCsrfToken();
      return api(path, options, true);
    }
    throw new Error(data.error || 'Fehler');
  }
  return data;
}

async function fetchCsrfToken() {
  try {
    const { csrfToken } = await api('/api/csrf-token');
    state.csrfToken = csrfToken;
  } catch (err) {
    console.error('CSRF-Token konnte nicht geladen werden:', err.message);
  }
}

function setUser(user) {
  state.user = user;
  $('#user-name').textContent = user.name;
  $('#user-avatar').textContent = avatarInitials(user.name);
  $('#user-box').hidden = false;
  const adminMenu = $('#admin-menu-wrapper');
  if (adminMenu) {
    const roles = user.roles || [];
    adminMenu.hidden = !(roles.includes('admin') || roles.includes('projektmanager'));
  }
}

const VIEWS = ['auth-view', 'dashboard-view', 'project-detail-view', 'profile-view', 'admin-view', 'gitlab-issue-view', 'gitlab-projects-view', 'task-detail-view', 'my-tasks-view'];

function show(viewId) {
  for (const id of VIEWS) {
    const el = $(`#${id}`);
    if (!el) {
      console.error(`View-Element nicht gefunden: #${id}`);
      continue;
    }
    el.hidden = id !== viewId;
  }
}

async function init() {
  initTheme();
  await fetchCsrfToken();
  loadAppVersion();
  try {
    const { user } = await api('/api/auth/me');
    setUser(user);
    await loadDashboard();
    loadNotifications();
    setInterval(loadNotifications, 60000);
  } catch {
    show('auth-view');
  }
}

// #110: Version im Footer (links unten) anzeigen
async function loadAppVersion() {
  const el = $('#app-version');
  if (!el) return;
  try {
    const { version } = await api('/api/version');
    el.textContent = `v${version}`;
  } catch {
    el.textContent = '';
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
  const cfSelect = $('#filter-custom-field');
  const cfId = cfSelect && !cfSelect.hidden ? cfSelect.value : '';
  const cfValue = ($('#filter-custom-field-value')?.value || '').trim();
  return {
    type: $('#filter-type').value,
    status: $('#filter-status').value,
    priority: $('#filter-priority') ? $('#filter-priority').value : '',
    sort: $('#filter-sort') ? $('#filter-sort').value : '',
    label: $('#filter-label').value.trim(),
    epic_only: $('#filter-epic-only').checked,
    cf_id: cfId,
    cf_value: cfValue,
  };
}

function taskMatchesFilter(t, f) {
  if (f.epic_only && t.issue_type !== 'epic') return false;
  if (f.type && t.issue_type !== f.type) return false;
  if (f.status && t.status !== f.status) return false;
  if (f.priority && (t.priority || 'normal') !== f.priority) return false;
  if (f.label && !(t.labels || []).includes(f.label)) return false;
  // #71: clientseitiger Custom-Field-Filter (serverseitig zusätzlich via ?cf_<id>=)
  if (f.cf_id && f.cf_value) {
    const v = (t.custom_fields || {})[f.cf_id];
    if (v === null || v === undefined || String(v) !== f.cf_value) return false;
  }
  return true;
}

function sortTasks(tasks, sort) {
  if (!sort) return tasks;
  const prioRank = { critical: 1, high: 2, normal: 3, low: 4 };
  const arr = [...tasks];
  if (sort === 'priority') {
    arr.sort((a, b) => (prioRank[a.priority || 'normal'] - prioRank[b.priority || 'normal']) || (b.created_at || '').localeCompare(a.created_at || ''));
  } else if (sort === 'due_date') {
    arr.sort((a, b) => ((a.due_date || '9999') .localeCompare(b.due_date || '9999')) || (b.created_at || '').localeCompare(a.created_at || ''));
  } else if (sort === 'title') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }
  return arr;
}

function populateAssigneeSelect(members, project, readonly) {
  const select = $('#task-assignee-select');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Mir zuweisen</option>';
  const people = [{ id: state.user.id, name: state.user.name + ' (ich)' }];
  if (project && project.owner_id !== state.user.id) {
    people.push({ id: project.owner_id, name: (project.owner_name || 'Owner') + ' (Owner)' });
  }
  for (const m of (members || [])) {
    if (m.id !== state.user.id) people.push({ id: m.id, name: m.name });
  }
  for (const p of people) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
  if (current) select.value = current;
  select.disabled = readonly;
}

function populateMilestoneSelect(milestones, readonly) {
  const select = $('#task-milestone-select');
  if (!select) return;
  const hasMilestones = milestones && milestones.length > 0;
  select.hidden = !hasMilestones;
  const current = select.value;
  select.innerHTML = '<option value="">Kein Meilenstein</option>';
  for (const m of (milestones || [])) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.title}${m.due_date ? ' (' + m.due_date + ')' : ''}`;
    select.appendChild(opt);
  }
  if (current) select.value = current;
  select.disabled = readonly;
}

async function loadMilestones(projectId) {
  try {
    const { milestones } = await api(`/api/gitlab/projects/${projectId}/milestones`);
    state.milestones = milestones;
    populateMilestoneSelect(milestones, !canEdit(state.myProjectRole));
    renderMilestoneList(milestones);
  } catch (err) {
    state.milestones = [];
  }
}

function renderMilestoneList(milestones) {
  const block = $('#milestone-block');
  const list = $('#milestone-list');
  if (!milestones || !milestones.length) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  list.innerHTML = '';
  for (const m of milestones) {
    const li = document.createElement('li');
    const stateBadge = m.state === 'active'
      ? '<span class="badge badge-active">aktiv</span>'
      : '<span class="badge badge-done">geschlossen</span>';
    li.innerHTML = `<span>${m.title}${m.due_date ? ` <small>📅 ${m.due_date}</small>` : ''}</span>${stateBadge}`;
    list.appendChild(li);
  }
}

async function loadNotifications() {
  try {
    const { notifications, unread } = await api('/api/notifications');
    state.notifications = notifications;
    const badge = $('#notif-badge');
    if (unread > 0) {
      badge.hidden = false;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    } else {
      badge.hidden = true;
    }
    renderNotificationList(notifications);
  } catch (err) {
    console.error('Benachrichtigungen konnten nicht geladen werden:', err.message);
  }
}

function renderNotificationList(notifications) {
  const list = $('#notif-list');
  list.innerHTML = '';
  if (!notifications.length) {
    list.innerHTML = '<li class="notif-empty">Keine Benachrichtigungen.</li>';
    return;
  }
  for (const n of notifications) {
    const li = document.createElement('li');
    li.className = n.read_at ? 'notif-item read' : 'notif-item unread';
    const icons = { assigned: '👤', status_change: '🔄', comment: '💬', mention: '@', milestone: '🎯' };
    li.innerHTML = `<span class="notif-icon">${icons[n.type] || '🔔'}</span>
      <div><strong>${n.title}</strong><br><small>${n.body || ''}</small><br>
      <small class="notif-time">${new Date(n.created_at).toLocaleString('de-DE')}</small></div>`;
    li.onclick = async () => {
      if (!n.read_at) await api(`/api/notifications/${n.id}/read`, { method: 'POST' });
      if (n.link && state.currentProject) {
        $('#notif-dropdown').hidden = true;
        await loadProject(state.currentProject.id);
      }
    };
    list.appendChild(li);
  }
}

async function loadGitLabProjects(search = '') {
  const list = $('#gitlab-project-list');
  list.innerHTML = '<li><small>Lade Projekte...</small></li>';
  try {
    const { projects, groups } = await api(`/api/gitlab/projects-list?search=${encodeURIComponent(search)}`);
    list.innerHTML = '';
    if (!projects.length) {
      list.innerHTML = '<li><small style="color:var(--text-muted);">Keine Projekte gefunden.</small></li>';
    }
    for (const p of projects) {
      const li = document.createElement('li');
      li.innerHTML = `<span><strong>${p.name}</strong><br><small>${p.path_with_namespace}</small></span>
        <button class="pick-project-btn btn-secondary" data-id="${p.id}" data-name="${p.name}">Verknüpfen…</button>`;
      li.querySelector('.pick-project-btn').onclick = () => pickGitLabProject(p);
      list.appendChild(li);
    }
    const groupsBlock = $('#gitlab-groups-block');
    const groupList = $('#gitlab-group-list');
    if (groups.length) {
      groupsBlock.hidden = false;
      groupList.innerHTML = '';
      for (const g of groups) {
        const li = document.createElement('li');
        li.innerHTML = `<span><strong>${g.name}</strong><br><small>${g.full_path}</small></span><a href="${g.web_url}" target="_blank" rel="noopener">↗</a>`;
        groupList.appendChild(li);
      }
    } else {
      groupsBlock.hidden = true;
    }
  } catch (err) {
    list.innerHTML = `<li><small class="error">Fehler: ${err.message}</small></li>`;
  }
  show('gitlab-projects-view');
}

function pickGitLabProject(p) {
  if (!state.currentProject) {
    alert('Bitte zuerst ein Projekt öffnen.');
    return;
  }
  if (!confirm(`GitLab-Projekt „${p.name}" (${p.path_with_namespace}) mit „${state.currentProject.name}" verknüpfen?`)) return;
  api(`/api/projects/${state.currentProject.id}`, {
    method: 'PUT',
    body: { gitlab_project_id: p.id },
  }).then(() => loadProject(state.currentProject.id))
    .catch(err => alert(err.message));
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
    const gitlabBadge = t.gitlab_iid ? ` <span class="badge badge-active" title="Mit GitLab synchronisiert">GL #${t.gitlab_iid}</span>` : '';
    li.innerHTML = `<span>${typeBadge}${gitlabBadge} ${t.title}${t.assignee_name ? ` <small>(${t.assignee_name})</small>` : ''}${dueHtml}<br>${labelsHtml}</span>`;
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
  populateAssigneeSelect(members || [], project, readonly);
  loadMilestones(id);

  const gitlabBlock = $('#gitlab-block');
  if (gitlabBlock) gitlabBlock.hidden = false;
  const glProjectIdInput = $('#gitlab-project-id-input');
  if (glProjectIdInput) glProjectIdInput.value = project.gitlab_project_id || '';
  const syncGitlabBtn = $('#sync-gitlab-btn');
  if (syncGitlabBtn) syncGitlabBtn.disabled = !project.gitlab_project_id;
  const newGitlabIssueBtn = $('#new-gitlab-issue-btn');
  if (newGitlabIssueBtn) newGitlabIssueBtn.hidden = readonly || !project.gitlab_project_id;
  const pushGitlabLabel = $('#push-gitlab-label');
  if (pushGitlabLabel) pushGitlabLabel.hidden = !project.gitlab_project_id;
  // #83: Auto-Sync-Checkbox anzeigen, wenn Tracker konfiguriert; Default = projektweite Einstellung
  const hasTracker = !!(project.issue_tracker_type && project.issue_tracker_type !== 'none' &&
    (project.gitlab_project_id || project.github_repo));
  const autoSyncLabel = $('#auto-sync-label');
  if (autoSyncLabel) {
    autoSyncLabel.hidden = !hasTracker;
    const cb = autoSyncLabel.querySelector('input[name="auto_sync"]');
    if (cb) cb.checked = project.auto_sync !== false;
  }

  // #56: Beim Öffnen automatisch mit GitLab synchronisieren (falls verknüpft)
  if (project.gitlab_project_id) {
    syncGitLabIssues(id, true);
  }
  loadGitLabIssues(id);

  state.allTasks = tasks;
  // #71: aktive Custom-Field-Definitionen für den Filter laden
  try {
    const { definitions } = await api(`/api/projects/${id}/custom-fields/active`);
    state.currentProjectCustomFieldDefs = definitions || [];
  } catch { state.currentProjectCustomFieldDefs = []; }
  renderCurrentProjectView(readonly, id);
  if (state.projectTab === 'dashboard') {
    loadProjectDashboard(id);
  }
  show('project-detail-view');
}

function renderCurrentProjectView(readonly, projectId) {
  const tasks = state.allTasks || [];
  const f = currentFilters();
  const filtered = sortTasks(tasks.filter(t => taskMatchesFilter(t, f)), f.sort);
  $('#filter-bar').hidden = state.projectTab === 'dashboard';
  updateCustomFieldFilterOptions();

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

async function syncGitLabIssues(projectId, silent = false) {
  const btn = $('#sync-gitlab-btn');
  if (btn && !silent) {
    btn.disabled = true;
    btn.textContent = 'Synchronisiere...';
  }
  try {
    const { issues } = await api(`/api/gitlab/projects/${projectId}/sync`, { method: 'POST' });
    renderGitLabIssues(issues);
  } catch (err) {
    if (!silent) alert(err.message);
    else console.warn('Auto-Sync fehlgeschlagen:', err.message);
  } finally {
    if (btn && !silent) {
      btn.disabled = false;
      btn.textContent = 'Synchronisieren';
    }
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
  // #96: Formular wurde aus der Benutzerverwaltung entfernt – nur noch Sync-Seite
  const form = $('#gitlab-settings-form');
  if (!form) return;
  try {
    const s = await api('/api/gitlab/settings');
    form.base_url.value = s.base_url || '';
    form.access_token.value = '';
    const sa = $('#gitlab-sa-username');
    if (sa) sa.value = s.service_account_username || '';
    const msg = $('#gitlab-settings-msg');
    if (msg) msg.textContent = s.configured
      ? `Konfiguriert: ${s.base_url} (Token gesetzt${s.service_account_username ? ', Service-Account: @' + s.service_account_username : ''})`
      : 'Noch nicht konfiguriert.';
  } catch (err) {
    const msg = $('#gitlab-settings-msg');
    if (msg) msg.textContent = err.message;
  }
}

async function loadGitLabIssue(issue) {
  state.currentGitLabIssue = issue;
  $('#gi-edit-form').hidden = true;
  $('#gi-title').textContent = `#${issue.gitlab_iid} ${issue.title}`;
  $('#gi-description').textContent = issue.description || '(keine Beschreibung)';
  $('#gi-edit-btn').hidden = !canEdit(state.myProjectRole);
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

async function loadAdmin(defaultTab) {
  loadGitLabSettings();
  const { users } = await api('/api/admin/users');
  renderUserRoleMatrix(users);
  await renderPermissionMatrix();
  const tbody = $('#user-table tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    const roleLabels = (u.roles || []).map(r => ({ admin: 'Admin', projektmanager: 'Projektmanager', entwickler: 'Entwickler', beobachter: 'Beobachter' }[r] || r));
    const roleBadges = roleLabels.map(l => `<span class="badge" style="margin-right:0.25rem;">${l}</span>`).join('');
    tr.innerHTML = `
      <td>${u.name}</td>
      <td>@${u.username}</td>
      <td>${u.email}</td>
      <td>${roleBadges}</td>
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
  // #71: Load custom field definitions
  await loadCustomFieldDefinitions();
  // #89/#90: Tab auswählen
  switchAdminTab(defaultTab === 'projects' ? 'projects' : 'users');
  if (defaultTab === 'projects') await loadAdminProjects();
  show('admin-view');
}

const ALL_ROLES = ['admin', 'projektmanager', 'entwickler', 'beobachter'];
const ALL_PERMISSIONS = [
  'view_project', 'edit_project', 'delete_project', 'manage_members',
  'create_task', 'edit_task', 'delete_task', 'manage_users', 'manage_settings',
];

function renderUserRoleMatrix(users) {
  const tbody = $('#user-role-matrix tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    const cells = ALL_ROLES.map(role => {
      const checked = (u.roles || []).includes(role) ? 'checked' : '';
      return `<td style="text-align:center;"><input type="checkbox" class="role-matrix-cb" data-user="${u.id}" data-role="${role}" ${checked}></td>`;
    }).join('');
    tr.innerHTML = `<td>${u.name} <small>(@${u.username})</small></td>${cells}`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('.role-matrix-cb').forEach(cb => {
    cb.onchange = async () => {
      const userId = cb.dataset.user;
      const user = users.find(x => String(x.id) === String(userId));
      let roles = (user.roles || []).filter(r => r !== cb.dataset.role);
      if (cb.checked) roles.push(cb.dataset.role);
      if (roles.length === 0) {
        cb.checked = true;
        alert('Mindestens eine Rolle muss zugewiesen bleiben.');
        return;
      }
      if (String(userId) === String(state.user.id) && cb.dataset.role === 'admin' && !cb.checked) {
        cb.checked = true;
        alert('Die eigene Admin-Rolle kann nicht entzogen werden.');
        return;
      }
      try {
        await api(`/api/admin/users/${userId}`, { method: 'PUT', body: { roles } });
        await loadAdmin();
      } catch (err) {
        alert(err.message);
        cb.checked = !cb.checked;
      }
    };
  });
}

async function renderPermissionMatrix() {
  const { matrix } = await api('/api/admin/permissions-matrix');
  const tbody = $('#permission-matrix tbody');
  tbody.innerHTML = '';
  for (const role of ALL_ROLES) {
    const tr = document.createElement('tr');
    const perms = matrix[role] || [];
    const cells = ALL_PERMISSIONS.map(p => {
      const checked = perms.includes(p) ? 'checked' : '';
      const disabled = role === 'admin' ? 'disabled title="Admin hat immer alle Rechte"' : '';
      return `<td style="text-align:center;"><input type="checkbox" class="perm-matrix-cb" data-role="${role}" data-perm="${p}" ${checked} ${disabled}></td>`;
    }).join('');
    const label = { admin: 'Admin', projektmanager: 'Projektmanager', entwickler: 'Entwickler', beobachter: 'Beobachter' }[role];
    tr.innerHTML = `<td><span class="badge">${label}</span></td>${cells}`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('.perm-matrix-cb:not([disabled])').forEach(cb => {
    cb.onchange = async () => {
      const role = cb.dataset.role;
      const row = cb.closest('tr');
      const perms = [...row.querySelectorAll('.perm-matrix-cb')].filter(c => c.checked).map(c => c.dataset.perm);
      try {
        await api(`/api/admin/permissions-matrix/${role}`, { method: 'PUT', body: { permissions: perms } });
      } catch (err) {
        alert(err.message);
        cb.checked = !cb.checked;
      }
    };
  });
}

function editUser(u) {
  const form = $('#user-form');
  form.id.value = u.id;
  form.firstName.value = u.first_name || '';
  form.lastName.value = u.last_name || '';
  form.username.value = u.username || '';
  form.email.value = u.email;
  form.querySelectorAll('input[name="roles"]').forEach(cb => {
    cb.checked = (u.roles || []).includes(cb.value);
  });
  form.is_active.checked = u.is_active;
  form.password.value = '';
  form.password.required = false;
  form.hidden = false;
}

function bind(id, handler, eventType) {
  // 'submit' events must use addEventListener, not onclick
  if (id === 'submit' || eventType === 'submit') {
    document.addEventListener('submit', handler);
    return;
  }
  const el = $(id);
  if (!el) {
    // Silent for optional elements (removed in refactors) – no console spam
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
  state.csrfToken = null;
  $('#user-box').hidden = true;
  show('auth-view');
  await fetchCsrfToken();
});

bind('#notif-btn', () => {
  const dd = $('#notif-dropdown');
  dd.hidden = !dd.hidden;
  if (!dd.hidden) loadNotifications();
});
document.addEventListener('click', (e) => {
  const dd = $('#notif-dropdown');
  const btn = $('#notif-btn');
  if (dd && !dd.hidden && !dd.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    dd.hidden = true;
  }
});
bind('#notif-read-all', async () => {
  await api('/api/notifications/read-all', { method: 'POST' });
  await loadNotifications();
});

bind('#pick-gitlab-project-btn', () => loadGitLabProjects($('#gitlab-search-input').value));
bind('#gitlab-search-btn', () => loadGitLabProjects($('#gitlab-search-input').value));
bind('#gitlab-projects-back-btn', () => {
  if (state.currentProject) loadProject(state.currentProject.id);
  else loadDashboard();
});
bind('#sync-milestones-btn', async () => {
  const btn = $('#sync-milestones-btn');
  btn.disabled = true;
  try {
    const { milestones } = await api(`/api/gitlab/projects/${state.currentProject.id}/milestones/sync`, { method: 'POST' });
    state.milestones = milestones;
    populateMilestoneSelect(milestones, !canEdit(state.myProjectRole));
    renderMilestoneList(milestones);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

bind('#profile-btn', () => loadProfile());
bind('#profile-back-btn', () => loadDashboard());
bind('#my-tasks-btn', () => loadMyTasks());
bind('#my-tasks-back-btn', () => loadDashboard());

/* ===== #92: MEINE TASKS ===== */
async function loadMyTasks() {
  try {
    const { tasks } = await api('/api/projects/my-tasks');
    renderMyTasks(tasks);
    show('my-tasks-view');
  } catch (err) {
    alert(err.message);
  }
}

function renderMyTasks(tasks) {
  const list = $('#my-tasks-list');
  list.innerHTML = '';
  if (!tasks.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Dir sind aktuell keine Tasks zugewiesen.</small></li>';
    return;
  }
  for (const t of tasks) {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex; align-items:center; gap:0.5rem; padding:0.75rem; cursor:pointer;';
    li.innerHTML = `
      <span style="flex:1;">#${t.id} ${escapeHtml(t.title)}</span>
      <small style="color:var(--text-muted);">${escapeHtml(t.project_name)}</small>
      ${priorityBadge(t.priority || 'normal')}
      <span class="badge ${badgeClass(t.status)}">${t.status}</span>
      ${t.due_date ? `<small style="color:var(--text-muted);">\ud83d\udcc5 ${t.due_date}</small>` : ''}
    `;
    li.onclick = async () => {
      try {
        const { project } = await api(`/api/projects/${t.project_id}?no_sync=1`);
        state.currentProject = project;
        await loadProject(t.project_id);
        loadTaskDetail(t.project_id, t.id);
      } catch (err) {
        alert(err.message);
      }
    };
    list.appendChild(li);
  }
}


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

bind('#admin-btn', (e) => {
  e.stopPropagation();
  const dd = $('#admin-dropdown');
  if (dd) dd.hidden = !dd.hidden;
});
document.addEventListener('click', (e) => {
  const dd = $('#admin-dropdown');
  const wrapper = $('#admin-menu-wrapper');
  if (dd && wrapper && !wrapper.contains(e.target)) dd.hidden = true;
});
bind('#admin-users-btn', () => {
  const dd = $('#admin-dropdown');
  if (dd) dd.hidden = true;
  loadAdmin('users');
});
bind('#admin-projects-btn', () => {
  const dd = $('#admin-dropdown');
  if (dd) dd.hidden = true;
  loadAdmin('projects');
});
bind('#admin-tab-users-btn', () => switchAdminTab('users'));
bind('#admin-tab-projects-btn', () => switchAdminTab('projects'));

function switchAdminTab(tab) {
  const usersBtn = $('#admin-tab-users-btn');
  const projectsBtn = $('#admin-tab-projects-btn');
  const usersDiv = $('#admin-tab-users');
  const projectsDiv = $('#admin-tab-projects');
  if (usersBtn) usersBtn.classList.toggle('active', tab === 'users');
  if (projectsBtn) projectsBtn.classList.toggle('active', tab === 'projects');
  if (usersDiv) usersDiv.hidden = tab !== 'users';
  if (projectsDiv) projectsDiv.hidden = tab !== 'projects';
  if (tab === 'projects') loadAdminProjects();
}
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
    body.roles = fd.getAll('roles');
    body.is_active = fd.get('is_active') === 'on';
    if (!body.password) delete body.password;
    if (body.roles.length === 0) {
      alert('Bitte mindestens eine Rolle auswählen.');
      return;
    }
    const userId = body.id;
    delete body.id;
    delete body.role;
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
      assignee_id: fd.get('assignee_id') || null,
      milestone_id: fd.get('milestone_id') || null,
      push_to_gitlab: fd.get('push_to_gitlab') === 'on',
      auto_sync: fd.get('auto_sync') === 'on',
      priority: fd.get('priority') || 'normal',
      estimated_hours: fd.get('estimated_hours') || null,
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

for (const el of ['#filter-type', '#filter-status', '#filter-priority', '#filter-sort', '#filter-label', '#filter-epic-only', '#filter-custom-field', '#filter-custom-field-value']) {
  const node = $(el);
  if (node) node.addEventListener('change', () => renderCurrentProjectView(!canEdit(state.myProjectRole), state.currentProject.id));
}
const cfValueInput = $('#filter-custom-field-value');
if (cfValueInput) {
  cfValueInput.addEventListener('input', () => renderCurrentProjectView(!canEdit(state.myProjectRole), state.currentProject.id));
  $('#filter-custom-field').addEventListener('change', () => {
    cfValueInput.hidden = !$('#filter-custom-field').value;
  });
}
bind('#filter-reset-btn', () => {
  $('#filter-type').value = '';
  $('#filter-status').value = '';
  if ($('#filter-priority')) $('#filter-priority').value = '';
  if ($('#filter-sort')) $('#filter-sort').value = '';
  $('#filter-label').value = '';
  $('#filter-epic-only').checked = false;
  $('#filter-custom-field').value = '';
  $('#filter-custom-field-value').value = '';
  $('#filter-custom-field-value').hidden = true;
  renderCurrentProjectView(!canEdit(state.myProjectRole), state.currentProject.id);
});

// #71: Zusatzfeld-Dropdown im Filter mit den aktiven Feldern des Projekts befüllen
function updateCustomFieldFilterOptions() {
  const sel = $('#filter-custom-field');
  if (!sel) return;
  const defs = state.currentProjectCustomFieldDefs || [];
  if (!defs.length) { sel.hidden = true; $('#filter-custom-field-value').hidden = true; return; }
  const prev = sel.value;
  sel.innerHTML = '<option value="">Alle Zusatzfelder</option>' +
    defs.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  sel.value = prev;
  sel.hidden = false;
}

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
  if (!$('#gitlab-settings-form')) return; // #96: Formular entfernt
  const msg = $('#gitlab-settings-msg');
  msg.textContent = 'Teste Verbindung...';
  try {
    const fd = new FormData($('#gitlab-settings-form'));
    await api('/api/gitlab/settings', { method: 'PUT', body: Object.fromEntries(fd) });
    const { ok, user } = await api('/api/gitlab/settings/test', { method: 'POST' });
    if (ok) msg.textContent = `Verbindung erfolgreich! ✅ Angemeldet als: @${user.username} (${user.name})`;
  } catch (err) {
    msg.textContent = `Fehler: ${err.message}`;
  }
});

bind('#sync-gitlab-btn', () => syncGitLabIssues(state.currentProject.id));

bind('#new-gitlab-issue-btn', () => { $('#gitlab-issue-form').hidden = false; });
bind('#cancel-gitlab-issue-btn', () => { $('#gitlab-issue-form').hidden = true; });

bind('#gitlab-issue-back-btn', () => loadProject(state.currentProject.id));

bind('#gi-edit-btn', () => {
  const issue = state.currentGitLabIssue;
  const form = $('#gi-edit-form');
  form.title.value = issue.title || '';
  form.description.value = issue.description || '';
  form.hidden = false;
});
bind('#gi-edit-cancel-btn', () => { $('#gi-edit-form').hidden = true; });

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'gi-edit-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const issue = state.currentGitLabIssue;
    try {
      const { issue: updated } = await api(`/api/gitlab/projects/${state.currentProject.id}/issues/${issue.gitlab_iid}`, {
        method: 'PUT',
        body: { title: fd.get('title'), description: fd.get('description') },
      });
      $('#gi-edit-form').hidden = true;
      await loadGitLabIssue(updated);
      await loadGitLabIssues(state.currentProject.id);
    } catch (err) {
      alert(err.message);
    }
  }
});

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
    const body = Object.fromEntries(fd);
    if (!body.service_account_username) delete body.service_account_username;
    try {
      await api('/api/gitlab/settings', { method: 'PUT', body });
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

/* ===== EPIC 6: AUFGABENMANAGEMENT ===== */

const PRIORITY_LABELS = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', critical: 'Kritisch' };
const PRIORITY_CLASSES = { low: 'badge-todo', normal: 'badge-active', high: 'badge-review', critical: 'badge-done' };

function priorityBadge(p) {
  const cls = PRIORITY_CLASSES[p] || 'badge-todo';
  const label = PRIORITY_LABELS[p] || p;
  return `<span class="badge ${cls}">⚑ ${label}</span>`;
}

/* ===== TASK DETAIL VIEW (US-28) ===== */

async function loadTaskDetail(projectId, taskId) {
  try {
    const data = await api(`/api/projects/${projectId}/tasks/${taskId}`);
    state.currentTask = data;
    renderTaskDetail(data);
    show('task-detail-view');
  } catch (err) {
    alert(err.message);
  }
}

function renderTaskDetail(data) {
  const { task, comments, history, subtasks, watchers, watching } = data;
  state.currentTask = data;

  // Header
  $('#td-title').textContent = task.title;
  $('#td-description').textContent = task.description || '';
  $('#td-type-badge').textContent = ISSUE_TYPE_LABELS[task.issue_type] || task.issue_type;
  $('#td-priority-badge').innerHTML = priorityBadge(task.priority || 'normal');
  $('#td-status-badge').className = `badge ${badgeClass(task.status)}`;
  $('#td-status-badge').textContent = task.status;

  // GitLab
  const glBadge = $('#td-gitlab-badge');
  const glLink = $('#td-gitlab-link');
  if (task.gitlab_iid) {
    glBadge.hidden = false;
    glBadge.textContent = `GL #${task.gitlab_iid}`;
    glLink.hidden = false;
  } else {
    glBadge.hidden = true;
    glLink.hidden = true;
  }

  // #83: Auto-Sync-Checkbox in Edit-Form anzeigen, wenn Tracker konfiguriert
  const tdAutoSyncLabel = $('#td-auto-sync-label');
  if (tdAutoSyncLabel) {
    const hasTracker = !!(state.currentProject && state.currentProject.issue_tracker_type &&
      state.currentProject.issue_tracker_type !== 'none' &&
      (state.currentProject.gitlab_project_id || state.currentProject.github_repo));
    tdAutoSyncLabel.hidden = !hasTracker;
    const cb = tdAutoSyncLabel.querySelector('input[name="auto_sync"]');
    if (cb) cb.checked = state.currentProject.auto_sync !== false;
  }

  // Watch button
  const watchBtn = $('#td-watch-btn');
  watchBtn.textContent = watching ? '★ Watching' : '☆ Watch';
  watchBtn.classList.toggle('btn-secondary', !watching);

  // Meta info
  $('#td-assignee').textContent = task.assignee_name ? `👤 ${task.assignee_name}` : '👤 Nicht zugewiesen';
  $('#td-creator').textContent = task.creator_name ? `✏️ ${task.creator_name}` : '';
  $('#td-due').textContent = task.due_date ? `📅 ${task.due_date}` : '';
  const hoursText = [];
  if (task.estimated_hours) hoursText.push(`⏱ geschätzt: ${task.estimated_hours}h`);
  if (task.spent_hours) hoursText.push(`⏱ aufgewendet: ${task.spent_hours}h`);
  $('#td-hours').textContent = hoursText.join(' · ');
  $('#td-labels').innerHTML = (task.labels || []).map(l => `<span class="badge badge-todo">${l}</span>`).join(' ');

  // Subtask progress
  const subProgress = $('#td-subtask-progress');
  if (task.subtask_count > 0) {
    subProgress.hidden = false;
    $('#td-subtask-count').textContent = `${task.subtask_done}/${task.subtask_count} erledigt`;
    const pct = task.subtask_count > 0 ? (task.subtask_done / task.subtask_count) * 100 : 0;
    $('#td-subtask-bar').style.width = `${pct}%`;
    $('#td-subtask-badge').hidden = false;
    $('#td-subtask-badge').textContent = `${task.subtask_done}/${task.subtask_count}`;
  } else {
    subProgress.hidden = true;
    $('#td-subtask-badge').hidden = true;
  }

  // Edit form
  $('#td-edit-title').value = task.title || '';
  $('#td-edit-description').value = task.description || '';
  $('#td-edit-status').value = task.status || 'todo';
  $('#td-edit-priority').value = task.priority || 'normal';
  $('#td-edit-type').value = task.issue_type || 'task';
  $('#td-edit-due').value = task.due_date || '';
  $('#td-edit-est').value = task.estimated_hours || '';
  $('#td-edit-spent').value = task.spent_hours || '';
  $('#td-edit-labels').value = (task.labels || []).join(', ');

  // Tabs
  $('#td-comment-count').textContent = String(comments.length);
  renderTaskComments(comments);
  renderTaskSubtasks(subtasks);
  renderTaskHistory(history);
  renderTaskWatchers(watchers);
}

function renderTaskComments(comments) {
  const list = $('#td-comment-list');
  list.innerHTML = '';
  if (!comments.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Noch keine Kommentare.</small></li>';
    return;
  }
  for (const c of comments) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:0.75rem; border:1px solid var(--border); border-radius:6px; margin-bottom:0.5rem;';
    const date = new Date(c.created_at).toLocaleString('de-DE');
    const isAuthor = state.user && Number(c.user_id) === Number(state.user.id);
    const canDelete = isAuthor || (state.currentProject && ['admin', 'projektmanager'].includes(state.currentProject.my_role));
    li.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
        <strong>${c.author_name || 'Unbekannt'}</strong>
        <small style="color:var(--text-muted);">${date}${c.updated_at !== c.created_at ? ' (bearbeitet)' : ''}</small>
      </div>
      <p id="td-comment-body-${c.id}" style="margin:0; white-space:pre-wrap;">${escapeHtml(c.body)}</p>
      <div id="td-comment-edit-${c.id}" hidden>
        <textarea id="td-comment-edit-ta-${c.id}" style="width:100%;">${escapeHtml(c.body)}</textarea>
        <div style="display:flex; gap:0.5rem; margin-top:0.35rem;">
          <button class="btn-small" onclick="saveCommentEdit(${c.id})">Speichern</button>
          <button class="btn-small btn-secondary" onclick="cancelCommentEdit(${c.id})">Abbrechen</button>
        </div>
      </div>
      ${isAuthor || canDelete ? `
        <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
          ${isAuthor ? `<button class="btn-small btn-secondary" onclick="editComment(${c.id})">✏️</button>` : ''}
          ${canDelete ? `<button class="btn-small btn-secondary" onclick="deleteComment(${c.id})">🗑</button>` : ''}
        </div>
      ` : ''}
    `;
    list.appendChild(li);
  }
}

function renderTaskSubtasks(subtasks) {
  const list = $('#td-subtask-list');
  list.innerHTML = '';
  if (!subtasks.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Keine Checklisten-Punkte.</small></li>';
    return;
  }
  for (const s of subtasks) {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex; align-items:center; gap:0.5rem; padding:0.5rem;';
    li.innerHTML = `
      <input type="checkbox" ${s.is_done ? 'checked' : ''} onchange="toggleSubtask(${s.id}, this.checked)">
      <span style="flex:1; ${s.is_done ? 'text-decoration:line-through; color:var(--text-muted);' : ''}">${escapeHtml(s.title)}</span>
      ${s.assignee_name ? `<small style="color:var(--text-muted);">${s.assignee_name}</small>` : ''}
      <button class="btn-small btn-secondary" onclick="deleteSubtask(${s.id})">🗑</button>
    `;
    list.appendChild(li);
  }
}

function renderTaskHistory(history) {
  const list = $('#td-history-list');
  list.innerHTML = '';
  if (!history.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Keine Historie vorhanden.</small></li>';
    return;
  }
  const actionLabels = {
    created: '✅ Erstellt',
    updated: '✏️ Geändert',
    deleted: '🗑 Gelöscht',
    status_changed: '🔄 Status geändert',
    assigned: '👤 Zugewiesen',
    commented: '💬 Kommentiert',
    subtask_toggled: '☑️ Subtask geändert',
  };
  const fieldLabels = {
    title: 'Titel', description: 'Beschreibung', status: 'Status',
    assignee_id: 'Bearbeiter', issue_type: 'Typ', priority: 'Priorität',
    due_date: 'Fälligkeitsdatum', milestone_id: 'Meilenstein', epic_id: 'Epic',
    estimated_hours: 'Geschätzte Zeit', spent_hours: 'Aufgewendete Zeit',
    labels: 'Labels', subtask_added: 'Subtask hinzugefügt', subtask: 'Subtask',
  };
  for (const h of history) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:0.5rem; border-left:3px solid var(--border); margin-bottom:0.35rem;';
    const date = new Date(h.changed_at).toLocaleString('de-DE');
    const actionLabel = actionLabels[h.action] || h.action;
    let detail = '';
    if (h.field) {
      const fieldLabel = fieldLabels[h.field] || h.field;
      const oldV = h.old_value !== null ? formatHistoryValue(h.old_value) : '—';
      const newV = h.new_value !== null ? formatHistoryValue(h.new_value) : '—';
      detail = `<br><small style="color:var(--text-muted);">${fieldLabel}: ${oldV} → ${newV}</small>`;
    }
    li.innerHTML = `<small style="color:var(--text-muted);">${date} · ${h.user_name || 'System'}</small> ${actionLabel}${detail}`;
    list.appendChild(li);
  }
}

function formatHistoryValue(v) {
  if (v === null || v === undefined) return '—';
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.join(', ') || '(leer)';
  } catch { /* not JSON */ }
  return String(v).slice(0, 50);
}

function renderTaskWatchers(watchers) {
  const list = $('#td-watcher-list');
  list.innerHTML = '';
  if (!watchers.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Keine Watcher.</small></li>';
    return;
  }
  for (const w of watchers) {
    const li = document.createElement('li');
    const date = new Date(w.created_at).toLocaleDateString('de-DE');
    const isMe = state.user && Number(w.id) === Number(state.user.id);
    li.innerHTML = `<strong>${w.name}</strong> <small style="color:var(--text-muted);">@${w.username} · seit ${date}</small>${isMe ? ' <span class="badge badge-active">Du</span>' : ''}`;
    list.appendChild(li);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ===== TASK DETAIL TABS ===== */
let tdCurrentTab = 'info';
function setTaskDetailTab(tab) {
  tdCurrentTab = tab;
  const tabs = ['info', 'comments', 'subtasks', 'history', 'watchers'];
  for (const t of tabs) {
    $(`#td-tab-${t}`).hidden = t !== tab;
    $(`#td-tab-${t}-btn`).classList.toggle('active', t === tab);
  }
}

/* ===== TASK DETAIL EVENT HANDLERS ===== */

function bindTaskDetailEvents() {
  bind('#task-detail-back-btn', () => {
    if (state.currentProject) loadProject(state.currentProject.id);
    else loadDashboard();
  });

  bind('#td-watch-btn', async () => {
    if (!state.currentTask) return;
    const { task } = state.currentTask;
    const pid = state.currentProject.id;
    try {
      if (state.currentTask.watching) {
        await api(`/api/projects/${pid}/tasks/${task.id}/watch`, { method: 'DELETE' });
      } else {
        await api(`/api/projects/${pid}/tasks/${task.id}/watch`, { method: 'POST' });
      }
      await loadTaskDetail(pid, task.id);
    } catch (err) { alert(err.message); }
  });

  // Tab buttons
  bind('#td-tab-info-btn', () => setTaskDetailTab('info'));
  bind('#td-tab-comments-btn', () => setTaskDetailTab('comments'));
  bind('#td-tab-subtasks-btn', () => setTaskDetailTab('subtasks'));
  bind('#td-tab-history-btn', () => setTaskDetailTab('history'));
  bind('#td-tab-watchers-btn', () => setTaskDetailTab('watchers'));

  // Edit form
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'td-edit-form') {
      e.preventDefault();
      if (!state.currentTask || !state.currentProject) return;
      const fd = new FormData(e.target);
      const labels = (fd.get('labels') || '').split(',').map(s => s.trim()).filter(Boolean);
      // #71: Collect custom field values
      const customFields = state.currentTask.customFieldDefs
        ? collectTaskCustomFields(state.currentTask.customFieldDefs)
        : undefined;
      try {
        await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}`, {
          method: 'PUT',
          body: {
            title: fd.get('title'),
            description: fd.get('description') || null,
            status: fd.get('status'),
            priority: fd.get('priority'),
            issue_type: fd.get('issue_type'),
            due_date: fd.get('due_date') || null,
            estimated_hours: fd.get('estimated_hours') || null,
            spent_hours: fd.get('spent_hours') || null,
            labels,
            custom_fields: customFields,
            auto_sync: fd.get('auto_sync') === 'on',
          },
        });
        $('#td-msg').textContent = '✅ Gespeichert';
        setTimeout(() => { $('#td-msg').textContent = ''; }, 2000);
        await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
        await loadProject(state.currentProject.id);
      } catch (err) { alert(err.message); }
    }
  });

  // Delete task
  bind('#td-delete-btn', async () => {
    if (!state.currentTask || !state.currentProject) return;
    if (!confirm('Task wirklich löschen?')) return;
    try {
      await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}`, { method: 'DELETE' });
      await loadProject(state.currentProject.id);
      show('project-detail-view');
    } catch (err) { alert(err.message); }
  });

  // Comment form
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'td-comment-form') {
      e.preventDefault();
      if (!state.currentTask || !state.currentProject) return;
      const fd = new FormData(e.target);
      try {
        await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/comments`, {
          method: 'POST', body: { body: fd.get('body') },
        });
        e.target.reset();
        await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
      } catch (err) { alert(err.message); }
    }
  });

  // Subtask form
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'td-subtask-form') {
      e.preventDefault();
      if (!state.currentTask || !state.currentProject) return;
      const fd = new FormData(e.target);
      try {
        await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/subtasks`, {
          method: 'POST', body: { title: fd.get('title') },
        });
        e.target.reset();
        await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
        await loadProject(state.currentProject.id);
      } catch (err) { alert(err.message); }
    }
  });
}

/* ===== COMMENT ACTIONS (global for onclick) ===== */
window.editComment = function(commentId) {
  $(`#td-comment-body-${commentId}`).hidden = true;
  $(`#td-comment-edit-${commentId}`).hidden = false;
};

window.cancelCommentEdit = function(commentId) {
  $(`#td-comment-body-${commentId}`).hidden = false;
  $(`#td-comment-edit-${commentId}`).hidden = true;
};

window.saveCommentEdit = async function(commentId) {
  if (!state.currentTask || !state.currentProject) return;
  const body = $(`#td-comment-edit-ta-${commentId}`).value;
  try {
    await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/comments/${commentId}`, {
      method: 'PUT', body: { body },
    });
    await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
  } catch (err) { alert(err.message); }
};

window.deleteComment = async function(commentId) {
  if (!confirm('Kommentar löschen?')) return;
  if (!state.currentTask || !state.currentProject) return;
  try {
    await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/comments/${commentId}`, { method: 'DELETE' });
    await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
  } catch (err) { alert(err.message); }
};

/* ===== SUBTASK ACTIONS (global for onchange/onclick) ===== */
window.toggleSubtask = async function(subtaskId, isDone) {
  if (!state.currentTask || !state.currentProject) return;
  try {
    await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/subtasks/${subtaskId}`, {
      method: 'PUT', body: { is_done: isDone },
    });
    await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
    await loadProject(state.currentProject.id);
  } catch (err) { alert(err.message); }
};

window.deleteSubtask = async function(subtaskId) {
  if (!confirm('Checklisten-Punkt löschen?')) return;
  if (!state.currentTask || !state.currentProject) return;
  try {
    await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/subtasks/${subtaskId}`, { method: 'DELETE' });
    await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
    await loadProject(state.currentProject.id);
  } catch (err) { alert(err.message); }
};

/* ===== MAKE TASKS CLICKABLE (open detail) ===== */
function makeTasksClickable() {
  // Task list items
  document.querySelectorAll('#task-list li').forEach((li, idx) => {
    if (!li.dataset.taskId) return;
    li.style.cursor = 'pointer';
    li.addEventListener('click', (e) => {
      // Don't open detail when interacting with select
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
      const taskId = Number(li.dataset.taskId);
      if (taskId && state.currentProject) loadTaskDetail(state.currentProject.id, taskId);
    });
  });
  // Board cards
  document.querySelectorAll('.board-card').forEach(card => {
    if (!card.dataset.taskId) return;
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (card.classList.contains('dragging')) return;
      const taskId = Number(card.dataset.taskId);
      if (taskId && state.currentProject) loadTaskDetail(state.currentProject.id, taskId);
    });
  });
}

/* ===== PRIORITY IN TASK FORM (US-25) ===== */
function enhanceTaskForm() {
  const form = $('#task-form');
  if (!form || form.dataset.enhanced) return;
  form.dataset.enhanced = '1';
  // Add priority select after issue_type select
  const typeSelect = form.querySelector('select[name="issue_type"]');
  if (typeSelect) {
    const priorityLabel = document.createElement('select');
    priorityLabel.name = 'priority';
    priorityLabel.innerHTML = `
      <option value="normal">Normal</option>
      <option value="low">Niedrig</option>
      <option value="high">Hoch</option>
      <option value="critical">Kritisch</option>
    `;
    typeSelect.parentNode.insertBefore(priorityLabel, typeSelect.nextSibling);
  }
}

/* ===== INIT TASK DETAIL EVENTS ===== */
const _origInit = init;
init = async function() {
  await _origInit();
  bindTaskDetailEvents();
};

init();

/* ===== HOOK INTO renderTaskList TO ADD data-task-id ===== */
const _origRenderTaskList = renderTaskList;
renderTaskList = function(tasks, readonly, projectId) {
  _origRenderTaskList(tasks, readonly, projectId);
  const list = $('#task-list');
  const items = list.querySelectorAll('li');
  tasks.forEach((t, idx) => {
    if (items[idx]) items[idx].dataset.taskId = t.id;
  });
  makeTasksClickable();
};

const _origRenderBoard = renderBoard;
renderBoard = function(tasks, readonly, projectId) {
  _origRenderBoard(tasks, readonly, projectId);
  document.querySelectorAll('.board-card').forEach((card, idx) => {
    const visible = tasks;
    // Find the task for this card by matching order
  });
  // Add task IDs to board cards
  for (const status of ['todo', 'in_progress', 'review', 'done']) {
    const col = $(`#col-${status}`);
    const cards = col.querySelectorAll('.board-card');
    const statusTasks = tasks.filter(t => t.status === status);
    cards.forEach((card, idx) => {
      if (statusTasks[idx]) card.dataset.taskId = statusTasks[idx].id;
    });
  }
  makeTasksClickable();
};

/* ===== HOOK INTO TASK FORM SUBMIT TO SEND PRIORITY ===== */
document.addEventListener('submit', async (e) => {
  if (e.target.id === 'task-form') {
    // Let the original handler run, but we need to intercept to add priority
    // The original handler is bound separately, so we just enhance the form
    enhanceTaskForm();
  }
});

/* ===== ISSUE #71: CUSTOM FIELDS ===== */

const CF_TYPE_LABELS = {
  text: 'Text', number: 'Zahl', date: 'Datum', checkbox: 'Checkbox', dropdown: 'Dropdown',
};

/* ===== ADMIN: Custom Field Definitions CRUD ===== */

async function loadCustomFieldDefinitions() {
  try {
    const { definitions } = await api('/api/admin/custom-fields');
    renderCustomFieldTable(definitions);
  } catch (err) {
    console.error('Custom Fields laden fehlgeschlagen:', err.message);
  }
}

function renderCustomFieldTable(definitions) {
  const tbody = $('#custom-field-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!definitions.length) {
    tbody.innerHTML = '<tr><td colspan="5"><small style="color:var(--text-muted);">Noch keine Custom Fields definiert.</small></td></tr>';
    return;
  }
  for (const def of definitions) {
    const tr = document.createElement('tr');
    const optionsText = def.field_type === 'dropdown' ? (def.options || []).join(', ') : '—';
    tr.innerHTML = `
      <td>${escapeHtml(def.name)}</td>
      <td><span class="badge badge-todo">${CF_TYPE_LABELS[def.field_type] || def.field_type}</span></td>
      <td><small>${escapeHtml(optionsText)}</small></td>
      <td>${def.is_required ? '✅ Ja' : '—'}</td>
      <td>
        <button class="btn-small btn-secondary" onclick="editCustomField(${def.id})">✏️</button>
        <button class="btn-small btn-secondary" onclick="deleteCustomField(${def.id})">🗑</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function bindCustomFieldAdminEvents() {
  // Type select changes -> show/hide options input
  bind('#cf-type-select', 'change', (e) => {
    const isDropdown = e.target.value === 'dropdown';
    $('#cf-options-label').hidden = !isDropdown;
    $('#cf-options-input').required = isDropdown;
  });

  // Form submit (create or update)
  bind('submit', async (e) => {
    if (e.target.id === 'custom-field-form') {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = fd.get('id');
      const fieldType = fd.get('field_type');
      const options = fieldType === 'dropdown'
        ? (fd.get('options') || '').split(',').map(s => s.trim()).filter(Boolean)
        : [];
      const body = {
        name: fd.get('name'),
        field_type: fieldType,
        options,
        is_required: fd.get('is_required') === 'on',
      };
      try {
        if (id) {
          await api(`/api/admin/custom-fields/${id}`, { method: 'PUT', body });
        } else {
          await api('/api/admin/custom-fields', { method: 'POST', body });
        }
        e.target.reset();
        $('#custom-field-form input[name="id"]').value = '';
        $('#cf-submit-btn').textContent = '+ Hinzufügen';
        $('#cf-cancel-btn').hidden = true;
        $('#cf-msg').textContent = '✅ Gespeichert';
        setTimeout(() => { $('#cf-msg').textContent = ''; }, 2000);
        await loadCustomFieldDefinitions();
      } catch (err) {
        $('#cf-msg').textContent = '❌ ' + err.message;
      }
    }
  });

  // Cancel edit
  bind('#cf-cancel-btn', () => {
    $('#custom-field-form').reset();
    $('#custom-field-form input[name="id"]').value = '';
    $('#cf-submit-btn').textContent = '+ Hinzufügen';
    $('#cf-cancel-btn').hidden = true;
    $('#cf-options-label').hidden = true;
  });
}

/* Global functions for onclick handlers */
window.editCustomField = async function(id) {
  try {
    const { definitions } = await api('/api/admin/custom-fields');
    const def = definitions.find(d => d.id === id);
    if (!def) return;
    $('#custom-field-form input[name="id"]').value = def.id;
    $('#custom-field-form input[name="name"]').value = def.name;
    $('#cf-type-select').value = def.field_type;
    $('#cf-options-label').hidden = def.field_type !== 'dropdown';
    $('#cf-options-input').value = (def.options || []).join(', ');
    $('#cf-options-input').required = def.field_type === 'dropdown';
    $('#custom-field-form input[name="is_required"]').checked = def.is_required;
    $('#cf-submit-btn').textContent = 'Speichern';
    $('#cf-cancel-btn').hidden = false;
  } catch (err) { alert(err.message); }
};

window.deleteCustomField = async function(id) {
  if (!confirm('Custom Field wirklich löschen? Dies entfernt das Feld aus allen Projekten.')) return;
  try {
    await api(`/api/admin/custom-fields/${id}`, { method: 'DELETE' });
    await loadCustomFieldDefinitions();
  } catch (err) { alert(err.message); }
};

/* ===== PROJECT: Custom Fields Aktivierung ===== */

async function loadProjectCustomFields(projectId) {
  const block = $('#project-custom-fields-block');
  if (!block) return;
  try {
    const { definitions } = await api(`/api/projects/${projectId}/custom-fields`);
    if (!definitions.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    renderProjectCustomFields(definitions);
  } catch (err) {
    block.hidden = true;
  }
}

function renderProjectCustomFields(definitions) {
  const container = $('#project-cf-list');
  container.innerHTML = '';
  for (const def of definitions) {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex; align-items:center; gap:0.5rem; padding:0.35rem 0;';
    div.innerHTML = `
      <input type="checkbox" id="pcf-${def.id}" ${def.is_enabled ? 'checked' : ''} data-field-id="${def.id}">
      <label for="pcf-${def.id}" style="flex:1; cursor:pointer;">
        ${escapeHtml(def.name)}
        <small style="color:var(--text-muted);">(${CF_TYPE_LABELS[def.field_type] || def.field_type}${def.is_required ? ', Pflichtfeld' : ''})</small>
      </label>
    `;
    container.appendChild(div);
  }
  // Show save button only for users with edit permission
  const saveBtn = $('#save-project-cf-btn');
  if (saveBtn) {
    const canEdit = state.currentProject && ['admin', 'projektmanager'].includes(state.currentProject.my_role);
    saveBtn.hidden = !canEdit;
  }
}

function bindProjectCustomFieldsEvents() {
  bind('#save-project-cf-btn', async () => {
    if (!state.currentProject) return;
    const checkboxes = document.querySelectorAll('#project-cf-list input[type="checkbox"]');
    const fields = Array.from(checkboxes).map(cb => ({
      field_definition_id: Number(cb.dataset.fieldId),
      is_enabled: cb.checked,
    }));
    try {
      await api(`/api/projects/${state.currentProject.id}/custom-fields`, {
        method: 'PUT', body: { fields },
      });
      alert('✅ Custom Fields gespeichert');
    } catch (err) { alert(err.message); }
  });
}

/* ===== TASK DETAIL: Custom Fields Rendering ===== */

function renderTaskCustomFields(customFieldDefs, taskCustomFields) {
  const container = $('#td-custom-fields-container');
  const inputsDiv = $('#td-custom-fields-inputs');
  if (!container || !inputsDiv) return;
  if (!customFieldDefs || !customFieldDefs.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  inputsDiv.innerHTML = '';
  const values = taskCustomFields || {};
  for (const def of customFieldDefs) {
    const key = String(def.id);
    const value = values[key];
    const fieldDiv = document.createElement('div');
    fieldDiv.style.cssText = 'margin-bottom:0.75rem;';
    let inputHtml = '';
    switch (def.field_type) {
      case 'text':
        inputHtml = `<input type="text" id="td-cf-${def.id}" value="${escapeHtml(value || '')}" style="width:100%;">`;
        break;
      case 'number':
        inputHtml = `<input type="number" id="td-cf-${def.id}" value="${value !== undefined ? value : ''}" step="any" style="width:100%;">`;
        break;
      case 'date':
        inputHtml = `<input type="date" id="td-cf-${def.id}" value="${value || ''}" style="width:100%;">`;
        break;
      case 'checkbox':
        inputHtml = `<input type="checkbox" id="td-cf-${def.id}" ${value === true ? 'checked' : ''}>`;
        break;
      case 'dropdown':
        const opts = (def.options || []).map(o =>
          `<option value="${escapeHtml(o)}" ${o === value ? 'selected' : ''}>${escapeHtml(o)}</option>`
        ).join('');
        inputHtml = `<select id="td-cf-${def.id}" style="width:100%;"><option value="">—</option>${opts}</select>`;
        break;
    }
    fieldDiv.innerHTML = `
      <label style="font-size:0.875rem; color:var(--text-muted);">
        ${escapeHtml(def.name)}${def.is_required ? ' *' : ''}
      </label>
      ${inputHtml}
    `;
    inputsDiv.appendChild(fieldDiv);
  }
}

function collectTaskCustomFields(customFieldDefs) {
  const result = {};
  if (!customFieldDefs) return result;
  for (const def of customFieldDefs) {
    const el = $(`#td-cf-${def.id}`);
    if (!el) continue;
    switch (def.field_type) {
      case 'text':
        result[String(def.id)] = el.value || null;
        break;
      case 'number':
        result[String(def.id)] = el.value === '' ? null : Number(el.value);
        break;
      case 'date':
        result[String(def.id)] = el.value || null;
        break;
      case 'checkbox':
        result[String(def.id)] = el.checked;
        break;
      case 'dropdown':
        result[String(def.id)] = el.value || null;
        break;
    }
  }
  return result;
}

/* ===== HOOK INTO renderTaskDetail TO RENDER CUSTOM FIELDS ===== */
const _origRenderTaskDetail = renderTaskDetail;
renderTaskDetail = function(data) {
  _origRenderTaskDetail(data);
  if (data.customFieldDefs) {
    renderTaskCustomFields(data.customFieldDefs, data.task.custom_fields);
  }
};

/* ===== HOOK INTO TASK EDIT FORM SUBMIT TO SEND CUSTOM FIELDS ===== */
// We need to intercept the td-edit-form submit to include custom_fields
const _origBindTaskDetailEvents = bindTaskDetailEvents;
bindTaskDetailEvents = function() {
  _origBindTaskDetailEvents();
  // Override the td-edit-form submit handler to include custom fields
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'td-edit-form' && state.currentTask && state.currentTask.customFieldDefs) {
      // Let the original handler run first, then we can't easily intercept...
      // Instead, we modify the approach: we add custom fields collection before the original handler
      // Actually, the original handler is bound via bind('submit', ...), so we need to
      // collect custom fields and store them for the original handler to use
      state._pendingCustomFields = collectTaskCustomFields(state.currentTask.customFieldDefs);
    }
  }, true); // Use capture phase to run before the original handler
};

/* ===== HOOK INTO loadAdmin TO LOAD CUSTOM FIELDS ===== */
const _origLoadAdmin = typeof loadAdmin !== 'undefined' ? loadAdmin : null;
if (_origLoadAdmin) {
  window.loadAdmin = async function(defaultTab) {
    await _origLoadAdmin(defaultTab);
    try { await loadCustomFieldDefinitions(); } catch (e) { console.error('loadCustomFieldDefinitions:', e.message); }
  };
}

/* ===== HOOK INTO loadProject TO LOAD PROJECT CUSTOM FIELDS ===== */
const _origLoadProject = loadProject;
loadProject = async function(id) {
  await _origLoadProject(id);
  try { await loadProjectCustomFields(id); } catch (e) { console.error('loadProjectCustomFields:', e.message); }
};

/* ===== INIT CUSTOM FIELD EVENTS ===== */
bindCustomFieldAdminEvents();
bindProjectCustomFieldsEvents();

/* ===== ISSUE #74: TASK RELATIONS (Parent/Child/Related) ===== */

function renderTaskRelations(data) {
  const block = $('#td-relations-block');
  if (!block) return;
  block.hidden = false;

  const { parent, children, related, childrenProgress } = data;

  // Parent
  const parentDisplay = $('#td-parent-display');
  const parentLink = $('#td-parent-link');
  if (parent) {
    parentDisplay.hidden = false;
    parentLink.textContent = `#${parent.id} ${parent.title}`;
    parentLink.onclick = () => {
      if (state.currentProject) loadTaskDetail(state.currentProject.id, parent.id);
    };
  } else {
    parentDisplay.hidden = true;
  }

  // Children
  const childrenDisplay = $('#td-children-display');
  const childrenList = $('#td-children-list');
  if (children && children.length > 0) {
    childrenDisplay.hidden = false;
    childrenList.innerHTML = '';
    for (const c of children) {
      const li = document.createElement('li');
      li.style.cssText = 'display:flex; align-items:center; gap:0.5rem; padding:0.25rem 0;';
      const statusBadge = `<span class="badge ${badgeClass(c.status)}">${c.status}</span>`;
      const removeBtn = `<button class="btn-small btn-secondary" onclick="removeRelation(${c.id}, 'parent_child', 'child')" title="Verknüpfung entfernen">✕</button>`;
      li.innerHTML = `<span style="cursor:pointer; color:var(--accent); flex:1;" onclick="loadTaskDetail(state.currentProject.id, ${c.id})">#${c.id} ${escapeHtml(c.title)}</span> ${statusBadge} ${removeBtn}`;
      childrenList.appendChild(li);
    }
    // Progress
    const progressDiv = $('#td-children-progress');
    if (childrenProgress && childrenProgress.total > 0) {
      progressDiv.hidden = false;
      $('#td-children-progress-text').textContent = `${childrenProgress.done}/${childrenProgress.total} erledigt`;
      $('#td-children-progress-bar').style.width = `${childrenProgress.percent}%`;
    } else {
      progressDiv.hidden = true;
    }
  } else {
    childrenDisplay.hidden = true;
  }

  // Related
  const relatedDisplay = $('#td-related-display');
  const relatedList = $('#td-related-list');
  if (related && related.length > 0) {
    relatedDisplay.hidden = false;
    relatedList.innerHTML = '';
    for (const r of related) {
      const li = document.createElement('li');
      li.style.cssText = 'display:flex; align-items:center; gap:0.5rem; padding:0.25rem 0;';
      const arrow = r.direction === 'parent' ? '←' : '→';
      const removeBtn = `<button class="btn-small btn-secondary" onclick="removeRelation(${r.id}, 'relates_to', '${r.direction}')" title="Verknüpfung entfernen">✕</button>`;
      li.innerHTML = `<span style="cursor:pointer; color:var(--accent); flex:1;" onclick="loadTaskDetail(state.currentProject.id, ${r.id})">${arrow} #${r.id} ${escapeHtml(r.title)}</span> ${removeBtn}`;
      relatedList.appendChild(li);
    }
  } else {
    relatedDisplay.hidden = true;
  }
}

function bindRelationEvents() {
  bind('#td-relation-toggle-btn', () => {
    const form = $('#td-relation-form');
    form.hidden = !form.hidden;
    if (!form.hidden && state.currentTask && state.currentProject) {
      loadRelationCandidates();
    }
  });

  bind('#td-relation-cancel-btn', () => {
    $('#td-relation-form').hidden = true;
  });

  bind('#td-relation-type', 'change', (e) => {
    // Show/hide direction for relates_to
    const isParentChild = e.target.value === 'parent_child';
    $('#td-relation-direction').disabled = !isParentChild;
  });

  bind('#td-relation-add-btn', async () => {
    if (!state.currentTask || !state.currentProject) return;
    const targetId = Number($('#td-relation-target').value);
    const relType = $('#td-relation-type').value;
    const direction = $('#td-relation-direction').value;
    if (!targetId) { alert('Bitte einen Task auswählen'); return; }
    try {
      await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/relations`, {
        method: 'POST',
        body: { target_task_id: targetId, relation_type: relType, direction },
      });
      $('#td-relation-form').hidden = true;
      await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
      await loadProject(state.currentProject.id);
    } catch (err) { alert(err.message); }
  });
}

async function loadRelationCandidates() {
  if (!state.currentTask || !state.currentProject) return;
  try {
    const { tasks } = await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/relation-candidates`);
    const select = $('#td-relation-target');
    select.innerHTML = '<option value="">-- Task wählen --</option>';
    for (const t of tasks) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `#${t.id} ${t.title} (${t.status})`;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error('Candidates laden fehlgeschlagen:', err.message);
  }
}

/* Global function for remove relation */
window.removeRelation = async function(targetTaskId, relType, direction) {
  if (!confirm('Verknüpfung wirklich entfernen?')) return;
  if (!state.currentTask || !state.currentProject) return;
  try {
    await api(`/api/projects/${state.currentProject.id}/tasks/${state.currentTask.task.id}/relations/${targetTaskId}?type=${relType}&direction=${direction}`, { method: 'DELETE' });
    await loadTaskDetail(state.currentProject.id, state.currentTask.task.id);
    await loadProject(state.currentProject.id);
  } catch (err) { alert(err.message); }
};

/* Hook into renderTaskDetail */
const _origRenderTaskDetail2 = renderTaskDetail;
renderTaskDetail = function(data) {
  _origRenderTaskDetail2(data);
  if (data.parent !== undefined || data.children !== undefined) {
    renderTaskRelations(data);
  }
};

/* Init relation events */
bindRelationEvents();

/* ===== ISSUE #77/#78: GITHUB/GITLAB TRACKER ===== */

/* ===== ADMIN: GitHub Settings ===== */
async function loadGitHubSettings() {
  // #96: Formular wurde aus der Benutzerverwaltung entfernt – nur noch Sync-Seite
  const form = $('#github-settings-form');
  if (!form) return;
  try {
    const s = await api('/api/github/settings');
    form.base_url.value = s.base_url || '';
    form.access_token.value = '';
    form.service_account_username.value = s.service_account_username || '';
  } catch (err) {
    console.error('GitHub-Settings konnten nicht geladen werden:', err.message);
  }
}

function bindGitHubAdminEvents() {
  bind('submit', async (e) => {
    if (e.target.id === 'github-settings-form') {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/github/settings', {
          method: 'PUT',
          body: {
            base_url: fd.get('base_url'),
            access_token: fd.get('access_token'),
            service_account_username: fd.get('service_account_username') || null,
          },
        });
        $('#github-settings-msg').textContent = '✅ Gespeichert';
        setTimeout(() => { $('#github-settings-msg').textContent = ''; }, 2000);
      } catch (err) {
        $('#github-settings-msg').textContent = '❌ ' + err.message;
      }
    }
  });

  bind('#test-github-btn', async () => {
    if (!$('#github-settings-form')) return; // #96: Formular entfernt
    try {
      const result = await api('/api/github/settings/test', { method: 'POST' });
      $('#github-settings-msg').textContent = `✅ Verbunden als: ${result.user.name || result.user.username} (@${result.user.username})`;
    } catch (err) {
      $('#github-settings-msg').textContent = '❌ ' + err.message;
    }
  });
}

/* ===== PROJECT: Tracker Selection & Repo Picker ===== */
async function loadProjectTracker(projectId) {
  const block = $('#gitlab-block');
  if (!block) return;
  try {
    const t = await api(`/api/projects/${projectId}/tracker`);
    block.hidden = false;
    state.currentTracker = t;
    renderTrackerForm(t);
  } catch (err) {
    block.hidden = true;
  }
}

function renderTrackerForm(tracker) {
  // #106: Nur noch Link + Sync-Button anzeigen (kein Formular mehr in der Projektansicht)
  const type = tracker.type || 'none';
  const linkEl = $('#tracker-repo-link');
  const syncBtn = $('#sync-tracker-btn');
  const titleEl = $('#tracker-block-title');
  const toggleBtn = $('#toggle-project-tracker-settings-btn');

  titleEl.textContent = type === 'github' ? 'GitHub' : type === 'gitlab' ? 'GitLab' : 'Issue-Tracker';

  if (type === 'github' && tracker.github_repo) {
    // GitHub repo link
    const baseUrl = (state.currentTrackerSettings && state.currentTrackerSettings.base_url) || 'https://github.com';
    linkEl.href = baseUrl.replace(/\/+$/, '') + '/' + tracker.github_repo;
    linkEl.textContent = tracker.github_repo;
    linkEl.style.display = '';
  } else if (type === 'gitlab' && tracker.gitlab_project_id) {
    // GitLab project link (base_url aus settings wenn vorhanden)
    const baseUrl = (state.currentTrackerSettings && state.currentTrackerSettings.base_url) || '';
    if (baseUrl) {
      linkEl.href = baseUrl.replace(/\/+$/, '') + '/-/projects/' + tracker.gitlab_project_id;
    } else {
      linkEl.href = '#';
    }
    linkEl.textContent = 'GitLab-Projekt #' + tracker.gitlab_project_id;
    linkEl.style.display = '';
  } else {
    linkEl.textContent = '(kein Repository verknüpft – in Admin → Projektverwaltung einstellen)';
    linkEl.removeAttribute('href');
    linkEl.style.display = '';
  }

  const canEdit = state.currentProject && ['admin', 'projektmanager'].includes(state.currentProject.my_role);
  if (syncBtn) syncBtn.hidden = !tracker.configured;
  if (toggleBtn) toggleBtn.hidden = !canEdit || type === 'none';
}

// #106: updateTrackerFormVisibility entfernt – Projektansicht zeigt nur Link + Sync

function bindTrackerEvents() {
  // #106: Tracker-Auswahl nur noch in Admin-Projektverwaltung

  // #106: tracker-project-form submit entfernt (nur noch Link-Anzeige)

  bind('#sync-tracker-btn', async () => {
    if (!state.currentProject) return;
    try {
      await api(`/api/projects/${state.currentProject.id}/tracker/sync`, { method: 'POST' });
      await loadProject(state.currentProject.id);
      alert('✅ Synchronisiert');
    } catch (err) { alert(err.message); }
  });

  // #106: pick-tracker-project-btn entfernt – Repository-Auswahl nur noch in Admin-Projektverwaltung
}

function renderTrackerSearchResults(projects, type) {
  const resultsDiv = $('#tracker-search-results');
  const list = $('#tracker-search-list');
  resultsDiv.hidden = false;
  list.innerHTML = '';
  if (!projects.length) {
    list.innerHTML = '<li><small style="color:var(--text-muted);">Keine Ergebnisse.</small></li>';
    return;
  }
  for (const p of projects) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:0.5rem; cursor:pointer; border-bottom:1px solid var(--border);';
    const displayName = type === 'github' ? p.full_name : (p.path_with_namespace || p.name);
    const id = type === 'github' ? p.full_name : p.id;
    li.innerHTML = `<strong>${escapeHtml(displayName)}</strong>${p.description ? `<br><small style="color:var(--text-muted);">${escapeHtml(p.description.slice(0, 80))}</small>` : ''}`;
    li.onclick = () => {
      if (type === 'github') {
        $('#github-repo-input').value = id;
      } else {
        $('#gitlab-project-id-input').value = id;
      }
      resultsDiv.hidden = true;
    };
    list.appendChild(li);
  }
}

/* ===== HOOK INTO loadProject ===== */
const _origLoadProjectTracker = loadProject;
loadProject = async function(id) {
  await _origLoadProjectTracker(id);
  try { await loadProjectTracker(id); } catch (e) { console.error('loadProjectTracker:', e.message); }
};

/* ===== HOOK INTO loadAdmin ===== */
const _origLoadAdminGh = typeof loadAdmin !== 'undefined' ? loadAdmin : null;
if (_origLoadAdminGh) {
  const _prevLoadAdminGh = window.loadAdmin || _origLoadAdminGh;
  window.loadAdmin = async function(defaultTab) {
    await _prevLoadAdminGh(defaultTab);
    try { await loadGitHubSettings(); } catch (e) { console.error('loadGitHubSettings:', e.message); }
  };
}

/* ===== INIT ===== */
bindGitHubAdminEvents();
bindTrackerEvents();

/* ============================================================
 * Issues #80-83: Admin-Projektverwaltung, Pro-Projekt Tracker-Settings,
 * Auto-Sync beim Projekt-Oeffnen, Auto-Sync beim Task-Speichern
 * ============================================================ */

/* ===== #81: Admin-Projektverwaltung ===== */

async function loadAdminProjects() {
  const tbody = $('#admin-project-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">Laden...</td></tr>';
  try {
    // #90: Projektmanager sehen nur eigene Projekte, Admins alle
    const isAdmin = (state.user && state.user.roles || []).includes('admin');
    const endpoint = isAdmin ? '/api/admin/projects' : '/api/admin/my-projects';
    const { projects } = await api(endpoint);
    tbody.innerHTML = '';
    if (!projects || projects.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">Keine Projekte vorhanden.</td></tr>';
      return;
    }
    for (const p of projects) {
      const tr = document.createElement('tr');
      const statusLabels = { active: 'Aktiv', paused: 'Pausiert', done: 'Abgeschlossen', archived: 'Archiviert' };
      const statusLabel = statusLabels[p.status] || p.status || 'active';
      let trackerLabel = p.issue_tracker_type === 'gitlab' ? 'GitLab' : p.issue_tracker_type === 'github' ? 'GitHub' : '\u2013';
      if (p.issue_tracker_type === 'gitlab' && Number(p.has_gitlab_settings) > 0) trackerLabel += ' \u2705';
      if (p.issue_tracker_type === 'github' && Number(p.has_github_settings) > 0) trackerLabel += ' \u2705';
      tr.innerHTML = `
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.owner_name || '')}</td>
        <td><span class="badge">${statusLabel}</span></td>
        <td>${trackerLabel}</td>
        <td style="text-align:center;">${p.task_count || 0}</td>
        <td style="text-align:center;">${p.member_count || 0}</td>
        <td>
          <button class="btn-small edit-admin-project-btn">Bearbeiten</button>
          <button class="btn-small btn-secondary delete-admin-project-btn" style="color:var(--danger);">L\u00f6schen</button>
        </td>`;
      tr.querySelector('.edit-admin-project-btn').onclick = () => editAdminProject(p);
      tr.querySelector('.delete-admin-project-btn').onclick = () => deleteAdminProject(p);
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger);">Fehler: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function editAdminProject(project) {
  const form = $('#admin-project-form');
  if (!form) return;
  form.hidden = false;
  form.elements['id'].value = project.id;
  form.elements['name'].value = project.name || '';
  form.elements['description'].value = project.description || '';
  form.elements['status'].value = project.status || 'active';

  // #96: Tracker-Felder befüllen
  const trackerTypeSelect = $('#admin-project-tracker-type');
  if (trackerTypeSelect) {
    trackerTypeSelect.value = project.issue_tracker_type || 'none';
    updateAdminProjectTrackerVisibility(project.issue_tracker_type || 'none');
  }
  const glIdInput = $('#admin-project-gitlab-id');
  if (glIdInput) glIdInput.value = project.gitlab_project_id || '';
  const ghRepoInput = $('#admin-project-github-repo');
  if (ghRepoInput) ghRepoInput.value = project.github_repo || '';
  // Project-spezifische Verbindungsdaten laden
  loadAdminProjectConnectionSettings(project.id);

  // #91/#96: Tracker-Typ-Wechsel-Handler
  if (trackerTypeSelect && !trackerTypeSelect.dataset.bound) {
    trackerTypeSelect.dataset.bound = '1';
    trackerTypeSelect.addEventListener('change', (e) => {
      updateAdminProjectTrackerVisibility(e.target.value);
    });
  }

  // Owner-Dropdown laden
  const ownerSelect = $('#admin-project-owner-select');
  ownerSelect.innerHTML = '<option value="">Laden...</option>';
  try {
    const { users } = await api('/api/admin/projects-users');
    ownerSelect.innerHTML = '';
    for (const u of users) {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = `${u.name} (@${u.username})`;
      if (String(u.id) === String(project.owner_id)) opt.selected = true;
      ownerSelect.appendChild(opt);
    }
  } catch (err) {
    ownerSelect.innerHTML = `<option value="${project.owner_id}">${escapeHtml(project.owner_name || '')}</option>`;
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteAdminProject(project) {
  if (!confirm(`Projekt "${project.name}" wirklich l\u00f6schen?\nAlle Tasks, Mitglieder und Einstellungen werden entfernt.`)) return;
  try {
    await api(`/api/admin/projects/${project.id}`, { method: 'DELETE' });
    await loadAdminProjects();
  } catch (err) { alert(err.message); }
}

function bindAdminProjectEvents() {
  // Form submit (edit)

  // Cancel button
  bind('#admin-project-cancel-btn', () => {
    $('#admin-project-form').hidden = true;
  });
}

/* ===== #82: Pro-Projekt Tracker-Settings ===== */

async function loadProjectTrackerSettings(projectId) {
  const block = $('#project-tracker-settings-block');
  const toggleBtn = $('#toggle-project-tracker-settings-btn');
  if (!block || !toggleBtn) return;

  // Nur anzeigen, wenn ein Tracker konfiguriert ist
  const trackerType = state.currentTracker ? state.currentTracker.type : null;
  if (!trackerType || trackerType === 'none') {
    toggleBtn.hidden = true;
    block.hidden = true;
    return;
  }
  // #91: Button nur anzeigen wenn User edit_project-Rechte hat (admin/projektmanager)
  const canEditProject = state.currentProject && ['admin', 'projektmanager'].includes(state.currentProject.my_role);
  toggleBtn.hidden = !canEditProject;

  // Settings laden
  try {
    const settings = await api(`/api/projects/${projectId}/tracker/settings`);
    state.currentTrackerSettings = settings;
    if (settings.has_project_settings && settings.base_url) {
      const form = $('#project-tracker-settings-form');
      form.elements['base_url'].value = settings.base_url || '';
      form.elements['access_token'].value = ''; // Token nicht anzeigen, nur neu eingeben
      form.elements['service_account_username'].value = settings.service_account_username || '';
    }
  } catch (err) {
    // Nicht kritisch - einfach keine Settings vorausf\u00fcllen
    console.error('Tracker-Settings konnten nicht geladen werden:', err.message);
  }
}

function bindProjectTrackerSettingsEvents() {
  // Toggle visibility
  bind('#toggle-project-tracker-settings-btn', () => {
    const block = $('#project-tracker-settings-block');
    if (block) block.hidden = !block.hidden;
  });

  // Form submit (save)
  // #105 ULTIMATE FIX: Direct onsubmit on the form element (most reliable)
  const apf = $('#admin-project-form');
  if (apf) {
    apf.onsubmit = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('[admin-project-form] onsubmit fired');
      const fd = new FormData(apf);
      const id = fd.get('id');
      const trackerType = fd.get('issue_tracker_type') || 'none';
      const body = {
        name: fd.get('name'),
        description: fd.get('description') || null,
        status: fd.get('status'),
        owner_id: Number(fd.get('owner_id')),
        issue_tracker_type: trackerType,
        conn_base_url: fd.get('conn_base_url') || null,
        conn_access_token: fd.get('conn_access_token') || null,
        conn_service_account: fd.get('conn_service_account') || null,
      };
      if (trackerType === 'gitlab') {
        const gid = fd.get('gitlab_project_id');
        body.gitlab_project_id = gid ? Number(gid) : null;
        body.github_repo = null;
      } else if (trackerType === 'github') {
        body.github_repo = fd.get('github_repo') || null;
        body.gitlab_project_id = null;
      } else {
        body.gitlab_project_id = null;
        body.github_repo = null;
      }
      console.log('[admin-project-form] sending PUT', id, JSON.stringify({trackerType, hasUrl: !!body.conn_base_url, hasToken: !!body.conn_access_token, repo: body.github_repo}));
      const msgEl = $('#admin-project-conn-msg');
      try {
        const resp = await api(`/api/admin/projects/${id}`, { method: 'PUT', body });
        console.log('[admin-project-form] saved OK:', JSON.stringify(resp).slice(0, 200));
        if (msgEl) { msgEl.textContent = '✅ Gespeichert'; msgEl.style.color = 'var(--success, #4caf50)'; }
        await loadAdminProjectConnectionSettings(id);
        if (typeof loadAdminProjects === 'function') await loadAdminProjects();
      } catch (err) {
        console.error('[admin-project-form] save FAILED:', err.message);
        if (msgEl) { msgEl.textContent = '❌ ' + err.message; msgEl.style.color = 'var(--danger, #f44336)'; }
      }
      return false;
    };
  }
  // Backup: document-level capture listener
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'admin-project-form') return;
    // onsubmit already handled it
    if (e.defaultPrevented) return;
    e.preventDefault();
    console.log('[admin-project-form] document-level fallback fired');
  }, true);

  // Delete (reset to global)
  bind('#delete-project-tracker-settings-btn', async () => {
    if (!state.currentProject) return;
    if (!confirm('Projekt-spezifische Verbindung entfernen? Es wird wieder die globale Verbindung verwendet.')) return;
    const msgEl = $('#project-tracker-settings-msg');
    try {
      await api(`/api/projects/${state.currentProject.id}/tracker/settings`, { method: 'DELETE' });
      const form = $('#project-tracker-settings-form');
      if (form) form.reset();
      if (msgEl) { msgEl.textContent = '\u2705 Auf globale Einstellungen zur\u00fcckgesetzt'; msgEl.style.color = 'var(--success)'; }
      await loadProjectTrackerSettings(state.currentProject.id);
    } catch (err) {
      if (msgEl) { msgEl.textContent = err.message; msgEl.style.color = 'var(--danger)'; }
    }
  });
}

/* ===== #80: Sync-Indikator beim Projekt-Oeffnen ===== */

function showSyncIndicator() {
  // Zeigt einen kleinen Indikator in der Projekt-Detail-Ansicht
  let indicator = $('#sync-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.id = 'sync-indicator';
    indicator.className = 'badge';
    indicator.style.cssText = 'margin-left:0.5rem; font-size:0.75rem; opacity:0.7;';
    const detailStatus = $('#detail-status');
    if (detailStatus && detailStatus.parentNode) {
      detailStatus.parentNode.appendChild(indicator);
    }
  }
  indicator.textContent = '\u21bb Sync...';
  indicator.hidden = false;
}

function hideSyncIndicator() {
  const indicator = $('#sync-indicator');
  if (indicator) indicator.hidden = true;
}

/* ===== HOOKS ===== */

// Hook: loadAdmin -> auch Projekte laden (#81)
const _origLoadAdminFinal = typeof loadAdmin !== 'undefined' ? loadAdmin : null;
if (_origLoadAdminFinal) {
  const _prevLoadAdmin2 = window.loadAdmin || _origLoadAdminFinal;
  window.loadAdmin = async function(defaultTab) {
    await _prevLoadAdmin2(defaultTab);
    try { await loadAdminProjects(); } catch (e) { console.error('loadAdminProjects:', e.message); }
  };
}

// Hook: loadProject -> auch Tracker-Settings laden (#82)
const _origLoadProjectFinal = loadProject;
loadProject = async function(id) {
  await _origLoadProjectFinal(id);
  // #80: Sync-Indikator anzeigen waehrend Backend-Sync laeuft
  try {
    const tracker = state.currentTracker;
    if (tracker && tracker.configured) showSyncIndicator();
    await loadProjectTrackerSettings(id);
    // Indikator nach kurzer Zeit ausblenden (Backend-Sync ist best-effort)
    setTimeout(hideSyncIndicator, 3000);
  } catch (e) { console.error('loadProjectTrackerSettings:', e.message); }
};

/* ===== INIT ===== */
bindAdminProjectEvents();
bindProjectTrackerSettingsEvents();

/* ============================================================
 * #91 (reopened) + #96: Tracker-Verbindung in "Projekt bearbeiten" (Admin-Tab)
 * ============================================================ */

function updateAdminProjectTrackerVisibility(type) {
  const glLabel = $('#admin-project-gitlab-id-label');
  const ghLabel = $('#admin-project-github-repo-label');
  const connBlock = $('#admin-project-connection-block');
  if (glLabel) glLabel.hidden = type !== 'gitlab';
  if (ghLabel) ghLabel.hidden = type !== 'github';
  if (connBlock) connBlock.hidden = type === 'none';
}

async function loadAdminProjectConnectionSettings(projectId) {
  const msgEl = $('#admin-project-conn-msg');
  const baseUrlInput = $('#admin-project-conn-base-url');
  const saInput = $('#admin-project-conn-sa');
  const tokenInput = $('#admin-project-conn-access-token');
  try {
    const s = await api(`/api/admin/projects/${projectId}/tracker/settings`);
    if (s.has_project_settings) {
      if (baseUrlInput) baseUrlInput.value = s.base_url || '';
      if (saInput) saInput.value = s.service_account_username || '';
      if (tokenInput) { tokenInput.value = ''; tokenInput.placeholder = 'Token gespeichert (neu eingeben zum \u00c4ndern)'; }
      if (msgEl) { msgEl.textContent = '\u2705 Projekt-spezifische Verbindung aktiv: ' + (s.base_url || ''); msgEl.style.color = 'var(--success, #4caf50)'; }
    } else {
      if (baseUrlInput) baseUrlInput.value = '';
      if (saInput) saInput.value = '';
      if (tokenInput) { tokenInput.value = ''; tokenInput.placeholder = '(leer lassen = global verwenden)'; }
      if (msgEl) { msgEl.textContent = 'Globale Verbindung wird verwendet.'; msgEl.style.color = 'var(--text-muted)'; }
    }
  } catch (e) {
    if (msgEl) { msgEl.textContent = ''; msgEl.style.color = ''; }
  }
}

// Test-Button für die projekt-spezifische Verbindung im Admin-Tab
bind('#admin-project-test-conn-btn', async () => {
  const form = $('#admin-project-form');
  if (!form || form.elements['id'].value === '') return;
  const projectId = form.elements['id'].value;
  const msgEl = $('#admin-project-conn-msg');
  const detailEl = $('#admin-project-conn-detail');
  // Werte direkt aus dem Formular lesen (auch wenn noch nicht gespeichert)
  const fd = new FormData(form);
  const trackerType = fd.get('issue_tracker_type') || 'none';
  const connBaseUrl = fd.get('conn_base_url') || '';
  const connToken = fd.get('conn_access_token') || '';
  const connSa = fd.get('conn_service_account') || '';
  if (msgEl) { msgEl.textContent = 'Teste Verbindung...'; msgEl.style.color = 'var(--text-muted)'; }
  if (detailEl) { detailEl.hidden = false; detailEl.textContent = ''; }
  if (trackerType === 'none') {
    if (msgEl) { msgEl.textContent = '❌ Bitte zuerst GitLab oder GitHub als Tracker wählen.'; msgEl.style.color = 'var(--danger, #f44336)'; }
    if (detailEl) { detailEl.textContent = JSON.stringify({ status: 'FEHLER', error: 'Tracker-Typ ist "Keiner" – bitte GitLab oder GitHub wählen.' }, null, 2); }
    return;
  }
  if (!connBaseUrl || !connToken) {
    if (msgEl) { msgEl.textContent = '❌ Bitte API-URL und Access Token eingeben.'; msgEl.style.color = 'var(--danger, #f44336)'; }
    if (detailEl) { detailEl.textContent = JSON.stringify({ status: 'FEHLER', error: 'API-URL und Access Token fehlen im Formular.' }, null, 2); }
    return;
  }
  try {
    const r = await api(`/api/admin/projects/${projectId}/tracker/settings/test`, {
      method: 'POST',
      body: { type: trackerType, base_url: connBaseUrl, access_token: connToken, service_account_username: connSa || null },
    });
    const src = r.used_project_settings ? 'Formular-Werte' : 'gespeichert';
    if (msgEl) { msgEl.textContent = '✅ OK: @' + (r.user.username || r.user.login || r.user.name) + ' (' + r.service + ', ' + (r.response_time_ms || '?') + 'ms)'; msgEl.style.color = 'var(--success, #4caf50)'; }
    if (detailEl) {
      detailEl.textContent = JSON.stringify({
        status: 'OK (HTTP ' + (r.http_status || 200) + ')',
        service: r.service,
        tested_type: r.tested_type,
        base_url: r.base_url,
        settings_source: src,
        user: r.user,
        response_time_ms: r.response_time_ms,
      }, null, 2);
    }
  } catch (err) {
    if (msgEl) { msgEl.textContent = '❌ Fehler (HTTP ' + (err.status || '?') + '): ' + err.message; msgEl.style.color = 'var(--danger, #f44336)'; }
    if (detailEl) {
      detailEl.textContent = JSON.stringify({
        status: 'FEHLER (HTTP ' + (err.status || '?') + ')',
        tested_type: trackerType,
        base_url: connBaseUrl,
        error: err.message,
        response_time_ms: null,
      }, null, 2);
    }
  }
});
