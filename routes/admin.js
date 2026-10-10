// Operational endpoints
// POST /api/admin/ingest { product }    kick off an ingest for one product from the web UI
// POST /api/admin/recalculate           rebuild deals without re-fetching
// GET  /api/admin/runs                  last 50 ingest runs (spot a dead source)
const express = require('express');
const router = express.Router();
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

// POST /api/admin/import-sales  { csv, source }
// Load completed sales from a spreadsheet (CSV text). Columns (header row, any order, case-insensitive):
//   machine, title, price            required   (machine = what we track it as, e.g. "frac pump")
//   sold_date, year, hours, city, state, url, serial, notes    optional
// Rows become rows in `sales` with source = <source> (default "import"), so a dealer's own
// sold history can back market values for machines the auctions rarely show.
router.post('/import-sales', express.text({ type: '*/*', limit: '5mb' }), async (req, res, next) => {
  try {
    const { parse } = require('csv-parse/sync');
    const { getOrCreateProduct, upsertSale } = require('../lib/listings');
    const { recalculateProduct } = require('../lib/pricing');
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = { csv: body }; } }
    const csv = String(body.csv || '').trim();
    const source = String(body.source || 'import').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'import';
    if (!csv) return res.status(400).json({ error: 'No rows found' });
    let rows;
    try { rows = parse(csv, { columns: (h) => h.map(x => String(x).trim().toLowerCase().replace(/\s+/g, '_')), skip_empty_lines: true, trim: true, relax_column_count: true }); }
    catch (e) { return res.status(400).json({ error: 'Could not read that as a spreadsheet: ' + e.message }); }
    const pick = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return null; };
    const touched = new Set(); let ok = 0, skipped = 0; const problems = [];
    for (const [i, r] of rows.entries()) {
      const machine = pick(r, 'machine', 'product', 'category', 'type');
      const title = pick(r, 'title', 'description', 'item', 'unit', 'name');
      const price = Number(String(pick(r, 'price', 'sold_price', 'sale_price', 'sold', 'amount') || '').replace(/[^0-9.]/g, ''));
      if (!machine || !title || !price) { skipped++; if (problems.length < 5) problems.push(`row ${i + 2}: needs machine, title and price`); continue; }
      const pid = await getOrCreateProduct(machine);
      touched.add(pid);
      const soldAt = pick(r, 'sold_date', 'date', 'sold_at', 'sale_date');
      const result = await upsertSale(pid, {
        source, source_id: pick(r, 'serial', 'id', 'stock', 'stock_number') || require('crypto').createHash('md5').update(`${machine}|${title}|${price}|${soldAt || ''}`).digest('hex'),
        title, price, year: pick(r, 'year', 'model_year'), hours: pick(r, 'hours', 'meter'),
        city: pick(r, 'city', 'location'), state: pick(r, 'state', 'st'), url: pick(r, 'url', 'link'),
        sold_at: soldAt ? new Date(soldAt) : null,
      });
      result === 'skipped' ? skipped++ : ok++;
    }
    for (const pid of touched) await recalculateProduct(pid);
    res.json({ imported: ok, skipped, machines: touched.size, problems });
  } catch (e) { next(e); }
});

// GET /api/admin/status   one-screen health summary (what a screenshot needs to show)
router.get('/status', async (req, res, next) => {
  try {
    const [budget, machines, errors, counts] = await Promise.all([
      require('../lib/sources/apify').budgetLeft().catch(() => null),
      pool.query(`
        SELECT p.id, p.name,
          (SELECT COUNT(*)::int FROM listings l WHERE l.product_id = p.id AND l.is_active) AS listings,
          (SELECT COUNT(*)::int FROM sales s WHERE s.product_id = p.id) AS sales,
          (SELECT COUNT(*)::int FROM deals d JOIN listings l ON l.id = d.listing_id WHERE d.product_id = p.id AND l.is_active AND d.commission_status = 'open') AS deals,
          (SELECT COUNT(*)::int FROM watchlists w WHERE w.product_id = p.id) AS watchers,
          (SELECT MAX(started_at) FROM ingest_runs r WHERE r.product_id = p.id) AS last_fetch,
          (SELECT COALESCE(json_agg(json_build_object('source', x.source, 'fetched', x.fetched, 'error', x.error) ORDER BY x.source), '[]'::json)
             FROM (SELECT DISTINCT ON (source) source, fetched, error FROM ingest_runs r WHERE r.product_id = p.id AND source NOT LIKE '%:sold' ORDER BY source, started_at DESC) x) AS last_by_source,
          (SELECT median_price FROM market_stats m WHERE m.product_id = p.id AND m.region_type = 'country') AS market,
          (SELECT basis FROM market_stats m WHERE m.product_id = p.id AND m.region_type = 'country') AS basis
        FROM products p ORDER BY p.name`),
      pool.query(`SELECT source, error, started_at, (SELECT name FROM products WHERE id = product_id) AS product
                  FROM ingest_runs WHERE error IS NOT NULL AND started_at > NOW() - INTERVAL '2 days' ORDER BY started_at DESC LIMIT 10`),
      pool.query(`SELECT (SELECT COUNT(*)::int FROM listings WHERE is_active) AS listings, (SELECT COUNT(*)::int FROM sales) AS sales,
                         (SELECT COUNT(*)::int FROM deals d JOIN listings l ON l.id = d.listing_id WHERE l.is_active AND d.commission_status = 'open') AS deals,
                         (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM buyers WHERE active) AS buyers`),
    ]);
    res.json({ build: BUILD_STAMP(), budget, sources: require('../lib/sources').map(s => s.name), queue: ingestQueue.status(), totals: counts.rows[0],
               machines: machines.rows, recent_errors: errors.rows });
  } catch (e) { next(e); }
});
const BUILD_STAMP = () => { try { return require('child_process').execSync('git log -1 --format=%cd~%s --date=format:%m-%d\\ %H:%M', { cwd: require('path').join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; } };

// POST /api/admin/alerts/run   send any due digests now (what the scheduler does every 15 min)
router.post('/alerts/run', async (req, res, next) => {
  try { res.json(await sendDigests()); } catch (e) { next(e); }
});

module.exports = router;
