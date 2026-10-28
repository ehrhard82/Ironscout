// Find buyers: the demand side. Who is about to need iron (drilling permits), where the bidding is
// (demand heat from the listings we already pull), and a public intake link per rep.
// Paid add-on per company (organizations.demand_access); the platform admin always has it.
const router = require('express').Router();
const pool = require('../lib/db');
const { log } = require('../lib/activity');

const gate = (req, res, next) => (req.user && req.user.demand_access) ? next() : res.status(403).json({ error: 'Find buyers is not turned on for your company yet', upsell: true });
const isAdmin = (u) => u.role === 'admin';

// GET /api/demand/operators?days=30&county=Midland,Howard&q=diamondback&min=1
// Operators ranked by permits in the window; flags the ones already in this rep's buyer list.
router.get('/operators', gate, async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
    const counties = String(req.query.county || '').split(',').map(s => s.trim()).filter(Boolean);
    const q = String(req.query.q || '').trim();
    const params = [String(days)];
    let where = `COALESCE(p.issued_at, p.received_at) > NOW() - ($1 || ' days')::interval`;
    if (counties.length) { params.push(counties); where += ` AND p.county = ANY($${params.length})`; }
    if (q) { params.push(`%${q}%`); where += ` AND p.operator_name ILIKE $${params.length}`; }
    params.push(req.user.id);
    const r = await pool.query(`
      SELECT COALESCE(NULLIF(p.operator_no,''), 'name:' || lower(p.operator_name)) AS key, MAX(p.operator_name) AS name,
             COUNT(*)::int AS permits, COUNT(*) FILTER (WHERE p.status = 'pending')::int AS pending,
             COUNT(*) FILTER (WHERE COALESCE(p.issued_at, p.received_at) > NOW() - interval '7 days')::int AS last_7d,
             STRING_AGG(DISTINCT p.county, ', ' ORDER BY p.county) AS counties,
             MAX(COALESCE(p.issued_at, p.received_at)) AS last_permit_at,
             MAX(o.phone) AS phone, MAX(o.city) AS city, MAX(o.st) AS st, MAX(o.website) AS website,
             EXISTS (SELECT 1 FROM buyers b WHERE b.owner_user_id = $${params.length} AND lower(b.company) = lower(MAX(p.operator_name))) AS in_my_buyers
      FROM permits p LEFT JOIN operators o ON o.state = p.state AND o.operator_no = COALESCE(NULLIF(p.operator_no,''), 'name:' || lower(p.operator_name))
      WHERE ${where}
      GROUP BY 1 ORDER BY permits DESC, last_permit_at DESC LIMIT 300`, params);
    const meta = await pool.query(`SELECT (SELECT value FROM app_state WHERE key = 'permits_refreshed_at') AS refreshed_at, (SELECT COUNT(*)::int FROM permits) AS permits,
                                          (SELECT COUNT(DISTINCT county) FROM permits WHERE county IS NOT NULL)::int AS counties`);
    const countyList = await pool.query(`SELECT county, COUNT(*)::int AS n FROM permits WHERE county IS NOT NULL AND COALESCE(issued_at, received_at) > NOW() - ($1 || ' days')::interval GROUP BY county ORDER BY n DESC LIMIT 60`, [String(days)]);
    res.json({ days, count: r.rows.length, operators: r.rows, ...meta.rows[0], top_counties: countyList.rows });
  } catch (e) { next(e); }
});

