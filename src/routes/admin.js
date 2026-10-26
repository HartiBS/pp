const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ROLES = ['admin', 'projektmanager', 'entwickler', 'beobachter'];
const USER_FIELDS = 'id, email, name, role, is_active, created_at';

router.use(requireAuth, requireRole('admin'));

router.get('/users', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ${USER_FIELDS} FROM users ORDER BY created_at ASC`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/users', async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'E-Mail, Passwort und Name sind erforderlich' });
  }
  if (role && !ROLES.includes(role)) {
    return res.status(400).json({ error: `Ungültige Rolle. Erlaubt: ${ROLES.join(', ')}` });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING ${USER_FIELDS}`,
      [email, hash, name, role || 'entwickler']
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'E-Mail bereits registriert' });
    }
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/users/:id', async (req, res) => {
  const { name, email, role, is_active, password } = req.body;

  if (role && !ROLES.includes(role)) {
    return res.status(400).json({ error: `Ungültige Rolle. Erlaubt: ${ROLES.join(', ')}` });
  }
  if (req.params.id === String(req.currentUser.id) && is_active === false) {
    return res.status(400).json({ error: 'Der eigene Account kann nicht deaktiviert werden' });
  }
  if (req.params.id === String(req.currentUser.id) && role && role !== 'admin') {
    return res.status(400).json({ error: 'Die eigene Admin-Rolle kann nicht entzogen werden' });
  }

  try {
    const updates = [];
    const params = [];
    if (name) { params.push(name); updates.push(`name = $${params.length}`); }
    if (email) { params.push(email); updates.push(`email = $${params.length}`); }
    if (role) { params.push(role); updates.push(`role = $${params.length}`); }
    if (is_active !== undefined) { params.push(is_active); updates.push(`is_active = $${params.length}`); }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      params.push(hash);
      updates.push(`password_hash = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine Änderungen angegeben' });
    }

    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING ${USER_FIELDS}`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }
    res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
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

router.get('/roles', (req, res) => {
  res.json({ roles: ROLES });
});

module.exports = router;
