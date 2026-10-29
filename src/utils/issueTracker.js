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
 */
async function getProjectTracker(projectId) {
  const { rows } = await db.query(
    'SELECT id, issue_tracker_type, gitlab_project_id, github_repo FROM projects WHERE id = $1',
    [projectId]
  );
  if (rows.length === 0) return null;
  return rows[0];
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
async function createIssue(project, { title, description, labels }) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  if (name === 'gitlab') {
    return gitlab.createGitLabIssue(projectId, { title, description });
  }
  if (name === 'github') {
    return github.createGitHubIssue(projectId, { title, description, labels });
  }
  throw new Error('Kein Issue-Tracker für dieses Projekt konfiguriert');
}

/**
 * Aktualisiert ein Issue im externen Tracker.
 */
async function updateIssue(project, externalId, { title, description, state_event }) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  if (name === 'gitlab') {
    return gitlab.updateGitLabIssue(projectId, externalId, { title, description, state_event });
  }
  if (name === 'github') {
    return github.updateGitHubIssue(projectId, externalId, { title, description, state_event });
  }
  throw new Error('Kein Issue-Tracker für dieses Projekt konfiguriert');
}

/**
 * Fügt einen Kommentar im externen Tracker hinzu.
 */
async function addComment(project, externalId, note) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  if (name === 'gitlab') {
    return gitlab.addGitLabComment(projectId, externalId, note);
  }
  if (name === 'github') {
    return github.addGitHubComment(projectId, externalId, note);
  }
  throw new Error('Kein Issue-Tracker für dieses Projekt konfiguriert');
}

/**
 * Holt Kommentare aus dem externen Tracker.
 */
async function getComments(project, externalId) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  if (name === 'gitlab') {
    return gitlab.getGitLabComments(projectId, externalId);
  }
  if (name === 'github') {
    return github.getGitHubComments(projectId, externalId);
  }
  return [];
}

/**
 * Synchronisiert Issues aus dem externen Tracker in die lokale DB.
 */
async function syncIssues(project) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  if (name === 'gitlab') {
    return gitlab.syncProjectIssues(project.id, projectId);
  }
  if (name === 'github') {
    return github.syncProjectIssues(project.id, projectId);
  }
  return [];
}

/**
 * Sucht nach Projekten/Repos im externen Tracker.
 */
async function searchProjects(trackerType, search) {
  if (trackerType === 'gitlab') {
    return gitlab.listGitLabProjects(search);
  }
  if (trackerType === 'github') {
    return github.listGitHubRepos(search);
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
};
