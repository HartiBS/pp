const db = require('../config/database');

const PERMISSIONS = {
  'view_project':    ['admin', 'projektmanager', 'entwickler', 'beobachter'],
  'edit_project':    ['admin', 'projektmanager'],
  'delete_project':  ['admin', 'projektmanager'],
  'manage_members':  ['admin', 'projektmanager'],
  'create_task':     ['admin', 'projektmanager', 'entwickler'],
  'edit_task':       ['admin', 'projektmanager', 'entwickler'],
  'delete_task':     ['admin', 'projektmanager'],
};

const PROJECT_ROLES = ['projektmanager', 'entwickler', 'beobachter'];

async function getProjectRole(user, projectId) {
  if (!user) return null;
  if (user.roles && user.roles.includes('admin')) return 'admin';
  if (user.role === 'admin') return 'admin';

  const { rows } = await db.query(
    `SELECT CASE WHEN p.owner_id = $1 THEN 'projektmanager' ELSE pm.role END AS role
     FROM projects p
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
     WHERE p.id = $2`,
    [user.id, projectId]
  );
  return rows.length ? rows[0].role : null;
}

async function loadProjectRole(req, res, next) {
  const projectId = req.params.id || req.params.projectId;
  if (!projectId) return next();
  try {
    req.projectRole = await getProjectRole(req.currentUser, projectId);
    if (!req.projectRole) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// #39: Die Berechtigungs-Matrix wird in der DB (role_permissions) verwaltet und
// hier durchgesetzt. Fällt auf die hartkodierten Defaults zurück, wenn für eine
// Rolle kein DB-Eintrag existiert (z. B. vor Migration 009).
const FALLBACK_PERMISSIONS = PERMISSIONS;

async function getPermissionMatrix() {
  const { rows } = await db.query('SELECT role, permission FROM role_permissions');
  const matrix = {};
  for (const row of rows) {
    if (!matrix[row.role]) matrix[row.role] = [];
    matrix[row.role].push(row.permission);
  }
  for (const role of Object.keys(FALLBACK_PERMISSIONS)) {
    if (!matrix[role]) matrix[role] = FALLBACK_PERMISSIONS[role];
  }
  return matrix;
}

function requireProjectPermission(permission) {
  return async (req, res, next) => {
    try {
      const matrix = await getPermissionMatrix();
      const allowed = matrix[req.projectRole] || [];
      if (!req.projectRole || !allowed.includes(permission)) {
        return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { PERMISSIONS, PROJECT_ROLES, getProjectRole, loadProjectRole, requireProjectPermission, getPermissionMatrix };
