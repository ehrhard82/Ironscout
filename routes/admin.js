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
      SELECT u.id, u.email, u.name, u.role, u.org_id, (SELECT name FROM organizations o WHERE o.id = u.org_id) AS org_name, u.subscription_status, u.subscription_ends_at, u.last_login, u.created_at,
             (SELECT COUNT(*)::int FROM watchlists w WHERE w.user_id = u.id) AS watchlists
      FROM users u ORDER BY u.created_at DESC`);
    res.json({ count: r.rows.length, users: r.rows });
  } catch (e) { next(e); }
});
// ---- companies --------------------------------------------------------------
// Everyone in a company shares claims and the team view; companies never see each other's.
router.get('/orgs', async (req, res, next) => {
  try { res.json((await pool.query(`SELECT o.id, o.name, o.client_emails, (SELECT COUNT(*)::int FROM users u WHERE u.org_id = o.id) AS members, (SELECT COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', u.role) ORDER BY u.email), '[]'::json) FROM users u WHERE u.org_id = o.id) AS people FROM organizations o ORDER BY o.name`)).rows); } catch (e) { next(e); }
});
router.post('/orgs', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'Company name required' });
    res.status(201).json((await pool.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id, name', [name])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/orgs/:id', async (req, res, next) => {
  try {
    if (req.body && typeof req.body.client_emails === 'boolean') {
      const r = await pool.query('UPDATE organizations SET client_emails = $2 WHERE id = $1 RETURNING id, name, client_emails', [req.params.id, req.body.client_emails]);
      return r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
    }
    const name = String(req.body?.name || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'Company name required' });
    const r = await pool.query('UPDATE organizations SET name = $2 WHERE id = $1 RETURNING id, name', [req.params.id, name]);
    r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  } catch (e) { next(e); }
});

