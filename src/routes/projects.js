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
const customFields = require('../utils/customFields');
const taskMarkdown = require('../utils/taskMarkdown');
const taskRelations = require('../utils/taskRelations');
const issueTracker = require('../utils/issueTracker');

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
    // #80: Beim Öffnen Issues vom externen Tracker syncen (best effort, nicht-blockierend)
    if (req.query.no_sync !== '1') {
      try {
        const tracker = await issueTracker.getProjectTracker(req.params.id);
        if (tracker && issueTracker.trackerProjectId(tracker)) {
          await issueTracker.syncIssues(tracker);
        }
      } catch (syncErr) {
        console.error('Auto-Sync beim Projekt-Öffnen fehlgeschlagen:', syncErr.message);
      }
    }
    const { rows } = await db.query(
      'SELECT p.*, u.name AS owner_name FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = $1',
      [req.params.id]
    );
    const { type, label, status, epic_only, priority, sort } = req.query;
    const conditions = ['t.project_id = $1'];
    const params = [req.params.id];
    if (type) { params.push(type); conditions.push(`t.issue_type = $${params.length}`); }
    if (label) { params.push(label); conditions.push(`$${params.length} = ANY(t.labels)`); }
    if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
    if (epic_only === 'true') { conditions.push(`t.issue_type = 'epic'`); }
    // #64: Filter nach Priorität
    if (priority) {
      const validPriorities = ['low', 'normal', 'high', 'critical'];
      if (!validPriorities.includes(priority)) {
        return res.status(400).json({ error: 'Ungültige Priorität. Erlaubt: low, normal, high, critical' });
      }
      params.push(priority); conditions.push(`t.priority = $${params.length}`);
    }
    // #71: Filter nach Custom-Field-Werten (?cf_<fieldDefinitionId>=<wert>)
    for (const [key, value] of Object.entries(req.query)) {
      const m = key.match(/^cf_(\d+)$/);
      if (!m) continue;
      params.push(m[1], String(value));
      const keyParam = params.length - 1;
      const valParam = params.length;
      // JSONB-Pfad: custom_fields->key = wert (textueller Vergleich, gilt für alle Feldtypen)
      conditions.push(`t.custom_fields->>$${keyParam} = $${valParam}`);
    }
    // #64: Sortierung (kritisch zuerst als Default-Ordnung bei sort=priority)
    let orderBy = 't.created_at DESC';
    if (sort === 'priority') {
      orderBy = `CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 ELSE 5 END ASC, t.created_at DESC`;
    } else if (sort === 'due_date') {
      orderBy = 't.due_date ASC NULLS LAST, t.created_at DESC';
    } else if (sort === 'title') {
      orderBy = 't.title ASC';
    }
    const tasks = await db.query(
      `SELECT t.*, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}`,
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
  const { name, description, status, issue_tracker_type, gitlab_project_id, github_repo, auto_sync } = req.body;

  // #77: Tracker-Typ validieren
  let trackerType = null;
  if (issue_tracker_type !== undefined) {
    if (!['none', 'gitlab', 'github'].includes(issue_tracker_type)) {
      return res.status(400).json({ error: 'Ungültiger Tracker-Typ. Erlaubt: none, gitlab, github' });
    }
    trackerType = issue_tracker_type;
  }

  let gitlabId = null;
  if (gitlab_project_id !== undefined && gitlab_project_id !== null && gitlab_project_id !== '') {
    const n = Number(gitlab_project_id);
    if (!Number.isInteger(n)) {
      return res.status(400).json({ error: 'gitlab_project_id muss eine ganze Zahl sein' });
    }
    gitlabId = n;
  }

  // #77: github_repo validieren (Format: owner/repo)
  let githubRepo = null;
  if (github_repo !== undefined) {
    if (github_repo === null || github_repo === '') {
      githubRepo = null;
    } else if (typeof github_repo === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(github_repo.trim())) {
      githubRepo = github_repo.trim();
    } else {
      return res.status(400).json({ error: 'github_repo muss das Format "owner/repo" haben' });
    }
  }

  try {
    // #77: Beim Tracker-Wechsel die bisherige externe Verknüpfung immer zurücksetzen
    // (unabhängig davon, ob das Feld im Request mitkommt — sonst bleibt eine
    // ungültige Kombination aus altem Tracker-Typ + neuer ID stehen).
    let effectiveGitlabId = gitlabId;
    let effectiveGithubRepo = githubRepo;
    let effectiveTrackerType = trackerType;
    let resetGitlab = gitlab_project_id !== undefined && gitlabId === null;
    let resetGithub = github_repo !== undefined && githubRepo === null;

    if (trackerType !== null) {
      const current = await db.query(
        'SELECT issue_tracker_type FROM projects WHERE id = $1',
        [req.params.id]
      );
      if (current.rows.length > 0) {
        const prevType = current.rows[0].issue_tracker_type || 'none';
        if (prevType !== trackerType) {
          if (trackerType !== 'gitlab') { effectiveGitlabId = null; resetGitlab = true; }
          if (trackerType !== 'github') { effectiveGithubRepo = null; resetGithub = true; }
        }
      }
    }

    // #83: projektweite Auto-Sync-Einstellung
    if (auto_sync !== undefined && auto_sync !== null) {
      if (typeof auto_sync !== 'boolean') {
        return res.status(400).json({ error: 'auto_sync muss ein Boolean sein' });
      }
    }

    const { rows } = await db.query(
      `UPDATE projects
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           issue_tracker_type = COALESCE($4, issue_tracker_type),
           gitlab_project_id = CASE WHEN $5 THEN NULL WHEN $6::int IS NULL THEN gitlab_project_id ELSE $6::int END,
           github_repo = CASE WHEN $7 THEN NULL WHEN $8 IS NULL THEN github_repo ELSE $8 END,
           auto_sync = COALESCE($10, auto_sync),
           updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        name, description, status,
        effectiveTrackerType,
        resetGitlab, effectiveGitlabId,
        resetGithub, effectiveGithubRepo,
        req.params.id,
        auto_sync !== undefined && auto_sync !== null ? auto_sync : null,
      ]
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
  const { title, description, issue_type, labels, due_date, epic_id, assignee_id, milestone_id, push_to_gitlab, priority, estimated_hours, custom_fields, auto_sync } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }
  const validPriorities = ['low', 'normal', 'high', 'critical'];
  const taskPriority = priority && validPriorities.includes(priority) ? priority : 'normal';
  const finalAssignee = assignee_id || req.session.userId;
  try {
    const { rows: projectRows } = await db.query(
      'SELECT gitlab_project_id, issue_tracker_type, github_repo, auto_sync FROM projects WHERE id = $1',
      [req.params.id]
    );
    const projectRow = projectRows[0] || {};
    const gitlabProjectId = projectRow.gitlab_project_id || null;
    // #83: projektweiter Auto-Sync-Default (an, wenn Tracker konfiguriert und nicht deaktiviert)
    const projectAutoSync = projectRow.auto_sync !== false;

    const estHours = estimated_hours !== undefined && estimated_hours !== null && estimated_hours !== ''
      ? Number(estimated_hours) : null;
    if (estHours !== null && (isNaN(estHours) || estHours < 0)) {
      return res.status(400).json({ error: 'estimated_hours muss eine positive Zahl sein' });
    }

    // #71: Custom Fields validieren
    let cleanedCustomFields = {};
    if (custom_fields !== undefined && custom_fields !== null) {
      const cfResult = await customFields.validateTaskCustomFields(req.params.id, custom_fields);
      if (!cfResult.ok) {
        return res.status(400).json({ error: cfResult.error });
      }
      cleanedCustomFields = cfResult.cleaned;
    }

    let gitlabIid = null;
    // #57/#77/#83: Task direkt als Issue im externen Tracker anlegen
    // (wenn explizit gewünscht ODER projektweiter Auto-Sync aktiv und Tracker konfiguriert)
    const effectiveAutoSync = auto_sync !== undefined && auto_sync !== null ? auto_sync : projectAutoSync;
    if (push_to_gitlab || effectiveAutoSync) {
      try {
        const tracker = await issueTracker.getProjectTracker(req.params.id);
        const trackerProjectId = issueTracker.trackerProjectId(tracker);
        if (trackerProjectId) {
          // #72: Task als Markdown serialisieren
          const activeCfDefs = await customFields.getProjectFieldDefinitions(req.params.id);
          const mdDescription = taskMarkdown.taskToMarkdown(
            {
              title, description: description || '', status: 'todo',
              priority: taskPriority, issue_type: issue_type || 'task',
              labels: Array.isArray(labels) ? labels : [],
              due_date: due_date || null, estimated_hours: estHours, spent_hours: 0,
              custom_fields: cleanedCustomFields,
            },
            { customFieldDefs: activeCfDefs, subtasks: [] }
          );
          const created = await issueTracker.createIssue(tracker, { title, description: mdDescription, labels: Array.isArray(labels) ? labels : [] });
          gitlabIid = created.gitlab_iid;
          await db.query(
            `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [req.params.id, created.gitlab_iid, created.title, created.description, created.state, created.web_url]
          );
        }
      } catch (trackerErr) {
        console.error('Tracker-Push fehlgeschlagen (Task-Anlegen):', trackerErr.message);
      }
    }

    const { rows } = await db.query(
      `INSERT INTO tasks (project_id, title, description, assignee_id, issue_type, labels, due_date, epic_id, milestone_id, gitlab_iid, priority, estimated_hours, created_by, custom_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
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
        cleanedCustomFields,
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
  const { title, description, status, assignee_id, issue_type, labels, due_date, epic_id, milestone_id, priority, estimated_hours, spent_hours, custom_fields, auto_sync } = req.body;
  try {
    const prev = await db.query(
      `SELECT t.*, p.gitlab_project_id, p.issue_tracker_type, p.github_repo, p.auto_sync
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
    // #83: projektweiter Auto-Sync-Default (an, sofern nicht explizit deaktiviert)
    const projectAutoSync = oldTask.auto_sync !== false;
    const effectiveAutoSync = auto_sync !== undefined && auto_sync !== null ? auto_sync : projectAutoSync;

    // #65: Erledigte Tasks mit offenen Subtasks können nicht auf "done" gesetzt werden
    if (status === 'done' && oldStatus !== 'done') {
      const openCount = await db.query(
        'SELECT COUNT(*)::int AS c FROM task_subtasks WHERE task_id = $1 AND is_done = FALSE',
        [req.params.taskId]
      );
      if (openCount.rows[0].c > 0) {
        return res.status(409).json({ error: `Task kann nicht auf "done" gesetzt werden: ${openCount.rows[0].c} offene(r) Subtask(s)` });
      }
    }

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

    // #71: Custom Fields validieren (wenn übergeben)
    let cleanedCustomFields = null;
    if (custom_fields !== undefined && custom_fields !== null) {
      const cfResult = await customFields.validateTaskCustomFields(req.params.id, custom_fields);
      if (!cfResult.ok) {
        return res.status(400).json({ error: cfResult.error });
      }
      cleanedCustomFields = cfResult.cleaned;
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
           custom_fields = COALESCE($13, custom_fields),
           updated_at = NOW()
       WHERE id = $14 AND project_id = $15
       RETURNING *`,
      [title, description, status, assignee_id, issue_type,
       labels !== undefined ? (Array.isArray(labels) ? labels : []) : null,
       due_date, epic_id, milestone_id, newPriority, estHours, spentH,
       cleanedCustomFields,
       req.params.taskId, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task nicht gefunden' });
    }
    const updatedTask = rows[0];

    // US-24: Historie – Änderungen protokollieren
    await taskHistory.logTaskDiff(updatedTask.id, req.session.userId, oldTask, updatedTask);

    // #83: Auto-Sync — wenn Task noch kein externes Issue hat, aber Auto-Sync aktiv
    if (!gitlabIid && effectiveAutoSync) {
      try {
        const tracker = await issueTracker.getProjectTracker(req.params.id);
        const trackerProjectId = issueTracker.trackerProjectId(tracker);
        if (trackerProjectId) {
          const activeCfDefs = await customFields.getProjectFieldDefinitions(req.params.id);
          const subtasks = await taskSubtasks.getSubtasks(updatedTask.id);
          const [parent, children, related] = await Promise.all([
            taskRelations.getParent(updatedTask.id),
            taskRelations.getChildren(updatedTask.id),
            taskRelations.getRelatedTasks(updatedTask.id),
          ]);
          const mdDescription = taskMarkdown.taskToMarkdown(updatedTask, {
            customFieldDefs: activeCfDefs, subtasks, parent, children, related,
          });
          const created = await issueTracker.createIssue(tracker, {
            title: updatedTask.title, description: mdDescription,
            labels: Array.isArray(updatedTask.labels) ? updatedTask.labels : [],
          });
          // gitlab_iid setzen
          await db.query('UPDATE tasks SET gitlab_iid = $1 WHERE id = $2', [created.gitlab_iid, updatedTask.id]);
          updatedTask.gitlab_iid = created.gitlab_iid;
          await db.query(
            `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [req.params.id, created.gitlab_iid, created.title, created.description, created.state, created.web_url]
          );
        }
      } catch (trackerErr) {
        console.error('Auto-Sync (Task-Erstellen im Tracker) fehlgeschlagen:', trackerErr.message);
      }
    }

    // #57/#77: Änderungen an verknüpfte Issues im externen Tracker pushen
    if (updatedTask.gitlab_iid || gitlabIid) {
      try {
        const tracker = await issueTracker.getProjectTracker(req.params.id);
        const trackerProjectId = issueTracker.trackerProjectId(tracker);
        const extId = updatedTask.gitlab_iid || gitlabIid;
        if (trackerProjectId && extId) {
          const trackerUpdate = {};
          if (title) trackerUpdate.title = title;
          // #72: Beschreibung als Markdown serialisieren
          if (description !== undefined || status !== undefined || priority !== undefined ||
              estimated_hours !== undefined || spent_hours !== undefined || custom_fields !== undefined) {
            const activeCfDefs = await customFields.getProjectFieldDefinitions(req.params.id);
            const subtasks = await taskSubtasks.getSubtasks(updatedTask.id);
            const [parent, children, related] = await Promise.all([
              taskRelations.getParent(updatedTask.id),
              taskRelations.getChildren(updatedTask.id),
              taskRelations.getRelatedTasks(updatedTask.id),
            ]);
            trackerUpdate.description = taskMarkdown.taskToMarkdown(updatedTask, {
              customFieldDefs: activeCfDefs, subtasks, parent, children, related,
            });
          }
          if (status && status !== oldStatus) {
            trackerUpdate.state_event = status === 'done' ? 'close' : 'reopen';
          }
          if (Object.keys(trackerUpdate).length > 0) {
            const updated = await issueTracker.updateIssue(tracker, extId, trackerUpdate);
            await db.query(
              `INSERT INTO gitlab_issues (project_id, gitlab_iid, title, description, state, web_url, synced_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW())
               ON CONFLICT (project_id, gitlab_iid) DO UPDATE
               SET title = EXCLUDED.title, description = EXCLUDED.description,
                   state = EXCLUDED.state, synced_at = NOW()`,
              [req.params.id, extId, updated.title, updated.description, updated.state, updated.web_url]
            );
          }
        }
      } catch (trackerErr) {
        console.error('Tracker-Push fehlgeschlagen (Task-Update):', trackerErr.message);
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

    // #77: Kommentar an externen Tracker pushen (GitLab oder GitHub)
    const trackerInfo = await db.query(
      `SELECT t.gitlab_iid, p.issue_tracker_type, p.gitlab_project_id, p.github_repo
       FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
      [req.params.taskId]
    );
    if (trackerInfo.rows[0]?.gitlab_iid) {
      try {
        const tracker = {
          id: req.params.id,
          issue_tracker_type: trackerInfo.rows[0].issue_tracker_type,
          gitlab_project_id: trackerInfo.rows[0].gitlab_project_id,
          github_repo: trackerInfo.rows[0].github_repo,
        };
        await issueTracker.addComment(tracker, trackerInfo.rows[0].gitlab_iid, `**${req.currentUser.name}** (PP): ${body.trim()}`);
      } catch (trackerErr) {
        console.error('Tracker-Kommentar fehlgeschlagen:', trackerErr.message);
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

// ===== Issue #74: Task-Relationen (Parent/Child/Related) =====

// GET: Alle Relationen eines Tasks
router.get('/:id/tasks/:taskId/relations', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const [relations, parent, children, related, childrenProgress] = await Promise.all([
      taskRelations.getTaskRelations(req.params.taskId),
      taskRelations.getParent(req.params.taskId),
      taskRelations.getChildren(req.params.taskId),
      taskRelations.getRelatedTasks(req.params.taskId),
      taskRelations.getChildrenProgress(req.params.taskId),
    ]);
    res.json({ relations, parent, children, related, childrenProgress });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// POST: Relation erstellen (Parent oder Related)
router.post('/:id/tasks/:taskId/relations', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const { target_task_id, relation_type, direction } = req.body;
  if (!target_task_id) {
    return res.status(400).json({ error: 'target_task_id ist erforderlich' });
  }
  const relType = relation_type || 'parent_child';
  // direction: 'parent' = target is parent of this task, 'child' = target is child of this task
  const isParent = direction === 'parent';
  const parentId = isParent ? Number(target_task_id) : Number(req.params.taskId);
  const childId = isParent ? Number(req.params.taskId) : Number(target_task_id);

  try {
    const relation = await taskRelations.createRelation(parentId, childId, relType);
    if (!relation) {
      return res.status(409).json({ error: 'Relation existiert bereits' });
    }

    // #74: Issue-Link im externen Tracker erstellen (best effort, nur GitLab unterstützt Links)
    try {
      const tracker = await issueTracker.getProjectTracker(req.params.id);
      if (tracker && tracker.issue_tracker_type === 'gitlab') {
        const opts = tracker.use_project_settings && tracker.project_gitlab_settings
          ? { projectSettings: tracker.project_gitlab_settings } : {};
        const { rows: bothTasks } = await db.query(
          'SELECT id, gitlab_iid FROM tasks WHERE id IN ($1, $2) AND project_id = $3',
          [parentId, childId, req.params.id]
        );
        const pTask = bothTasks.find(t => Number(t.id) === parentId);
        const cTask = bothTasks.find(t => Number(t.id) === childId);
        if (pTask?.gitlab_iid && cTask?.gitlab_iid) {
          const linkType = relType === 'parent_child' ? 'is_blocked_by' : 'relates_to';
          await gitlab.createIssueLink(
            issueTracker.trackerProjectId(tracker),
            cTask.gitlab_iid,
            pTask.gitlab_iid,
            linkType,
            opts
          );
        }
      }
    } catch (trackerErr) {
      console.error('Tracker-Link fehlgeschlagen:', trackerErr.message);
    }

    // Historie
    await taskHistory.logTaskChange(req.params.taskId, req.session.userId, 'updated', 'relation_added', null, `Task #${target_task_id} (${relType})`);

    res.status(201).json({ relation });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Serverfehler' });
  }
});

