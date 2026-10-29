const db = require('../config/database');
const gitlab = require('./gitlab');
const github = require('./github');
const taskMarkdown = require('./taskMarkdown');

/**
 * Tracker-Abstraktion: Wählt je nach Projekttyp (gitlab/github/none)
 * den passenden Issue-Tracker und bietet einheitliche Funktionen.
 */

/**
 * Holt den Tracker-Typ und die Verbindungsdaten eines Projekts.
 * #82: Lädt auch project-spezifische Settings (project_gitlab_settings /
 * project_github_settings), die globale Settings überschreiben.
 */
async function getProjectTracker(projectId) {
  const { rows } = await db.query(
    'SELECT id, issue_tracker_type, gitlab_project_id, github_repo FROM projects WHERE id = $1',
    [projectId]
  );
  if (rows.length === 0) return null;
  const project = rows[0];

  // #82: Project-spezifische GitLab-Settings laden
  if (project.issue_tracker_type === 'gitlab') {
    const { rows: gls } = await db.query(
      'SELECT base_url, access_token, service_account_username FROM project_gitlab_settings WHERE project_id = $1',
      [projectId]
    );
    if (gls.length > 0) {
      project.project_gitlab_settings = gls[0];
      project.use_project_settings = true;
    }
  }

  // #82: Project-spezifische GitHub-Settings laden
  if (project.issue_tracker_type === 'github') {
    const { rows: ghs } = await db.query(
      'SELECT base_url, access_token, service_account_username FROM project_github_settings WHERE project_id = $1',
      [projectId]
    );
    if (ghs.length > 0) {
      project.project_github_settings = ghs[0];
      project.use_project_settings = true;
    }
  }

  return project;
}

/**
 * #82: Speichert project-spezifische GitLab-Settings.
 */
async function saveProjectGitLabSettings(projectId, { base_url, access_token, service_account_username }) {
  const { rows } = await db.query(
    `INSERT INTO project_gitlab_settings (project_id, base_url, access_token, service_account_username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id) DO UPDATE
     SET base_url = EXCLUDED.base_url, access_token = EXCLUDED.access_token,
         service_account_username = EXCLUDED.service_account_username, updated_at = NOW()
     RETURNING *`,
    [projectId, base_url, access_token, service_account_username || null]
  );
  return rows[0];
}

/**
 * #82: Speichert project-spezifische GitHub-Settings.
 */
async function saveProjectGitHubSettings(projectId, { base_url, access_token, service_account_username }) {
  const { rows } = await db.query(
    `INSERT INTO project_github_settings (project_id, base_url, access_token, service_account_username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id) DO UPDATE
     SET base_url = EXCLUDED.base_url, access_token = EXCLUDED.access_token,
         service_account_username = EXCLUDED.service_account_username, updated_at = NOW()
     RETURNING *`,
    [projectId, base_url || 'https://api.github.com', access_token, service_account_username || null]
  );
  return rows[0];
}

/**
 * #82: Löscht project-spezifische Settings (fällt auf global zurück).
 */
async function deleteProjectTrackerSettings(projectId, trackerType) {
  if (trackerType === 'gitlab') {
    await db.query('DELETE FROM project_gitlab_settings WHERE project_id = $1', [projectId]);
  } else if (trackerType === 'github') {
    await db.query('DELETE FROM project_github_settings WHERE project_id = $1', [projectId]);
  }
  return true;
}

/**
 * #82: Holt project-spezifische Settings für ein Projekt.
 */
async function getProjectTrackerSettings(projectId, trackerType) {
  if (trackerType === 'gitlab') {
    const { rows } = await db.query(
      'SELECT base_url, access_token, service_account_username FROM project_gitlab_settings WHERE project_id = $1',
      [projectId]
    );
    return rows[0] || null;
  }
  if (trackerType === 'github') {
    const { rows } = await db.query(
      'SELECT base_url, access_token, service_account_username FROM project_github_settings WHERE project_id = $1',
      [projectId]
    );
    return rows[0] || null;
  }
  return null;
}

/**
 * Gibt den Namen des Trackers zurück ('gitlab', 'github' oder 'none').
 */
function trackerName(project) {
  return project.issue_tracker_type || 'none';
}

/**
 * Gibt die externe Projekt-ID zurück (gitlab_project_id oder github_repo).
 */
