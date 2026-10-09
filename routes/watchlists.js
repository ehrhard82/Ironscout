// "Machines I watch." One row per machine. Filters (states, % below, $ margin...)
// come from the user's settings; a row can override them but the UI doesn't expose
// that yet - keep it simple.
//
// GET    /api/watchlists                    my machines (+ matching deal count)
// PUT    /api/watchlists                    { product_ids: [..] }  set the whole list at once
// POST   /api/watchlists                    { product_id | product }  add one
// DELETE /api/watchlists/:productId         remove one
// GET    /api/watchlists/deals              all deals matching my machines + settings
// POST   /api/watchlists/request            { term }  ask admin to track something new
// GET/POST/DELETE /api/watchlists/saved[/:dealId]
const router = require('express').Router();
const pool = require('../lib/db');
const { requireAccess } = require('../lib/auth');

router.use(requireAccess);

/** Effective filters for a (user, watchlist row) pair: row overrides, else user settings. */
function effective(user, w = {}) {
  return {
    product_id: w.product_id,
    states: w.states || user.alert_states || null,
    min_discount: w.min_discount ?? user.alert_min_discount ?? 0,
    min_margin: w.min_margin ?? user.alert_min_margin ?? 0,
    max_price: w.max_price ?? user.alert_max_price ?? null,
    min_year: w.min_year ?? user.alert_min_year ?? null,
  };
}

/** SQL WHERE fragment (uses aliases d=deals, l=listings) for an effective filter set. */
function matchSql(f, params) {
  const where = [`d.commission_status <> 'passed'`, 'l.is_active'];
  if (f.product_id) where.push(`d.product_id = $${params.push(f.product_id)}`);
  if (f.product_ids && f.product_ids.length) where.push(`d.product_id = ANY($${params.push(f.product_ids)})`);
  if (f.states && f.states.length) where.push(`l.state = ANY($${params.push(f.states)})`);
  if (Number(f.min_discount) > 0) where.push(`d.discount_percent >= $${params.push(Number(f.min_discount))}`);
  if (Number(f.min_margin) > 0) where.push(`d.estimated_margin >= $${params.push(Number(f.min_margin))}`);
  if (f.max_price) where.push(`l.price <= $${params.push(Number(f.max_price))}`);
  if (f.min_year) where.push(`l.year >= $${params.push(Number(f.min_year))}`);
  return where.join(' AND ');
}

