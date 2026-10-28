const db = require('../config/database');

/**
 * Holt alle Kommentare eines Tasks mit Autor-Details.
 */
async function getComments(taskId) {
  const { rows } = await db.query(
    `SELECT c.*, u.name AS author_name, u.username AS author_username
     FROM task_comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.task_id = $1
     ORDER BY c.created_at ASC`,
    [taskId]
  );
  return rows;
}

/**
 * Erstellt einen Kommentar.
 */
async function createComment(taskId, userId, body) {
  const { rows } = await db.query(
    `INSERT INTO task_comments (task_id, user_id, body)
     VALUES ($1, $2, $3) RETURNING *`,
    [taskId, userId, body]
  );
  const { rows: userRows } = await db.query(
    'SELECT name, username FROM users WHERE id = $1',
    [userId]
  );
  return { ...rows[0], author_name: userRows[0]?.name, author_username: userRows[0]?.username };
}

/**
 * Aktualisiert einen Kommentar (nur durch Autor).
 */
async function updateComment(commentId, taskId, body) {
  const { rows } = await db.query(
    `UPDATE task_comments SET body = $1, updated_at = NOW()
     WHERE id = $2 AND task_id = $3 RETURNING *`,
    [body, commentId, taskId]
  );
  return rows[0] || null;
}

/**
 * Löscht einen Kommentar.
 */
async function deleteComment(commentId, taskId) {
  const { rowCount } = await db.query(
    'DELETE FROM task_comments WHERE id = $1 AND task_id = $2',
    [commentId, taskId]
  );
  return rowCount > 0;
}

module.exports = { getComments, createComment, updateComment, deleteComment };
