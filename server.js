// IronScout API + web app
require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const pool = require('./lib/db');
const auth = require('./lib/auth');
const billing = require('./routes/billing');

const app = express();
app.set('trust proxy', 1);            // behind Caddy/nginx: correct req.ip and secure cookies
app.disable('x-powered-by');

// Stripe webhook must see the raw body, so it is mounted before the JSON parser.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billing.webhook);

app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(auth.attachUser);

// Basic security headers (no extra dependency)
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS listings FROM listings WHERE is_active');
    res.json({ status: 'ok', active_listings: r.rows[0].listings });
  } catch (e) {
    const hasUrl = Boolean((process.env.DATABASE_URL || '').trim());
    res.status(500).json({
      status: 'db error',
      error: e.message || e.code || String(e),
      database_url_set: hasUrl,
      hint: hasUrl ? 'DATABASE_URL is set but the connection failed - check it was pasted completely (starts with postgresql:// and ends with ?sslmode=require).'
                   : 'DATABASE_URL is NOT set on this service. In Render -> this service -> Environment, add DATABASE_URL with your Neon connection string.',
    });
  }
});

// Public
app.use('/api/auth', require('./routes/auth'));
app.use('/api/billing', billing.router);

// Needs an account with access (admin, broker, or live subscription)
app.use('/api/deals', auth.requireAccess, require('./routes/deals'));
app.use('/api/search', auth.requireAccess, require('./routes/search'));
app.use('/api/products', require('./routes/products'));         // GET open to access-holders, POST admin-only (inside)
app.use('/api/watchlists', require('./routes/watchlists').router);
app.use('/api/settings', require('./routes/settings'));
app.use('/api/lookup', require('./routes/lookup'));
app.use('/api/cron', require('./routes/cron'));

// Role-restricted
app.use('/api/broker', auth.requireRole('admin', 'broker'), require('./routes/broker'));
app.use('/api/admin', auth.requireRole('admin'), require('./routes/admin'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// Clean out expired sessions once a day
setInterval(() => auth.purgeExpiredSessions().catch(() => {}), 24 * 3600 * 1000).unref();

// Apply the schema on startup (safe to rerun: everything is IF NOT EXISTS). This
// means free-tier hosts with no shell still get their tables created.
async function ensureSchema() {
  const fs = require('fs');
  const sql = fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Database schema verified');
}

const PORT = Number(process.env.PORT || 3000);
ensureSchema().catch(e => console.error('Schema setup failed (will keep serving; check DATABASE_URL):', e.message));
app.listen(PORT, () => {
  console.log(`IronScout running at ${process.env.APP_URL || 'http://localhost:' + PORT}`);
  if (!process.env.STRIPE_SECRET_KEY) console.log('  (billing disabled: STRIPE_SECRET_KEY not set — admin/broker accounts still work)');
  if (!process.env.RESEND_API_KEY) console.log('  (email disabled: RESEND_API_KEY not set — emails print to console)');
});

module.exports = app;
