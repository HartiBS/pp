const db = require('../config/database');

async function notify(userId, { type, title, body, link }) {
  if (!userId) return;
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, link)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, body || null, link || null]
  );
}

async function notifyAssignment({ taskTitle, projectId, assigneeId, actorName }) {
  if (!assigneeId) return;
  await notify(assigneeId, {
    type: 'assigned',
    title: `Dir wurde ein Issue zugewiesen: ${taskTitle}`,
    body: `${actorName || 'Jemand'} hat dir „${taskTitle}" zugewiesen.`,
    link: `/#/project/${projectId}`,
  });
}

async function notifyStatusChange({ taskTitle, projectId, oldStatus, newStatus, assigneeId, actorName, actorId }) {
  if (!assigneeId || Number(assigneeId) === Number(actorId)) return;
  await notify(assigneeId, {
    type: 'status_change',
    title: `Status geändert: ${taskTitle}`,
    body: `${actorName || 'Jemand'} hat den Status von „${oldStatus}" auf „${newStatus}" geändert.`,
    link: `/#/project/${projectId}`,
  });
}

async function notifyComment({ taskTitle, projectId, assigneeId, commenterName, commenterId, snippet }) {
  if (!assigneeId || Number(assigneeId) === Number(commenterId)) return;
  await notify(assigneeId, {
    type: 'comment',
    title: `Neuer Kommentar: ${taskTitle}`,
    body: `${commenterName || 'Jemand'}: ${snippet}`,
    link: `/#/project/${projectId}`,
  });
}

module.exports = { notify, notifyAssignment, notifyStatusChange, notifyComment };
