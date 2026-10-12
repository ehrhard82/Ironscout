// GET /api/deals            best deals, filterable
// GET /api/deals/:id        one deal with full listing + market context
const router = require('express').Router();
const pool = require('../lib/db');
const { buyersSql, buyerCountSql, isStaff } = require('../lib/buyers');
const { attachLanded } = require('../lib/landed');
const { blockedSql, EFFECTIVE_STATUS_SQL, notPassedSql, attachClaims } = require('../lib/orgs');

const dealSelect = (user) => `
  SELECT d.id, d.deal_score, d.discount_percent, d.discount_amount, d.estimated_margin, d.market_price,
         d.compared_to, d.commission_status, d.flagged_at,
         l.id AS listing_id, l.title, l.price, l.condition, l.year, l.hours,
         l.city, l.state, l.zip_code, l.latitude, l.longitude, l.url, l.image_url, l.seller_name, l.source, l.sale_type, l.auction_ends, l.posted_date,
         p.name AS product
  FROM deals d
  JOIN listings l ON l.id = d.listing_id
  JOIN products p ON p.id = d.product_id
  WHERE l.is_active AND (l.auction_ends IS NULL OR l.auction_ends > NOW()) AND l.id NOT IN ${blockedSql(user)}`;

router.get('/', async (req, res, next) => {
  try {
    const { product, state, states, minDiscount, minMargin, minPrice, maxPrice, minScore, status = 'open', sort = 'score', limit = 50, hasBuyer } = req.query;
    const staff = isStaff(req.user);
    const where = [];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

    if (product) add('p.name ILIKE ?', `%${product}%`);
    if (state) add('l.state = ?', state.toUpperCase());
    if (states) add('l.state = ANY(?)', states.toUpperCase().split(',').map(s => s.trim()));
    if (minDiscount) add('d.discount_percent >= ?', Number(minDiscount));
    if (maxPrice) add('l.price <= ?', Number(maxPrice));
    if (minPrice) add('l.price >= ?', Number(minPrice));
    if (minMargin) add('d.estimated_margin >= ?', Number(minMargin));
    if (minScore) add('d.deal_score >= ?', Number(minScore));
    // Status is per company: open (including deals a teammate has claimed, shown with a banner), claimed, sold, passed.
    const ORG = Number(req.user.org_id) || 0;
    const dcJoin = `LEFT JOIN deal_claims dc ON dc.listing_id = l.id AND dc.org_id = ${ORG}`;
    const eff = EFFECTIVE_STATUS_SQL('dc');
    if (status === 'open') where.push(`(${eff} = 'open' OR (${eff} = 'claimed' AND dc.user_id IS DISTINCT FROM ${Number(req.user.id)}))`);
    else if (status && status !== 'all') where.push(`${eff} = '${['claimed', 'sold', 'passed'].includes(status) ? status : 'open'}'`);
    if (staff && hasBuyer === '1') where.push(`(${buyerCountSql(req.user)} > 0 OR dc.buyer_id IN (SELECT id FROM buyers WHERE owner_user_id = ${Number(req.user.id)}))`);

    const order = {
      score: 'd.deal_score DESC, d.discount_percent DESC',
      discount: 'd.discount_percent DESC',
      savings: 'd.discount_amount DESC',
      margin: 'd.estimated_margin DESC',
      price_low: 'l.price ASC',
      newest: 'l.posted_date DESC NULLS LAST',
      buyers: `${staff ? buyerCountSql(req.user) : '0'} DESC, d.deal_score DESC`,
    }[sort] || 'd.deal_score DESC';

    params.push(Math.min(Number(limit) || 50, 500));
    const base = dealSelect(req.user);
    const select = staff ? base.replace('p.name AS product', `p.name AS product, ${buyersSql(req.user)}`) : base;
    const sql = `${select.replace('WHERE l.is_active', dcJoin + ' WHERE l.is_active')} ${where.length ? 'AND ' + where.join(' AND ') : ''}
                 ORDER BY ${order} LIMIT $${params.length}`;
    const r = await pool.query(sql, params);
    const u = (await pool.query('SELECT yard_city, yard_state, commission_percent FROM users WHERE id = $1', [req.user.id])).rows[0] || {};
    const rows = require('../lib/dedupe').dedupe(r.rows);
    await attachClaims(rows, req.user);
    res.json({ count: rows.length, deals: attachLanded(rows, u) });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const r = await pool.query(`${dealSelect(req.user)} AND d.id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const deal = r.rows[0];
    const [stats, history, log] = await Promise.all([
      pool.query(`SELECT region_type, region, median_price, p25_price, p75_price, sample_size
                  FROM market_stats WHERE product_id = (SELECT product_id FROM deals WHERE id=$1)
                  AND (region_type='country' OR region=$2)`, [deal.id, deal.state]),
      pool.query('SELECT old_price, new_price, changed_at FROM price_history WHERE listing_id=$1 ORDER BY changed_at', [deal.listing_id]),
      pool.query('SELECT action, notes, created_at FROM broker_interactions WHERE deal_id=$1 ORDER BY created_at', [deal.id]),
    ]);
    res.json({ ...deal, market: stats.rows, price_history: history.rows, activity: log.rows });
  } catch (e) { next(e); }
});

module.exports = router;
