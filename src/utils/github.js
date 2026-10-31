const db = require('../config/database');
const taskMarkdown = require('./taskMarkdown');
const taskRelations = require('./taskRelations');
const { version } = require('../../package.json');
/**
 * Parst und validiert eine URL streng.
 * Gibt nur { protocol, host } zurück – kein Pfad, keine Query, keine Credentials.
 * Erlaubt nur http/https und rejectiert Credentials im URL.
 */
function safeParseUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if (!u.hostname) return null;
    // Host darf keine Steuerzeichen/Whitespace enthalten
    if (/[\s\u0000-\u001f]/.test(u.host)) return null;
    return { protocol: u.protocol, host: u.host };
  } catch {
    return null;
  }
}


/**
 * Kodiert "owner/repo" für die GitHub-API, ohne den trennenden Slash zu kodieren.
 */
function encodeRepo(repo) {
  return String(repo).split('/').map(encodeURIComponent).join('/');
}

/**
 * GitHub-Integration (analog zu gitlab.js).
 * Unterstützt GitHub REST API v3 (github.com oder GitHub Enterprise).
 */

async function getSettings() {
  const { rows } = await db.query(
    'SELECT id, base_url, access_token, service_account_username FROM github_settings ORDER BY id DESC LIMIT 1'
  );
  return rows[0] || null;
}

function stripTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}

async function saveSettings(baseUrl, accessToken, userId, serviceAccountUsername) {
  const { rows } = await db.query(
    `INSERT INTO github_settings (base_url, access_token, updated_by, service_account_username)
     VALUES ($1, $2, $3, $4) RETURNING id, base_url`,
    [stripTrailingSlashes(baseUrl), accessToken, userId, serviceAccountUsername || null]
  );
  return rows[0];
}

