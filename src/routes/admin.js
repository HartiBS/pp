const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const roles = require('../utils/roles');
const customFields = require('../utils/customFields');

const router = express.Router();

const USER_FIELDS = 'id, email, username, first_name, last_name, name, is_active, created_at';

router.use(requireAuth, requireRole('admin'));

async function attachRoles(users) {
  const result = [];
  for (const u of users) {
    result.push({
      ...u,
      roles: await roles.getUserRoles(u.id),
      role: roles.effectiveRole(await roles.getUserRoles(u.id)),
    });
  }
  return result;
}

router.get('/users', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ${USER_FIELDS} FROM users ORDER BY created_at ASC`
    );
    res.json({ users: await attachRoles(rows) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/users', async (req, res) => {
  const { email, password, firstName, lastName, username, roles: userRoles } = req.body;
  const roleList = Array.isArray(userRoles) ? userRoles : (req.body.role ? [req.body.role] : []);
  // #54: Beim Anlegen durch den Admin reichen Username, Passwort und Rolle.
  // E-Mail/Vorname/Nachname sind optional (Login geht dann nur per Benutzername).
  if (!username || !password || roleList.length === 0) {
    return res.status(400).json({ error: 'Benutzername, Passwort und mindestens eine Rolle sind erforderlich' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });
  }
  if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) {
    return res.status(400).json({ error: 'Benutzername: 3-50 Zeichen (Buchstaben, Zahlen, _ . -)' });
  }
  const invalid = roleList.filter(r => !roles.ALL_ROLES.includes(r));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Ungültige Rolle(n): ${invalid.join(', ')}. Erlaubt: ${roles.ALL_ROLES.join(', ')}` });
  }
  const name = [firstName, lastName].filter(Boolean).join(' ') || username;

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, name, first_name, last_name, username, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${USER_FIELDS}`,
      [email || null, hash, name, firstName || null, lastName || null, username, roles.effectiveRole(roleList)]
    );
    await roles.setUserRoles(rows[0].id, roleList);
    const user = { ...rows[0], roles: roleList, role: roles.effectiveRole(roleList) };
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === '23505') {
      const detail = err.constraint || '';
      if (detail.includes('username')) {
        return res.status(409).json({ error: 'Benutzername bereits vergeben' });
      }
      return res.status(409).json({ error: 'E-Mail bereits vergeben' });
    }
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/users/:id', async (req, res) => {
  const { firstName, lastName, username, email, is_active, password } = req.body;
  const roleList = Array.isArray(req.body.roles) ? req.body.roles : (req.body.role ? [req.body.role] : undefined);

  if (roleList) {
    const invalid = roleList.filter(r => !roles.ALL_ROLES.includes(r));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Ungültige Rolle(n): ${invalid.join(', ')}. Erlaubt: ${roles.ALL_ROLES.join(', ')}` });
    }
    if (roleList.length === 0) {
      return res.status(400).json({ error: 'Mindestens eine Rolle muss zugewiesen bleiben' });
    }
  }
  if (username && !/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) {
    return res.status(400).json({ error: 'Benutzername: 3-50 Zeichen (Buchstaben, Zahlen, _ . -)' });
  }
  if (req.params.id === String(req.currentUser.id) && is_active === false) {
    return res.status(400).json({ error: 'Der eigene Account kann nicht deaktiviert werden' });
  }
  if (req.params.id === String(req.currentUser.id) && roleList && !roleList.includes('admin')) {
    return res.status(400).json({ error: 'Die eigene Admin-Rolle kann nicht entzogen werden' });
  }

  try {
    const { rows: currentRows } = await db.query(
      'SELECT first_name, last_name FROM users WHERE id = $1', [req.params.id]
    );
    if (currentRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }

    const updates = [];
    const params = [];
    if (firstName) { params.push(firstName); updates.push(`first_name = $${params.length}`); }
    if (lastName !== undefined) { params.push(lastName || null); updates.push(`last_name = $${params.length}`); }
    if (username) { params.push(username); updates.push(`username = $${params.length}`); }
    if (email) { params.push(email); updates.push(`email = $${params.length}`); }
    if (firstName || lastName !== undefined) {
      const fullName = [firstName || currentRows[0].first_name, lastName !== undefined ? (lastName || null) : currentRows[0].last_name]
        .filter(Boolean).join(' ');
      params.push(fullName);
      updates.push(`name = $${params.length}`);
    }
    if (is_active !== undefined) { params.push(is_active); updates.push(`is_active = $${params.length}`); }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      params.push(hash);
      updates.push(`password_hash = $${params.length}`);
    }

    let user = null;
    if (updates.length > 0) {
      params.push(req.params.id);
      const { rows } = await db.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING ${USER_FIELDS}`,
        params
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Benutzer nicht gefunden' });
      }
      user = rows[0];
    } else {
      const { rows } = await db.query(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [req.params.id]);
      user = rows[0];
    }

    if (roleList) {
      const saved = await roles.setUserRoles(req.params.id, roleList);
      const eff = roles.effectiveRole(saved);
      await db.query('UPDATE users SET role = $1 WHERE id = $2', [eff, req.params.id]);
      user = { ...user, role: eff };
      res.json({ user: { ...user, roles: saved } });
      return;
    }

    const userRoles = await roles.getUserRoles(req.params.id);
    res.json({ user: { ...user, roles: userRoles, role: roles.effectiveRole(userRoles) } });
  } catch (err) {
    if (err.code === '23505') {
      const detail = err.constraint || '';
      if (detail.includes('username')) {
        return res.status(409).json({ error: 'Benutzername bereits vergeben' });
      }
      return res.status(409).json({ error: 'E-Mail bereits vergeben' });
    }
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/users/:id', async (req, res) => {
  if (req.params.id === String(req.currentUser.id)) {
    return res.status(400).json({ error: 'Der eigene Account kann nicht gelöscht werden' });
  }
  try {
    const { rowCount } = await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.get('/roles', async (req, res) => {
  res.json({ roles: roles.ALL_ROLES, permissions: roles.PERMISSIONS });
});

router.get('/permissions-matrix', async (req, res) => {
  try {
    res.json({ matrix: await roles.getRolePermissions(), permissions: roles.PERMISSIONS, roles: roles.ALL_ROLES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/permissions-matrix/:role', async (req, res) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions muss ein Array sein' });
  }
  try {
    const saved = await roles.setRolePermissions(req.params.role, permissions);
    res.json({ role: req.params.role, permissions: saved });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ===== Issue #71: Custom Field Definitions (Admin) =====

router.get('/custom-fields', async (req, res) => {
  try {
    const definitions = await customFields.getAllDefinitions();
    res.json({ definitions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/custom-fields', async (req, res) => {
  const { name, field_type, options, is_required } = req.body;
  const validation = customFields.validateFieldDefinition({
    name,
    field_type: field_type || 'text',
    options: Array.isArray(options) ? options : [],
    is_required: is_required || false,
  });
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  try {
    const def = await customFields.createDefinition({
      name, field_type: field_type || 'text', options, is_required: is_required || false,
    });
    res.status(201).json({ definition: def });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/custom-fields/:id', async (req, res) => {
  const { name, field_type, options, is_required } = req.body;
  if (field_type !== undefined && !customFields.VALID_FIELD_TYPES.includes(field_type)) {
    return res.status(400).json({ error: `Ungültiger Feldtyp. Erlaubt: ${customFields.VALID_FIELD_TYPES.join(', ')}` });
  }
  if (field_type === 'dropdown' && options !== undefined && (!Array.isArray(options) || options.length === 0)) {
    return res.status(400).json({ error: 'Dropdown-Felder benötigen mindestens eine Option' });
  }
  try {
    const updated = await customFields.updateDefinition(req.params.id, { name, field_type, options, is_required });
    if (!updated) {
      return res.status(404).json({ error: 'Custom Field nicht gefunden' });
    }
    res.json({ definition: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/custom-fields/:id', async (req, res) => {
  try {
    const deleted = await customFields.deleteDefinition(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Custom Field nicht gefunden' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ===== Issue #81: Admin-Projektverwaltung =====

router.get('/projects', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, u.name AS owner_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
              (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
              (SELECT COUNT(*) FROM project_gitlab_settings pgs WHERE pgs.project_id = p.id) AS has_gitlab_settings,
              (SELECT COUNT(*) FROM project_github_settings pghs WHERE pghs.project_id = p.id) AS has_github_settings
       FROM projects p
       JOIN users u ON u.id = p.owner_id
       ORDER BY p.updated_at DESC`
    );
    res.json({ projects: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/projects/:id', async (req, res) => {
  const { name, description, status, owner_id, issue_tracker_type, gitlab_project_id, github_repo } = req.body;
  try {
    // Validate status
    if (status !== undefined && !['active', 'paused', 'done', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Ungültiger Status' });
    }
    // Validate owner exists and is active
    if (owner_id !== undefined) {
      const ownerCheck = await db.query('SELECT id FROM users WHERE id = $1 AND is_active = TRUE', [owner_id]);
      if (ownerCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Owner nicht gefunden oder deaktiviert' });
      }
    }
    // #91/#96: Tracker-Typ validieren
    if (issue_tracker_type !== undefined && !['none', 'gitlab', 'github'].includes(issue_tracker_type)) {
      return res.status(400).json({ error: 'Ungültiger Tracker-Typ' });
    }
    const { rows } = await db.query(
      `UPDATE projects
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           owner_id = COALESCE($4, owner_id),
           issue_tracker_type = COALESCE($5, issue_tracker_type),
           gitlab_project_id = COALESCE($6, gitlab_project_id),
           github_repo = COALESCE($7, github_repo),
           updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [name, description, status, owner_id, issue_tracker_type, gitlab_project_id, github_repo, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    res.json({ project: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.delete('/projects/:id', async (req, res) => {
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

// GET: Alle aktiven User für Owner-Auswahl
router.get('/projects-users', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, username, email FROM users WHERE is_active = TRUE ORDER BY name ASC'
    );
    res.json({ users: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});


// ===== Issue #90: Projektverwaltung für Projektmanager (nur eigene Projekte) =====
router.get('/my-projects', requireRole('admin', 'projektmanager'), async (req, res) => {
  try {
    const isAdmin = req.currentUser.roles.includes('admin');
    let rows;
    if (isAdmin) {
      const result = await db.query(
        `SELECT p.*, u.name AS owner_name,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
                (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
                (SELECT COUNT(*) FROM project_gitlab_settings pgs WHERE pgs.project_id = p.id) AS has_gitlab_settings,
                (SELECT COUNT(*) FROM project_github_settings pghs WHERE pghs.project_id = p.id) AS has_github_settings
         FROM projects p
         JOIN users u ON u.id = p.owner_id
         ORDER BY p.updated_at DESC`
      );
      rows = result.rows;
    } else {
      const result = await db.query(
        `SELECT p.*, u.name AS owner_name,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
                (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
                (SELECT COUNT(*) FROM project_gitlab_settings pgs WHERE pgs.project_id = p.id) AS has_gitlab_settings,
                (SELECT COUNT(*) FROM project_github_settings pghs WHERE pghs.project_id = p.id) AS has_github_settings
         FROM projects p
         JOIN users u ON u.id = p.owner_id
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
         WHERE p.owner_id = $1 OR (pm.role = 'projektmanager')
         ORDER BY p.updated_at DESC`,
        [req.session.userId]
      );
      rows = result.rows;
    }
    res.json({ projects: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

module.exports = router;
