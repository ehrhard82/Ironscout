// Alerts: email and/or text, on the schedule each user chose.
//
// For every user with access, machines on their watchlist, and a channel other
// than "none", we find deals that match their settings and that they haven't been
// told about yet (alert_log). If their chosen frequency says it's time, we send one
// message (email, text, or both) and log every deal in it.
//
//   realtime -> sent at the end of every ingest run (so "real time" = your ingest schedule)
//   hourly   -> at most once an hour       daily -> once a day       weekly -> once a week
//
// sendDigests({ realtimeOnly: true })  is called after each ingest.
// sendDigests()                        is called by the scheduler every 15 minutes
//                                      and sends to whoever is due.

const pool = require('./db');
const mailer = require('./mailer');
const sms = require('./sms');
const { hasAccess } = require('./auth');
const { matchSql, effective } = require('../routes/watchlists');

const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const money = (n) => '$' + Math.round(Number(n)).toLocaleString('en-US');
const HOURS = { realtime: 0, hourly: 1, daily: 24, weekly: 24 * 7 };

function isDue(user) {
  const h = HOURS[user.alert_frequency] ?? 24;
  if (h === 0) return true;
  if (!user.last_digest_at) return true;
  return Date.now() - new Date(user.last_digest_at).getTime() >= h * 3600_000 - 60_000;
}

async function newDealsFor(user) {
  const wl = await pool.query('SELECT * FROM watchlists WHERE user_id = $1 AND alerts', [user.id]);
  const seen = new Set(), out = [];
  for (const w of wl.rows) {
    const params = [];
    const sql = `
      SELECT d.id, d.deal_score, d.discount_percent, d.estimated_margin, d.market_price, d.compared_to,
             l.title, l.price, l.year, l.hours, l.city, l.state, l.url, l.source, l.sale_type, l.auction_ends, p.name AS product
      FROM deals d JOIN listings l ON l.id = d.listing_id JOIN products p ON p.id = d.product_id
      WHERE ${matchSql(effective(user, w), params)}
        AND NOT EXISTS (SELECT 1 FROM alert_log a WHERE a.deal_id = d.id AND a.user_id = $${params.push(user.id)})
      ORDER BY d.deal_score DESC LIMIT 50`;
    for (const d of (await pool.query(sql, params)).rows) if (!seen.has(d.id)) { seen.add(d.id); out.push(d); }
  }
  return out.sort((a, b) => b.deal_score - a.deal_score);
}

