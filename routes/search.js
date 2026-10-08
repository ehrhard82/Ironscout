// GET /api/search?q=bobcat&state=TX&maxPrice=40000&sort=price_low
// Searches ALL active listings (not just deals), with deal info attached when present.
const router = require('express').Router();
const pool = require('../lib/db');

router.get('/', async (req, res, next) => {
  try {
    const { q, product, state, minPrice, maxPrice, source, sort = 'score', limit = 100 } = req.query;
    const where = ['l.is_active'];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

    if (q) { params.push(`%${q}%`); where.push(`(l.title ILIKE $${params.length} OR p.name ILIKE $${params.length})`); }
    if (product) add('p.name ILIKE ?', `%${product}%`);
    if (state) add('l.state = ?', state.toUpperCase());
    if (minPrice) add('l.price >= ?', Number(minPrice));
    if (maxPrice) add('l.price <= ?', Number(maxPrice));
    if (source) add('l.source = ?', source);

    const order = {
      score: 'd.deal_score DESC NULLS LAST, l.posted_date DESC NULLS LAST',
      price_low: 'l.price ASC', price_high: 'l.price DESC',
      newest: 'l.posted_date DESC NULLS LAST',
    }[sort] || 'l.price ASC';

    params.push(Math.min(Number(limit) || 100, 500));
    const r = await pool.query(`
      SELECT l.id, l.title, l.price, l.condition, l.year, l.hours, l.city, l.state, l.zip_code,
             l.url, l.image_url, l.source, l.seller_name, l.sale_type, l.auction_ends, l.posted_date, p.name AS product,
             d.deal_score, d.discount_percent, d.estimated_margin, d.market_price, d.compared_to
      FROM listings l
      JOIN products p ON p.id = l.product_id
      LEFT JOIN deals d ON d.listing_id = l.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT $${params.length}`, params);
    res.json({ count: r.rows.length, listings: r.rows });
  } catch (e) { next(e); }
});

module.exports = router;
