const db = require('../config/database');

async function getSettings() {
  const { rows } = await db.query('SELECT id, base_url, access_token FROM gitlab_settings ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

async function saveSettings(baseUrl, accessToken, userId) {
  const { rows } = await db.query(
    `INSERT INTO gitlab_settings (base_url, access_token, updated_by)
     VALUES ($1, $2, $3) RETURNING id, base_url`,
    [baseUrl.replace(/\/+$/, ''), accessToken, userId]
  );
  return rows[0];
}

async function gitlabRequest(path, { method = 'GET', body } = {}) {
  const settings = await getSettings();
  if (!settings) {
    const err = new Error('GitLab ist nicht konfiguriert');
    err.status = 400;
    throw err;
  }

  const res = await fetch(`${settings.base_url}/api/v4${path}`, {
    method,
    headers: {
      'PRIVATE-TOKEN': settings.access_token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
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

async function syncProjectIssues(projectId, gitlabProjectId) {
  const issues = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues?per_page=100&order_by=updated_at&sort=desc`
  );

  for (const issue of issues) {
    const mapped = mapGitLabIssue(issue);
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
  return rows;
}

async function createGitLabIssue(gitlabProjectId, { title, description }) {
  const issue = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues`,
    { method: 'POST', body: { title, description } }
  );
  return mapGitLabIssue(issue);
}

async function updateGitLabIssue(gitlabProjectId, iid, { title, description, state_event }) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (description !== undefined) body.description = description;
  if (state_event) body.state_event = state_event;
  const issue = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}`,
    { method: 'PUT', body }
  );
  return mapGitLabIssue(issue);
}

async function addGitLabComment(gitlabProjectId, iid, note) {
  await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}/notes`,
    { method: 'POST', body: { body: note } }
  );
  return true;
}

async function getGitLabComments(gitlabProjectId, iid) {
  return gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}/notes?per_page=100&order_by=created_at&sort=asc`
  );
}

async function listGitLabProjects(search) {
  const q = search ? `?search=${encodeURIComponent(search)}&membership=true&per_page=50&order_by=last_activity_at&sort=desc` : '?membership=true&per_page=50&order_by=last_activity_at&sort=desc';
  const projects = await gitlabRequest(`/projects${q}`);
  return projects.map(p => ({
    id: p.id,
    name: p.name,
    path_with_namespace: p.path_with_namespace,
    description: p.description || '',
    web_url: p.web_url,
    default_branch: p.default_branch || null,
  }));
}

async function listGitLabGroups(search) {
  const q = search ? `?search=${encodeURIComponent(search)}&per_page=50&order_by=last_activity_at&sort=desc` : '?per_page=50&order_by=last_activity_at&sort=desc';
  const groups = await gitlabRequest(`/groups${q}`);
  return groups.map(g => ({
    id: g.id,
    name: g.name,
    full_path: g.full_path,
    web_url: g.web_url,
  }));
}

async function listGitLabMilestones(gitlabProjectId) {
  const milestones = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/milestones?per_page=100&order_by=due_date&sort=asc`
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

async function listGitLabLabels(gitlabProjectId) {
  return gitlabRequest(`/projects/${encodeURIComponent(gitlabProjectId)}/labels?per_page=100`);
}

async function assignGitLabIssue(gitlabProjectId, iid, assigneeId) {
  const issue = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/issues/${iid}`,
    { method: 'PUT', body: { assignee_id: assigneeId } }
  );
  return mapGitLabIssue(issue);
}

async function listGitLabUsers(gitlabProjectId) {
  const users = await gitlabRequest(
    `/projects/${encodeURIComponent(gitlabProjectId)}/users?per_page=100`
  );
  return users.map(u => ({ id: u.id, username: u.username, name: u.name }));
}

async function syncProjectMilestones(projectId, gitlabProjectId) {
  const milestones = await listGitLabMilestones(gitlabProjectId);
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
};
