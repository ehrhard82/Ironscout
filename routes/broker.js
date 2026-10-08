// Broker workflow: open -> claimed -> sold (or passed)
// GET  /api/broker/dashboard
// POST /api/broker/deals/:id/claim
// POST /api/broker/deals/:id/sold   { salePrice, notes }
// POST /api/broker/deals/:id/pass   { notes }
const router = require('express').Router();
const pool = require('../lib/db');

const BROKER = () => process.env.BROKER_ID || 'broker_1';
const RATE = () => Number(process.env.COMMISSION_PERCENTAGE || 10);

async function setStatus(dealId, status, extra = {}, notes = '') {
  const r = await pool.query(
    `UPDATE deals SET commission_status=$1, sale_price=COALESCE($2, sale_price),
       commission_earned=COALESCE($3, commission_earned), notes=COALESCE($4, notes)
     WHERE id=$5 RETURNING *`,
    [status, extra.sale_price ?? null, extra.commission ?? null, notes || null, dealId]);
  if (!r.rows.length) return null;
  await pool.query(
    'INSERT INTO broker_interactions (deal_id, broker_id, action, notes) VALUES ($1,$2,$3,$4)',
    [dealId, BROKER(), status, notes || null]);
  return r.rows[0];
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const [totals, byProduct, recent] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE commission_status='open')::int    AS open_deals,
               COUNT(*) FILTER (WHERE commission_status='claimed')::int AS claimed,
               COUNT(*) FILTER (WHERE commission_status='sold')::int    AS sold,
               COALESCE(SUM(commission_earned) FILTER (WHERE commission_status='sold'),0)::float AS commission_earned,
               COALESCE(SUM(estimated_margin) FILTER (WHERE commission_status='open'),0)::float AS open_margin_potential
        FROM deals`),
      pool.query(`
        SELECT p.name, COUNT(*) FILTER (WHERE d.commission_status='open')::int AS open_deals,
               MAX(d.deal_score)::float AS best_score
        FROM deals d JOIN products p ON p.id=d.product_id GROUP BY p.name ORDER BY open_deals DESC`),
      pool.query(`
        SELECT bi.action, bi.notes, bi.created_at, l.title, d.id AS deal_id
        FROM broker_interactions bi JOIN deals d ON d.id=bi.deal_id JOIN listings l ON l.id=d.listing_id
        ORDER BY bi.created_at DESC LIMIT 20`),
    ]);
    res.json({ broker_id: BROKER(), commission_rate: RATE(), ...totals.rows[0],
               by_product: byProduct.rows, recent_activity: recent.rows });
  } catch (e) { next(e); }
});

router.post('/deals/:id/claim', async (req, res, next) => {
  try {
    const d = await setStatus(req.params.id, 'claimed', {}, req.body?.notes);
    d ? res.json(d) : res.status(404).json({ error: 'Deal not found' });
  } catch (e) { next(e); }
});

router.post('/deals/:id/sold', async (req, res, next) => {
  try {
    const salePrice = Number(req.body?.salePrice);
    if (!salePrice) return res.status(400).json({ error: 'salePrice is required' });
    const commission = +(salePrice * RATE() / 100).toFixed(2);
    const d = await setStatus(req.params.id, 'sold', { sale_price: salePrice, commission },
      req.body?.notes || `Sold for $${salePrice}; commission $${commission}`);
    d ? res.json(d) : res.status(404).json({ error: 'Deal not found' });
  } catch (e) { next(e); }
});

router.post('/deals/:id/pass', async (req, res, next) => {
  try {
    const d = await setStatus(req.params.id, 'passed', {}, req.body?.notes);
    d ? res.json(d) : res.status(404).json({ error: 'Deal not found' });
  } catch (e) { next(e); }
});

module.exports = router;
