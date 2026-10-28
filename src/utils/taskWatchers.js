const db = require('../config/database');

/**
 * Fügt einen Watcher zu einem Task hinzu (idempotent).
 */
async function addWatcher(taskId, userId) {
  if (!taskId || !userId) return;
  await db.query(
    `INSERT INTO task_watchers (task_id, user_id) VALUES ($1, $2)
     ON CONFLICT (task_id, user_id) DO NOTHING`,
    [taskId, userId]
  );
}

/**
 * Entfernt einen Watcher von einem Task.
 */
async function removeWatcher(taskId, userId) {
  await db.query(
    'DELETE FROM task_watchers WHERE task_id = $1 AND user_id = $2',
    [taskId, userId]
  );
}

/**
 * Prüft, ob ein User einen Task watcht.
 */
async function isWatching(taskId, userId) {
  const { rows } = await db.query(
    'SELECT 1 FROM task_watchers WHERE task_id = $1 AND user_id = $2',
    [taskId, userId]
  );
  return rows.length > 0;
}

/**
 * Holt alle Watcher eines Tasks (als User-IDs).
 */
async function getWatcherIds(taskId) {
  const { rows } = await db.query(
    'SELECT user_id FROM task_watchers WHERE task_id = $1',
    [taskId]
  );
  return rows.map(r => r.user_id);
}

/**
 * Holt alle Watcher eines Tasks mit Benutzerdetails.
 */
async function getWatchers(taskId) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.username, tw.created_at
     FROM task_watchers tw JOIN users u ON u.id = tw.user_id
     WHERE tw.task_id = $1 ORDER BY tw.created_at ASC`,
    [taskId]
  );
  return rows;
}

module.exports = { addWatcher, removeWatcher, isWatching, getWatcherIds, getWatchers };
