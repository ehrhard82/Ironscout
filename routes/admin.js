// Operational endpoints
// POST /api/admin/ingest { product }    kick off an ingest for one product from the web UI
// POST /api/admin/recalculate           rebuild deals without re-fetching
// GET  /api/admin/runs                  last 50 ingest runs (spot a dead source)
const router = require('express').Router();
const pool = require('../lib/db');
const { ingestProduct } = require('../scripts/ingest');
const { recalculateAll } = require('../lib/pricing');
const { sendDigests } = require('../lib/alerts');
const { hashPassword, validEmail, validPassword } = require('../lib/auth');

let busy = false;

router.post('/ingest', async (req, res, next) => {
  try {
    const product = (req.body?.product || '').trim();
    if (!product) return res.status(400).json({ error: 'product is required' });
    if (busy) return res.status(409).json({ error: 'An ingest is already running' });
    busy = true;
    res.json({ started: product });                 // respond immediately; work continues
    ingestProduct(product).then(() => sendDigests({ realtimeOnly: true })).catch(e => console.error(e)).finally(() => { busy = false; });
  } catch (e) { busy = false; next(e); }
});

router.post('/recalculate', async (req, res, next) => {
  try { res.json({ results: await recalculateAll() }); } catch (e) { next(e); }
});

router.get('/runs', async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT ir.id, p.name AS product, ir.source, ir.fetched, ir.inserted, ir.updated, ir.error, ir.started_at, ir.finished_at
      FROM ingest_runs ir LEFT JOIN products p ON p.id = ir.product_id
      ORDER BY ir.started_at DESC LIMIT 50`);
    res.json({ busy, runs: r.rows });
  } catch (e) { next(e); }
});


// ---- users -----------------------------------------------------------------
// GET   /api/admin/users
// PATCH /api/admin/users/:id   { role, subscription_status }   e.g. make someone broker, or comp a subscription
// POST  /api/admin/users       { email, password, name, role } create an account by hand (e.g. the broker)
router.get('/users', async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT u.id, u.email, u.name, u.role, u.subscription_status, u.subscription_ends_at, u.last_login, u.created_at,
             (SELECT COUNT(*)::int FROM watchlists w WHERE w.user_id = u.id) AS watchlists
      FROM users u ORDER BY u.created_at DESC`);
    res.json({ count: r.rows.length, users: r.rows });
  } catch (e) { next(e); }
});
router.post('/users', async (req, res, next) => {
  try {
    const { email, password, name, role = 'subscriber' } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Valid email required' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!['admin', 'broker', 'subscriber'].includes(role)) return res.status(400).json({ error: 'Bad role' });
    const r = await pool.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role`,
      [email.trim().toLowerCase(), hashPassword(password), name || null, role]);
    res.status(201).json(r.rows[0]);
  } catch (e) { e.code === '23505' ? res.status(409).json({ error: 'Email already exists' }) : next(e); }
});
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { role, subscription_status, subscription_ends_at } = req.body || {};
    if (role && !['admin', 'broker', 'subscriber'].includes(role)) return res.status(400).json({ error: 'Bad role' });
    const r = await pool.query(
      `UPDATE users SET role = COALESCE($2, role), subscription_status = COALESCE($3, subscription_status),
         subscription_ends_at = COALESCE($4, subscription_ends_at)
       WHERE id = $1 RETURNING id, email, name, role, subscription_status, subscription_ends_at`,
      [req.params.id, role || null, subscription_status || null, subscription_ends_at || null]);
    r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  } catch (e) { next(e); }
});

// ---- product requests from subscribers --------------------------------------
router.get('/requests', async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT pr.id, pr.term, pr.status, pr.created_at, u.email
      FROM product_requests pr LEFT JOIN users u ON u.id = pr.user_id
      ORDER BY pr.status = 'pending' DESC, pr.created_at DESC LIMIT 200`);
    res.json({ requests: r.rows });
  } catch (e) { next(e); }
});
router.post('/requests/:id/approve', async (req, res, next) => {
  try {
    const r = await pool.query(`UPDATE product_requests SET status = 'approved' WHERE id = $1 RETURNING term, user_id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const { term, user_id } = r.rows[0];
    const p = await pool.query(`INSERT INTO products (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [term]);
    if (user_id) await pool.query(`INSERT INTO watchlists (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user_id, p.rows[0].id]);
    if (!busy) { busy = true; ingestProduct(term).then(() => sendDigests({ realtimeOnly: true })).catch(console.error).finally(() => { busy = false; }); }
    res.json({ ok: true, product: term, ingesting: true, note: 'Add it to TRACKED_PRODUCTS in .env so the scheduler keeps it fresh.' });
  } catch (e) { next(e); }
});
router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    await pool.query(`UPDATE product_requests SET status = 'rejected' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});


// POST /api/admin/alerts/run   send any due digests now (what the scheduler does every 15 min)
router.post('/alerts/run', async (req, res, next) => {
  try { res.json(await sendDigests()); } catch (e) { next(e); }
});

module.exports = router;
