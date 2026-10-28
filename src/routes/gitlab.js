const express = require('express');
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { loadProjectRole, requireProjectPermission } = require('../utils/permissions');
const gitlab = require('../utils/gitlab');
const notifications = require('../utils/notifications');

const router = express.Router();

router.use(requireAuth);

router.get('/settings', requireRole('admin'), async (req, res) => {
  try {
    const settings = await gitlab.getSettings();
    res.json({
      configured: !!settings,
      base_url: settings ? settings.base_url : (process.env.GITLAB_URL || ''),
      has_token: !!settings,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/settings', requireRole('admin'), async (req, res) => {
  const { base_url, access_token } = req.body;
  if (!base_url || !access_token) {
    return res.status(400).json({ error: 'base_url und access_token sind erforderlich' });
  }
  try {
    new URL(base_url);
  } catch {
    return res.status(400).json({ error: 'Ungültige GitLab-URL' });
  }
  try {
    const saved = await gitlab.saveSettings(base_url, access_token, req.session.userId);
    res.json({ ok: true, id: saved.id, base_url: saved.base_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/settings/test', requireRole('admin'), async (req, res) => {
  try {
    await gitlab.gitlabRequest('/user');
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/projects/:id/sync', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length || !rows[0].gitlab_project_id) {
      return res.status(400).json({ error: 'Kein GitLab-Projekt mit diesem Projekt verknüpft' });
    }
    const issues = await gitlab.syncProjectIssues(req.params.id, rows[0].gitlab_project_id);
    res.json({ issues });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
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
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length || !rows[0].gitlab_project_id) {
      return res.status(400).json({ error: 'Kein GitLab-Projekt mit diesem Projekt verknüpft' });
    }
    const created = await gitlab.createGitLabIssue(rows[0].gitlab_project_id, { title, description });
    const { rows: saved } = await db.query(
      `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [req.params.id, created.gitlab_iid, created.title, created.description, created.state, created.web_url]
    );
    res.status(201).json({ issue: saved[0] });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/projects/:id/issues/:iid', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { title, description, state_event } = req.body;
  if (state_event && !['close', 'reopen'].includes(state_event)) {
    return res.status(400).json({ error: "state_event muss 'close' oder 'reopen' sein" });
  }
  try {
    const project = await db.query(
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!project.rows.length || !project.rows[0].gitlab_project_id) {
      return res.status(400).json({ error: 'Kein GitLab-Projekt mit diesem Projekt verknüpft' });
    }
    const existing = await db.query(
      'SELECT gitlab_iid FROM gitlab_issues WHERE project_id = $1 AND gitlab_iid = $2',
      [req.params.id, req.params.iid]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Issue nicht gefunden' });
    }
    const prevState = await db.query(
      'SELECT state FROM gitlab_issues WHERE project_id = $1 AND gitlab_iid = $2',
      [req.params.id, req.params.iid]
    );
    const oldState = prevState.rows[0] ? prevState.rows[0].state : null;

    const updated = await gitlab.updateGitLabIssue(project.rows[0].gitlab_project_id, req.params.iid, {
      title, description, state_event,
    });

    if (state_event && oldState && oldState !== updated.state) {
      const members = await db.query(
        `SELECT u.id, u.name FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1
         UNION SELECT p.owner_id, u2.name FROM projects p JOIN users u2 ON u2.id = p.owner_id WHERE p.id = $1`,
        [req.params.id]
      );
      for (const m of members.rows) {
        if (Number(m.id) === Number(req.currentUser.id)) continue;
        await notifications.notify(m.id, {
          type: 'status_change',
          title: `Status geändert: ${updated.title}`,
          body: `${req.currentUser.name} hat „${updated.title}" von „${oldState}" auf „${updated.state}" gesetzt.`,
          link: `/#/project/${req.params.id}`,
        });
      }
    }

    const { rows } = await db.query(
      `UPDATE gitlab_issues
       SET title = $1, description = $2, state = $3, synced_at = NOW()
       WHERE project_id = $4 AND gitlab_iid = $5 RETURNING *`,
      [updated.title, updated.description, updated.state, req.params.id, req.params.iid]
    );
    res.json({ issue: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/projects/:id/issues/:iid/comments', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { note } = req.body;
  if (!note) {
    return res.status(400).json({ error: 'Kommentar (note) ist erforderlich' });
  }
  try {
    const project = await db.query(
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!project.rows.length || !project.rows[0].gitlab_project_id) {
      return res.status(400).json({ error: 'Kein GitLab-Projekt mit diesem Projekt verknüpft' });
    }
    await gitlab.addGitLabComment(project.rows[0].gitlab_project_id, req.params.iid, note);

    const issueRow = await db.query(
      'SELECT title FROM gitlab_issues WHERE project_id = $1 AND gitlab_iid = $2',
      [req.params.id, req.params.iid]
    );
    const issueTitle = issueRow.rows[0] ? issueRow.rows[0].title : `#${req.params.iid}`;

    const members = await db.query(
      `SELECT u.id, u.name FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1
       UNION SELECT p.owner_id, u2.name FROM projects p JOIN users u2 ON u2.id = p.owner_id WHERE p.id = $1`,
      [req.params.id]
    );
    const snippet = note.length > 120 ? note.slice(0, 120) + '…' : note;
    for (const m of members.rows) {
      if (Number(m.id) === Number(req.currentUser.id)) continue;
      await notifications.notify(m.id, {
        type: 'comment',
        title: `Neuer Kommentar: ${issueTitle}`,
        body: `${req.currentUser.name}: ${snippet}`,
        link: `/#/project/${req.params.id}`,
      });
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/projects/:id/issues/:iid/comments', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const project = await db.query(
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!project.rows.length || !project.rows[0].gitlab_project_id) {
      return res.status(400).json({ error: 'Kein GitLab-Projekt mit diesem Projekt verknüpft' });
    }
    const comments = await gitlab.getGitLabComments(project.rows[0].gitlab_project_id, req.params.iid);
    res.json({ comments });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/projects-list', requireRole('admin', 'projektmanager'), async (req, res) => {
  try {
    const search = req.query.search || '';
    const [projects, groups] = await Promise.all([
      gitlab.listGitLabProjects(search),
      search ? gitlab.listGitLabGroups(search) : Promise.resolve([]),
    ]);
    res.json({ projects, groups });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/projects/:id/milestones', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM gitlab_milestones WHERE project_id = $1 ORDER BY due_date NULLS LAST, id',
      [req.params.id]
    );
    res.json({ milestones: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/projects/:id/milestones/sync', loadProjectRole, requireProjectPermission('edit_project'), async (req, res) => {
  try {
    const project = await db.query(
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!project.rows.length || !project.rows[0].gitlab_project_id) {
      return res.status(400).json({ error: 'Kein GitLab-Projekt mit diesem Projekt verknüpft' });
    }
    const milestones = await gitlab.syncProjectMilestones(req.params.id, project.rows[0].gitlab_project_id);
    res.json({ milestones });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/projects/:id/gitlab-users', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const project = await db.query(
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!project.rows.length || !project.rows[0].gitlab_project_id) {
      return res.status(400).json({ error: 'Kein GitLab-Projekt mit diesem Projekt verknüpft' });
    }
    const users = await gitlab.listGitLabUsers(project.rows[0].gitlab_project_id);
    res.json({ gitlab_users: users });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/projects/:id/issues/:iid/assignee', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { assignee_id } = req.body;
  try {
    const project = await db.query(
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!project.rows.length || !project.rows[0].gitlab_project_id) {
      return res.status(400).json({ error: 'Kein GitLab-Projekt mit diesem Projekt verknüpft' });
    }
    const issue = await gitlab.assignGitLabIssue(project.rows[0].gitlab_project_id, req.params.iid, assignee_id || 0);
    await db.query(
      `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (project_id, gitlab_iid) DO UPDATE
       SET title = EXCLUDED.title, state = EXCLUDED.state, synced_at = NOW()`,
      [req.params.id, issue.gitlab_iid, issue.title, issue.description, issue.state, issue.web_url]
    );
    res.json({ ok: true, assignee: issue.assignees || [] });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
