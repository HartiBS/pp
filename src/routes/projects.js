const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { loadProjectRole, requireProjectPermission, PROJECT_ROLES } = require('../utils/permissions');
const notifications = require('../utils/notifications');
const gitlab = require('../utils/gitlab');
const taskHistory = require('../utils/taskHistory');
const taskWatchers = require('../utils/taskWatchers');
const taskComments = require('../utils/taskComments');
const taskSubtasks = require('../utils/taskSubtasks');

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
          OR $2 = TRUE
       ORDER BY p.updated_at DESC`,
      [req.session.userId, req.currentUser.roles.includes('admin')]
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
  const { title, description, issue_type, labels, due_date, epic_id, assignee_id, milestone_id, push_to_gitlab, priority, estimated_hours } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }
  const validPriorities = ['low', 'normal', 'high', 'critical'];
  const taskPriority = priority && validPriorities.includes(priority) ? priority : 'normal';
  const finalAssignee = assignee_id || req.session.userId;
  try {
    const { rows: projectRows } = await db.query(
      'SELECT gitlab_project_id FROM projects WHERE id = $1',
      [req.params.id]
    );
    const gitlabProjectId = projectRows[0] ? projectRows[0].gitlab_project_id : null;

    let gitlabIid = null;
    // #57: Task direkt als GitLab-Issue anlegen (wenn verknüpft und gewünscht)
    if (push_to_gitlab && gitlabProjectId) {
      try {
        const created = await gitlab.createGitLabIssue(gitlabProjectId, { title, description });
        gitlabIid = created.gitlab_iid;
        await db.query(
          `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [req.params.id, created.gitlab_iid, created.title, created.description, created.state, created.web_url]
        );
      } catch (gitlabErr) {
        console.error('GitLab-Push fehlgeschlagen (Task-Anlegen):', gitlabErr.message);
      }
    }

    const estHours = estimated_hours !== undefined && estimated_hours !== null && estimated_hours !== ''
      ? Number(estimated_hours) : null;
    if (estHours !== null && (isNaN(estHours) || estHours < 0)) {
      return res.status(400).json({ error: 'estimated_hours muss eine positive Zahl sein' });
    }

    const { rows } = await db.query(
      `INSERT INTO tasks (project_id, title, description, assignee_id, issue_type, labels, due_date, epic_id, milestone_id, gitlab_iid, priority, estimated_hours, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        req.params.id,
        title,
        description || null,
        finalAssignee,
        issue_type || 'task',
        Array.isArray(labels) ? labels : [],
        due_date || null,
        epic_id || null,
        milestone_id || null,
        gitlabIid,
        taskPriority,
        estHours,
        req.session.userId,
      ]
    );
    const newTask = rows[0];

    // US-24: Historie – Task erstellt
    await taskHistory.logTaskChange(newTask.id, req.session.userId, 'created');

    // US-27: Ersteller und Bearbeiter automatisch als Watcher hinzufügen
    await taskWatchers.addWatcher(newTask.id, req.session.userId);
    if (finalAssignee && Number(finalAssignee) !== Number(req.session.userId)) {
      await taskWatchers.addWatcher(newTask.id, Number(finalAssignee));
      await notifications.notifyAssignment({
        taskTitle: title,
        projectId: req.params.id,
        assigneeId: finalAssignee,
        actorName: req.currentUser.name,
      });
    }

    res.status(201).json({ task: { ...newTask, subtask_count: 0, subtask_done: 0 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/:id/tasks/:taskId', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { title, description, status, assignee_id, issue_type, labels, due_date, epic_id, milestone_id, priority, estimated_hours, spent_hours } = req.body;
  try {
    const prev = await db.query(
      `SELECT t.*, p.gitlab_project_id
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = $1 AND t.project_id = $2`,
      [req.params.taskId, req.params.id]
    );
    if (prev.rows.length === 0) {
      return res.status(404).json({ error: 'Task nicht gefunden' });
    }
    const oldTask = prev.rows[0];
    const oldStatus = oldTask.status;
    const oldAssignee = oldTask.assignee_id;
    const taskTitle = (title || oldTask.title) || 'Task';
    const gitlabIid = oldTask.gitlab_iid;
    const gitlabProjectId = oldTask.gitlab_project_id;

    // US-25: Priorität validieren
    const validPriorities = ['low', 'normal', 'high', 'critical'];
    let newPriority = null;
    if (priority !== undefined) {
      if (!validPriorities.includes(priority)) {
        return res.status(400).json({ error: 'Ungültige Priorität. Erlaubt: low, normal, high, critical' });
      }
      newPriority = priority;
    }

    // US-25: Stunden validieren
    let estHours = null, spentH = null;
    if (estimated_hours !== undefined) {
      estHours = estimated_hours === null || estimated_hours === '' ? null : Number(estimated_hours);
      if (estHours !== null && (isNaN(estHours) || estHours < 0)) {
        return res.status(400).json({ error: 'estimated_hours muss eine positive Zahl sein' });
      }
    }
    if (spent_hours !== undefined) {
      spentH = spent_hours === null || spent_hours === '' ? 0 : Number(spent_hours);
      if (isNaN(spentH) || spentH < 0) {
        return res.status(400).json({ error: 'spent_hours muss eine positive Zahl sein' });
      }
    }

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
           milestone_id = COALESCE($9, milestone_id),
           priority = COALESCE($10, priority),
           estimated_hours = COALESCE($11, estimated_hours),
           spent_hours = COALESCE($12, spent_hours),
           updated_at = NOW()
       WHERE id = $13 AND project_id = $14
       RETURNING *`,
      [title, description, status, assignee_id, issue_type,
       labels !== undefined ? (Array.isArray(labels) ? labels : []) : null,
       due_date, epic_id, milestone_id, newPriority, estHours, spentH,
       req.params.taskId, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task nicht gefunden' });
    }
    const updatedTask = rows[0];

    // US-24: Historie – Änderungen protokollieren
    await taskHistory.logTaskDiff(updatedTask.id, req.session.userId, oldTask, updatedTask);

    // #57: Änderungen an verknüpfte GitLab-Issues pushen
    if (gitlabIid && gitlabProjectId) {
      const gitlabUpdate = {};
      if (title) gitlabUpdate.title = title;
      if (description !== undefined) gitlabUpdate.description = description;
      if (status && status !== oldStatus) {
        gitlabUpdate.state_event = status === 'done' ? 'close' : 'reopen';
      }
      if (Object.keys(gitlabUpdate).length > 0) {
        try {
          const updated = await gitlab.updateGitLabIssue(gitlabProjectId, gitlabIid, gitlabUpdate);
          await db.query(
            `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (project_id, gitlab_iid) DO UPDATE
             SET title = EXCLUDED.title, description = EXCLUDED.description,
                 state = EXCLUDED.state, synced_at = NOW()`,
            [req.params.id, gitlabIid, updated.title, updated.description, updated.state, updated.web_url]
          );
        } catch (gitlabErr) {
          console.error('GitLab-Push fehlgeschlagen (Task-Update):', gitlabErr.message);
        }
      }
    }

    // US-27: Neuer Bearbeiter wird automatisch Watcher
    if (assignee_id && Number(assignee_id) !== Number(oldAssignee)) {
      await taskWatchers.addWatcher(updatedTask.id, Number(assignee_id));
      await notifications.notifyAssignment({
        taskTitle,
        projectId: req.params.id,
        assigneeId: assignee_id,
        actorName: req.currentUser.name,
      });
    }

    // US-27: Statusänderung – alle Watcher benachrichtigen (außer Actor)
    if (status && oldStatus && status !== oldStatus) {
      const watcherIds = await taskWatchers.getWatcherIds(updatedTask.id);
      for (const wid of watcherIds) {
        if (Number(wid) !== Number(req.session.userId)) {
          await notifications.notifyStatusChange({
            taskTitle,
            projectId: req.params.id,
            oldStatus,
            newStatus: status,
            assigneeId: wid,
            actorName: req.currentUser.name,
            actorId: req.session.userId,
          });
        }
      }
    }

    // Subtask-Fortschritt anreichern
    const progress = await taskSubtasks.getSubtaskProgress(updatedTask.id);
    res.json({ task: { ...updatedTask, subtask_count: progress.total, subtask_done: progress.done } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/:id/tasks/:taskId', loadProjectRole, requireProjectPermission('delete_task'), async (req, res) => {
  try {
    // US-24: Historie vor dem Löschen protokollieren
    await taskHistory.logTaskChange(req.params.taskId, req.session.userId, 'deleted');
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

// ===== Epic 6: Aufgabenmanagement – Erweiterte Task-Features =====

// US-23: Task-Kommentare
router.get('/:id/tasks/:taskId/comments', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const comments = await taskComments.getComments(req.params.taskId);
    res.json({ comments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/:id/tasks/:taskId/comments', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Kommentar-Text ist erforderlich' });
  }
  try {
    // Task Infos für Benachrichtigungen
    const taskInfo = await db.query(
      'SELECT title FROM tasks WHERE id = $1 AND project_id = $2',
      [req.params.taskId, req.params.id]
    );
    if (taskInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Task nicht gefunden' });
    }
    const comment = await taskComments.createComment(req.params.taskId, req.session.userId, body.trim());

    // Historie
    await taskHistory.logTaskChange(req.params.taskId, req.session.userId, 'commented');

    // Autor als Watcher hinzufügen
    await taskWatchers.addWatcher(req.params.taskId, req.session.userId);

    // Alle Watcher benachrichtigen (außer Kommentator)
    const watcherIds = await taskWatchers.getWatcherIds(req.params.taskId);
    const snippet = body.trim().slice(0, 100);
    for (const wid of watcherIds) {
      if (Number(wid) !== Number(req.session.userId)) {
        await notifications.notify(wid, {
          type: 'comment',
          title: `Neuer Kommentar: ${taskInfo.rows[0].title}`,
          body: `${req.currentUser.name}: ${snippet}`,
          link: `/#/project/${req.params.id}`,
        });
      }
    }

    // GitLab-Push wenn verknüpft
    const gitlabInfo = await db.query(
      'SELECT t.gitlab_iid, p.gitlab_project_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1',
      [req.params.taskId]
    );
    if (gitlabInfo.rows[0]?.gitlab_iid && gitlabInfo.rows[0]?.gitlab_project_id) {
      try {
        await gitlab.addGitLabComment(
          gitlabInfo.rows[0].gitlab_project_id,
          gitlabInfo.rows[0].gitlab_iid,
          `**${req.currentUser.name}** (PP): ${body.trim()}`
        );
      } catch (gitlabErr) {
        console.error('GitLab-Kommentar fehlgeschlagen:', gitlabErr.message);
      }
    }

    res.status(201).json({ comment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/:id/tasks/:taskId/comments/:commentId', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Kommentar-Text ist erforderlich' });
  }
  try {
    // Nur Autor darf bearbeiten
    const check = await db.query(
      'SELECT user_id FROM task_comments WHERE id = $1 AND task_id = $2',
      [req.params.commentId, req.params.taskId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    }
    if (Number(check.rows[0].user_id) !== Number(req.session.userId) && req.projectRole !== 'admin' && req.projectRole !== 'projektmanager') {
      return res.status(403).json({ error: 'Nur der Autor darf diesen Kommentar bearbeiten' });
    }
    const updated = await taskComments.updateComment(req.params.commentId, req.params.taskId, body.trim());
    res.json({ comment: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/:id/tasks/:taskId/comments/:commentId', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  try {
    // Autor oder PM/Admin darf löschen
    const check = await db.query(
      'SELECT user_id FROM task_comments WHERE id = $1 AND task_id = $2',
      [req.params.commentId, req.params.taskId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    }
    if (Number(check.rows[0].user_id) !== Number(req.session.userId) && req.projectRole !== 'admin' && req.projectRole !== 'projektmanager') {
      return res.status(403).json({ error: 'Keine Berechtigung zum Löschen' });
    }
    await taskComments.deleteComment(req.params.commentId, req.params.taskId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// US-24: Task-Historie
router.get('/:id/tasks/:taskId/history', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const history = await taskHistory.getTaskHistory(req.params.taskId);
    res.json({ history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// US-26: Subtasks / Checkliste
router.get('/:id/tasks/:taskId/subtasks', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const subtasks = await taskSubtasks.getSubtasks(req.params.taskId);
    const progress = await taskSubtasks.getSubtaskProgress(req.params.taskId);
    res.json({ subtasks, progress });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/:id/tasks/:taskId/subtasks', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { title, assignee_id } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }
  try {
    const subtask = await taskSubtasks.createSubtask(req.params.taskId, title.trim(), assignee_id || null);
    await taskHistory.logTaskChange(req.params.taskId, req.session.userId, 'updated', 'subtask_added', null, title.trim());
    res.status(201).json({ subtask });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/:id/tasks/:taskId/subtasks/:subtaskId', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { title, is_done, assignee_id } = req.body;
  try {
    const prev = await db.query(
      'SELECT is_done FROM task_subtasks WHERE id = $1 AND task_id = $2',
      [req.params.subtaskId, req.params.taskId]
    );
    if (prev.rows.length === 0) {
      return res.status(404).json({ error: 'Subtask nicht gefunden' });
    }
    const wasDone = prev.rows[0].is_done;
    const subtask = await taskSubtasks.updateSubtask(req.params.subtaskId, req.params.taskId, {
      title, is_done, assignee_id,
    });
    if (is_done !== undefined && Boolean(is_done) !== Boolean(wasDone)) {
      await taskHistory.logTaskChange(
        req.params.taskId, req.session.userId, 'subtask_toggled',
        'subtask', wasDone ? 'erledigt' : 'offen', is_done ? 'erledigt' : 'offen'
      );
    }
    res.json({ subtask });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/:id/tasks/:taskId/subtasks/:subtaskId', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  try {
    const deleted = await taskSubtasks.deleteSubtask(req.params.subtaskId, req.params.taskId);
    if (!deleted) {
      return res.status(404).json({ error: 'Subtask nicht gefunden' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// US-27: Task-Watcher
router.get('/:id/tasks/:taskId/watchers', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const watchers = await taskWatchers.getWatchers(req.params.taskId);
    const watching = await taskWatchers.isWatching(req.params.taskId, req.session.userId);
    res.json({ watchers, watching });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/:id/tasks/:taskId/watch', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    await taskWatchers.addWatcher(req.params.taskId, req.session.userId);
    res.json({ ok: true, watching: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/:id/tasks/:taskId/watch', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    await taskWatchers.removeWatcher(req.params.taskId, req.session.userId);
    res.json({ ok: true, watching: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// US-28: Task-Detail (alle Infos auf einmal)
router.get('/:id/tasks/:taskId', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT t.*, u.name AS assignee_name, c.name AS creator_name
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN users c ON c.id = t.created_by
       WHERE t.id = $1 AND t.project_id = $2`,
      [req.params.taskId, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task nicht gefunden' });
    }
    const task = rows[0];
    const [comments, history, subtasks, watchers, progress] = await Promise.all([
      taskComments.getComments(req.params.taskId),
      taskHistory.getTaskHistory(req.params.taskId),
      taskSubtasks.getSubtasks(req.params.taskId),
      taskWatchers.getWatchers(req.params.taskId),
      taskSubtasks.getSubtaskProgress(req.params.taskId),
    ]);
    const watching = await taskWatchers.isWatching(req.params.taskId, req.session.userId);
    res.json({
      task: { ...task, subtask_count: progress.total, subtask_done: progress.done },
      comments,
      history,
      subtasks,
      watchers,
      watching,
    });
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
