// Broker workflow, per company: open -> claimed -> sold (or passed). One company's claims never touch another's.
// GET  /api/broker/dashboard
// POST /api/broker/deals/:id/claim
// POST /api/broker/deals/:id/sold   { salePrice, notes }
// POST /api/broker/deals/:id/pass   { notes }
const router = require('express').Router();
const pool = require('../lib/db');

const curators = (req, res, next) => ['admin', 'broker'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Only admin or broker accounts can hide listings' });
const BROKER = () => process.env.BROKER_ID || 'broker_1';
const RATE = () => Number(process.env.COMMISSION_PERCENTAGE || 10);


const { blockedSql, EFFECTIVE_STATUS_SQL, CLAIM_HOURS } = require('../lib/orgs');
const isAdmin = (u) => u.role === 'admin';

async function logAction(dealId, req, action, notes) {
  try { const t = (await pool.query('SELECT l.title FROM deals d JOIN listings l ON l.id = d.listing_id WHERE d.id = $1', [dealId])).rows[0]; require('../lib/activity').log(req.user, action + ' deal', t && t.title); } catch {}
  await pool.query('INSERT INTO broker_interactions (deal_id, broker_id, action, notes, org_id) VALUES ($1,$2,$3,$4,$5)',
    [dealId, req.user.email, action, notes || null, req.user.org_id || null]);
}
async function dealRow(id) {
  return (await pool.query('SELECT d.id, d.listing_id, l.auction_ends FROM deals d JOIN listings l ON l.id = d.listing_id WHERE d.id = $1', [id])).rows[0];
}

// "Not this machine": hide a wrong match. Admin hides it for everyone (and out of market values);
// a broker hides it for their own company only.
router.post('/listings/:id/block', curators, async (req, res, next) => {
  try {
    const id = req.params.id;
    const l = (await pool.query('SELECT product_id FROM listings WHERE id = $1', [id])).rows[0];
    if (!l) return res.status(404).json({ error: 'not found' });
    await pool.query('INSERT INTO listing_blocks (listing_id, blocked_by, org_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, req.user.id, isAdmin(req.user) ? null : req.user.org_id]);
    require('../lib/activity').log(req.user, 'hid listing', id);
    if (isAdmin(req.user)) require('../lib/pricing').recalculateProduct(l.product_id).catch(e => console.error('recalc after block failed:', e.message));
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/listings/:id/block', curators, async (req, res, next) => {
  try {
    const r = await pool.query(`DELETE FROM listing_blocks WHERE listing_id = $1 AND ${isAdmin(req.user) ? 'org_id IS NULL' : 'org_id = $2'} RETURNING listing_id`,
      isAdmin(req.user) ? [req.params.id] : [req.params.id, req.user.org_id]);
    const p = (await pool.query('SELECT product_id FROM listings WHERE id = $1', [req.params.id])).rows[0];
    if (p && isAdmin(req.user)) require('../lib/pricing').recalculateProduct(p.product_id).catch(() => {});
    res.json({ ok: true, restored: r.rowCount });
  } catch (e) { next(e); }
});
router.get('/blocked', curators, async (req, res, next) => {
  try {
    res.json((await pool.query(`SELECT l.id, l.title, l.price::float AS price, l.url, (SELECT name FROM products WHERE id = l.product_id) AS product
                                FROM listing_blocks b JOIN listings l ON l.id = b.listing_id
                                WHERE ${isAdmin(req.user) ? 'b.org_id IS NULL' : 'b.org_id = $1'} ORDER BY b.blocked_at DESC LIMIT 100`,
                               isAdmin(req.user) ? [] : [req.user.org_id])).rows);
  } catch (e) { next(e); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const org = Number(req.user.org_id) || 0;
    const eff = EFFECTIVE_STATUS_SQL('dc');
    const live = `l.is_active AND (l.auction_ends IS NULL OR l.auction_ends > NOW()) AND l.id NOT IN ${blockedSql(req.user)}`;
    const from = `FROM deals d JOIN listings l ON l.id = d.listing_id LEFT JOIN deal_claims dc ON dc.listing_id = l.id AND dc.org_id = ${org} WHERE ${live}`;
    const [totals, earned, byProduct, recent] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE ${eff}='open')::int    AS open_deals,
               COUNT(*) FILTER (WHERE ${eff}='claimed')::int AS claimed,
               COUNT(*) FILTER (WHERE ${eff}='sold')::int    AS sold,
               COALESCE(SUM(d.estimated_margin) FILTER (WHERE ${eff}='open'),0)::float AS open_margin_potential
        ${from}`),
      pool.query(`SELECT COALESCE(SUM(commission_earned),0)::float AS commission_earned FROM deal_claims WHERE org_id = $1 AND status = 'sold'`, [org]),
      pool.query(`
        SELECT p.name, COUNT(*) FILTER (WHERE ${eff}='open')::int AS open_deals, MAX(d.deal_score)::float AS best_score
        FROM deals d JOIN listings l ON l.id = d.listing_id JOIN products p ON p.id = d.product_id
        LEFT JOIN deal_claims dc ON dc.listing_id = l.id AND dc.org_id = ${org}
        WHERE ${live} GROUP BY p.name ORDER BY open_deals DESC`),
      pool.query(`
        SELECT bi.action, bi.notes, bi.created_at, l.title, d.id AS deal_id
        FROM broker_interactions bi JOIN deals d ON d.id=bi.deal_id JOIN listings l ON l.id=d.listing_id
        WHERE bi.org_id = $1 ORDER BY bi.created_at DESC LIMIT 20`, [org]),
    ]);
    const myPct = Number((await pool.query('SELECT commission_percent FROM users WHERE id = $1', [req.user.id])).rows[0]?.commission_percent) || RATE();
    const out = { broker_id: req.user.email, commission_rate: myPct, ...totals.rows[0], ...earned.rows[0], by_product: byProduct.rows, recent_activity: recent.rows };
    if (req.user.role === 'agent') {      // agents don't see the company's earnings
      out.commission_earned = null; out.commission_rate = null; out.open_margin_potential = null;
      out.recent_activity = out.recent_activity.map(r => ({ ...r, notes: null }));
    }
    res.json(out);
  } catch (e) { next(e); }
});

// Claim: reserves the deal for your company for CLAIM_HOURS (or until the auction ends).
// If a teammate already holds it, the answer is 409 until the request says confirm:true.
router.post('/deals/:id/claim', async (req, res, next) => {
  try {
    const d = await dealRow(req.params.id);
    if (!d) return res.status(404).json({ error: 'Deal not found' });
    const org = req.user.org_id;
    if (!org) return res.status(400).json({ error: 'Your account has no company yet - ask the admin' });
    let buyerId = req.body?.buyer_id ? Number(req.body.buyer_id) : null;
    if (buyerId) {   // only one of YOUR buyers can be attached
      const own = await pool.query('SELECT 1 FROM buyers WHERE id = $1 AND owner_user_id = $2', [buyerId, req.user.id]);
      if (!own.rows.length) buyerId = null;
    }
    const cur = (await pool.query(
      `SELECT dc.*, u.name AS by_name, u.email AS by_email FROM deal_claims dc LEFT JOIN users u ON u.id = dc.user_id
       WHERE dc.listing_id = $1 AND dc.org_id = $2`, [d.listing_id, org])).rows[0];
    const live = cur && cur.status === 'claimed' && (!cur.expires_at || new Date(cur.expires_at) > new Date());
    if (cur && cur.status === 'sold') return res.status(409).json({ error: 'Your company already sold this one.' });
    if (live && cur.user_id !== req.user.id && !req.body?.confirm)
      return res.status(409).json({ taken: true, by: cur.by_name || (cur.by_email || '').split('@')[0], error: `${cur.by_name || 'A teammate'} already claimed this.` });
    const hours = CLAIM_HOURS();
    const r = await pool.query(
      `INSERT INTO deal_claims (listing_id, org_id, user_id, buyer_id, status, claimed_at, expires_at, notes)
       VALUES ($1,$2,$3,$4,'claimed', NOW(),
         CASE WHEN $5::timestamp > NOW() THEN LEAST(NOW() + $6 * INTERVAL '1 hour', $5::timestamp) ELSE NOW() + $6 * INTERVAL '1 hour' END, $7)
       ON CONFLICT (listing_id, org_id) DO UPDATE SET user_id = EXCLUDED.user_id, buyer_id = EXCLUDED.buyer_id, status = 'claimed',
         claimed_at = NOW(), expires_at = EXCLUDED.expires_at, notes = COALESCE(EXCLUDED.notes, deal_claims.notes)
       RETURNING *`, [d.listing_id, org, req.user.id, buyerId, d.auction_ends, hours, req.body?.notes || null]);
    await logAction(d.id, req, 'claimed', req.body?.notes);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.post('/deals/:id/sold', async (req, res, next) => {
  try {
    const d = await dealRow(req.params.id);
    if (!d) return res.status(404).json({ error: 'Deal not found' });
    const salePrice = Number(req.body?.salePrice);
    if (!salePrice) return res.status(400).json({ error: 'salePrice is required' });
    const pct = Number((await pool.query('SELECT commission_percent FROM users WHERE id = $1', [req.user.id])).rows[0]?.commission_percent) || RATE();
    const commission = +(salePrice * pct / 100).toFixed(2);
    const r = await pool.query(
      `INSERT INTO deal_claims (listing_id, org_id, user_id, status, sale_price, commission_earned, expires_at, notes)
       VALUES ($1,$2,$3,'sold',$4,$5,NULL,$6)
       ON CONFLICT (listing_id, org_id) DO UPDATE SET status='sold', sale_price=EXCLUDED.sale_price, commission_earned=EXCLUDED.commission_earned,
         expires_at=NULL, user_id = COALESCE(deal_claims.user_id, EXCLUDED.user_id), notes = COALESCE(EXCLUDED.notes, deal_claims.notes) RETURNING *`,
      [d.listing_id, req.user.org_id, req.user.id, salePrice, commission, req.body?.notes || `Sold for $${salePrice}; commission $${commission}`]);
    await logAction(d.id, req, 'sold', req.body?.notes || `Sold for $${salePrice}; commission $${commission}`);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.post('/deals/:id/pass', async (req, res, next) => {
  try {
    const d = await dealRow(req.params.id);
    if (!d) return res.status(404).json({ error: 'Deal not found' });
    const r = await pool.query(
      `INSERT INTO deal_claims (listing_id, org_id, user_id, status, expires_at, notes) VALUES ($1,$2,$3,'passed',NULL,$4)
       ON CONFLICT (listing_id, org_id) DO UPDATE SET status='passed', expires_at=NULL, user_id=EXCLUDED.user_id,
         notes = COALESCE(EXCLUDED.notes, deal_claims.notes) RETURNING *`,
      [d.listing_id, req.user.org_id, req.user.id, req.body?.notes || null]);
    await logAction(d.id, req, 'passed', req.body?.notes);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// Release a claim (yours, or any in your company if you're admin/broker): the deal goes back to open.
router.post('/deals/:id/release', async (req, res, next) => {
  try {
    const d = await dealRow(req.params.id);
    if (!d) return res.status(404).json({ error: 'Deal not found' });
    const mine = ['admin', 'broker'].includes(req.user.role) ? '' : ' AND user_id = $3';
    const r = await pool.query(`DELETE FROM deal_claims WHERE listing_id = $1 AND org_id = $2 AND status IN ('claimed','passed')${mine} RETURNING listing_id`,
      mine ? [d.listing_id, req.user.org_id, req.user.id] : [d.listing_id, req.user.org_id]);
    await logAction(d.id, req, 'released');
    res.json({ ok: true, released: r.rowCount });
  } catch (e) { next(e); }
});

module.exports = router;
