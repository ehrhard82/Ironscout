// "Dusty found you a vac truck": when a listing matches what one of a rep's buyers wants,
// email the buyer in the rep's name. The buyer never sees IronScout - no listing link, just
// the machine, the price, the delivered estimate, and "reply or call me". Once a day per
// buyer at most, only for companies that have switched it on (needs a real sending domain).
const pool = require('./db');
const mailer = require('./mailer');
const { landedCost } = require('./landed');
const money = (n) => '$' + Math.round(Number(n)).toLocaleString();

async function sendBuyerEmails({ limitPerBuyer = 5 } = {}) {
  const stats = { buyers: 0, sent: 0, skipped: 0, errors: 0 };
  if (!process.env.RESEND_API_KEY || /resend\.dev/i.test(process.env.MAIL_FROM || '')) { stats.reason = 'email delivery not set up (needs a verified domain)'; return stats; }
  const buyers = (await pool.query(`
    SELECT b.id, b.company, b.contact_name, b.email, b.city, b.state, b.deliver_city, b.deliver_state, b.last_mailed_at,
           u.id AS rep_id, u.name AS rep_name, u.email AS rep_email, u.phone AS rep_phone, o.name AS org_name
    FROM buyers b JOIN users u ON u.id = b.owner_user_id JOIN organizations o ON o.id = u.org_id
    WHERE b.active AND b.emails AND b.email IS NOT NULL AND b.email <> '' AND o.client_emails
      AND (b.last_mailed_at IS NULL OR b.last_mailed_at < NOW() - INTERVAL '20 hours')`)).rows;
  for (const b of buyers) {
    stats.buyers++;
    const rows = (await pool.query(`
      SELECT DISTINCT ON (l.id) l.id AS listing_id, l.title, l.price::float AS price, l.year, l.hours, l.city, l.state, l.source, l.image_url,
             d.market_price::float AS market_price, d.deal_score, p.name AS product,
             COALESCE(NULLIF(bw.deliver_state,''), NULLIF($2,''), b.state) AS to_state,
             CASE WHEN NULLIF(bw.deliver_state,'') IS NOT NULL THEN bw.deliver_city WHEN NULLIF($2,'') IS NOT NULL THEN $3 ELSE b.city END AS to_city
      FROM buyer_wants bw JOIN buyers b ON b.id = bw.buyer_id JOIN products p ON p.id = bw.product_id
      JOIN deals d ON d.product_id = bw.product_id JOIN listings l ON l.id = d.listing_id
      WHERE bw.active AND bw.buyer_id = $1 AND l.is_active AND (l.auction_ends IS NULL OR l.auction_ends > NOW() + INTERVAL '12 hours')
        AND (bw.max_price IS NULL OR l.price <= bw.max_price)
        AND (bw.states IS NULL OR cardinality(bw.states) = 0 OR l.state = ANY(bw.states))
        AND (bw.min_year IS NULL OR l.year IS NULL OR l.year >= bw.min_year)
        AND NOT EXISTS (SELECT 1 FROM buyer_alert_log a WHERE a.buyer_id = b.id AND a.listing_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM listing_blocks x WHERE x.listing_id = l.id)
      ORDER BY l.id, d.deal_score DESC`, [b.id, b.deliver_state || '', b.deliver_city || ''])).rows
      .sort((x, y) => y.deal_score - x.deal_score).slice(0, limitPerBuyer);
    if (!rows.length) { stats.skipped++; continue; }
    for (const r of rows) r.landed = landedCost({ price: r.price, market_price: r.market_price, source: r.source, title: r.title, product: r.product, city: r.city, state: r.state }, { city: r.to_city, state: r.to_state });
    const m = render(b, rows);
    try {
      await mailer.send({ to: b.email, subject: m.subject, text: m.text, html: m.html, reply_to: b.rep_email, from_name: `${b.rep_name || b.org_name} (${b.org_name})` });
      for (const r of rows) await pool.query('INSERT INTO buyer_alert_log (buyer_id, listing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [b.id, r.listing_id]);
      await pool.query('UPDATE buyers SET last_mailed_at = NOW() WHERE id = $1', [b.id]);
      require('./activity').log({ id: b.rep_id }, 'emailed client', `${b.company}: ${rows.length} machine${rows.length === 1 ? '' : 's'}`);
      stats.sent++;
    } catch (e) {
      stats.errors++;
      require('./activity').log({ id: b.rep_id }, 'client email failed', `${b.company}: ${(e.response?.data?.message || e.message || '').slice(0, 120)}`);
    }
  }
  return stats;
}

function render(b, rows) {
  const first = (b.contact_name || b.company || '').split(' ')[0];
  const rep = b.rep_name || b.org_name;
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const line = (r) => `${r.year ? r.year + ' ' : ''}${r.title}\n  ${money(r.price)}${r.landed ? ` - about ${money(r.landed.delivered)} delivered to ${r.landed.to}` : ''}${r.hours ? ` - ${Number(r.hours).toLocaleString()} hrs` : ''} - ${[r.city, r.state].filter(Boolean).join(', ')}`;
  const one = rows.length === 1;
  const text = `${first ? 'Hi ' + first + ',' : 'Hi,'}\n\n${rep} here at ${b.org_name}. ${one ? 'A machine' : rows.length + ' machines'} came up that fit${one ? 's' : ''} what you're looking for:\n\n${rows.map(line).join('\n\n')}\n\nWant me to go after ${one ? 'it' : 'any of these'}? Reply to this email${b.rep_phone ? ' or call me at ' + b.rep_phone : ''}.\n\n${rep}\n${b.org_name}`;
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:600px">
    <p>${first ? 'Hi ' + esc(first) + ',' : 'Hi,'}</p>
    <p>${esc(rep)} here at ${esc(b.org_name)}. ${one ? 'A machine' : rows.length + ' machines'} came up that fit${one ? 's' : ''} what you're looking for:</p>
    ${rows.map(r => `<div style="border:1px solid #ddd;border-radius:10px;padding:12px 14px;margin:10px 0">
      ${r.image_url ? `<img src="${esc(r.image_url)}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:6px;margin-bottom:8px">` : ''}
      <div style="font-weight:600">${esc((r.year ? r.year + ' ' : '') + r.title)}</div>
      <div style="font-size:20px;font-weight:700;margin:4px 0">${money(r.price)}</div>
      ${r.landed ? `<div style="color:#333">About <b>${money(r.landed.delivered)}</b> delivered to ${esc(r.landed.to)}</div>` : ''}
      <div style="color:#666;font-size:13px">${[r.hours ? Number(r.hours).toLocaleString() + ' hrs' : null, r.city, r.state].filter(Boolean).map(esc).join(' · ')}</div>
    </div>`).join('')}
    <p>Want me to go after ${one ? 'it' : 'any of these'}? Reply to this email${b.rep_phone ? ' or call me at <b>' + esc(b.rep_phone) + '</b>' : ''}.</p>
    <p>${esc(rep)}<br>${esc(b.org_name)}</p></div>`;
  const subject = one ? `${rows[0].year ? rows[0].year + ' ' : ''}${rows[0].product} - ${money(rows[0].price)}` : `${rows.length} ${rows[0].product}s that fit what you're after`;
  return { subject, text, html };
}

module.exports = { sendBuyerEmails, render };
