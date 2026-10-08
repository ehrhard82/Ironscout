// POST /api/auth/signup   { email, password, name }
// POST /api/auth/login    { email, password }
// POST /api/auth/logout
// GET  /api/auth/me
// POST /api/auth/forgot   { email }          -> emails a reset link
// POST /api/auth/reset    { token, password }
// POST /api/auth/password { current, next }  -> change password while logged in
const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../lib/db');
const auth = require('../lib/auth');
const mailer = require('../lib/mailer');

const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

router.post('/signup', auth.rateLimitLogin, async (req, res, next) => {
  try {
    const { email, password, name } = req.body || {};
    if (!auth.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (!auth.validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const clean = email.trim().toLowerCase();
    const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [clean]);
    if (exists.rows.length) return res.status(409).json({ error: 'An account with that email already exists' });

    // First account ever becomes admin so you can get in without a seed script.
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    const role = count.rows[0].n === 0 ? 'admin' : 'subscriber';

    const r = await pool.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4)
       RETURNING id, email, name, role, subscription_status`,
      [clean, auth.hashPassword(password), (name || '').trim().slice(0, 255) || null, role]);
    await auth.createSession(res, r.rows[0].id);
    res.status(201).json({ ...r.rows[0], has_access: auth.hasAccess(r.rows[0]) });
  } catch (e) { next(e); }
});

router.post('/login', auth.rateLimitLogin, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const r = await pool.query(
      `SELECT id, email, name, role, password_hash, subscription_status, subscription_ends_at
       FROM users WHERE email = $1`, [String(email || '').trim().toLowerCase()]);
    const u = r.rows[0];
    if (!u || !auth.verifyPassword(String(password || ''), u.password_hash)) {
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    await auth.createSession(res, u.id);
    delete u.password_hash;
    res.json({ ...u, has_access: auth.hasAccess(u) });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try { await auth.destroySession(req, res); res.json({ ok: true }); } catch (e) { next(e); }
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in', login: true });
  res.json(req.user);
});

router.post('/forgot', auth.rateLimitLogin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const r = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
    if (r.rows.length) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `UPDATE users SET reset_token = $1, reset_expires = NOW() + interval '1 hour' WHERE id = $2`,
        [token, r.rows[0].id]);
      await mailer.send({
        to: email, subject: 'Reset your IronScout password',
        text: `Someone (hopefully you) asked to reset the password for ${email}.\n\nReset it here (link is good for 1 hour):\n${APP_URL()}/reset.html?token=${token}\n\nIf you didn't ask for this, ignore this email.`,
      });
    }
    // Same response whether or not the account exists (don't leak who has accounts)
    res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  } catch (e) { next(e); }
});

router.post('/reset', auth.rateLimitLogin, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!auth.validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const r = await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL
       WHERE reset_token = $2 AND reset_expires > NOW() RETURNING id`,
      [auth.hashPassword(password), String(token || '')]);
    if (!r.rows.length) return res.status(400).json({ error: 'That reset link is invalid or has expired' });
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id]);   // log out everywhere
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/password', auth.requireLogin, async (req, res, next) => {
  try {
    const { current, next: nextPw } = req.body || {};
    if (!auth.validPassword(nextPw)) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!auth.verifyPassword(String(current || ''), r.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [auth.hashPassword(nextPw), req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
