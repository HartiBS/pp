const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, u.name AS owner_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
       FROM projects p
       JOIN users u ON u.id = p.owner_id
       WHERE p.owner_id = $1
       ORDER BY p.updated_at DESC`,
      [req.session.userId]
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
    res.status(201).json({ project: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.session.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    const tasks = await db.query(
      `SELECT t.*, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = $1 ORDER BY t.created_at DESC`,
      [req.params.id]
    );
    res.json({ project: rows[0], tasks: tasks.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/:id', async (req, res) => {
  const { name, description, status } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE projects
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           updated_at = NOW()
       WHERE id = $4 AND owner_id = $5
       RETURNING *`,
      [name, description, status, req.params.id, req.session.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    res.json({ project: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.session.userId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/:id/tasks', async (req, res) => {
  const { title, description } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }
  try {
    const project = await db.query(
      'SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.session.userId]
    );
    if (project.rows.length === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
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

router.put('/:id/tasks/:taskId', async (req, res) => {
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

module.exports = router;