async function githubRequest(path, { method = 'GET', body, projectSettings } = {}) {
  const settings = projectSettings || await getSettings();
  if (!settings) {
    const err = new Error('GitHub ist nicht konfiguriert');
    err.status = 400;
    throw err;
  }

  const headers = {
    'Authorization': `Bearer ${settings.access_token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': process.env.GITHUB_USER_AGENT || `pp-project-management/${version}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  // SSRF-Schutz: base_url strikt validieren und nur validierte Komponenten verwenden
  const parsed = safeParseUrl(settings.base_url);
  if (!parsed) {
    const err = new Error('Ungültige GitHub base_url');
    err.status = 400;
    throw err;
  }
  const apiUrl = parsed.protocol + '//' + parsed.host + path;
  const res = await fetch(apiUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`GitHub API Fehler (${res.status}): ${text.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  if (res.status === 204) return null;
  return res.json();
}

function mapGitHubIssue(issue) {
  return {
    gitlab_iid: issue.number, // kompatibel: number statt iid
    github_number: issue.number,
    title: issue.title,
    description: issue.body || '',
    state: issue.state === 'open' ? 'opened' : 'closed', // GitLab-kompatibel
    web_url: issue.html_url,
    assignees: (issue.assignees || []).map(a => ({ id: a.id, username: a.login, name: a.login })),
    assignee_id: issue.assignee ? issue.assignee.id : null,
    labels: (issue.labels || []).map(l => typeof l === 'string' ? l : l.name),
    milestone: issue.milestone ? { id: issue.milestone.id, title: issue.milestone.title } : null,
  };
}

async function syncProjectIssues(projectId, repo, options = {}) {
  const issues = await githubRequest(
    `/repos/${encodeRepo(repo)}/issues?per_page=100&state=all&sort=updated&direction=desc`,
    { projectSettings: options.projectSettings }
  );

  // Nur Issues (keine PRs — GitHub listet PRs auch als Issues)
  const pureIssues = issues.filter(i => !i.pull_request);

  for (const issue of pureIssues) {
    const mapped = mapGitHubIssue(issue);
    await db.query(
      `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (project_id, gitlab_iid) DO UPDATE
       SET title = EXCLUDED.title,
           description = EXCLUDED.description,
           state = EXCLUDED.state,
           web_url = EXCLUDED.web_url,
           synced_at = NOW()`,
      [projectId, mapped.gitlab_iid, mapped.title, mapped.description, mapped.state, mapped.web_url]
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

  // #72/#77: GitHub-Issues mit pp-meta in lokale Tasks zurückführen (Pull-Richtung)
  for (const issue of rows) {
    const parsed = taskMarkdown.markdownToTaskFields(issue.description || '');
    if (parsed.meta) {
      const taskResult = await db.query(
        'SELECT id FROM tasks WHERE gitlab_iid = $1 AND project_id = $2',
        [issue.gitlab_iid, projectId]
      );
      if (taskResult.rows.length > 0) {
        const taskId = taskResult.rows[0].id;
        const m = parsed.meta;
        let newStatus = null;
        if (issue.state === 'closed' && m.status !== 'done') {
          newStatus = 'done';
        } else if (issue.state === 'opened' && m.status === 'done') {
          newStatus = 'in_progress';
        }
        await db.query(
          `UPDATE tasks
           SET title = COALESCE($1, title),
               description = $2,
               status = COALESCE($3, status),
               priority = COALESCE($4, priority),
               issue_type = COALESCE($5, issue_type),
               labels = COALESCE($6, labels),
               due_date = COALESCE($7, due_date),
               estimated_hours = COALESCE($8, estimated_hours),
               custom_fields = COALESCE($9, custom_fields),
               updated_at = NOW()
           WHERE id = $10`,
          [
            issue.title || null,
            parsed.description || null,
            newStatus,
            m.priority || null,
            m.issue_type || null,
            Array.isArray(m.labels) ? m.labels : null,
            m.due_date || null,
            m.estimated_hours != null ? m.estimated_hours : null,
            m.custom_fields && Object.keys(m.custom_fields).length > 0 ? m.custom_fields : null,
            taskId,
          ]
        );
        // #74: Relationen aus dem Meta-Block wiederherstellen (Pull)
        await taskRelations.restoreFromMeta(taskId, m, projectId);
      }
    }
  }
  return rows;
}

async function createGitHubIssue(repo, { title, description, labels }, options = {}) {
  const body = { title, body: description || '' };
  if (Array.isArray(labels) && labels.length > 0) body.labels = labels;
  const issue = await githubRequest(
    `/repos/${encodeRepo(repo)}/issues`,
    { method: 'POST', body, projectSettings: options.projectSettings }
  );
  return mapGitHubIssue(issue);
}

async function updateGitHubIssue(repo, number, { title, description, state_event }, options = {}) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (description !== undefined) body.body = description;
  if (state_event) body.state = state_event === 'close' ? 'closed' : 'open';
  const issue = await githubRequest(
    `/repos/${encodeRepo(repo)}/issues/${number}`,
    { method: 'PATCH', body, projectSettings: options.projectSettings }
  );
  return mapGitHubIssue(issue);
}

async function addGitHubComment(repo, number, note, options = {}) {
  await githubRequest(
    `/repos/${encodeRepo(repo)}/issues/${number}/comments`,
    { method: 'POST', body: { body: note }, projectSettings: options.projectSettings }
  );
  return true;
}

async function getGitHubComments(repo, number, options = {}) {
  const comments = await githubRequest(
    `/repos/${encodeRepo(repo)}/issues/${number}/comments?per_page=100`,
    { projectSettings: options.projectSettings }
  );
  return (comments || []).map(c => ({
    id: c.id,
    body: c.body,
    user: c.user ? { login: c.user.login, name: c.user.login } : null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
}

async function listGitHubRepos(search, options = {}) {
  // Authenticated user's repos
  if (search) {
    const data = await githubRequest(
      `/search/repositories?q=${encodeURIComponent(search)}+in:name&per_page=50&sort=updated`,
      { projectSettings: options.projectSettings }
    );
    return (data.items || []).map(r => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      description: r.description || '',
      web_url: r.html_url,
      default_branch: r.default_branch || null,
      private: r.private,
    }));
  }
  const repos = await githubRequest('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', { projectSettings: options.projectSettings });
  return (repos || []).map(r => ({
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    description: r.description || '',
    web_url: r.html_url,
    default_branch: r.default_branch || null,
    private: r.private,
  }));
}

async function listGitHubOrgs(options = {}) {
  const orgs = await githubRequest('/user/orgs?per_page=100', { projectSettings: options.projectSettings });
  return (orgs || []).map(o => ({
    id: o.id,
    login: o.login,
    name: o.name || o.login,
    web_url: o.html_url,
  }));
}

async function listGitHubMilestones(repo, options = {}) {
  const milestones = await githubRequest(
    `/repos/${encodeRepo(repo)}/milestones?per_page=100&state=all`,
    { projectSettings: options.projectSettings }
  );
  return (milestones || []).map(m => ({
    gitlab_id: m.id,
    title: m.title,
    description: m.description || '',
    state: m.state === 'open' ? 'active' : 'closed',
    due_date: m.due_on || null,
    web_url: m.html_url,
  }));
}

async function listGitHubLabels(repo, options = {}) {
  const labels = await githubRequest(
    `/repos/${encodeRepo(repo)}/labels?per_page=100`,
    { projectSettings: options.projectSettings }
  );
  return labels || [];
}

async function listGitHubUsers(repo, options = {}) {
  const users = await githubRequest(
    `/repos/${encodeRepo(repo)}/collaborators?per_page=100`,
    { projectSettings: options.projectSettings }
  );
  return (users || []).map(u => ({ id: u.id, username: u.login, name: u.login }));
}

async function testConnection(options = {}) {
  const user = await githubRequest('/user', { projectSettings: options.projectSettings });
  return { id: user.id, username: user.login, name: user.name || user.login };
}

module.exports = {
  getSettings,
  saveSettings,
  githubRequest,
  syncProjectIssues,
  createGitHubIssue,
  updateGitHubIssue,
  addGitHubComment,
  getGitHubComments,
  listGitHubRepos,
  listGitHubOrgs,
  listGitHubMilestones,
  listGitHubLabels,
  listGitHubUsers,
  testConnection,
};
