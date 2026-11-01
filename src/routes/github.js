const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { loadProjectRole, requireProjectPermission } = require('../utils/permissions');
const github = require('../utils/github');
const db = require('../config/database');

const router = express.Router();

router.use(requireAuth);

// ===== Admin: GitHub-Settings =====

router.get('/settings', requireRole('admin'), async (req, res) => {
  try {
    const settings = await github.getSettings();
    res.json({
      configured: !!settings,
      base_url: settings ? settings.base_url : null,
      service_account_username: settings ? settings.service_account_username : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/settings', requireRole('admin'), async (req, res) => {
  const { base_url, access_token, service_account_username } = req.body;
  if (!base_url || !access_token) {
    return res.status(400).json({ error: 'base_url und access_token sind erforderlich' });
  }
  if (service_account_username && !/^[a-zA-Z0-9_.\-]{1,255}$/.test(service_account_username)) {
    return res.status(400).json({ error: 'Ungültiger Service-Account-Benutzername' });
  }
  try {
    new URL(base_url);
  } catch {
    return res.status(400).json({ error: 'Ungültige GitHub-URL' });
  }
  try {
    const saved = await github.saveSettings(base_url, access_token, req.session.userId, service_account_username);
    res.json({ ok: true, id: saved.id, base_url: saved.base_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/settings/test', requireRole('admin'), async (req, res) => {
  try {
    const user = await github.testConnection();
    res.json({ ok: true, user });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ===== Repo-Suche (#78) =====

router.get('/repos', requireRole('admin', 'projektmanager'), async (req, res) => {
  try {
    const search = req.query.search || '';
    const repos = await github.listGitHubRepos(search);
    res.json({ repos });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

router.get('/orgs', requireRole('admin', 'projektmanager'), async (req, res) => {
  try {
    const orgs = await github.listGitHubOrgs();
    res.json({ orgs });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// ===== Projekt-Sync =====

router.post('/projects/:id/sync', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT github_repo FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    const issues = await github.syncProjectIssues(req.params.id, rows[0].github_repo);
    res.json({ issues });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

router.get('/projects/:id/issues', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM gitlab_issues WHERE project_id = $1 ORDER BY gitlab_iid DESC',
      [req.params.id]
    );
    res.json({ issues: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// Einzelnes Issue: holt den aktuellen Stand live aus GitHub (Pull beim Laden
// der Detailansicht), aktualisiert den lokalen Datensatz inkl. node_id und
// liefert ihn zurueck. Fällt bei Tracker-Fehlern auf den lokalen Stand zurück.
router.get('/projects/:id/issues/:number', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT github_repo FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    let issue = null;
    try {
      const live = await github.getGitHubIssue(rows[0].github_repo, Number(req.params.number));
      const { rows: saved } = await db.query(
        `INSERT INTO gitlab_issues (project_id, gitlab_iid, tracker_node_id, title, description, state, web_url, synced_at, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
         ON CONFLICT (project_id, gitlab_iid) DO UPDATE
         SET tracker_node_id = EXCLUDED.tracker_node_id,
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             state = EXCLUDED.state,
             web_url = EXCLUDED.web_url,
             raw_data = EXCLUDED.raw_data,
             synced_at = NOW()
         RETURNING *`,
        [req.params.id, live.gitlab_iid, live.tracker_node_id, live.title, live.description, live.state, live.web_url, JSON.stringify(live.raw_issue || live)]
      );
      issue = saved[0];
    } catch (liveErr) {
      console.warn('Live-Pull des GitHub-Issues fehlgeschlagen, lokaler Stand wird geliefert:', liveErr.message);
      const local = await db.query(
        'SELECT * FROM gitlab_issues WHERE project_id = $1 AND gitlab_iid = $2',
        [req.params.id, Number(req.params.number)]
      );
      if (!local.rows.length) {
        return res.status(404).json({ error: 'Issue nicht gefunden' });
      }
      issue = local.rows[0];
    }
    res.json({ issue });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

router.post('/projects/:id/issues', loadProjectRole, requireProjectPermission('create_task'), async (req, res) => {
  const { title, description } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }
  try {
    const { rows } = await db.query(
      'SELECT github_repo FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    const created = await github.createGitHubIssue(rows[0].github_repo, { title, description });
    await db.query(
      `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [req.params.id, created.gitlab_iid, created.title, created.description, created.state, created.web_url]
    );
    res.status(201).json({ issue: created });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

router.put('/projects/:id/issues/:number', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { title, description, state_event, labels, assignees, auto_sync } = req.body;
  if (labels !== undefined && !Array.isArray(labels)) {
    return res.status(400).json({ error: 'labels muss ein Array sein' });
  }
  if (assignees !== undefined && !Array.isArray(assignees)) {
    return res.status(400).json({ error: 'assignees muss ein Array sein' });
  }
  try {
    const { rows } = await db.query(
      'SELECT github_repo, auto_sync FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    // Push zum Tracker nur bei aktivem Auto-Sync (Request-Override oder Projekt-Default)
    const pushToTracker = auto_sync !== undefined && auto_sync !== null
      ? auto_sync === true
      : rows[0].auto_sync !== false;
    const existing = await db.query(
      'SELECT gitlab_iid, title, description, state FROM gitlab_issues WHERE project_id = $1 AND gitlab_iid = $2',
      [req.params.id, Number(req.params.number)]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Issue nicht gefunden' });
    }
    const old = existing.rows[0];
    let updated;
    if (pushToTracker) {
      updated = await github.updateGitHubIssue(rows[0].github_repo, Number(req.params.number), {
        title, description, state_event, labels, assignees,
      });
    } else {
      updated = {
        gitlab_iid: Number(req.params.number),
        title: title !== undefined ? title : old.title,
        description: description !== undefined ? description : old.description,
        state: state_event === 'close' ? 'closed' : state_event === 'reopen' ? 'opened' : old.state,
        web_url: null,
      };
    }
    await db.query(
      `UPDATE gitlab_issues SET title = $1, description = $2, state = $3, synced_at = NOW()
       WHERE project_id = $4 AND gitlab_iid = $5`,
      [updated.title, updated.description, updated.state, req.params.id, Number(req.params.number)]
    );
    res.json({ issue: updated, pushed: pushToTracker });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

router.get('/projects/:id/labels', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT github_repo FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    const labels = await github.listGitHubLabels(rows[0].github_repo);
    res.json({ labels: (labels || []).map(l => ({ name: l.name, color: l.color || null })) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

router.get('/projects/:id/github-users', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT github_repo FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    const users = await github.listGitHubUsers(rows[0].github_repo);
    res.json({ github_users: users });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

router.get('/projects/:id/issues/:number/comments', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT github_repo FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    const comments = await github.getGitHubComments(rows[0].github_repo, Number(req.params.number));
    res.json({ comments });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

router.post('/projects/:id/issues/:number/comments', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { body } = req.body;
  if (!body) {
    return res.status(400).json({ error: 'Kommentar-Text ist erforderlich' });
  }
  try {
    const { rows } = await db.query(
      'SELECT github_repo FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    await github.addGitHubComment(rows[0].github_repo, Number(req.params.number), body);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
