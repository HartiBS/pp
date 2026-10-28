const db = require('../config/database');
const { getUserRoles, getUserPermissions, effectiveRole } = require('../utils/roles');

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.accepts('html')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Nicht eingeloggt' });
  }
  next();
}

async function loadUser(req, res, next) {
  if (!req.session.userId) return next();
  try {
    const { rows } = await db.query(
      'SELECT id, email, username, first_name, last_name, name, is_active FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (rows.length === 0 || !rows[0].is_active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Account nicht verfügbar' });
    }
    const user = rows[0];
    user.roles = await getUserRoles(user.id);
    user.role = effectiveRole(user.roles);
    user.permissions = await getUserPermissions(user.id);
    req.currentUser = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.currentUser || !req.currentUser.roles || !req.currentUser.roles.some(r => roles.includes(r))) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
    next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.currentUser || !req.currentUser.permissions || !req.currentUser.permissions.includes(permission)) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requirePermission, loadUser };