async function fullUser(id) {
  return (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
}

const DEAL_COLS = `
  d.id, d.deal_score, d.discount_percent, d.estimated_margin, d.market_price, d.compared_to, d.flagged_at, d.commission_status,
  l.title, l.price, l.year, l.hours, l.city, l.state, l.url, l.image_url, l.source, l.sale_type, l.auction_ends, p.name AS product`;

router.get('/', async (req, res, next) => {
  try {
    const u = await fullUser(req.user.id);
    const r = await pool.query(
      `SELECT w.id, w.product_id, w.alerts, p.name AS product FROM watchlists w JOIN products p ON p.id = w.product_id
       WHERE w.user_id = $1 ORDER BY p.name`, [req.user.id]);
    for (const w of r.rows) {
      const params = [];
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM deals d JOIN listings l ON l.id = d.listing_id WHERE ${matchSql(effective(u, w), params)}`, params);
      w.matching_deals = c.rows[0].n;
    }
    res.json({ count: r.rows.length, watchlists: r.rows });
  } catch (e) { next(e); }
});

async function resolveProduct(b) {
  if (b.product_id) return Number(b.product_id);
  if (b.product) {
    const p = await pool.query('SELECT id FROM products WHERE name = $1', [String(b.product).trim().toLowerCase()]);
    return p.rows[0]?.id || null;
  }
  return null;
}

router.post('/', async (req, res, next) => {
  try {
    const pid = await resolveProduct(req.body || {});
    if (!pid) return res.status(404).json({ error: 'That machine is not tracked yet. Use "request" to ask for it.' });
    const limit = Number(process.env.MAX_WATCHLISTS || 25);
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM watchlists WHERE user_id = $1', [req.user.id]);
    if (n.rows[0].n >= limit) return res.status(400).json({ error: `You can watch up to ${limit} machines` });
    await pool.query(`INSERT INTO watchlists (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, pid]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

router.put('/', async (req, res, next) => {
  try {
    const ids = [...new Set((req.body?.product_ids || []).map(Number).filter(Boolean))].slice(0, Number(process.env.MAX_WATCHLISTS || 25));
    await pool.query('DELETE FROM watchlists WHERE user_id = $1 AND NOT (product_id = ANY($2))', [req.user.id, ids.length ? ids : [0]]);
    for (const pid of ids) await pool.query(`INSERT INTO watchlists (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, pid]);
    res.json({ ok: true, count: ids.length });
  } catch (e) { next(e); }
});

router.delete('/:productId', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM watchlists WHERE user_id = $1 AND product_id = $2', [req.user.id, req.params.productId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/deals', async (req, res, next) => {
  try {
    const u = await fullUser(req.user.id);
    const wl = await pool.query('SELECT product_id FROM watchlists WHERE user_id = $1', [req.user.id]);
    if (!wl.rows.length) return res.json({ count: 0, deals: [] });
    const params = [req.user.id];
    const f = { ...effective(u), product_ids: wl.rows.map(r => r.product_id) };
    const r = await pool.query(`
      SELECT ${DEAL_COLS}, (sd.deal_id IS NOT NULL) AS saved
      FROM deals d JOIN listings l ON l.id = d.listing_id JOIN products p ON p.id = d.product_id
      LEFT JOIN saved_deals sd ON sd.deal_id = d.id AND sd.user_id = $1
      WHERE ${matchSql(f, params)} ORDER BY d.deal_score DESC LIMIT 300`, params);
    res.json({ count: r.rows.length, deals: r.rows });
  } catch (e) { next(e); }
});

router.post('/request', async (req, res, next) => {
  try {
    const term = String(req.body?.term || '').trim().toLowerCase().slice(0, 255);
    if (term.length < 3) return res.status(400).json({ error: 'Tell us what you want tracked' });
    const existing = await pool.query('SELECT id FROM products WHERE name = $1', [term]);
    if (existing.rows.length) {
      await pool.query(`INSERT INTO watchlists (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, existing.rows[0].id]);
      return res.json({ ok: true, tracked: true, message: `"${term}" is already tracked — added to your machines.` });
    }
    // New machine: start tracking it right now. The request row stays as a record for the admin page.
    await pool.query(`INSERT INTO product_requests (user_id, term, status) VALUES ($1,$2,'approved')`, [req.user.id, term]);
    const p = await pool.query(`INSERT INTO products (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [term]);
    await pool.query(`INSERT INTO watchlists (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.user.id, p.rows[0].id]);
    const q = require('../lib/ingestQueue').enqueue(term);
    res.status(201).json({ ok: true, tracked: true, fetching: true, position: q.position,
      message: `Searching the auction sites for "${term}" now. This usually takes 2–5 minutes.` });
  } catch (e) { next(e); }
});

router.get('/saved', async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT ${DEAL_COLS}, sd.note, sd.saved_at, l.is_active
      FROM saved_deals sd JOIN deals d ON d.id = sd.deal_id JOIN listings l ON l.id = d.listing_id JOIN products p ON p.id = d.product_id
      WHERE sd.user_id = $1 ORDER BY sd.saved_at DESC`, [req.user.id]);
    res.json({ count: r.rows.length, deals: r.rows });
  } catch (e) { next(e); }
});
router.post('/saved/:dealId', async (req, res, next) => {
  try {
    await pool.query(`INSERT INTO saved_deals (user_id, deal_id, note) VALUES ($1,$2,$3) ON CONFLICT (user_id, deal_id) DO UPDATE SET note = EXCLUDED.note`,
      [req.user.id, req.params.dealId, req.body?.note || null]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/saved/:dealId', async (req, res, next) => {
  try { await pool.query('DELETE FROM saved_deals WHERE user_id = $1 AND deal_id = $2', [req.user.id, req.params.dealId]); res.json({ ok: true }); }
  catch (e) { next(e); }
});

module.exports = { router, matchSql, effective, DEAL_COLS };
