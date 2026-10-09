// GET /api/lookup?q=wheel loader
// The front page. One query -> everything the user wants to know about a machine:
//   - which tracked product matched (fuzzy)
//   - the market picture: US median, sample size, per-state medians
//   - deals on it, filtered by the user's settings (states, % below, $ margin)
//   - whether it's on their watchlist
// If nothing matches, says so and offers to request it.
const router = require('express').Router();
const pool = require('../lib/db');
const { requireAccess } = require('../lib/auth');
const { matchSql, effective, DEAL_COLS } = require('./watchlists');

router.get('/', requireAccess, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.status(400).json({ error: 'Type a machine, e.g. "wheel loader"' });

    // exact, then contains, then every word present
    const words = q.split(/\s+/).filter(Boolean);
    const p = await pool.query(`
      SELECT id, name FROM products
      WHERE name = $1
         OR name ILIKE $2
         OR ${words.map((_, i) => `name ILIKE $${i + 3}`).join(' AND ')}
      ORDER BY (name = $1) DESC, (name ILIKE $2) DESC, length(name) LIMIT 5`,
      [q, `%${q}%`, ...words.map(w => `%${w}%`)]);
    if (!p.rows.length) {
      const all = await pool.query('SELECT name FROM products ORDER BY name');
      return res.json({ tracked: false, query: q, tracked_machines: all.rows.map(r => r.name),
                        message: `We don't track "${q}" yet. Request it and we'll add it if we can source listings.` });
    }
    const product = p.rows[0];
    const u = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    const ignoreSettings = req.query.all === '1';
    const f = ignoreSettings ? { product_id: product.id } : effective(u, { product_id: product.id });

    const params = [req.user.id];
    const [market, deals, counts, watched] = await Promise.all([
      pool.query(`SELECT region_type, region, median_price, p25_price, p75_price, min_price, max_price, sample_size
                  FROM market_stats WHERE product_id = $1 ORDER BY region_type, sample_size DESC`, [product.id]),
      pool.query(`SELECT ${DEAL_COLS}, (sd.deal_id IS NOT NULL) AS saved
                  FROM deals d JOIN listings l ON l.id = d.listing_id JOIN products p ON p.id = d.product_id
                  LEFT JOIN saved_deals sd ON sd.deal_id = d.id AND sd.user_id = $1
                  WHERE ${matchSql(f, params)} ORDER BY d.deal_score DESC LIMIT 100`, params),
      pool.query(`SELECT COUNT(*) FILTER (WHERE l.is_active)::int AS active_listings,
                         COUNT(d.id) FILTER (WHERE l.is_active AND d.commission_status <> 'passed')::int AS all_deals,
                         MAX(l.last_seen) AS last_updated
                  FROM listings l LEFT JOIN deals d ON d.listing_id = l.id WHERE l.product_id = $1`, [product.id]),
      pool.query('SELECT 1 FROM watchlists WHERE user_id = $1 AND product_id = $2', [req.user.id, product.id]),
    ]);
    const us = market.rows.find(r => r.region_type === 'country');
    const qs = require('../lib/ingestQueue').status();
    res.json({
      tracked: true, query: q, product, other_matches: p.rows.slice(1),
      fetching: qs.running === product.name || qs.queued.includes(product.name),
      watched: watched.rows.length > 0,
      market: { us_median: us?.median_price || null, us_p25: us?.p25_price || null, us_p75: us?.p75_price || null, sample_size: us?.sample_size || 0,
                by_state: market.rows.filter(r => r.region_type === 'state') },
      ...counts.rows[0],
      filters_applied: !ignoreSettings, filters: ignoreSettings ? null : f,
      count: deals.rows.length, deals: deals.rows,
    });
  } catch (e) { next(e); }
});

module.exports = router;
