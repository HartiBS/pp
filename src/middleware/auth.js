const db = require('../config/database');

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
      'SELECT id, email, name, role, is_active FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (rows.length === 0 || !rows[0].is_active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Account nicht verfügbar' });
    }
    req.currentUser = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.currentUser || !roles.includes(req.currentUser.role)) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, loadUser };
