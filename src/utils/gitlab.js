const db = require('../config/database');
const { version } = require('../../package.json');
/**
 * Validiert eine Tracker base_url und gibt den Hostnamen zurück.
 * Erlaubt nur https (http nur für lokale Entwicklung) und lehnt
 * Credentials, Ports mit Sonderzeichen, Pfade und Query ab.
 * Rückgabe: valider Hostname-String oder null.
 */
function validateTrackerHost(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) return null;
    if (u.username || u.password) return null;
    if (u.pathname !== '/' || u.search || u.hash) return null;
    const host = u.hostname;
    if (!host || /[^a-zA-Z0-9.\-\[\]:]/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}


async function getSettings() {
  const { rows } = await db.query(
    'SELECT id, base_url, access_token, service_account_username FROM gitlab_settings ORDER BY id DESC LIMIT 1'
  );
  return rows[0] || null;
}

// Entfernt abschließende Slashes aus einer URL – ohne Regex, da die URL
// user-kontrolliert ist und ein Muster wie /\/+$/ von CodeQL als
// potenzielles ReDoS-Risiko (polynomial regular expression) gemeldet wird.
function stripTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}

async function saveSettings(baseUrl, accessToken, userId, serviceAccountUsername) {
  const { rows } = await db.query(
    `INSERT INTO gitlab_settings (base_url, access_token, updated_by, service_account_username)
     VALUES ($1, $2, $3, $4) RETURNING id, base_url`,
    [stripTrailingSlashes(baseUrl), accessToken, userId, serviceAccountUsername || null]
  );
  return rows[0];
}

async function gitlabRequest(path, { method = 'GET', body, projectSettings } = {}) {
  const settings = projectSettings || await getSettings();
  if (!settings) {
    const err = new Error('GitLab ist nicht konfiguriert');
    err.status = 400;
    throw err;
  }

  const headers = {
    'PRIVATE-TOKEN': settings.access_token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': process.env.GITLAB_USER_AGENT || `pp-project-management/${version}`,
  };
  if (settings.service_account_username) {
    headers['X-GitLab-Username'] = settings.service_account_username;
  }

  // SSRF-Schutz: nur validierter Hostname, festes https-Schema
  const host = validateTrackerHost(settings.base_url);
  if (!host) {
    const err = new Error('Ungültige GitLab base_url');
    err.status = 400;
    throw err;
  }
  const apiUrl = 'https://' + host + '/api/v4' + path;
  const res = await fetch(apiUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const err = new Error(
        `GitLab API Fehler (${res.status}): HTML-Antwort statt JSON – vermutlich blockiert ein Bot-Schutz ` +
        `(z. B. Cloudflare "Just a moment...") die Anfrage. User-Agent (GITLAB_USER_AGENT) und IP-Freigaben ` +
        `in der GitLab-/Cloudflare-Konfiguration prüfen.`
      );
      err.status = 502;
      throw err;
    }
    const err = new Error(`GitLab API Fehler (${res.status}): ${text.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  if (res.status === 204) return null;
  return res.json();
}

function mapGitLabIssue(issue) {
  return {
    gitlab_iid: issue.iid,
    title: issue.title,
    description: issue.description || '',
    state: issue.state,
    web_url: issue.web_url,
    assignees: (issue.assignees || []).map(a => ({ id: a.id, username: a.username, name: a.name })),
    assignee_id: issue.assignee ? issue.assignee.id : null,
    labels: issue.labels || [],
    milestone: issue.milestone ? { id: issue.milestone.id, title: issue.milestone.title } : null,
  };
}

async function syncProjectIssues(projectId, gitlabProjectId, options = {}) {
  const issues = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues?per_page=100&order_by=updated_at&sort=desc`,
    { projectSettings: options.projectSettings }
  );

  for (const issue of issues) {
    const mapped = mapGitLabIssue(issue);
    await db.query(
      `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       ON CONFLICT (project_id, gitlab_iid) DO UPDATE
       SET title = EXCLUDED.title,
           description = EXCLUDED.description,
           state = EXCLUDED.state,
           web_url = EXCLUDED.web_url,
           raw_data = EXCLUDED.raw_data,
           synced_at = NOW()`,
      [projectId, mapped.gitlab_iid, mapped.title, mapped.description, mapped.state, mapped.web_url, JSON.stringify(issue)]
    );
  }

  await db.query(
    `DELETE FROM gitlab_issues
     WHERE project_id = $1 AND synced_at < NOW() - INTERVAL '1 minute'`,
    [projectId]
  );

  const { rows } = await db.query(
    'SELECT * FROM gitlab_issues WHERE project_id = $1 ORDER BY synced_at DESC',
    [projectId]
  );

  // #72 + Tracker-Mapping: GitLab-Issues in lokale Tasks zurückführen (Pull-Richtung).
  // Gemappte externe Felder landen in den eigenen Feldern, nicht gemappte externe
  // Felder als Markdown-Tabelle in der Beschreibung.
  const issueTracker = require('./issueTracker');
  for (const issue of rows) {
    await issueTracker.applyPullToTask(projectId, 'gitlab', issue);
  }

  return rows;
}

