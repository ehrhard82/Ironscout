// The 7 AM brief: one email per salesman/broker with their day on it — leads on their plate, follow-ups due,
// fresh deals for their buyers, and (for brokers) how the team looks. Sent once a day from the alerts ping
// once BRIEF_HOUR (America/New_York) has passed. Only lands for real once mail is on a verified domain.
const pool = require('./db');

const TZ = () => process.env.BUDGET_TZ || 'America/New_York';
const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ() }).format(new Date());   // YYYY-MM-DD local
const hourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ(), hour: 'numeric', hour12: false }).format(new Date()));
const money = (n) => n == null ? '' : '$' + Math.round(Number(n)).toLocaleString();

async function buildFor(user) {
  const origin = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const org = user.org_id || 0;
  const lines = [];
  // follow-ups
  const fu = (await pool.query(`SELECT title, note, due_at FROM followups WHERE user_id = $1 AND done_at IS NULL AND due_at IS NOT NULL AND due_at < (NOW() AT TIME ZONE 'UTC') + interval '1 day' ORDER BY due_at LIMIT 10`, [user.id])).rows;
  if (fu.length) lines.push(`FOLLOW-UPS TODAY (${fu.length})`, ...fu.map(f => `  • ${f.title || ''}${f.note ? ' — ' + f.note : ''}${new Date(f.due_at) < new Date() ? ' (overdue)' : ''}`), '');
  // leads
  const leads = (await pool.query(`SELECT l.name, COALESCE(s.phone, l.phone) AS phone, l.signal_text, s.status, s.assigned_at FROM lead_state s JOIN leads l ON l.id = s.lead_id
                                   WHERE s.org_id = $1 AND s.assigned_to = $2 AND s.status IN ('new','assigned') ORDER BY s.assigned_at DESC, l.signal DESC LIMIT 8`, [org, user.id])).rows;
  const leadCount = (await pool.query(`SELECT COUNT(*)::int AS n FROM lead_state WHERE org_id = $1 AND assigned_to = $2 AND status IN ('new','assigned')`, [org, user.id])).rows[0].n;
  if (leadCount) lines.push(`LEADS WAITING ON YOU (${leadCount})`, ...leads.map(l => `  • ${l.name}${l.phone ? ' · ' + l.phone : ''}${l.signal_text ? ' · ' + l.signal_text : ''}`), leadCount > leads.length ? `  …and ${leadCount - leads.length} more` : '', '');
  // fresh deals for this person's buyers (last 24h)
  const deals = (await pool.query(`
    SELECT DISTINCT ON (d.id) d.id, l.title, l.price::float AS price, d.market_price::float AS market, l.city, l.state, b.company
    FROM deals d JOIN listings l ON l.id = d.listing_id JOIN products p ON p.id = d.product_id
    JOIN buyer_wants w ON w.product_id = p.id AND w.active JOIN buyers b ON b.id = w.buyer_id AND b.active AND b.owner_user_id = $1
    WHERE d.flagged_at > NOW() - interval '26 hours' AND (w.max_price IS NULL OR l.price <= w.max_price) AND (w.min_year IS NULL OR l.year IS NULL OR l.year >= w.min_year)
      AND (w.states IS NULL OR cardinality(w.states) = 0 OR l.state = ANY(w.states))
    ORDER BY d.id, d.deal_score DESC LIMIT 10`, [user.id])).rows;
  if (deals.length) lines.push(`NEW DEALS FOR YOUR BUYERS (${deals.length})`, ...deals.map(d => `  • ${d.title} — ${money(d.price)}${d.market ? ` (market ${money(d.market)})` : ''}${d.city ? ` · ${d.city}, ${d.state}` : ''} → ${d.company}`), '');
  // broker: team snapshot
  if (['admin', 'broker'].includes(user.role) && org) {
    const t = (await pool.query(`SELECT u.name, COUNT(s.lead_id) FILTER (WHERE s.status IN ('new','assigned'))::int AS untouched, COUNT(s.lead_id) FILTER (WHERE s.status = 'talking')::int AS talking,
                                        COUNT(s.lead_id) FILTER (WHERE s.status IN ('new','assigned') AND s.assigned_at < NOW() - interval '7 days')::int AS stale
                                 FROM users u LEFT JOIN lead_state s ON s.assigned_to = u.id AND s.org_id = $1 WHERE u.org_id = $1 AND u.role = 'agent' GROUP BY u.id ORDER BY u.name`, [org])).rows;
    const claims = (await pool.query(`SELECT COUNT(*)::int AS n FROM deal_claims WHERE org_id = $1 AND status = 'claimed'`, [org])).rows[0].n;
    if (t.length) lines.push(`YOUR TEAM`, ...t.map(x => `  • ${x.name}: ${x.untouched} untouched${x.stale ? ` (${x.stale} stale)` : ''}, ${x.talking} talking`), `  Open claims across the team: ${claims}`, '');
  }
  if (!lines.length) return null;
  lines.push(`Open IronScout: ${origin}/broker.html`);
  return lines.join('\n');
}

async function sendBriefs() {
  if (hourNow() < Number(process.env.BRIEF_HOUR || 7)) return { sent: 0, reason: 'before brief hour' };
  const key = todayKey();
  const users = (await pool.query(`SELECT u.id, u.email, u.name, u.role, u.org_id FROM users u
                                   WHERE u.role IN ('admin','broker','agent') AND u.email IS NOT NULL AND COALESCE(u.brief_opt_out, FALSE) = FALSE
                                     AND COALESCE(u.brief_sent_on, '') <> $1`, [key])).rows;
  let sent = 0;
  for (const u of users) {
    await pool.query(`UPDATE users SET brief_sent_on = $2 WHERE id = $1`, [u.id, key]);   // stamp first so a crash can't double-send
    try {
      const text = await buildFor(u);
      if (!text) continue;
      await require('./mailer').send({ to: u.email, subject: `Your IronScout morning — ${new Date().toLocaleDateString('en-US', { timeZone: TZ(), weekday: 'short', month: 'short', day: 'numeric' })}`, text: `Morning ${u.name ? u.name.split(' ')[0] : ''}.\n\n${text}` });
      sent++;
    } catch (e) { console.log('brief failed for', u.email, e.message); }
  }
  return { sent };
}

module.exports = { sendBriefs, buildFor };
