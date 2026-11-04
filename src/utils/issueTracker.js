const db = require('../config/database');
const gitlab = require('./gitlab');
const github = require('./github');
const taskMarkdown = require('./taskMarkdown');
const trackerFieldMapping = require('./trackerFieldMapping');
const customFields = require('./customFields');
const taskRelations = require('./taskRelations');

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

async function createIssue(project, payload) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  const opts = { projectSettings: getEffectiveSettings(project) };
  if (name === 'gitlab') {
    return gitlab.createGitLabIssue(projectId, payload, opts);
  }
  if (name === 'github') {
    return github.createGitHubIssue(projectId, payload, opts);
  }
  throw new Error('Kein Issue-Tracker für dieses Projekt konfiguriert');
}

/**
 * Aktualisiert ein Issue im externen Tracker.
 */
async function updateIssue(project, externalId, payload) {
  const name = trackerName(project);
  const projectId = trackerProjectId(project);
  const opts = { projectSettings: getEffectiveSettings(project) };
  if (name === 'gitlab') {
    return gitlab.updateGitLabIssue(projectId, externalId, payload, opts);
  }
  if (name === 'github') {
    return github.updateGitHubIssue(projectId, externalId, payload, opts);
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

/**
 * Baut das Push-Payload für den externen Tracker aus einem Task gemäß dem
 * konfigurierten Tracker-Feld-Mapping. Nicht gemappte eigene Felder (inkl.
 * Custom Fields) landen als Markdown im Kommentarfeld (description/body).
 */
async function buildPushPayload(project, task, { customFieldDefs = [], subtasks = [], parent = null, children = [], related = [] } = {}) {
  const type = trackerName(project);
  const mappings = await trackerFieldMapping.getMappings(type);
  let assigneeUsername = null;
  if (task.assignee_id) {
    const { rows } = await db.query('SELECT username FROM users WHERE id = $1', [task.assignee_id]);
    if (rows.length > 0) assigneeUsername = rows[0].username;
  }
  let milestoneExternalId = null;
  if (task.milestone_id) {
    const { rows } = await db.query('SELECT gitlab_id FROM gitlab_milestones WHERE id = $1', [task.milestone_id]);
    if (rows.length > 0) milestoneExternalId = rows[0].gitlab_id;
  }
  return trackerFieldMapping.buildTrackerPayload(type, task, mappings, {
    customFieldDefs, subtasks, parent, children, related,
    assigneeUsername, milestoneExternalId,
  }).payload;
}

/**
 * Wendet das konfigurierte Tracker-Feld-Mapping auf ein externes Issue an
 * (Pull-Richtung) und aktualisiert den lokalen Task.
 * Nicht gemappte Felder wandern in die lokalen Task-Felder; die Beschreibung
 * enthaelt nur noch den reinen Body-Inhalt.
 */
async function applyPullToTask(projectId, trackerType, issueRow) {
  const taskResult = await db.query(
    'SELECT id FROM tasks WHERE gitlab_iid = $1 AND project_id = $2',
    [issueRow.gitlab_iid, projectId]
  );
  if (taskResult.rows.length === 0) return;
  const taskId = taskResult.rows[0].id;

  const mappings = await trackerFieldMapping.getMappings(trackerType);
  const cfDefs = await customFields.getProjectFieldDefinitions(projectId);
  const raw = issueRow.raw_data && typeof issueRow.raw_data === 'object'
    ? issueRow.raw_data
    : { title: issueRow.title, description: issueRow.description, state: issueRow.state };

  const { fields, unmappedMarkdown } = trackerFieldMapping.applyPullMapping(trackerType, raw, mappings, {
    customFieldDefs: cfDefs,
  });

  // Bearbeiter über users.username auflösen
  let assigneeId = null;
  const rawUser = trackerType === 'github'
    ? ((raw.assignee && raw.assignee.login) || (Array.isArray(raw.assignees) && raw.assignees[0] && raw.assignees[0].login))
    : ((raw.assignee && raw.assignee.username) || raw.assignee_username);
  // Bearbeiter wandert unabhaengig vom Mapping in das lokale Feld
  if (rawUser) {
    const { rows: u } = await db.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [rawUser]);
    if (u.length > 0) assigneeId = u[0].id;
  }

  // Milestone: externe ID → lokale gitlab_milestones-Zeile
  let milestoneId = null;
  if (fields.milestone_external_id != null) {
    const { rows: ms } = await db.query(
      'SELECT id FROM gitlab_milestones WHERE project_id = $1 AND gitlab_id = $2 LIMIT 1',
      [projectId, fields.milestone_external_id]
    );
    if (ms.length > 0) milestoneId = ms[0].id;
  }

  // Body-Inhalt: pp-meta + ##-Abschnitte der nicht gemappten Felder parsen.
  // Lokal landet nur der reine Inhalt in der Beschreibung; die Werte der
  // nicht gemappten Felder wandern zurueck in die lokalen Task-Felder.
  const rawDescription = fields.rawDescription || raw.description || '';
  const parsed = taskMarkdown.markdownToTaskFields(rawDescription, { customFieldDefs: cfDefs });
  const sections = taskMarkdown.parseFieldSections(rawDescription, { customFieldDefs: cfDefs });
  let description = sections.description || null;
  void unmappedMarkdown; // nicht gemappte externe Felder landen nicht mehr im lokalen Text


  // Status: Mapping > Body-Abschnitt > Fallback über Issue-State
  let newStatus = fields.status || sections.fields.status || null;
  if (!newStatus) {
    if (issueRow.state === 'closed' && parsed.meta && parsed.meta.status !== 'done') newStatus = 'done';
    else if (issueRow.state === 'opened' && parsed.meta && parsed.meta.status === 'done') newStatus = 'in_progress';
  }

  // Weitere Felder: Mapping hat Vorrang, sonst Wert aus dem Body-Abschnitt
  const bodyPriority = sections.fields.priority || null;
  const bodyIssueType = sections.fields.issue_type || null;
  const bodyLabels = Array.isArray(sections.fields.labels) ? sections.fields.labels : null;
  const bodyDueDate = sections.fields.due_date || null;
  const bodyEst = sections.fields.estimated_hours != null ? sections.fields.estimated_hours : null;
  const bodySpent = sections.fields.spent_hours != null ? sections.fields.spent_hours : null;

    // Custom Fields mit bestehenden mergen: Werte aus Label-Mapping, pp-meta,
  // Markdown-Body (parsed.customFields) und ##-Abschnitten (sections.fields)
  const metaCf = (parsed.meta && parsed.meta.custom_fields) || {};
  const pulledCustomFields = {
    ...metaCf,
    ...(parsed.customFields || {}),
    ...(fields.custom_fields || {}),
    ...(sections.fields.custom_fields || {}),
  };
  let customFieldsValue = null;
  if (Object.keys(pulledCustomFields).length > 0) {
    const { rows: t } = await db.query('SELECT custom_fields FROM tasks WHERE id = $1', [taskId]);
    const existing = (t[0] && t[0].custom_fields) || {};
    customFieldsValue = { ...existing, ...pulledCustomFields };
  }

  await db.query(
    `UPDATE tasks
     SET title = COALESCE($1, title),
         description = COALESCE($2, description),
         status = COALESCE($3, status),
         priority = COALESCE($4, priority),
         issue_type = COALESCE($5, issue_type),
         labels = COALESCE($6, labels),
         due_date = COALESCE($7, due_date),
         estimated_hours = COALESCE($8, estimated_hours),
         spent_hours = COALESCE($9, spent_hours),
         assignee_id = COALESCE($10, assignee_id),
         milestone_id = COALESCE($11, milestone_id),
         custom_fields = COALESCE($12, custom_fields),
         updated_at = NOW()
     WHERE id = $13`,
    [
      fields.title || null,
      description,
      newStatus,
      fields.priority || bodyPriority,
      fields.issue_type || bodyIssueType,
      Array.isArray(fields.labels) ? fields.labels : bodyLabels,
      fields.due_date || bodyDueDate,
      fields.estimated_hours != null ? fields.estimated_hours : bodyEst,
      fields.spent_hours != null ? fields.spent_hours : bodySpent,
      assigneeId,
      milestoneId,
      customFieldsValue,
      taskId,
    ]
  );

  if (parsed.meta) {
    await taskRelations.restoreFromMeta(taskId, parsed.meta, projectId);
  }
}

/**
 * Wendet neue Custom-Field-Werte auf ein externes Issue an (Bearbeiten im Issue):
 * validiert die Werte gegen die aktiven Projekt-Definitionen, bettet sie in den
 * Markdown-Body (description/body) ein und aktualisiert den verknüpfuten lokalen Task.
 * @returns {{ ok, error?, description? }} description = neuer Markdown-Body zum Push
 */
async function applyCustomFieldsToIssue(projectId, issueRow, customFieldsInput) {
  const cfDefs = await customFields.getProjectFieldDefinitions(projectId);
  const cleaned = {};
  for (const def of cfDefs) {
    const key = String(def.id);
    const value = customFieldsInput ? customFieldsInput[key] : undefined;
    const result = customFields.validateFieldValue(def, value);
    if (!result.ok) return { ok: false, error: result.error };
    if (value !== null && value !== undefined && value !== '') cleaned[key] = value;
  }
  const raw = issueRow.raw_data && typeof issueRow.raw_data === 'object'
    ? issueRow.raw_data
    : null;
  const rawBody = raw
    ? (raw.body !== undefined ? raw.body : (raw.description || ''))
    : (issueRow.description || '');
  const newDescription = taskMarkdown.mergeCustomFieldsIntoMarkdown(rawBody, cfDefs, cleaned);

  // Verknüpfuten lokalen Task mitaktualisieren
  const taskResult = await db.query(
    'SELECT id, custom_fields FROM tasks WHERE gitlab_iid = $1 AND project_id = $2',
    [issueRow.gitlab_iid, projectId]
  );
  if (taskResult.rows.length > 0) {
    const existing = taskResult.rows[0].custom_fields || {};
    await db.query(
      'UPDATE tasks SET custom_fields = $1, updated_at = NOW() WHERE id = $2',
      [{ ...existing, ...cleaned }, taskResult.rows[0].id]
    );
  }
  return { ok: true, description: newDescription, cleaned };
}

module.exports = {
  getProjectTracker,
  getEffectiveSettings,
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
  applyPullToTask,
  buildPushPayload,
  applyCustomFieldsToIssue,
};