function trackerProjectId(project) {
  if (project.issue_tracker_type === 'gitlab') return project.gitlab_project_id;
  if (project.issue_tracker_type === 'github') return project.github_repo;
  return null;
}

/**
 * Erstellt ein Issue im externen Tracker.
 */
/**
 * #82: Gibt die effektiven Settings für ein Projekt zurück.
 * Project-spezifische Settings überschreiben globale Settings.
 */
function getEffectiveSettings(project) {
  if (project.use_project_settings) {
    if (project.issue_tracker_type === 'gitlab' && project.project_gitlab_settings) {
      return project.project_gitlab_settings;
    }
    if (project.issue_tracker_type === 'github' && project.project_github_settings) {
      return project.project_github_settings;
    }
  }
  return null; // null = globale Settings verwenden
}

async function createIssue(project, { title, description, labels }) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  const opts = { projectSettings: getEffectiveSettings(project) };
  if (name === 'gitlab') {
    return gitlab.createGitLabIssue(projectId, { title, description }, opts);
  }
  if (name === 'github') {
    return github.createGitHubIssue(projectId, { title, description, labels }, opts);
  }
  throw new Error('Kein Issue-Tracker für dieses Projekt konfiguriert');
}

/**
 * Aktualisiert ein Issue im externen Tracker.
 */
async function updateIssue(project, externalId, { title, description, state_event }) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  const opts = { projectSettings: getEffectiveSettings(project) };
  if (name === 'gitlab') {
    return gitlab.updateGitLabIssue(projectId, externalId, { title, description, state_event }, opts);
  }
  if (name === 'github') {
    return github.updateGitHubIssue(projectId, externalId, { title, description, state_event }, opts);
  }
  throw new Error('Kein Issue-Tracker für dieses Projekt konfiguriert');
}

/**
 * Fügt einen Kommentar im externen Tracker hinzu.
 */
async function addComment(project, externalId, note) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  const opts = { projectSettings: getEffectiveSettings(project) };
  if (name === 'gitlab') {
    return gitlab.addGitLabComment(projectId, externalId, note, opts);
  }
  if (name === 'github') {
    return github.addGitHubComment(projectId, externalId, note, opts);
  }
  throw new Error('Kein Issue-Tracker für dieses Projekt konfiguriert');
}

/**
 * Holt Kommentare aus dem externen Tracker.
 */
async function getComments(project, externalId) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  const opts = { projectSettings: getEffectiveSettings(project) };
  if (name === 'gitlab') {
    return gitlab.getGitLabComments(projectId, externalId, opts);
  }
  if (name === 'github') {
    return github.getGitHubComments(projectId, externalId, opts);
  }
  return [];
}

/**
 * Synchronisiert Issues aus dem externen Tracker in die lokale DB.
 */
async function syncIssues(project) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  const opts = { projectSettings: getEffectiveSettings(project) };
  if (name === 'gitlab') {
    return gitlab.syncProjectIssues(project.id, projectId, opts);
  }
  if (name === 'github') {
    return github.syncProjectIssues(project.id, projectId, opts);
  }
  return [];
}

/**
 * Sucht nach Projekten/Repos im externen Tracker.
 */
async function searchProjects(trackerType, search, project) {
  const opts = project ? { projectSettings: getEffectiveSettings(project) } : {};
  if (trackerType === 'gitlab') {
    return gitlab.listGitLabProjects(search, opts);
  }
  if (trackerType === 'github') {
    return github.listGitHubRepos(search, opts);
  }
  return [];
}

/**
 * Testet die Verbindung zum externen Tracker (liefert User-Info).
 */
async function testConnection(trackerType) {
  if (trackerType === 'gitlab') {
    const settings = await gitlab.getSettings();
    if (!settings) throw new Error('GitLab ist nicht konfiguriert');
    const res = await gitlab.gitlabRequest('/user');
    return { id: res.id, username: res.username, name: res.name };
  }
  if (trackerType === 'github') {
    return github.testConnection();
  }
  throw new Error('Unbekannter Tracker-Typ');
}

module.exports = {
  getProjectTracker,
  trackerName,
  trackerProjectId,
  createIssue,
  updateIssue,
  addComment,
  getComments,
  syncIssues,
  searchProjects,
  testConnection,
  saveProjectGitLabSettings,
  saveProjectGitHubSettings,
  deleteProjectTrackerSettings,
  getProjectTrackerSettings,
};
