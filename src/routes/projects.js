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
    const tasks = await db.query(
      `SELECT t.*, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = $1 ORDER BY t.created_at DESC`,
      [req.params.id]
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
  try {
    const { rows } = await db.query(
      `UPDATE projects
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [name, description, status, req.params.id]
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
  const { title, description } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO tasks (project_id, title, description, assignee_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.id, title, description || null, req.session.userId]
    );
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/:id/tasks/:taskId', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { title, description, status, assignee_id } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE tasks
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           assignee_id = COALESCE($4, assignee_id),
           updated_at = NOW()
       WHERE id = $5 AND project_id = $6
       RETURNING *`,
      [title, description, status, assignee_id, req.params.taskId, req.params.id]
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
