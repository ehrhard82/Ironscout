// The one settings page. Everything here applies to every machine the user watches.
// GET /api/settings
// PUT /api/settings  { states, min_discount, min_margin, max_price, min_year,
//                      channel (email|sms|both|none), frequency (realtime|hourly|daily|weekly), phone, name }
const router = require('express').Router();
const pool = require('../lib/db');
const { requireLogin } = require('../lib/auth');
const { STATE_CODES } = require('../lib/location');
const { normalizePhone } = require('../lib/sms');

const CHANNELS = ['email', 'sms', 'both', 'none'];
const FREQS = ['realtime', 'hourly', 'daily', 'weekly'];

function cleanStates(states) {
  if (states === null || states === undefined || states === '') return null;
  const arr = (Array.isArray(states) ? states : String(states).split(/[,\s]+/))
    .map(s => s.trim().toUpperCase()).filter(s => STATE_CODES.has(s));
  return arr.length ? arr : null;
}

router.get('/', requireLogin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT name, email, phone, alert_channel AS channel, alert_frequency AS frequency, alert_states AS states,
              alert_min_discount AS min_discount, alert_min_margin AS min_margin, alert_max_price AS max_price,
              alert_min_year AS min_year, last_digest_at
       FROM users WHERE id = $1`, [req.user.id]);
    res.json({ ...r.rows[0], channels: CHANNELS, frequencies: FREQS,
               sms_available: Boolean(process.env.TWILIO_ACCOUNT_SID) });
  } catch (e) { next(e); }
});

router.put('/', requireLogin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const channel = b.channel === undefined ? null : (CHANNELS.includes(b.channel) ? b.channel : 'email');
    const frequency = b.frequency === undefined ? null : (FREQS.includes(b.frequency) ? b.frequency : 'daily');
    let phone = b.phone === undefined ? undefined : (b.phone ? normalizePhone(b.phone) : null);
    if (b.phone && phone === null) return res.status(400).json({ error: 'Enter a 10-digit US phone number' });
    if ((channel === 'sms' || channel === 'both') && !(phone || (phone === undefined && req.user.phone))) {
      // allow saving channel only if a phone exists or is being set
      const cur = await pool.query('SELECT phone FROM users WHERE id=$1', [req.user.id]);
      if (!cur.rows[0].phone && !phone) return res.status(400).json({ error: 'Add a phone number to receive texts' });
    }
    const r = await pool.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
         alert_channel = COALESCE($5, alert_channel),
         alert_frequency = COALESCE($6, alert_frequency),
         alert_states = CASE WHEN $7::boolean THEN $8 ELSE alert_states END,
         alert_min_discount = COALESCE($9, alert_min_discount),
         alert_min_margin = COALESCE($10, alert_min_margin),
         alert_max_price = CASE WHEN $11::boolean THEN $12 ELSE alert_max_price END,
         alert_min_year = CASE WHEN $13::boolean THEN $14 ELSE alert_min_year END
       WHERE id = $1
       RETURNING name, phone, alert_channel AS channel, alert_frequency AS frequency, alert_states AS states,
                 alert_min_discount AS min_discount, alert_min_margin AS min_margin, alert_max_price AS max_price, alert_min_year AS min_year`,
      [req.user.id, b.name === undefined ? null : String(b.name).slice(0, 255),
       phone !== undefined, phone ?? null,
       channel, frequency,
       b.states !== undefined, cleanStates(b.states),
       b.min_discount === undefined || b.min_discount === '' ? null : Math.max(0, Math.min(90, Number(b.min_discount))),
       b.min_margin === undefined || b.min_margin === '' ? null : Math.max(0, Number(b.min_margin)),
       b.max_price !== undefined, b.max_price ? Number(b.max_price) : null,
       b.min_year !== undefined, b.min_year ? Number(b.min_year) : null]);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
