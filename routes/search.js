// GET /api/search?q=bobcat&state=TX&maxPrice=40000&sort=price_low
// Searches ALL active listings (not just deals), with deal info attached when present.
const router = require('express').Router();
const pool = require('../lib/db');
const { blockedSql, notPassedSql } = require('../lib/orgs');

router.get('/', async (req, res, next) => {
  try {
    const { q, product, state, minPrice, maxPrice, source, sort = 'score', limit = 100 } = req.query;
    const where = ['l.is_active', '(l.auction_ends IS NULL OR l.auction_ends > NOW())'];
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


// GET /api/search/machine?name=winch%20truck
// EVERY live listing for one machine (not just deals), each with how its price compares to normal:
// the deal's own comparable median when it has one, otherwise the machine's national median.
router.get('/machine', async (req, res, next) => {
  try {
    const name = String(req.query.name || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { JUNK_SQL, ATTACH_SQL } = require('../lib/pricing');
    const p = await pool.query('SELECT id, name FROM products WHERE name = $1', [name]);
    if (!p.rows.length) return res.status(404).json({ error: 'Unknown machine' });
    const pid = p.rows[0].id;
    const ms = await pool.query(`SELECT median_price, p25_price, p75_price, sample_size, basis FROM market_stats WHERE product_id = $1 AND region_type = 'country'`, [pid]);
    const normal = ms.rows[0] ? Number(ms.rows[0].median_price) : null;
    const r = await pool.query(`
      SELECT l.id, l.title, l.price::float AS price, l.year, l.hours, l.city, l.state, l.url, l.image_url, l.source, l.sale_type,
             l.auction_ends, l.posted_date, d.market_price::float AS deal_market, d.deal_score
      FROM listings l LEFT JOIN deals d ON d.listing_id = l.id AND ${notPassedSql(req.user)}
      WHERE l.product_id = $1 AND l.is_active AND (l.auction_ends IS NULL OR l.auction_ends > NOW())
        AND NOT (${JUNK_SQL}) AND NOT (${ATTACH_SQL}) AND l.id NOT IN ${blockedSql(req.user)}
      ORDER BY l.price ASC LIMIT 600`, [pid]);
    const listings = require('../lib/dedupe').dedupe(r.rows, (a, b) => (b.deal_score || 0) - (a.deal_score || 0)).map(l => {
      const ref = l.deal_market || normal;
      return { ...l, normal: ref, vs_normal_pct: ref ? Math.round(((l.price - ref) / ref) * 100) : null, is_deal: l.deal_market !== null };
    });
    res.json({ machine: p.rows[0].name, normal, market: ms.rows[0] || null, count: listings.length, listings });
  } catch (e) { next(e); }
});

module.exports = router;