// GET /api/demand/operators/:key/permits — the actual permits behind one operator (lease, county, dates)
router.get('/operators/:key/permits', gate, async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT permit_no, status, county, district, lease_name, well_no, received_at, issued_at FROM permits
                                WHERE COALESCE(NULLIF(operator_no,''), 'name:' || lower(operator_name)) = $1 ORDER BY COALESCE(issued_at, received_at) DESC LIMIT 100`, [req.params.key]);
    res.json({ permits: r.rows });
  } catch (e) { next(e); }
});

// POST /api/demand/operators/:key/add-buyer — drop an operator into this rep's buyers as a prospect
router.post('/operators/:key/add-buyer', gate, async (req, res, next) => {
  try {
    const o = (await pool.query(`SELECT MAX(operator_name) AS name, STRING_AGG(DISTINCT county, ', ') AS counties FROM permits
                                 WHERE COALESCE(NULLIF(operator_no,''), 'name:' || lower(operator_name)) = $1`, [req.params.key])).rows[0];
    if (!o || !o.name) return res.status(404).json({ error: 'Operator not found' });
    const op = (await pool.query(`SELECT phone, city, st FROM operators WHERE operator_no = $1 AND state = 'TX'`, [req.params.key])).rows[0] || {};
    const existing = await pool.query(`SELECT id FROM buyers WHERE owner_user_id = $1 AND lower(company) = lower($2)`, [req.user.id, o.name]);
    if (existing.rows.length) return res.json({ ok: true, buyer_id: existing.rows[0].id, existed: true });
    const r = await pool.query(`INSERT INTO buyers (company, phone, city, state, notes, status, source, owner_user_id)
                                VALUES ($1,$2,$3,$4,$5,'prospect','rrc',$6) RETURNING id`,
      [o.name, op.phone || null, op.city || null, op.st || null, `From drilling permits: active in ${o.counties || 'Texas'}. ${req.body?.notes || ''}`.trim(), req.user.id]);
    log(req.user, 'added buyer', `${o.name} (from permits)`);
    res.status(201).json({ ok: true, buyer_id: r.rows[0].id });
  } catch (e) { next(e); }
});

// ---- the lead list ----
const leads = require('../lib/demand/leads');
const canAssign = (u) => ['admin', 'broker'].includes(u.role);
router.get('/leads', gate, async (req, res, next) => { try { res.json(await leads.list(req.user, req.query)); } catch (e) { next(e); } });
router.get('/team', gate, async (req, res, next) => { try { if (!canAssign(req.user)) return res.status(403).json({ error: 'broker or admin only' }); res.json(await leads.team(req.user)); } catch (e) { next(e); } });
router.post('/leads/assign', gate, async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 500);
    const to = req.body?.assigned_to ? Number(req.body.assigned_to) : null;
    if (!canAssign(req.user) && !(req.user.role === 'agent' && to === req.user.id)) return res.status(403).json({ error: 'Only the broker or admin hands out leads' });
    const n = await leads.assign(req.user, ids, to);
    log(req.user, to ? 'assigned leads' : 'unassigned leads', `${n}`);
    res.json({ ok: true, updated: n });
  } catch (e) { next(e); }
});
// Broker: let salesmen pick from the unassigned pool (or not)
router.post('/settings', gate, async (req, res, next) => {
  try {
    if (!canAssign(req.user)) return res.status(403).json({ error: 'broker or admin only' });
    if (typeof req.body?.agents_pick === 'boolean') await pool.query(`UPDATE organizations SET agents_pick = $2 WHERE id = $1`, [req.user.org_id, req.body.agents_pick]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Hand-out rules (broker/admin)
router.get('/rules', gate, async (req, res, next) => { try { if (!canAssign(req.user)) return res.status(403).json({ error: 'broker or admin only' }); res.json({ rules: await leads.rules(Number(req.user.org_id)) }); } catch (e) { next(e); } });
router.post('/rules', gate, async (req, res, next) => {
  try { if (!canAssign(req.user)) return res.status(403).json({ error: 'broker or admin only' }); const b = req.body || {};
    const id = await leads.addRule(req.user, { kind: b.kind || null, fleet_min: b.fleet_min === '' || b.fleet_min == null ? null : Number(b.fleet_min), fleet_max: b.fleet_max === '' || b.fleet_max == null ? null : Number(b.fleet_max), county: b.county || null, assigned_to: Number(b.assigned_to) });
    const applied = b.apply ? await leads.applyRules(Number(req.user.org_id), req.user.id) : 0;
    log(req.user, 'added hand-out rule', `${b.kind || 'any'} ${b.fleet_min ?? ''}-${b.fleet_max ?? ''} ${b.county || ''}`.trim());
    res.status(201).json({ id, applied }); } catch (e) { next(e); }
});
router.delete('/rules/:id', gate, async (req, res, next) => { try { if (!canAssign(req.user)) return res.status(403).json({ error: 'broker or admin only' }); await leads.deleteRule(req.user, Number(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); } });
router.post('/rules/apply', gate, async (req, res, next) => { try { if (!canAssign(req.user)) return res.status(403).json({ error: 'broker or admin only' }); const n = await leads.applyRules(Number(req.user.org_id), req.user.id); log(req.user, 'assigned leads', `${n} by rules`); res.json({ assigned: n }); } catch (e) { next(e); } });
router.patch('/leads/:id', gate, async (req, res, next) => {
  try { res.json(await leads.update(req.user, Number(req.params.id), req.body || {})); } catch (e) { next(e); }
});
// Lead -> buyer for the person clicking (or for its assigned rep, when a broker clicks)
router.post('/leads/:id/add-buyer', gate, async (req, res, next) => {
  try {
    const org = Number(req.user.org_id);
    const l = (await pool.query(`SELECT l.*, s.assigned_to, s.buyer_id, COALESCE(s.phone, l.phone) AS phone, COALESCE(s.email, l.email) AS email, s.contact_name FROM leads l LEFT JOIN lead_state s ON s.lead_id = l.id AND s.org_id = $2 WHERE l.id = $1 AND (l.org_id IS NULL OR l.org_id = $2)`, [req.params.id, org])).rows[0];
    if (!l) return res.status(404).json({ error: 'Lead not found' });
    if (l.buyer_id) return res.json({ ok: true, buyer_id: l.buyer_id, existed: true });
    const owner = l.assigned_to || req.user.id;
    const existing = await pool.query(`SELECT id FROM buyers WHERE owner_user_id = $1 AND lower(company) = lower($2)`, [owner, l.name]);
    const buyerId = existing.rows.length ? existing.rows[0].id : (await pool.query(
      `INSERT INTO buyers (company, contact_name, phone, email, city, state, notes, status, source, owner_user_id) VALUES ($1,$9,$2,$3,$4,$5,$6,'prospect',$7,$8) RETURNING id`,
      [l.name, l.phone || null, l.email || null, l.city || null, l.st || null, `${l.kind === 'operator' ? 'From drilling permits' : l.kind === 'carrier' ? 'From the trucking registry' : 'Lead'}: ${l.signal_text || ''}${l.counties ? ' · ' + l.counties : ''}`.trim(), l.kind === 'operator' ? 'rrc' : l.kind === 'carrier' ? 'fmcsa' : 'lead', owner, l.contact_name || null])).rows[0].id;
    await leads.update(req.user, l.id, { status: 'talking', buyer_id: buyerId });
    log(req.user, 'added buyer', `${l.name} (lead)`);
    res.status(201).json({ ok: true, buyer_id: buyerId });
  } catch (e) { next(e); }
});
// Carriers (FMCSA): refresh / status / raw sample — admin
router.post('/carriers/refresh', async (req, res, next) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(require('../lib/demand/fmcsa').refreshInBackground()); } catch (e) { next(e); } });
router.get('/carriers/status', async (req, res, next) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(await require('../lib/demand/fmcsa').status()); } catch (e) { next(e); } });
router.get('/carriers/sample', async (req, res, next) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(await require('../lib/demand/fmcsa').sample()); } catch (e) { next(e); } });
// More feeds (OK/NM permits, TX new businesses, TX plugging): refresh / status / sample — admin
// Website crawl: what each company does / runs / where, from their own site. Admin starts a batch; everyone with access sees the tags.
router.post('/sites/crawl', async (req, res, next) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); const b = req.body || {}; res.json(require('../lib/demand/sites').runInBackground({ st: String(b.st || 'TX').toUpperCase(), segment: b.segment || 'service', limit: Math.min(Number(b.limit) || 200, 2000), recrawl: Boolean(b.recrawl) })); } catch (e) { next(e); } });
router.get('/sites/status', async (req, res, next) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(await require('../lib/demand/sites').status()); } catch (e) { next(e); } });
router.get('/sites/test', async (req, res) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(await require('../lib/demand/sites').crawlSite(String(req.query.domain || ''))); } catch (e) { res.status(500).json({ error: e.message }); } });
router.get('/sites/tags', async (req, res, next) => { try { res.json({ tags: await require('../lib/demand/sites').tagCounts(req.user.org_id) }); } catch (e) { next(e); } });
router.post('/more/refresh', async (req, res, next) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(require('../lib/demand/more').refreshInBackground()); } catch (e) { next(e); } });
router.get('/more/status', async (req, res, next) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(await require('../lib/demand/more').status()); } catch (e) { next(e); } });
router.get('/more/sample', async (req, res, next) => { try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(await require('../lib/demand/more').sample(String(req.query.feed || 'okPermits'))); } catch (e) { res.status(500).json({ error: e.message, body: e.response ? JSON.stringify(e.response.data).slice(0, 400) : undefined }); } });
router.post('/leads/sync', async (req, res, next) => {
  try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json({ synced: await leads.syncOperators() }); } catch (e) { next(e); }
});

// GET /api/demand/heat — where the bidding is: per machine, how many listings have bids, how many
// prices moved up this week, the hottest listings. Uses data the refresh already stores.
router.get('/heat', gate, async (req, res, next) => {
  try {
    // "price up" = the listing is really higher now than a week ago (net, not every wiggle), by at least 2%.
    // On an auction that's a bid landing; on a dealer listing it's rare and meaningful. US listings only.
    const r = await pool.query(`
      WITH live AS (
        SELECT l.*, p.name AS machine FROM listings l JOIN products p ON p.id = l.product_id
        WHERE l.is_active AND (l.auction_ends IS NULL OR l.auction_ends > NOW()) AND COALESCE(l.country,'US') = 'US'
      ), moved AS (
        SELECT h.listing_id, (array_agg(h.old_price ORDER BY h.changed_at ASC))[1]::float AS week_ago, COUNT(*)::int AS changes
        FROM price_history h WHERE h.changed_at > NOW() - interval '7 days' GROUP BY h.listing_id
      ), ups AS (
        SELECT m.listing_id, m.changes FROM moved m JOIN listings l ON l.id = m.listing_id WHERE l.price::float > m.week_ago * 1.02
      )
      SELECT machine,
             COUNT(*)::int AS live_listings,
             COUNT(*) FILTER (WHERE COALESCE(bids,0) > 0)::int AS with_bids,
             COALESCE(SUM(bids),0)::int AS total_bids,
             COUNT(ups.listing_id)::int AS prices_up_7d,
             COUNT(*) FILTER (WHERE sale_type = 'auction' AND auction_ends < NOW() + interval '3 days')::int AS ending_soon,
             ROUND((COUNT(*) FILTER (WHERE COALESCE(bids,0) > 0)::numeric / NULLIF(COUNT(*) FILTER (WHERE sale_type = 'auction'),0)) * 100)::int AS pct_auctions_bid
      FROM live LEFT JOIN ups ON ups.listing_id = live.id
      GROUP BY machine ORDER BY total_bids DESC, prices_up_7d DESC, live_listings DESC`);
    const hot = await pool.query(`
      WITH moved AS (
        SELECT h.listing_id, (array_agg(h.old_price ORDER BY h.changed_at ASC))[1]::float AS week_ago, COUNT(*)::int AS changes
        FROM price_history h WHERE h.changed_at > NOW() - interval '7 days' GROUP BY h.listing_id
      )
      SELECT l.id, l.title, l.price::float AS price, l.bids, l.watchers, l.city, l.state, l.source, l.url, l.auction_ends, l.sale_type, p.name AS machine,
             m.week_ago, CASE WHEN m.week_ago IS NOT NULL AND l.price::float > m.week_ago * 1.02 THEN ROUND(((l.price::float - m.week_ago) / m.week_ago * 100)::numeric)::int ELSE NULL END AS up_pct
      FROM listings l JOIN products p ON p.id = l.product_id LEFT JOIN moved m ON m.listing_id = l.id
      WHERE l.is_active AND (l.auction_ends IS NULL OR l.auction_ends > NOW()) AND COALESCE(l.country,'US') = 'US'
        AND (COALESCE(l.bids,0) > 0 OR (m.week_ago IS NOT NULL AND l.price::float > m.week_ago * 1.02))
      ORDER BY COALESCE(l.bids,0) DESC, up_pct DESC NULLS LAST LIMIT 40`);
    const soldPace = await pool.query(`
      SELECT p.name AS machine, COUNT(*) FILTER (WHERE s.sold_at > NOW() - interval '30 days')::int AS sold_30d, COUNT(*) FILTER (WHERE s.sold_at > NOW() - interval '90 days' AND s.sold_at <= NOW() - interval '30 days')::int AS sold_prev_60d
      FROM sales s JOIN products p ON p.id = s.product_id GROUP BY p.name`);
    const pace = Object.fromEntries(soldPace.rows.map(x => [x.machine, x]));
    res.json({ machines: r.rows.map(m => ({ ...m, sold_30d: pace[m.machine]?.sold_30d || 0, sold_prev_60d_avg: Math.round((pace[m.machine]?.sold_prev_60d || 0) / 2) })), hot: hot.rows });
  } catch (e) { next(e); }
});

// GET /api/demand/intake-link — this rep's public link (made on first ask)
router.get('/intake-link', gate, async (req, res, next) => {
  try {
    let slug = req.user.intake_slug;
    if (!slug) {
      const base = String(req.user.name || req.user.email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'rep';
      for (let i = 0; i < 20; i++) {
        const cand = i ? `${base}-${Math.random().toString(36).slice(2, 5)}` : base;
        const r = await pool.query(`UPDATE users SET intake_slug = $1 WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM users WHERE intake_slug = $1) RETURNING intake_slug`, [cand, req.user.id]);
        if (r.rows.length) { slug = cand; break; }
      }
    }
    const origin = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ slug, url: `${origin.replace(/\/$/, '')}/want/${slug}` });
  } catch (e) { next(e); }
});

// Admin: refresh permits now / look at the raw files
router.post('/permits/refresh', async (req, res, next) => {
  try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(require('../lib/demand/rrc').refreshInBackground()); } catch (e) { next(e); }
});
router.get('/permits/status', async (req, res, next) => {
  try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(await require('../lib/demand/rrc').lastResult()); } catch (e) { next(e); }
});
router.get('/permits/sample', async (req, res, next) => {
  try { if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin only' }); res.json(await require('../lib/demand/rrc').sample(req.query.kind)); } catch (e) { next(e); }
});

module.exports = router;
