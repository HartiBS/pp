const db = require('../config/database');

const VALID_RELATION_TYPES = ['parent_child', 'relates_to'];

/**
 * Prüft, ob eine Relation einen Zyklus erzeugen würde.
 * Folge der Parent-Kette von `childTaskId` nach oben — wenn `parentTaskId`
 * darin vorkommt, wäre es ein Zyklus.
 */
async function wouldCreateCycle(parentTaskId, childTaskId, relationType = 'parent_child') {
  if (Number(parentTaskId) === Number(childTaskId)) return true; // Selbst-Referenz
  if (relationType !== 'parent_child') return false; // relates_to erlaubt Zyklen

  // Folge parent-Kette von childTaskId nach oben
  let currentId = Number(childTaskId);
  const visited = new Set([currentId]);
  for (let i = 0; i < 100; i++) { // Max 100 Ebenen tief
    const { rows } = await db.query(
      `SELECT parent_task_id FROM task_relations
       WHERE child_task_id = $1 AND relation_type = 'parent_child'`,
      [currentId]
    );
    if (rows.length === 0) return false; // Kette endet, kein Zyklus
    const nextId = Number(rows[0].parent_task_id);
    if (nextId === Number(parentTaskId)) return true; // Zyklus gefunden
    if (visited.has(nextId)) return true; // Sicherheitsnetz
    visited.add(nextId);
    currentId = nextId;
  }
  return true; // Zu tief — lieber ablehnen
}

/**
 * Erstellt eine Relation zwischen zwei Tasks.
 */
async function createRelation(parentTaskId, childTaskId, relationType = 'parent_child') {
  if (!VALID_RELATION_TYPES.includes(relationType)) {
    const err = new Error(`Ungültiger Relation-Typ: ${relationType}`);
    err.status = 400;
    throw err;
  }
  if (Number(parentTaskId) === Number(childTaskId)) {
    const err = new Error('Ein Task kann nicht mit sich selbst verknüpft werden');
    err.status = 400;
    throw err;
  }

  // Prüfe, ob beide Tasks im selben Projekt sind
  const projectCheck = await db.query(
    `SELECT
       (SELECT project_id FROM tasks WHERE id = $1) AS parent_project,
       (SELECT project_id FROM tasks WHERE id = $2) AS child_project`,
    [parentTaskId, childTaskId]
  );
  if (projectCheck.rows.length === 0 ||
      !projectCheck.rows[0].parent_project ||
      !projectCheck.rows[0].child_project ||
      Number(projectCheck.rows[0].parent_project) !== Number(projectCheck.rows[0].child_project)) {
    const err = new Error('Beide Tasks müssen im selben Projekt sein');
    err.status = 400;
    throw err;
  }

  // Zyklus-Prüfung
  if (await wouldCreateCycle(parentTaskId, childTaskId, relationType)) {
    const err = new Error('Diese Relation würde einen Zyklus erzeugen');
    err.status = 400;
    throw err;
  }

  const { rows } = await db.query(
    `INSERT INTO task_relations (parent_task_id, child_task_id, relation_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (parent_task_id, child_task_id, relation_type) DO NOTHING
     RETURNING *`,
    [parentTaskId, childTaskId, relationType]
  );
  return rows[0] || null;
}

/**
 * Löscht eine Relation.
 */
async function deleteRelation(parentTaskId, childTaskId, relationType = 'parent_child') {
  const { rowCount } = await db.query(
    `DELETE FROM task_relations
     WHERE parent_task_id = $1 AND child_task_id = $2 AND relation_type = $3`,
    [parentTaskId, childTaskId, relationType]
  );
  return rowCount > 0;
}

/**
 * Holt alle Relationen eines Tasks (als Parent und als Child).
 */
async function getTaskRelations(taskId) {
  const { rows } = await db.query(
    `SELECT tr.*,
            pt.title AS parent_title, pt.status AS parent_status, pt.gitlab_iid AS parent_gitlab_iid,
            ct.title AS child_title, ct.status AS child_status, ct.gitlab_iid AS child_gitlab_iid
     FROM task_relations tr
     JOIN tasks pt ON pt.id = tr.parent_task_id
     JOIN tasks ct ON ct.id = tr.child_task_id
     WHERE tr.parent_task_id = $1 OR tr.child_task_id = $1
     ORDER BY tr.created_at ASC`,
    [taskId]
  );
  return rows;
}

/**
 * Holt den Parent eines Tasks (relation_type = 'parent_child').
 */
async function getParent(taskId) {
  const { rows } = await db.query(
    `SELECT t.id, t.title, t.status, t.issue_type, t.gitlab_iid, t.priority
     FROM task_relations tr
     JOIN tasks t ON t.id = tr.parent_task_id
     WHERE tr.child_task_id = $1 AND tr.relation_type = 'parent_child'`,
    [taskId]
  );
  return rows[0] || null;
}