router.delete('/orgs/:id', async (req, res, next) => {
  try {
    const n = (await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE org_id = $1', [req.params.id])).rows[0].n;
    if (n) return res.status(409).json({ error: 'Move the people out of this company first.' });
    const r = await pool.query('DELETE FROM organizations WHERE id = $1 RETURNING name', [req.params.id]);
    r.rows.length ? res.json({ deleted: r.rows[0].name }) : res.status(404).json({ error: 'Not found' });
  } catch (e) { next(e); }
});
router.post('/users', async (req, res, next) => {
  try {
    const { email, password, name, role = 'subscriber', org_id, org_name } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Valid email required' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!['admin', 'broker', 'agent', 'subscriber'].includes(role)) return res.status(400).json({ error: 'Bad role' });
    let org = org_id ? Number(org_id) : null;
    if (!org) {   // a new company named in the form, else one for this person
      org = (await pool.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [String(org_name || name || email.split('@')[0]).trim().slice(0, 200)])).rows[0].id;
    }
    const r = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, org_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, org_id`,
      [email.trim().toLowerCase(), hashPassword(password), name || null, role, org]);
    res.status(201).json(r.rows[0]);
  } catch (e) { e.code === '23505' ? res.status(409).json({ error: 'Email already exists' }) : next(e); }
});
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { role, subscription_status, subscription_ends_at, org_id, name, email, password } = req.body || {};
    if (email !== undefined && !validEmail(email)) return res.status(400).json({ error: 'Valid email required' });
    if (password && !validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (role && !['admin', 'broker', 'agent', 'subscriber'].includes(role)) return res.status(400).json({ error: 'Bad role' });
    const r = await pool.query(
      `UPDATE users SET role = COALESCE($2, role), subscription_status = COALESCE($3, subscription_status),
         subscription_ends_at = COALESCE($4, subscription_ends_at), org_id = COALESCE($5, org_id),
         name = CASE WHEN $6::boolean THEN $7 ELSE name END,
         email = COALESCE($8, email),
         password_hash = COALESCE($9, password_hash)
       WHERE id = $1 RETURNING id, email, name, role, org_id, subscription_status, subscription_ends_at`,
      [req.params.id, role || null, subscription_status || null, subscription_ends_at || null, org_id ? Number(org_id) : null,
       name !== undefined, name ? String(name).trim().slice(0, 255) : null,
       email ? email.trim().toLowerCase() : null, password ? hashPassword(password) : null]);
    if (password && r.rows.length) await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);   // new password = signed out everywhere
    r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  } catch (e) { e.code === '23505' ? res.status(409).json({ error: 'That email is already used by another account' }) : next(e); }
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
      return { source: s.name, ok: r.count > 0, items: r.count, usable: r.usable, run_status: r.run_status, seconds: Math.round((Date.now() - t0) / 1000),
        first: m ? `${m.year || ''} ${m.title || ''} — $${m.price || '?'} — ${m.city || ''} ${m.state || ''}${m.raw_location && !m.city ? m.raw_location : ''}`.trim()
                 : (r.count ? 'none usable (no US price among the sample — normal for a small test)' : null) };
    } catch (e) {
      return { source: s.name, ok: false, seconds: Math.round((Date.now() - t0) / 1000), error: e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message };
    }
  }));
  // free (non-Apify) sources, read directly from this server
  const pe = require('../lib/sources/plantandequipment');
  const t0 = Date.now();
  try {
    const rows = await pe.fetch(q);
    const m = rows[0];
    out.results.push({ source: 'plantandequipment', ok: rows.length > 0 || Boolean(rows.note), items: rows.returned || rows.length, usable: rows.length, seconds: Math.round((Date.now() - t0) / 1000),
      first: m ? `${m.year || ''} ${m.title} — $${m.price} — ${[m.city, pe.COUNTRY_NAME[m.country] || m.country].filter(Boolean).join(', ')}` : (rows.note || 'no listings parsed') });
  } catch (e) { out.results.push({ source: 'plantandequipment', ok: false, seconds: Math.round((Date.now() - t0) / 1000), error: e.response ? `${e.response.status} from plantandequipment.com` : e.message }); }
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

// POST /api/admin/refresh-all  — the same daily refresh the 6am job runs, started from the Admin page
// (no cron key needed; you're already logged in as admin). GET returns when it last ran.
router.post('/refresh-all', async (req, res, next) => {
  try {
    const cron = require('./cron');
    const since = (Date.now() - await cron.lastScheduledIngest()) / 3600000;
    const terms = await cron.runScheduledIngest(`admin button (${req.user.email})`);
    require('../lib/activity').log(req.user, 'started full refresh', `${terms.length} machines`).catch(() => {});
    res.json({ started: true, machines: terms, last_run_hours_ago: Math.round(since * 10) / 10 });
  } catch (e) { next(e); }
});
router.get('/refresh-all', async (req, res, next) => {
  try {
    const cron = require('./cron');
    const last = await cron.lastScheduledIngest();
    const r = await pool.query(`SELECT key, value FROM app_state WHERE key IN ('last_ingest_at', 'ingest_started_at')`).catch(() => ({ rows: [] }));
    res.json({ last_run: last ? new Date(last).toISOString() : null, ...Object.fromEntries(r.rows.map(x => [x.key, x.value])), queue: require('../lib/ingestQueue').status() });
  } catch (e) { next(e); }
});

// GET /api/admin/prospects/world[.csv]?country=AE,SA  — overseas dealers from PlantAndEquipment's directory (names + country;
// the site keeps phones behind a login, so these are leads to look up, not a call sheet).
router.get(['/prospects/world', '/prospects/world.csv'], async (req, res, next) => {
  try {
    const pe = require('../lib/sources/plantandequipment');
    const want = String(req.query.country || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    let rows = await pe.dealers();
    if (want.length) rows = rows.filter(r => want.includes(r.country_code));
    rows.sort((a, b) => (b.inventory || 0) - (a.inventory || 0));
    if (req.path.endsWith('.csv')) {
      const cols = ['name', 'country', 'inventory', 'url'];
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="ironscout-world-dealers.csv"');
      return res.send(cols.join(',') + '\n' + rows.map(x => cols.map(c => q(x[c])).join(',')).join('\n'));
    }
    res.json({ count: rows.length, dealers: rows, countries: [...new Set(rows.map(r => r.country).filter(Boolean))].sort() });
  } catch (e) { next(e); }
});

// GET /api/admin/prospects[.csv]?states=TX,OK,NM
// Dealers seen selling on the dealer sites (not auctions): who they are, where, what they list.
// This is the prospect list - people actively selling the exact machines the tool tracks.
router.get(['/prospects', '/prospects.csv'], async (req, res, next) => {
  try {
    const states = String(req.query.states || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const params = []; let where = `l.seller_name IS NOT NULL AND l.seller_name <> '' AND l.source IN ('machinio', 'ebay', 'craigslist')`;
    if (states.length) { params.push(states); where += ` AND l.state = ANY($1)`; }
    const r = await pool.query(`
      SELECT l.seller_name AS dealer,
             MODE() WITHIN GROUP (ORDER BY l.city) AS city, MODE() WITHIN GROUP (ORDER BY l.state) AS state,
             MAX(l.seller_phone) AS phone, MAX(l.seller_email) AS email,
             COUNT(*)::int AS listings, COUNT(*) FILTER (WHERE l.is_active)::int AS active_listings,
             STRING_AGG(DISTINCT p.name, ', ' ORDER BY p.name) AS machines,
             MAX(l.last_seen)::date AS last_seen, MIN(l.url) AS example_listing
      FROM listings l JOIN products p ON p.id = l.product_id
      WHERE ${where}
      GROUP BY l.seller_name ORDER BY active_listings DESC, listings DESC LIMIT 1000`, params);
    if (req.path.endsWith('.csv')) {
      const cols = ['dealer', 'city', 'state', 'phone', 'email', 'active_listings', 'listings', 'machines', 'last_seen', 'example_listing'];
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="ironscout-prospects.csv"');
      return res.send(cols.join(',') + '\n' + r.rows.map(x => cols.map(c => q(x[c])).join(',')).join('\n'));
    }
    res.json({ count: r.rows.length, prospects: r.rows });
  } catch (e) { next(e); }
});

// GET /api/admin/activity   who did what, newest first
router.get('/activity', async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT a.at, a.action, a.detail, u.email, u.name, (SELECT name FROM organizations o WHERE o.id = u.org_id) AS org
                                FROM activity a JOIN users u ON u.id = a.user_id ORDER BY a.at DESC LIMIT 200`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// POST /api/admin/test-email   sends a test message to the admin's own address
router.post('/test-email', async (req, res) => {
  try {
    if (!process.env.RESEND_API_KEY) return res.status(400).json({ error: 'RESEND_API_KEY is not set in Render yet' });
    const r = await require('../lib/mailer').send({ to: req.user.email, subject: 'IronScout test email', text: `Email is working. Sent ${new Date().toLocaleString()} from ${process.env.MAIL_FROM || '(MAIL_FROM not set)'}.` });
    res.json({ ok: true, to: req.user.email, id: r.id });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.response?.data?.error || e.message });
  }
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
          (SELECT basis FROM market_stats m WHERE m.product_id = p.id AND m.region_type = 'country') AS basis,
          (SELECT sample_size FROM market_stats m WHERE m.product_id = p.id AND m.region_type = 'country') AS sample_size
        FROM products p ORDER BY p.name`),
      pool.query(`SELECT source, error, started_at, (SELECT name FROM products WHERE id = product_id) AS product
                  FROM ingest_runs WHERE error IS NOT NULL AND started_at > NOW() - INTERVAL '2 days' ORDER BY started_at DESC LIMIT 10`),
      pool.query(`SELECT (SELECT COUNT(*)::int FROM listings WHERE is_active) AS listings, (SELECT COUNT(*)::int FROM sales) AS sales,
                         (SELECT COUNT(*)::int FROM deals d JOIN listings l ON l.id = d.listing_id WHERE l.is_active AND d.commission_status = 'open') AS deals,
                         (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM buyers WHERE active) AS buyers`),
    ]);
    const names = require('../lib/sources').map(s => s.name);
    const day = 24 * 3600 * 1000;
    const shown = [], idle = [];
    for (const m of machines.rows) {
      m.last_by_source = (m.last_by_source || []).filter(s => names.includes(s.source));   // only sources that are actually switched on
      const old = !m.last_fetch || Date.now() - new Date(m.last_fetch) > day;
      (m.listings + m.sales === 0 && old ? idle : shown).push(m);                           // old empty test machines
    }
    res.json({ build: BUILD_STAMP(), budget, sources: names, queue: ingestQueue.status(), totals: counts.rows[0],
               machines: shown, hidden_idle: idle.map(m => m.name), recent_errors: errors.rows });
  } catch (e) { next(e); }
});
// DELETE /api/admin/machines/:id   remove a machine and everything fetched for it (listings, sales, deals, watches, buyer wants)
router.delete('/machines/:id', async (req, res, next) => {
  try {
    const r = await pool.query('DELETE FROM products WHERE id = $1 RETURNING name', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: r.rows[0].name });
  } catch (e) { next(e); }
});
const BUILD_STAMP = () => { try { return require('child_process').execSync('git log -1 --format=%cd~%s --date=format:%m-%d\\ %H:%M', { cwd: require('path').join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; } };

// POST /api/admin/alerts/run   send any due digests now (what the scheduler does every 15 min)
router.post('/alerts/run', async (req, res, next) => {
  try { res.json(await sendDigests()); } catch (e) { next(e); }
});

module.exports = router;
