const db = require('../config/database');

/**
 * Protokolliert eine Änderung an einem Task in der task_history-Tabelle.
 * @param {number} taskId
 * @param {number|null} userId - Benutzer, der die Änderung vorgenommen hat
 * @param {string} action - 'created', 'updated', 'deleted', 'status_changed', 'assigned', 'commented', 'subtask_toggled'
 * @param {string|null} field - betroffenes Feld (bei 'created'/'deleted' null)
 * @param {string|null} oldValue
 * @param {string|null} newValue
 */
async function logTaskChange(taskId, userId, action, field = null, oldValue = null, newValue = null) {
  try {
    await db.query(
      `INSERT INTO task_history (task_id, user_id, action, field, old_value, new_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [taskId, userId || null, action, field,
       oldValue !== null && oldValue !== undefined ? String(oldValue) : null,
       newValue !== null && newValue !== undefined ? String(newValue) : null]
    );
  } catch (err) {
    // Historie-Fehler sollen den Hauptfluss nicht blockieren
    console.error('task_history insert failed:', err.message);
  }
}

/**
 * Vergleicht alte und neue Task-Werte und protokolliert alle Änderungen.
 */
async function logTaskDiff(taskId, userId, oldTask, newTask) {
  const fields = [
    ['title', 'Titel'],
    ['description', 'Beschreibung'],
    ['status', 'Status'],
    ['assignee_id', 'Bearbeiter'],
    ['issue_type', 'Typ'],
    ['priority', 'Priorität'],
    ['due_date', 'Fälligkeitsdatum'],
    ['milestone_id', 'Meilenstein'],
    ['epic_id', 'Epic'],
    ['estimated_hours', 'Geschätzte Zeit'],
    ['spent_hours', 'Aufgewendete Zeit'],
  ];
  for (const [key] of fields) {
    const oldV = oldTask[key] !== undefined ? oldTask[key] : null;
    const newV = newTask[key] !== undefined ? newTask[key] : null;
    if (String(oldV ?? '') !== String(newV ?? '')) {
      await logTaskChange(taskId, userId, 'updated', key, oldV, newV);
    }
  }
  // Labels separat behandeln (Array)
  const oldLabels = JSON.stringify(oldTask.labels || []);
  const newLabels = JSON.stringify(newTask.labels || []);
  if (oldLabels !== newLabels) {
    await logTaskChange(taskId, userId, 'updated', 'labels', oldLabels, newLabels);
  }
}

/**
 * Holt die Historie eines Tasks, angereichert mit Benutzernamen.
 */
async function getTaskHistory(taskId) {
  const { rows } = await db.query(
    `SELECT h.*, u.name AS user_name
     FROM task_history h
     LEFT JOIN users u ON u.id = h.user_id
     WHERE h.task_id = $1
     ORDER BY h.changed_at DESC, h.id DESC`,
    [taskId]
  );
  return rows;
}

module.exports = { logTaskChange, logTaskDiff, getTaskHistory };
