const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { loadProjectRole, requireProjectPermission, PROJECT_ROLES } = require('../utils/permissions');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, u.name AS owner_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
              CASE WHEN p.owner_id = $1 THEN 'projektmanager' ELSE pm.role END AS my_role
       FROM projects p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
       WHERE p.owner_id = $1 OR pm.user_id IS NOT NULL
          OR $2 = 'admin'
       ORDER BY p.updated_at DESC`,
      [req.session.userId, req.currentUser.role]
    );
    res.json({ projects: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/', async (req, res) => {
  const { name, description } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO projects (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *',
      [name, description || null, req.session.userId]
    );
    res.status(201).json({ project: { ...rows[0], my_role: 'projektmanager' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.get('/:id', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT p.*, u.name AS owner_name FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = $1',
      [req.params.id]
    );
    const { type, label, status, epic_only } = req.query;
    const conditions = ['t.project_id = $1'];
    const params = [req.params.id];
    if (type) { params.push(type); conditions.push(`t.issue_type = $${params.length}`); }
    if (label) { params.push(label); conditions.push(`$${params.length} = ANY(t.labels)`); }
    if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
    if (epic_only === 'true') { conditions.push(`t.issue_type = 'epic'`); }
    const tasks = await db.query(
      `SELECT t.*, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC`,
      params
    );
    const members = await db.query(
      `SELECT u.id, u.name, u.email, pm.role
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 ORDER BY pm.added_at ASC`,
      [req.params.id]
    );
    res.json({ project: { ...rows[0], my_role: req.projectRole }, tasks: tasks.rows, members: members.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/:id', loadProjectRole, requireProjectPermission('edit_project'), async (req, res) => {
  const { name, description, status } = req.body;
  const resetGitlab = req.body.gitlab_project_id === null || req.body.gitlab_project_id === '';
  let gitlabId = null;
  if (!resetGitlab && req.body.gitlab_project_id !== undefined) {
    const n = Number(req.body.gitlab_project_id);
    if (!Number.isInteger(n)) {
      return res.status(400).json({ error: 'gitlab_project_id muss eine ganze Zahl sein' });
    }
    gitlabId = n;
  }
  try {
    const { rows } = await db.query(
      `UPDATE projects
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           gitlab_project_id = CASE WHEN $4 THEN NULL WHEN $5::int IS NULL THEN gitlab_project_id ELSE $5::int END,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [name, description, status, resetGitlab, gitlabId, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    res.json({ project: { ...rows[0], my_role: req.projectRole } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/:id', loadProjectRole, requireProjectPermission('delete_project'), async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/:id/tasks', loadProjectRole, requireProjectPermission('create_task'), async (req, res) => {
  const { title, description, issue_type, labels, due_date, epic_id } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO tasks (project_id, title, description, assignee_id, issue_type, labels, due_date, epic_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        req.params.id,
        title,
        description || null,
        req.session.userId,
        issue_type || 'task',
        Array.isArray(labels) ? labels : [],
        due_date || null,
        epic_id || null,
      ]
    );
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/:id/tasks/:taskId', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { title, description, status, assignee_id, issue_type, labels, due_date, epic_id } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE tasks
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           assignee_id = COALESCE($4, assignee_id),
           issue_type = COALESCE($5, issue_type),
           labels = COALESCE($6, labels),
           due_date = COALESCE($7, due_date),
           epic_id = COALESCE($8, epic_id),
           updated_at = NOW()
       WHERE id = $9 AND project_id = $10
       RETURNING *`,
      [title, description, status, assignee_id, issue_type,
       labels !== undefined ? (Array.isArray(labels) ? labels : []) : null,
       due_date, epic_id, req.params.taskId, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task nicht gefunden' });
    }
    res.json({ task: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/:id/tasks/:taskId', loadProjectRole, requireProjectPermission('delete_task'), async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM tasks WHERE id = $1 AND project_id = $2',
      [req.params.taskId, req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Task nicht gefunden' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.get('/:id/dashboard', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const pid = req.params.id;

    const kpis = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status != 'done') AS open_tasks,
         COUNT(*) FILTER (WHERE status = 'done') AS done_tasks,
         COUNT(*) FILTER (WHERE issue_type = 'epic') AS epics,
         COUNT(*) FILTER (WHERE issue_type = 'user_story') AS user_stories,
         COUNT(*) FILTER (WHERE issue_type = 'bug') AS bugs,
         COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status != 'done') AS overdue,
         COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress
       FROM tasks WHERE project_id = $1`,
      [pid]
    );

    const byStatus = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM tasks WHERE project_id = $1 GROUP BY status`,
      [pid]
    );

    const byType = await db.query(
      `SELECT issue_type, COUNT(*)::int AS count FROM tasks WHERE project_id = $1 GROUP BY issue_type`,
      [pid]
    );

    const burndown = await db.query(
      `SELECT d::date AS date,
              COUNT(*) FILTER (WHERE t.created_at::date <= d::date AND (t.status != 'done' OR t.updated_at::date > d::date))::int AS open
       FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d
       CROSS JOIN tasks t
       WHERE t.project_id = $1
       GROUP BY d::date ORDER BY d::date`,
      [pid]
    );

    const activity = await db.query(
      `SELECT t.id, t.title, t.status, t.issue_type, t.updated_at, u.name AS actor
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = $1
       ORDER BY t.updated_at DESC
       LIMIT 10`,
      [pid]
    );

    const upcoming = await db.query(
      `SELECT id, title, due_date, status, issue_type
       FROM tasks
       WHERE project_id = $1 AND due_date IS NOT NULL AND status != 'done'
       ORDER BY due_date ASC
       LIMIT 5`,
      [pid]
    );

    res.json({
      kpis: kpis.rows[0],
      byStatus: byStatus.rows,
      byType: byType.rows,
      burndown: burndown.rows,
      activity: activity.rows,
      upcoming: upcoming.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.get('/:id/members', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, pm.role, pm.added_at
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 ORDER BY pm.added_at ASC`,
      [req.params.id]
    );
    res.json({ members: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/:id/members', loadProjectRole, requireProjectPermission('manage_members'), async (req, res) => {
  const { user_id, role } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id ist erforderlich' });
  }
  if (!PROJECT_ROLES.includes(role)) {
    return res.status(400).json({ error: `Ungültige Rolle. Erlaubt: ${PROJECT_ROLES.join(', ')}` });
  }
  try {
    const owner = await db.query('SELECT owner_id FROM projects WHERE id = $1', [req.params.id]);
    if (owner.rows.length && owner.rows[0].owner_id === Number(user_id)) {
      return res.status(400).json({ error: 'Der Projekt-Owner ist implizit Projektmanager' });
    }
    const user = await db.query('SELECT id FROM users WHERE id = $1 AND is_active = TRUE', [user_id]);
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden oder deaktiviert' });
    }
    const { rows } = await db.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [req.params.id, user_id, role]
    );
    res.status(201).json({ member: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/:id/members/:userId', loadProjectRole, requireProjectPermission('manage_members'), async (req, res) => {
  try {
    const owner = await db.query('SELECT owner_id FROM projects WHERE id = $1', [req.params.id]);
    if (owner.rows.length && owner.rows[0].owner_id === Number(req.params.userId)) {
      return res.status(400).json({ error: 'Der Projekt-Owner kann nicht entfernt werden' });
    }
    const { rowCount } = await db.query(
      'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Mitglied nicht gefunden' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

module.exports = router;
