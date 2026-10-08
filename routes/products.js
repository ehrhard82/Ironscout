// GET  /api/products                 tracked products with listing/deal counts and market medians
// POST /api/products { name }        start tracking a new product (then run ingest for it)
// GET  /api/products/:id/market      per-state medians for one product
const router = require('express').Router();
const pool = require('../lib/db');
const { requireAccess, requireRole } = require('../lib/auth');

router.get('/', requireAccess, async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT p.id, p.name, p.category,
             COUNT(l.id) FILTER (WHERE l.is_active)::int AS active_listings,
             COUNT(d.id) FILTER (WHERE d.commission_status='open')::int AS open_deals,
             ms.median_price AS us_median, ms.sample_size AS us_sample,
             MAX(l.last_seen) AS last_ingest
      FROM products p
      LEFT JOIN listings l ON l.product_id = p.id
      LEFT JOIN deals d ON d.listing_id = l.id
      LEFT JOIN market_stats ms ON ms.product_id = p.id AND ms.region_type='country'
      GROUP BY p.id, ms.median_price, ms.sample_size
      ORDER BY p.name`);
    res.json({ count: r.rows.length, products: r.rows });
  } catch (e) { next(e); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, category = 'heavy_equipment', description } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const r = await pool.query(
      `INSERT INTO products (name, category, description) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category RETURNING *`,
      [name.trim().toLowerCase(), category, description || null]);
    res.status(201).json({ ...r.rows[0], next_step: `npm run ingest -- "${r.rows[0].name}"` });
  } catch (e) { next(e); }
});

router.get('/:id/market', requireAccess, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT region_type, region, median_price, mean_price, p25_price, p75_price, min_price, max_price, sample_size, calculated_at
       FROM market_stats WHERE product_id = $1 ORDER BY region_type, sample_size DESC`, [req.params.id]);
    res.json({ count: r.rows.length, regions: r.rows });
  } catch (e) { next(e); }
});

module.exports = router;
