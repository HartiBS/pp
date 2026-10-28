const db = require('../config/database');

const ALL_ROLES = ['admin', 'projektmanager', 'entwickler', 'beobachter'];

const ROLE_PRIORITY = ['admin', 'projektmanager', 'entwickler', 'beobachter'];

const PERMISSIONS = [
  'view_project',
  'edit_project',
  'delete_project',
  'manage_members',
  'create_task',
  'edit_task',
  'delete_task',
  'manage_users',
  'manage_settings',
];

function effectiveRole(roles) {
  if (!roles || roles.length === 0) return null;
  for (const r of ROLE_PRIORITY) {
    if (roles.includes(r)) return r;
  }
  return roles[0];
}

async function getUserRoles(userId) {
  const { rows } = await db.query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
  return rows.map(r => r.role);
}

async function setUserRoles(userId, roles) {
  const valid = (roles || []).filter(r => ALL_ROLES.includes(r));
  await db.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  for (const role of valid) {
    await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [userId, role]);
  }
  return valid;
}

async function getEffectiveRole(userId) {
  return effectiveRole(await getUserRoles(userId));
}

async function getRolePermissions() {
  const { rows } = await db.query('SELECT role, permission FROM role_permissions');
  const matrix = {};
  for (const role of ALL_ROLES) matrix[role] = [];
  for (const row of rows) {
    if (matrix[row.role]) matrix[row.role].push(row.permission);
  }
  return matrix;
}

async function setRolePermissions(role, permissions) {
  if (!ALL_ROLES.includes(role)) {
    const err = new Error('Ungültige Rolle');
    err.status = 400;
    throw err;
  }
  const valid = (permissions || []).filter(p => PERMISSIONS.includes(p));
  await db.query('DELETE FROM role_permissions WHERE role = $1', [role]);
  for (const perm of valid) {
    await db.query('INSERT INTO role_permissions (role, permission) VALUES ($1, $2)', [role, perm]);
  }
  return valid;
}

async function getUserPermissions(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT rp.permission
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role = ur.role
     WHERE ur.user_id = $1`,
    [userId]
  );
  return rows.map(r => r.permission);
}

async function userHasPermission(userId, permission) {
  const { rows } = await db.query(
    `SELECT 1 FROM user_roles ur
     JOIN role_permissions rp ON rp.role = ur.role AND rp.permission = $2
     WHERE ur.user_id = $1 LIMIT 1`,
    [userId, permission]
  );
  return rows.length > 0;
}

module.exports = {
  ALL_ROLES,
  ROLE_PRIORITY,
  PERMISSIONS,
  effectiveRole,
  getUserRoles,
  setUserRoles,
  getEffectiveRole,
  getRolePermissions,
  setRolePermissions,
  getUserPermissions,
  userHasPermission,
};