const SOURCE_NAMES = { govdeals: 'GovDeals', ironplanet: 'IronPlanet', rbauction: 'Ritchie Bros', ebay: 'eBay', craigslist: 'Craigslist' };
const srcName = (x) => SOURCE_NAMES[x] || x;
const escHtml = (x) => String(x ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
function endsIn(when) {
  const ms = new Date(when) - Date.now();
  if (ms <= 0) return 'auction ended';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h < 1) return `auction ends in ${m} min`;
  if (h < 48) return `auction ends in ${h}h ${m}m`;
  return `auction ends ${new Date(when).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
}
const whenLine = (d) => d.sale_type === 'auction' ? (d.auction_ends ? ` · ${endsIn(d.auction_ends)}` : ' · auction') : ' · buy now / make offer';

function renderEmail(deals) {
  const total = deals.reduce((s, d) => s + Number(d.estimated_margin), 0);
  const line = (d) => {
    const where = [d.city, d.state].filter(Boolean).join(', ') || 'location n/a';
    return `${d.product.toUpperCase()}: ${d.title}\n  ${money(d.price)}  (market ${money(d.market_price)}, ${Math.round(d.discount_percent)}% below ${d.compared_to})\n  est. profit after fees ${money(d.estimated_margin)} · score ${d.deal_score} · ${where} · ${srcName(d.source)}${whenLine(d)}\n  ${d.url || APP_URL()}`;
  };
  const text = `${deals.length} new deal${deals.length === 1 ? '' : 's'} on machines you watch — ${money(total)} combined estimated margin.\n\n${deals.map(line).join('\n\n')}\n\n—\nOpen IronScout: ${APP_URL()}\nChange machines or alert settings: ${APP_URL()}/account.html\n\nIronScout surfaces listings; it does not inspect equipment. Verify condition and title before you buy.`;
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:640px">
    <p><b>${deals.length} new deal${deals.length === 1 ? '' : 's'}</b> on machines you watch — <b>${money(total)}</b> combined estimated margin.</p>
    ${deals.map(d => `<div style="border:1px solid #ddd;border-radius:10px;padding:12px 14px;margin:10px 0">
      <div style="color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">${escHtml(d.product)}</div>
      <div style="font-weight:600"><a href="${escHtml(d.url || APP_URL())}" style="color:#1a4fb4;text-decoration:none">${escHtml(d.title)}</a></div>
      <div style="font-size:20px;font-weight:700;margin:4px 0">${money(d.price)} <span style="font-size:13px;color:#888;text-decoration:line-through;font-weight:400">${money(d.market_price)}</span></div>
      <div style="color:#1d7a3e;font-weight:600">${money(d.market_price - d.price)} under what similar ones ${/sold/.test(d.compared_to) ? 'sold for' : 'are listed at'} · est. profit after fees ${money(d.estimated_margin)}</div>
      <div style="color:#666;font-size:13px">${Math.round(d.discount_percent)}% below ${escHtml(d.compared_to)}</div>
      <div style="color:#666;font-size:13px">score ${d.deal_score} · ${[d.year, d.city, d.state].filter(Boolean).map(escHtml).join(' · ')} · ${srcName(d.source)}${escHtml(whenLine(d))}</div>
      ${d.url ? `<div style="margin-top:8px"><a href="${escHtml(d.url)}" style="background:#f5a524;color:#1a1200;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">View listing</a></div>` : ''}
    </div>`).join('')}
    <p style="color:#888;font-size:12px">IronScout surfaces listings; it does not inspect equipment. Verify condition and title before you buy.<br>
    <a href="${APP_URL()}" style="color:#888">Open IronScout</a> · <a href="${APP_URL()}/account.html" style="color:#888">Alert settings</a></p></div>`;
  const subject = deals.length === 1
    ? `IronScout: ${deals[0].title} — ${money(deals[0].estimated_margin)} margin`
    : `IronScout: ${deals.length} new deals, ${money(total)} margin`;
  return { subject, text, html };
}

/** Texts are short: top 3 deals + a link. */
function renderSms(deals) {
  const top = deals.slice(0, 3).map(d =>
    `${d.year ? d.year + ' ' : ''}${d.product} ${d.state || ''} ${money(d.price)} (${Math.round(d.discount_percent)}% under, ~${money(d.estimated_margin)} margin)`.replace(/\s+/g, ' ').trim());
  const more = deals.length > 3 ? ` +${deals.length - 3} more.` : '';
  return `IronScout: ${deals.length} new deal${deals.length === 1 ? '' : 's'}\n${top.join('\n')}${more}\n${APP_URL()}`;
}

async function sendDigests({ realtimeOnly = false } = {}) {
  const users = await pool.query(`
    SELECT DISTINCT u.* FROM users u JOIN watchlists w ON w.user_id = u.id
    WHERE w.alerts AND u.alert_channel <> 'none'`);
  const stats = { considered: users.rows.length, sent: 0, skipped_not_due: 0, skipped_no_access: 0, errors: 0 };
  for (const u of users.rows) {
    if (!hasAccess(u)) { stats.skipped_no_access++; continue; }
    if (realtimeOnly && u.alert_frequency !== 'realtime') continue;
    if (!isDue(u)) { stats.skipped_not_due++; continue; }
    const deals = await newDealsFor(u);
    if (!deals.length) continue;
    try {
      const wantEmail = ['email', 'both'].includes(u.alert_channel);
      const wantSms = ['sms', 'both'].includes(u.alert_channel) && u.phone;
      if (wantEmail) { const m = renderEmail(deals); await mailer.send({ to: u.email, ...m }); }
      if (wantSms) await sms.send({ to: u.phone, text: renderSms(deals) });
      for (const d of deals) await pool.query('INSERT INTO alert_log (user_id, deal_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, d.id]);
      await pool.query('UPDATE users SET last_digest_at = NOW() WHERE id = $1', [u.id]);
      stats.sent++;
    } catch (e) {
      stats.errors++;
      console.error(`alert to ${u.email} failed:`, e.message);
    }
  }
  return stats;
}

module.exports = { sendDigests, newDealsFor, renderEmail, renderSms, isDue };
