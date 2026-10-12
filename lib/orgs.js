// Companies. The listing/market data is shared; claims, hidden listings and teams are per company.
const pool = require('./db');

const CLAIM_HOURS = () => Number(process.env.CLAIM_HOURS || 48);

/** Listings hidden for this company: platform-wide hides (org NULL) plus the company's own. SQL fragment. */
const blockedSql = (user) => `(SELECT listing_id FROM listing_blocks WHERE org_id IS NULL${user && user.org_id ? ` OR org_id = ${Number(user.org_id)}` : ''})`;
/** Platform-wide hides only (these also stay out of market values). */
const BLOCKED_GLOBAL_SQL = `(SELECT listing_id FROM listing_blocks WHERE org_id IS NULL)`;

/** The effective status of a claim row (alias dc): a lapsed claim counts as open again. */
const EFFECTIVE_STATUS_SQL = (a = 'dc') => `(CASE WHEN ${a}.status = 'claimed' AND ${a}.expires_at IS NOT NULL AND ${a}.expires_at < NOW() THEN 'open' ELSE COALESCE(${a}.status, 'open') END)`;

/** Hides listings this company passed on. Uses alias l = listings. */
const notPassedSql = (user) => user && user.org_id
  ? `NOT EXISTS (SELECT 1 FROM deal_claims x WHERE x.listing_id = l.id AND x.org_id = ${Number(user.org_id)} AND x.status = 'passed')`
  : 'TRUE';

/**
 * Sets d.commission_status (this company's view) and d.claim on each deal row. Rows need listing_id.
 * claim = { by, by_me, at, expires_at, status } for an active claim by someone in the viewer's company.
 */
async function attachClaims(rows, user) {
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map(r => r.listing_id).filter(Boolean))];
  let claims = [];
  if (user && user.org_id && ids.length) {
    claims = (await pool.query(
      `SELECT dc.listing_id, dc.user_id, dc.buyer_id, dc.status, dc.claimed_at, dc.expires_at, u.name AS by_name, u.email AS by_email,
              (SELECT json_build_object('company', b.company, 'contact', b.contact_name) FROM buyers b WHERE b.id = dc.buyer_id AND b.owner_user_id = $3) AS buyer
       FROM deal_claims dc LEFT JOIN users u ON u.id = dc.user_id
       WHERE dc.org_id = $1 AND dc.listing_id = ANY($2::uuid[])`, [user.org_id, ids, user.id])).rows;
  }
  const by = new Map(claims.map(c => [c.listing_id, c]));
  for (const d of rows) {
    const c = by.get(d.listing_id);
    const lapsed = c && c.status === 'claimed' && c.expires_at && new Date(c.expires_at) < new Date();
    d.commission_status = !c || lapsed ? 'open' : c.status;
    d.claim = c && !lapsed ? { status: c.status, by: c.by_name || (c.by_email || '').split('@')[0] || 'a teammate', by_me: c.user_id === user.id, at: c.claimed_at, expires_at: c.expires_at } : null;
    d.claimed_buyer = c && !lapsed && c.user_id === user.id ? c.buyer : null;
  }
  return rows;
}

/** One-time setup at startup: give every account a company; move pre-company claims to the first admin's company. */
async function ensureOrgs() {
  const users = (await pool.query('SELECT id, name, email, role FROM users WHERE org_id IS NULL ORDER BY id')).rows;
  for (const u of users) {
    const org = (await pool.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [(u.name || u.email.split('@')[0]).slice(0, 200)])).rows[0];
    await pool.query('UPDATE users SET org_id = $1 WHERE id = $2', [org.id, u.id]);
  }
  const legacy = (await pool.query(`SELECT COUNT(*)::int AS n FROM deals WHERE commission_status <> 'open'`)).rows[0].n;
  if (legacy) {
    const admin = (await pool.query(`SELECT id, org_id FROM users WHERE role = 'admin' AND org_id IS NOT NULL ORDER BY id LIMIT 1`)).rows[0];
    if (admin) {
      await pool.query(
        `INSERT INTO deal_claims (listing_id, org_id, user_id, buyer_id, status, claimed_at, expires_at, sale_price, commission_earned, notes)
         SELECT d.listing_id, $1, $2, d.buyer_id, d.commission_status, d.flagged_at, NULL, d.sale_price, d.commission_earned, d.notes
         FROM deals d WHERE d.commission_status IN ('claimed', 'sold', 'passed') ON CONFLICT DO NOTHING`, [admin.org_id, admin.id]);
      await pool.query(`UPDATE deals SET commission_status = 'open' WHERE commission_status <> 'open'`);
      console.log(`Moved ${legacy} existing claim(s) into the first admin's company`);
    }
  }
}

module.exports = { CLAIM_HOURS, blockedSql, BLOCKED_GLOBAL_SQL, EFFECTIVE_STATUS_SQL, notPassedSql, attachClaims, ensureOrgs };
