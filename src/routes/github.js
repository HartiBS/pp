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
  const { title, description, state_event } = req.body;
  try {
    const { rows } = await db.query(
      'SELECT github_repo FROM projects WHERE id = $1 AND issue_tracker_type = $2',
      [req.params.id, 'github']
    );
    if (rows.length === 0 || !rows[0].github_repo) {
      return res.status(400).json({ error: 'Projekt ist nicht mit GitHub verknüpft' });
    }
    const updated = await github.updateGitHubIssue(rows[0].github_repo, Number(req.params.number), {
      title, description, state_event,
    });
    await db.query(
      `UPDATE gitlab_issues SET title = $1, description = $2, state = $3, synced_at = NOW()
       WHERE project_id = $4 AND gitlab_iid = $5`,
      [updated.title, updated.description, updated.state, req.params.id, Number(req.params.number)]
    );
    res.json({ issue: updated });
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
