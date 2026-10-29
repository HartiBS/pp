const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const gitlab = require('../utils/gitlab');
const github = require('../utils/github');

const router = express.Router();

router.use(requireAuth);

/**
 * Zentrale Sync-Einstellungen-Seite.
 * Zeigt den Status aller Sync-Verbindungen (GitLab + GitHub global)
 * und erlaubt Admins, diese zu konfigurieren und zu testen.
 */

// GET: Übersicht aller Sync-Einstellungen (für alle eingeloggten User lesbar,
//      aber nur Admins sehen Tokens/Details)
router.get('/status', async (req, res) => {
  try {
    const isAdmin = (req.currentUser.roles || []).includes('admin');
    const [glSettings, ghSettings] = await Promise.all([
      gitlab.getSettings(),
      github.getSettings(),
    ]);
    res.json({
      gitlab: {
        configured: !!glSettings,
        base_url: glSettings ? glSettings.base_url : (process.env.GITLAB_URL || null),
        service_account_username: glSettings ? glSettings.service_account_username : null,
        has_token: !!glSettings,
      },
      github: {
        configured: !!ghSettings,
        base_url: ghSettings ? ghSettings.base_url : 'https://api.github.com',
        service_account_username: ghSettings ? ghSettings.service_account_username : null,
        has_token: !!ghSettings,
      },
      is_admin: isAdmin,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// POST: GitLab-Verbindung testen
router.post('/test/gitlab', requireRole('admin'), async (req, res) => {
  try {
    const user = await gitlab.gitlabRequest('/user');
    res.json({ ok: true, service: 'gitlab', user: { id: user.id, username: user.username, name: user.name } });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, service: 'gitlab', error: err.message });
  }
});

// POST: GitHub-Verbindung testen
router.post('/test/github', requireRole('admin'), async (req, res) => {
  try {
    const user = await github.testConnection();
    res.json({ ok: true, service: 'github', user });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, service: 'github', error: err.message });
  }
});

module.exports = router;
