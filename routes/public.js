// Public, no-login endpoints: the buyer intake form a rep texts to anyone.
// GET /want/:slug serves the page; POST /api/public/intake/:slug saves a buyer + what they want
// into that rep's private buyer list, and the next matching deal pings the rep.
const router = require('express').Router();
const pool = require('../lib/db');

const hits = new Map();   // crude per-IP throttle: 10 submissions / hour
function throttled(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 10;
}

router.get('/intake/:slug', async (req, res, next) => {
  try {
    const u = (await pool.query(`SELECT u.name, u.phone, (SELECT name FROM organizations o WHERE o.id = u.org_id) AS org FROM users u WHERE u.intake_slug = $1`, [req.params.slug])).rows[0];
    if (!u) return res.status(404).json({ error: 'That link is not active' });
    const machines = (await pool.query(`SELECT name FROM products ORDER BY name`)).rows.map(r => r.name);
    res.json({ rep: u.name, org: u.org, phone: u.phone, machines });
  } catch (e) { next(e); }
});

router.post('/intake/:slug', async (req, res, next) => {
  try {
    if (throttled(req.ip)) return res.status(429).json({ error: 'Too many submissions, try again later' });
    const rep = (await pool.query(`SELECT id, name, email FROM users WHERE intake_slug = $1`, [req.params.slug])).rows[0];
    if (!rep) return res.status(404).json({ error: 'That link is not active' });
    const b = req.body || {};
    const company = String(b.company || b.name || '').trim().slice(0, 200);
    const contact = String(b.contact_name || b.name || '').trim().slice(0, 200) || null;
    const phone = String(b.phone || '').trim().slice(0, 40) || null;
    const email = String(b.email || '').trim().slice(0, 255) || null;
    if (!company || (!phone && !email)) return res.status(400).json({ error: 'Name and a phone or email are required' });
    if (String(b.website || '').trim()) return res.json({ ok: true });   // honeypot field: bots fill it, people don't see it
    const wants = Array.isArray(b.wants) ? b.wants.slice(0, 8) : [];
    const aliases = require('../lib/aliases');
    const r = await pool.query(`INSERT INTO buyers (company, contact_name, phone, email, city, state, notes, status, source, owner_user_id, intake_note)
                                VALUES ($1,$2,$3,$4,$5,$6,$7,'prospect','intake',$8,$9) RETURNING id`,
      [company, contact, phone, email, String(b.city || '').trim().slice(0, 100) || null, String(b.state || '').trim().toUpperCase().slice(0, 2) || null,
       'Came in through your intake link', rep.id, String(b.notes || '').trim().slice(0, 1000) || null]);
    const buyerId = r.rows[0].id;
    for (const w of wants) {
      const resolved = await aliases.resolve(w.machine || w.product || '');
      const name = resolved.product ? resolved.product.name : resolved.name;
      if (!name) continue;
      const pid = resolved.product ? resolved.product.id : (await pool.query(`INSERT INTO products (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name])).rows[0].id;
      const max = Number(String(w.max_price || '').replace(/[^0-9.]/g, '')) || null;
      const minYear = Number(w.min_year) || null;
      await pool.query(`INSERT INTO buyer_wants (buyer_id, product_id, max_price, states, min_year, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
        [buyerId, pid, max, [], minYear, String(w.notes || '').trim().slice(0, 300) || null]);
    }
    // tell the rep (email if mail is set up; always in the activity feed)
    require('../lib/activity').log({ id: rep.id }, 'new buyer via link', `${company}${phone ? ' · ' + phone : ''}`);
    try {
      const { send } = require('../lib/mailer');
      if (rep.email) await send({ to: rep.email, subject: `New buyer lead: ${company}`,
        text: `${contact || company} filled out your IronScout link.\n\nCompany: ${company}\nPhone: ${phone || '-'}\nEmail: ${email || '-'}\nLooking for: ${wants.map(w => `${w.machine || w.product}${w.max_price ? ' up to $' + w.max_price : ''}`).join('; ') || '-'}\nNotes: ${b.notes || '-'}\n\nThey're in your Buyers tab as a prospect.` });
    } catch (e) { console.log('intake mail skipped:', e.message); }
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
