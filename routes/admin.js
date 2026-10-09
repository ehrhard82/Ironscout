// Operational endpoints
// POST /api/admin/ingest { product }    kick off an ingest for one product from the web UI
// POST /api/admin/recalculate           rebuild deals without re-fetching
// GET  /api/admin/runs                  last 50 ingest runs (spot a dead source)
const router = require('express').Router();
const pool = require('../lib/db');
const ingestQueue = require('../lib/ingestQueue');
const { recalculateAll } = require('../lib/pricing');
const { sendDigests } = require('../lib/alerts');
const { hashPassword, validEmail, validPassword } = require('../lib/auth');

router.post('/ingest', async (req, res, next) => {
  try {
    const product = (req.body?.product || '').trim();
    if (!product) return res.status(400).json({ error: 'product is required' });
    const q = ingestQueue.enqueue(product);       // respond immediately; work continues in the background
    res.json({ started: product, ...q, ...ingestQueue.status() });
  } catch (e) { next(e); }
});

// POST /api/admin/ingest-sold { product }   pull completed sales now (normally done weekly by the ingest)
router.post('/ingest-sold', async (req, res, next) => {
  try {
    const product = (req.body?.product || '').trim();
    if (!product) return res.status(400).json({ error: 'product is required' });
    const { ingestSold } = require('../scripts/ingest');
    const { getOrCreateProduct } = require('../lib/listings');
    const { recalculateProduct } = require('../lib/pricing');
    res.json({ started: product });
    getOrCreateProduct(product).then(id => ingestSold(id, product, { force: true }).then(() => recalculateProduct(id))).catch(e => console.error(e));
  } catch (e) { next(e); }
});

router.post('/recalculate', async (req, res, next) => {
  try { res.json({ results: await recalculateAll() }); } catch (e) { next(e); }
});

router.get('/runs', async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT ir.id, p.name AS product, ir.source, ir.fetched, ir.inserted, ir.updated, ir.error, ir.note, ir.started_at, ir.finished_at
      FROM ingest_runs ir LEFT JOIN products p ON p.id = ir.product_id
      ORDER BY ir.started_at DESC LIMIT 50`);
    const budget = await require('../lib/sources/apify').budgetLeft().catch(() => null);
    res.json({ busy: ingestQueue.isBusy(), ...ingestQueue.status(), budget, sources: require('../lib/sources').map(s => s.name), runs: r.rows });
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
    ingestQueue.enqueue(term);
    res.json({ ok: true, product: term, ingesting: true });
  } catch (e) { next(e); }
});
router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    await pool.query(`UPDATE product_requests SET status = 'rejected' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});


// GET /api/admin/debug/source?name=govdeals&q=wheel loader[&mode=sold]
// Calls the Apify actor directly and shows the raw items + how they map. Open in a browser.
router.get('/debug/source', async (req, res, next) => {
  try {
    const { rawSample } = require('../lib/sources/apify');
    if (!(process.env.APIFY_TOKEN || '').trim()) return res.status(400).json({ error: 'APIFY_TOKEN is not set on this server. In Render -> Environment, add a row with key APIFY_TOKEN and your apify_api_... token as the value.' });
    res.json(await rawSample(String(req.query.name || 'govdeals'), String(req.query.q || 'wheel loader'), 2, req.query.mode === 'sold' ? 'sold' : 'active'));
  } catch (e) {
    res.status(500).json({ error: e.message, response: e.response?.data });
  }
});

// GET /api/admin/debug/sources?q=wheel loader
// One-tap health check for the phone: asks every enabled Apify source for 5 items and
// reports what came back, with the first title, so you can see which source is alive.
router.get('/debug/sources', async (req, res) => {
  const { rawSample, enabledSources } = require('../lib/sources/apify');
  const q = String(req.query.q || 'wheel loader');
  const out = { server: req.get('host'), token_present: Boolean((process.env.APIFY_TOKEN || '').trim()), apify_sources_env: process.env.APIFY_SOURCES || '(blank → default govdeals,ironplanet)' };
  out.results = await Promise.all(enabledSources().map(async (s) => {       // in parallel so the phone doesn't time out
    const t0 = Date.now();
    try {
      const r = await rawSample(s.name, q, 1);
      const m = r.mapped[0];
      return { source: s.name, ok: r.count > 0, items: r.count, run_status: r.run_status, seconds: Math.round((Date.now() - t0) / 1000),
        first: m ? `${m.year || ''} ${m.title || ''} — $${m.price || '?'} — ${m.city || ''} ${m.state || ''}`.trim() : null };
    } catch (e) {
      return { source: s.name, ok: false, seconds: Math.round((Date.now() - t0) / 1000), error: e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message };
    }
  }));
  res.json(out);
});

// POST /api/admin/alerts/run   send any due digests now (what the scheduler does every 15 min)
router.post('/alerts/run', async (req, res, next) => {
  try { res.json(await sendDigests()); } catch (e) { next(e); }
});

module.exports = router;