/**
 * Holt alle Children eines Tasks (relation_type = 'parent_child').
 */
async function getChildren(taskId) {
  const { rows } = await db.query(
    `SELECT t.id, t.title, t.status, t.issue_type, t.gitlab_iid, t.priority,
            t.due_date, t.assignee_id, u.name AS assignee_name,
            (SELECT COUNT(*) FROM task_subtasks s WHERE s.task_id = t.id AND s.is_done = TRUE)::int AS subtasks_done,
            (SELECT COUNT(*) FROM task_subtasks s WHERE s.task_id = t.id)::int AS subtasks_total
     FROM task_relations tr
     JOIN tasks t ON t.id = tr.child_task_id
     LEFT JOIN users u ON u.id = t.assignee_id
     WHERE tr.parent_task_id = $1 AND tr.relation_type = 'parent_child'
     ORDER BY t.created_at ASC`,
    [taskId]
  );
  return rows;
}

/**
 * Holt alle 'relates_to' Verknüpfungen eines Tasks.
 */
async function getRelatedTasks(taskId) {
  const { rows } = await db.query(
    `SELECT t.id, t.title, t.status, t.issue_type, t.gitlab_iid,
            CASE WHEN tr.parent_task_id = $1 THEN 'child' ELSE 'parent' END AS direction
     FROM task_relations tr
     JOIN tasks t ON t.id = CASE WHEN tr.parent_task_id = $1 THEN tr.child_task_id ELSE tr.parent_task_id END
     WHERE (tr.parent_task_id = $1 OR tr.child_task_id = $1) AND tr.relation_type = 'relates_to'
     ORDER BY t.created_at ASC`,
    [taskId]
  );
  return rows;
}

/**
 * Holt die gesamte Parent-Kette eines Tasks (von direkt bis root).
 */
async function getParentChain(taskId) {
  const chain = [];
  let currentId = Number(taskId);
  const visited = new Set([currentId]);
  for (let i = 0; i < 50; i++) {
    const parent = await getParent(currentId);
    if (!parent) break;
    chain.push(parent);
    if (visited.has(parent.id)) break;
    visited.add(parent.id);
    currentId = parent.id;
  }
  return chain;
}

/**
 * Aggregierter Fortschritt aller Children (z.B. für Fortschrittsbalken).
 */
async function getChildrenProgress(taskId) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE t.status = 'done')::int AS done
     FROM task_relations tr
     JOIN tasks t ON t.id = tr.child_task_id
     WHERE tr.parent_task_id = $1 AND tr.relation_type = 'parent_child'`,
    [taskId]
  );
  const total = rows[0]?.total || 0;
  const done = rows[0]?.done || 0;
  return { total, done, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/**
 * #74: Stellt Relationen aus dem Markdown-Meta-Block wieder her (Pull-Richtung).
 * Erzeugt fehlende Relationen (best effort), Zyklus-Prüfung greift dabei.
 * @param {number} taskId - Lokaler Task, dessen Meta-Block geparst wurde
 * @param {object} meta - Geparstes pp-meta (enthält parent/children/related)
 * @param {number} projectId - Projekt-ID (für Same-Project-Prüfung)
 */
async function restoreFromMeta(taskId, meta, projectId) {
  if (!meta || typeof meta !== 'object') return;
  const candidates = [];
  if (meta.parent && meta.parent.id) {
    candidates.push({ parentId: Number(meta.parent.id), childId: Number(taskId), type: 'parent_child' });
  }
  if (Array.isArray(meta.children)) {
    for (const c of meta.children) {
      if (c && c.id) candidates.push({ parentId: Number(taskId), childId: Number(c.id), type: 'parent_child' });
    }
  }
  if (Array.isArray(meta.related)) {
    for (const r of meta.related) {
      if (!r || !r.id) continue;
      const other = Number(r.id);
      const parentId = r.direction === 'parent' ? other : Number(taskId);
      const childId = r.direction === 'parent' ? Number(taskId) : other;
      candidates.push({ parentId, childId, type: 'relates_to' });
    }
  }
  for (const c of candidates) {
    try {
      await createRelation(c.parentId, c.childId, c.type);
    } catch {
      // Relation existiert bereits, ist Zyklus oder Tasks nicht im selben Projekt — ignorieren
    }
  }
}

module.exports = {
  VALID_RELATION_TYPES,
  createRelation,
  deleteRelation,
  getTaskRelations,
  getParent,
  getChildren,
  getRelatedTasks,
  getParentChain,
  getChildrenProgress,
  wouldCreateCycle,
  restoreFromMeta,
};