// DELETE: Relation entfernen
router.delete('/:id/tasks/:taskId/relations/:targetTaskId', loadProjectRole, requireProjectPermission('edit_task'), async (req, res) => {
  const relationType = req.query.type || 'parent_child';
  const direction = req.query.direction || 'child'; // 'child' = target is child of this task
  const isParent = direction === 'parent';
  const parentId = isParent ? Number(req.params.targetTaskId) : Number(req.params.taskId);
  const childId = isParent ? Number(req.params.taskId) : Number(req.params.targetTaskId);

  try {
    const deleted = await taskRelations.deleteRelation(parentId, childId, relationType);
    if (!deleted) {
      return res.status(404).json({ error: 'Relation nicht gefunden' });
    }

    // #74: Issue-Links im externen Tracker entfernen (best effort, nur GitLab)
    try {
      const tracker = await issueTracker.getProjectTracker(req.params.id);
      if (tracker && tracker.issue_tracker_type === 'gitlab') {
        const opts = tracker.use_project_settings && tracker.project_gitlab_settings
          ? { projectSettings: tracker.project_gitlab_settings } : {};
        const { rows: bothTasks } = await db.query(
          'SELECT id, gitlab_iid FROM tasks WHERE id IN ($1, $2) AND project_id = $3',
          [parentId, childId, req.params.id]
        );
        const pTask = bothTasks.find(t => Number(t.id) === parentId);
        const cTask = bothTasks.find(t => Number(t.id) === childId);
        const glProjectId = issueTracker.trackerProjectId(tracker);
        if (glProjectId && pTask?.gitlab_iid && cTask?.gitlab_iid) {
          for (const [sourceIid, targetIid] of [[cTask.gitlab_iid, pTask.gitlab_iid], [pTask.gitlab_iid, cTask.gitlab_iid]]) {
            try {
              const links = await gitlab.getIssueLinks(glProjectId, sourceIid, opts);
              for (const link of links || []) {
                if (link.target?.iid === targetIid || link.issue?.iid === targetIid) {
                  await gitlab.deleteIssueLink(glProjectId, sourceIid, link.id, opts);
                }
              }
            } catch (linkErr) {
              console.error('Issue-Link löschen fehlgeschlagen:', linkErr.message);
            }
          }
        }
      }
    } catch (trackerErr) {
      console.error('Tracker-Link-Entfernung fehlgeschlagen:', trackerErr.message);
    }

    await taskHistory.logTaskChange(req.params.taskId, req.session.userId, 'updated', 'relation_removed', `Task #${req.params.targetTaskId}`, null);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// GET: Verfügbare Tasks für Relation-Auswahl (im selben Projekt, außer sich selbst)
router.get('/:id/tasks/:taskId/relation-candidates', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, status, issue_type, gitlab_iid
       FROM tasks
       WHERE project_id = $1 AND id != $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.params.id, req.params.taskId]
    );
    res.json({ tasks: rows });
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
    const customFieldDefs = await customFields.getProjectFieldDefinitions(req.params.id);
    // #74: Relationen laden
    const [parent, children, related, childrenProgress] = await Promise.all([
      taskRelations.getParent(req.params.taskId),
      taskRelations.getChildren(req.params.taskId),
      taskRelations.getRelatedTasks(req.params.taskId),
      taskRelations.getChildrenProgress(req.params.taskId),
    ]);
    res.json({
      task: { ...task, subtask_count: progress.total, subtask_done: progress.done },
      comments,
      history,
      subtasks,
      watchers,
      watching,
      customFieldDefs,
      parent,
      children,
      related,
      childrenProgress,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});



// ===== Issue #77/#78: Unified Tracker API (GitLab/GitHub) =====

// GET: Tracker-Info eines Projekts
router.get('/:id/tracker', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const tracker = await issueTracker.getProjectTracker(req.params.id);
    if (!tracker) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    res.json({
      type: tracker.issue_tracker_type || 'none',
      gitlab_project_id: tracker.gitlab_project_id,
      github_repo: tracker.github_repo,
      configured: !!issueTracker.trackerProjectId(tracker),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// POST: Sync Issues vom externen Tracker
router.post('/:id/tracker/sync', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const tracker = await issueTracker.getProjectTracker(req.params.id);
    if (!tracker || !issueTracker.trackerProjectId(tracker)) {
      return res.status(400).json({ error: 'Projekt ist nicht mit einem externen Tracker verknüpft' });
    }
    const issues = await issueTracker.syncIssues(tracker);
    res.json({ issues });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// GET: Suche nach Projekten/Repos im externen Tracker (#78)
router.get('/:id/tracker/search', loadProjectRole, requireProjectPermission('edit_project'), async (req, res) => {
  try {
    const tracker = await issueTracker.getProjectTracker(req.params.id);
    if (!tracker) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    const type = tracker.issue_tracker_type || 'none';
    if (type === 'none') {
      return res.json({ projects: [], type: 'none' });
    }
    const search = req.query.q || '';
    const projects = await issueTracker.searchProjects(type, search);
    res.json({ projects, type });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// ===== Issue #82: Pro-Projekt Tracker-Settings =====

// GET: Project-spezifische Tracker-Settings
router.get('/:id/tracker/settings', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const tracker = await issueTracker.getProjectTracker(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const type = tracker.issue_tracker_type || 'none';
    const settings = await issueTracker.getProjectTrackerSettings(req.params.id, type);
    res.json({
      type,
      has_project_settings: !!settings,
      base_url: settings ? settings.base_url : null,
      service_account_username: settings ? settings.service_account_username : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// PUT: Project-spezifische Tracker-Settings speichern
router.put('/:id/tracker/settings', loadProjectRole, requireProjectPermission('edit_project'), async (req, res) => {
  const { base_url, access_token, service_account_username } = req.body;
  if (!base_url || !access_token) {
    return res.status(400).json({ error: 'base_url und access_token sind erforderlich' });
  }
  try {
    const tracker = await issueTracker.getProjectTracker(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const type = tracker.issue_tracker_type;
    if (type === 'gitlab') {
      await issueTracker.saveProjectGitLabSettings(req.params.id, { base_url, access_token, service_account_username });
    } else if (type === 'github') {
      await issueTracker.saveProjectGitHubSettings(req.params.id, { base_url, access_token, service_account_username });
    } else {
      return res.status(400).json({ error: 'Projekt hat keinen Tracker-Typ' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// DELETE: Project-spezifische Settings löschen (fällt auf global zurück)
router.delete('/:id/tracker/settings', loadProjectRole, requireProjectPermission('edit_project'), async (req, res) => {
  try {
    const tracker = await issueTracker.getProjectTracker(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    await issueTracker.deleteProjectTrackerSettings(req.params.id, tracker.issue_tracker_type);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// #96 Fix: Verbindungstest MIT projekt-spezifischen Settings (falls vorhanden)
router.post('/:id/tracker/settings/test', loadProjectRole, requireProjectPermission('edit_project'), async (req, res) => {
  try {
    const tracker = await issueTracker.getProjectTracker(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const type = tracker.issue_tracker_type || 'none';
    const projectSettings = issueTracker.getEffectiveSettings
      ? issueTracker.getEffectiveSettings(tracker)
      : null;
    const opts = { projectSettings };
    if (type === 'gitlab') {
      const user = await gitlab.gitlabRequest('/user', opts);
      return res.json({ ok: true, service: 'gitlab', user: { id: user.id, username: user.username, name: user.name }, used_project_settings: !!projectSettings });
    }
    if (type === 'github') {
      const user = await github.testConnection(opts);
      return res.json({ ok: true, service: 'github', user, used_project_settings: !!projectSettings });
    }
    return res.status(400).json({ ok: false, error: 'Projekt hat keinen Tracker-Typ' });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});

// ===== Issue #71: Custom Fields pro Projekt =====

// GET: Alle Custom-Field-Definitionen mit Aktivierungsstatus für dieses Projekt
router.get('/:id/custom-fields', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const definitions = await customFields.getProjectFieldDefinitionsWithStatus(req.params.id);
    res.json({ definitions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// PUT: Custom Fields für dieses Projekt aktivieren/deaktivieren (nur PM/Admin)
router.put('/:id/custom-fields', loadProjectRole, requireProjectPermission('edit_project'), async (req, res) => {
  const { fields } = req.body;
  if (!Array.isArray(fields)) {
    return res.status(400).json({ error: 'fields muss ein Array sein' });
  }
  for (const f of fields) {
    if (!Number.isInteger(Number(f.field_definition_id))) {
      return res.status(400).json({ error: 'Ungültige field_definition_id' });
    }
    if (typeof f.is_enabled !== 'boolean') {
      return res.status(400).json({ error: 'is_enabled muss ein Boolean sein' });
    }
  }
  try {
    await customFields.setProjectFields(req.params.id, fields);
    const definitions = await customFields.getProjectFieldDefinitionsWithStatus(req.params.id);
    res.json({ definitions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// GET: Nur die aktiven Custom-Field-Definitionen für dieses Projekt (für Task-Formular)
router.get('/:id/custom-fields/active', loadProjectRole, requireProjectPermission('view_project'), async (req, res) => {
  try {
    const definitions = await customFields.getProjectFieldDefinitions(req.params.id);
    res.json({ definitions });
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
