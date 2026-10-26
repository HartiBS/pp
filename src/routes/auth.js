const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const USER_FIELDS = 'id, email, username, first_name, last_name, name, role, is_active, created_at';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,50}$/;

router.post('/register', async (req, res) => {
  const { email, password, firstName, lastName, username } = req.body;
  if (!email || !password || !firstName || !username) {
    return res.status(400).json({ error: 'E-Mail, Passwort, Vorname und Benutzername sind erforderlich' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Benutzername: 3-50 Zeichen (Buchstaben, Zahlen, _ . -)' });
  }
  const name = [firstName, lastName].filter(Boolean).join(' ');

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, name, first_name, last_name, username)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${USER_FIELDS}`,
      [email, hash, name, firstName, lastName || null, username]
    );
    req.session.userId = rows[0].id;
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      const detail = err.constraint || '';
      if (detail.includes('username')) {
        return res.status(409).json({ error: 'Benutzername bereits vergeben' });
      }
      return res.status(409).json({ error: 'E-Mail bereits registriert' });
    }
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Benutzername/E-Mail und Passwort sind erforderlich' });
  }

  try {
    const { rows } = await db.query(
      `SELECT * FROM users WHERE email = $1 OR username = $1`,
      [identifier]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Ungültige Zugangsdaten' });
    }
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Ungültige Zugangsdaten' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account ist deaktiviert' });
    }
    req.session.userId = user.id;
    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ${USER_FIELDS} FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Nicht eingeloggt' });
    }
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

router.put('/profile', requireAuth, async (req, res) => {
  const { firstName, lastName, username, email, currentPassword, newPassword } = req.body;

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const user = rows[0];

    if (username && username !== user.username && !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Benutzername: 3-50 Zeichen (Buchstaben, Zahlen, _ . -)' });
    }

    if (email && email !== user.email) {
      const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'E-Mail bereits vergeben' });
      }
    }

    if (username && username !== user.username) {
      const existing = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Benutzername bereits vergeben' });
      }
    }

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Aktuelles Passwort erforderlich' });
      }
      const ok = await bcrypt.compare(currentPassword, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
      }
    }

    const updates = [];
    const params = [];
    if (firstName) { params.push(firstName); updates.push(`first_name = $${params.length}`); }
    if (lastName !== undefined) { params.push(lastName || null); updates.push(`last_name = $${params.length}`); }
    if (username) { params.push(username); updates.push(`username = $${params.length}`); }
    if (email) { params.push(email); updates.push(`email = $${params.length}`); }
    if (firstName || lastName !== undefined) {
      const fullName = [firstName || user.first_name, lastName !== undefined ? (lastName || null) : user.last_name]
        .filter(Boolean).join(' ');
      params.push(fullName);
      updates.push(`name = $${params.length}`);
    }
    if (newPassword) {
      const hash = await bcrypt.hash(newPassword, 10);
      params.push(hash);
      updates.push(`password_hash = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine Änderungen angegeben' });
    }

    params.push(req.session.userId);
    const { rows: updated } = await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING ${USER_FIELDS}`,
      params
    );
    res.json({ user: updated[0] });
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

module.exports = router;
