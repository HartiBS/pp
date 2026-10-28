const db = require('../config/database');

/**
 * Holt alle Subtasks eines Tasks, sortiert nach Position.
 */
async function getSubtasks(taskId) {
  const { rows } = await db.query(
    `SELECT s.*, u.name AS assignee_name
     FROM task_subtasks s
     LEFT JOIN users u ON u.id = s.assignee_id
     WHERE s.task_id = $1
     ORDER BY s.position ASC, s.id ASC`,
    [taskId]
  );
  return rows;
}

/**
 * Erstellt einen Subtask. Position wird automatisch ans Ende gesetzt.
 */
async function createSubtask(taskId, title, assigneeId = null) {
  const { rows: posRows } = await db.query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM task_subtasks WHERE task_id = $1',
    [taskId]
  );
  const { rows } = await db.query(
    `INSERT INTO task_subtasks (task_id, title, assignee_id, position)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [taskId, title, assigneeId, posRows[0].next_pos]
  );
  return rows[0];
}

/**
 * Aktualisiert einen Subtask (Titel, Erledigt-Status, Bearbeiter).
 */
async function updateSubtask(subtaskId, taskId, { title, is_done, assignee_id }) {
  const { rows } = await db.query(
    `UPDATE task_subtasks
     SET title = COALESCE($1, title),
         is_done = COALESCE($2, is_done),
         assignee_id = CASE WHEN $3 = 'reset' THEN NULL ELSE COALESCE($3::int, assignee_id) END,
         updated_at = NOW()
     WHERE id = $4 AND task_id = $5
     RETURNING *`,
    [
      title !== undefined ? title : null,
      is_done !== undefined ? is_done : null,
      assignee_id !== undefined ? (assignee_id === null ? 'reset' : String(assignee_id)) : undefined,
      subtaskId, taskId,
    ]
  );
  return rows[0] || null;
}

/**
 * Löscht einen Subtask.
 */
async function deleteSubtask(subtaskId, taskId) {
  const { rowCount } = await db.query(
    'DELETE FROM task_subtasks WHERE id = $1 AND task_id = $2',
    [subtaskId, taskId]
  );
  return rowCount > 0;
}

/**
 * Liefert Fortschritt: { total, done, percent }
 */
async function getSubtaskProgress(taskId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_done = TRUE)::int AS done
     FROM task_subtasks WHERE task_id = $1`,
    [taskId]
  );
  const total = rows[0]?.total || 0;
  const done = rows[0]?.done || 0;
  return { total, done, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

module.exports = { getSubtasks, createSubtask, updateSubtask, deleteSubtask, getSubtaskProgress };
