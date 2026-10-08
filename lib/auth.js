// Authentication: password hashing, sessions, and route guards.
//
// Passwords are hashed with Node's built-in scrypt (no external crypto library to
// go stale). Sessions are random tokens stored in the DB and sent as an HttpOnly
// cookie; they expire after SESSION_DAYS (default 30).
//
// Roles:   admin      - you. Everything, including ingest controls and user management.
//          broker     - your broker. Deals + claim/sold workflow. No billing required.
//          subscriber - paying users. Deals, search, watchlists, alerts. Needs an
//                       active or trialing Stripe subscription (or the grace window).

const crypto = require('crypto');
const pool = require('./db');

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = 'ironscout_session';

// ---- passwords -------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }
function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255; }

// ---- sessions --------------------------------------------------------------
async function createSession(res, userId) {
  const token = crypto.randomBytes(48).toString('hex');
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, NOW() + ($3 || ' days')::interval)`,
    [token, userId, String(SESSION_DAYS)]);
  await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [userId]);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86400 * 1000, path: '/',
  });
}
async function destroySession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.clearCookie(COOKIE, { path: '/' });
}

/** True if a subscriber-role user may use the product right now. */
function hasAccess(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'broker') return true;
  if (['active', 'trialing'].includes(user.subscription_status)) return true;
  // past_due / canceled: honor the already-paid period
  if (user.subscription_ends_at && new Date(user.subscription_ends_at) > new Date()) return true;
  return false;
}

// ---- middleware ------------------------------------------------------------
/** Attaches req.user (or null) from the session cookie. Never blocks. */
async function attachUser(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) { req.user = null; return next(); }
    const r = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.subscription_status, u.subscription_ends_at, u.stripe_customer_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`, [token]);
    req.user = r.rows[0] || null;
    if (req.user) req.user.has_access = hasAccess(req.user);
    next();
  } catch (e) { next(e); }
}

const requireLogin = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Please log in', login: true });

/** Logged in AND (admin | broker | subscriber with live subscription). */
const requireAccess = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in', login: true });
  if (!req.user.has_access) return res.status(402).json({ error: 'Subscription required', subscribe: true });
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in', login: true });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
  next();
};

// ---- very small login rate limiter (per IP, in memory) --------------------
const attempts = new Map();
function rateLimitLogin(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, reset: now + 15 * 60_000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 15 * 60_000; }
  if (rec.n >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  rec.n++; attempts.set(key, rec);
  next();
}

async function purgeExpiredSessions() {
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, validPassword, validEmail,
  createSession, destroySession, hasAccess,
  attachUser, requireLogin, requireAccess, requireRole, rateLimitLogin, purgeExpiredSessions,
};