async function createGitLabIssue(gitlabProjectId, payload = {}, options = {}) {
  const { title, description } = payload;
  const body = { title, description };
  if (payload.labels !== undefined) body.labels = payload.labels;
  if (payload.due_date) body.due_date = payload.due_date;
  if (payload.milestone_id != null) body.milestone_id = payload.milestone_id;
  if (payload.time_estimate != null) body.time_estimate = payload.time_estimate;
  if (payload.time_spent != null) body.time_spent = payload.time_spent;
  const issue = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues`,
    { method: 'POST', body, projectSettings: options.projectSettings }
  );
  return mapGitLabIssue(issue);
}

async function updateGitLabIssue(gitlabProjectId, iid, payload = {}, options = {}) {
  const { title, description, state_event } = payload;
  const body = {};
  if (title !== undefined) body.title = title;
  if (description !== undefined) body.description = description;
  if (state_event) body.state_event = state_event;
  if (payload.labels !== undefined) body.labels = payload.labels;
  if (payload.due_date !== undefined) body.due_date = payload.due_date || null;
  if (payload.milestone_id !== undefined) body.milestone_id = payload.milestone_id || null;
  if (payload.time_estimate !== undefined) body.time_estimate = payload.time_estimate;
  if (payload.time_spent !== undefined) body.time_spent = payload.time_spent;
  const issue = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}`,
    { method: 'PUT', body, projectSettings: options.projectSettings }
  );
  return mapGitLabIssue(issue);
}

async function addGitLabComment(gitlabProjectId, iid, note, options = {}) {
  await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}/notes`,
    { method: 'POST', body: { body: note }, projectSettings: options.projectSettings }
  );
  return true;
}

async function getGitLabComments(gitlabProjectId, iid, options = {}) {
  return gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}/notes?per_page=100&order_by=created_at&sort=asc`,
    { projectSettings: options.projectSettings }
  );
}

async function listGitLabProjects(search, options = {}) {
  const q = search ? `?search=${encodeURIComponent(search)}&membership=true&per_page=50&order_by=last_activity_at&sort=desc` : '?membership=true&per_page=50&order_by=last_activity_at&sort=desc';
  const projects = await gitlabRequest(`/projects${q}`, { projectSettings: options.projectSettings });
  return projects.map(p => ({
    id: p.id,
    name: p.name,
    path_with_namespace: p.path_with_namespace,
    description: p.description || '',
    web_url: p.web_url,
    default_branch: p.default_branch || null,
  }));
}

async function listGitLabGroups(search, options = {}) {
  const q = search ? `?search=${encodeURIComponent(search)}&per_page=50&order_by=last_activity_at&sort=desc` : '?per_page=50&order_by=last_activity_at&sort=desc';
  const groups = await gitlabRequest(`/groups${q}`, { projectSettings: options.projectSettings });
  return groups.map(g => ({
    id: g.id,
    name: g.name,
    full_path: g.full_path,
    web_url: g.web_url,
  }));
}

