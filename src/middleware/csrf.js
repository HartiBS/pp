const crypto = require('crypto');

function generateCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  next();
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  const sessionToken = req.session.csrfToken;
  const headerToken = req.get('X-CSRF-Token');
  const bodyToken = req.body && req.body._csrf;

  function safeEqual(a, b) {
    if (!a || !b) return false;
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  const valid = !!sessionToken && (safeEqual(headerToken, sessionToken) || safeEqual(bodyToken, sessionToken));

  if (!valid) {
    return res.status(403).json({ error: 'Ungültiges oder fehlendes CSRF-Token' });
  }
  next();
}

module.exports = { generateCsrfToken, requireCsrf };
