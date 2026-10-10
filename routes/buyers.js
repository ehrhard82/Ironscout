// The broker team's buyer book (admin + broker only).
//
// GET    /api/buyers                      all active buyers with their wants
// POST   /api/buyers                      { company, contact_name, phone, email, city, state, notes, status, wants:[{product, max_price, states, min_year, notes}] }
// PATCH  /api/buyers/:id                  any of the buyer fields; active:false retires them
// POST   /api/buyers/:id/wants            { product, max_price, states, min_year, notes }
// DELETE /api/buyers/wants/:wantId
// GET    /api/buyers/:id/matches          open deals that match this buyer's wants
const router = require('express').Router();
const pool = require('../lib/db');
const { BUYERS_SQL } = require('../lib/buyers');
const { DEAL_COLS } = require('./watchlists');

const STATE = (s) => String(s || '').trim().toUpperCase().slice(0, 2) || null;
const STATES = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map(STATE).filter(Boolean);
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

async function productId(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const r = await pool.query(`INSERT INTO products (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [n]);
  return r.rows[0].id;
}

async function addWant(buyerId, w) {
  const pid = await productId(w.product);
  if (!pid) return null;
  const r = await pool.query(
    `INSERT INTO buyer_wants (buyer_id, product_id, max_price, states, min_year, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [buyerId, pid, num(w.max_price), STATES(w.states), num(w.min_year), w.notes || null]);
  return r.rows[0].id;
}

async function list(where = 'b.active', params = []) {
  const r = await pool.query(`
    SELECT b.*, u.name AS owner_name, u.email AS owner_email,
      (SELECT COALESCE(json_agg(json_build_object('id', bw.id, 'product', p.name, 'product_id', bw.product_id, 'max_price', bw.max_price,
                'states', bw.states, 'min_year', bw.min_year, 'notes', bw.notes) ORDER BY p.name), '[]'::json)
       FROM buyer_wants bw JOIN products p ON p.id = bw.product_id WHERE bw.buyer_id = b.id AND bw.active) AS wants,
      (SELECT COUNT(*)::int FROM deals d JOIN listings l ON l.id = d.listing_id JOIN buyer_wants bw ON bw.buyer_id = b.id AND bw.active AND bw.product_id = d.product_id
        WHERE l.is_active AND d.commission_status = 'open'
          AND (bw.max_price IS NULL OR l.price <= bw.max_price)
          AND (bw.states IS NULL OR cardinality(bw.states) = 0 OR l.state = ANY(bw.states))
          AND (bw.min_year IS NULL OR l.year IS NULL OR l.year >= bw.min_year)) AS open_matches
    FROM buyers b LEFT JOIN users u ON u.id = b.owner_user_id
    WHERE ${where} ORDER BY b.status = 'customer' DESC, b.company`, params);
  return r.rows;
}

router.get('/', async (req, res, next) => {
  try { res.json({ buyers: await list(req.query.all === '1' ? 'TRUE' : 'b.active') }); } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!String(b.company || '').trim()) return res.status(400).json({ error: 'Company name is required' });
    const r = await pool.query(
      `INSERT INTO buyers (company, contact_name, phone, email, city, state, notes, status, source, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9) RETURNING id`,
      [b.company.trim(), b.contact_name || null, b.phone || null, b.email || null, b.city || null, STATE(b.state), b.notes || null,
       b.status === 'prospect' ? 'prospect' : 'customer', req.user.id]);
    const id = r.rows[0].id;
    for (const w of (Array.isArray(b.wants) ? b.wants : [])) await addWant(id, w);
    res.status(201).json({ buyer: (await list('b.id = $1', [id]))[0] });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `UPDATE buyers SET company = COALESCE($2, company), contact_name = COALESCE($3, contact_name), phone = COALESCE($4, phone),
         email = COALESCE($5, email), city = COALESCE($6, city), state = COALESCE($7, state), notes = COALESCE($8, notes),
         status = COALESCE($9, status), active = COALESCE($10, active), updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [req.params.id, b.company || null, b.contact_name ?? null, b.phone ?? null, b.email ?? null, b.city ?? null,
       b.state ? STATE(b.state) : null, b.notes ?? null, b.status || null, typeof b.active === 'boolean' ? b.active : null]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ buyer: (await list('b.id = $1', [req.params.id]))[0] });
  } catch (e) { next(e); }
});

router.post('/:id/wants', async (req, res, next) => {
  try {
    const id = await addWant(req.params.id, req.body || {});
    if (!id) return res.status(400).json({ error: 'Machine is required' });
    res.status(201).json({ buyer: (await list('b.id = $1', [req.params.id]))[0] });
  } catch (e) { next(e); }
});

router.delete('/wants/:wantId', async (req, res, next) => {
  try {
    await pool.query('UPDATE buyer_wants SET active = FALSE WHERE id = $1', [req.params.wantId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/:id/matches', async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT ${DEAL_COLS}, ${BUYERS_SQL}
      FROM deals d JOIN listings l ON l.id = d.listing_id JOIN products p ON p.id = d.product_id
      WHERE l.is_active AND d.commission_status <> 'passed'
        AND EXISTS (SELECT 1 FROM buyer_wants bw WHERE bw.buyer_id = $1 AND bw.active AND bw.product_id = d.product_id
          AND (bw.max_price IS NULL OR l.price <= bw.max_price)
          AND (bw.states IS NULL OR cardinality(bw.states) = 0 OR l.state = ANY(bw.states))
          AND (bw.min_year IS NULL OR l.year IS NULL OR l.year >= bw.min_year))
      ORDER BY d.deal_score DESC LIMIT 100`, [req.params.id]);
    res.json({ count: r.rows.length, deals: require('../lib/landed').attachLanded(r.rows, {}) });
  } catch (e) { next(e); }
});

module.exports = router;