async function listGitLabMilestones(gitlabProjectId, options = {}) {
  const milestones = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/milestones?per_page=100&order_by=due_date&sort=asc`,
    { projectSettings: options.projectSettings }
  );
  return milestones.map(m => ({
    gitlab_id: m.id,
    title: m.title,
    description: m.description || '',
    state: m.state,
    due_date: m.due_date || null,
    web_url: m.web_url,
  }));
}

async function listGitLabLabels(gitlabProjectId, options = {}) {
  return gitlabRequest(`/projects/${encodeURIComponent(gitlabProjectId)}/labels?per_page=100`, { projectSettings: options.projectSettings });
}

async function assignGitLabIssue(gitlabProjectId, iid, assigneeId, options = {}) {
  const issue = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}`,
    { method: 'PUT', body: { assignee_id: assigneeId }, projectSettings: options.projectSettings }
  );
  return mapGitLabIssue(issue);
}

async function listGitLabUsers(gitlabProjectId, options = {}) {
  const users = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/users?per_page=100`,
    { projectSettings: options.projectSettings }
  );
  return users.map(u => ({ id: u.id, username: u.username, name: u.name }));
}

async function syncProjectMilestones(projectId, gitlabProjectId, options = {}) {
  const milestones = await listGitLabMilestones(gitlabProjectId, options);
  for (const m of milestones) {
    await db.query(
      `INSERT INTO gitlab_milestones (project_id, gitlab_id, title, description, state, due_date, web_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (project_id, gitlab_id) DO UPDATE
       SET title = EXCLUDED.title,
           description = EXCLUDED.description,
           state = EXCLUDED.state,
           due_date = EXCLUDED.due_date,
           web_url = EXCLUDED.web_url,
           synced_at = NOW()`,
      [projectId, m.gitlab_id, m.title, m.description, m.state, m.due_date, m.web_url]
    );
  }
  const { rows } = await db.query(
    'SELECT * FROM gitlab_milestones WHERE project_id = $1 ORDER BY due_date NULLS LAST, id',
    [projectId]
  );
  return rows;
}

/**
 * #74: Erstellt einen GitLab-Issue-Link zwischen zwei Issues.
 * GitLab API: POST /projects/:id/issues/:issue_iid/links
 * @param {string|number} gitlabProjectId - GitLab-Projekt-ID
 * @param {number} sourceIid - Quell-Issue IID
 * @param {number} targetIid - Ziel-Issue IID
 * @param {string} linkType - 'relates_to' | 'blocks' | 'is_blocked_by'
 */
async function createIssueLink(gitlabProjectId, sourceIid, targetIid, linkType = 'relates_to', options = {}) {
  return gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${sourceIid}/links`,
    { method: 'POST', body: { target_project_id: gitlabProjectId, target_issue_iid: targetIid, link_type: linkType }, projectSettings: options.projectSettings }
  );
}

/**
 * #74: Löscht einen GitLab-Issue-Link.
 */
async function deleteIssueLink(gitlabProjectId, sourceIid, linkId, options = {}) {
  await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${sourceIid}/links/${linkId}`,
    { method: 'DELETE', projectSettings: options.projectSettings }
  );
  return true;
}

/**
 * #74: Holt alle Links eines GitLab-Issues.
 */
async function getIssueLinks(gitlabProjectId, iid, options = {}) {
  return gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}/links?per_page=100`,
    { projectSettings: options.projectSettings }
  );
}

module.exports = {
  getSettings,
  saveSettings,
  gitlabRequest,
  syncProjectIssues,
  syncProjectMilestones,
  createGitLabIssue,
  updateGitLabIssue,
  assignGitLabIssue,
  addGitLabComment,
  getGitLabComments,
  listGitLabProjects,
  listGitLabGroups,
  listGitLabMilestones,
  listGitLabLabels,
  listGitLabUsers,
  createIssueLink,
  deleteIssueLink,
  getIssueLinks,
};
