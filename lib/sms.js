// Outbound SMS via Twilio's REST API (no SDK needed). ~$0.0079 per US text plus
// ~$1.15/month for the phone number. Sign up at twilio.com, buy a number, and set:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (your Twilio number, +1...)
// With those unset, texts are printed to the console instead.
//
// Note: US carriers require A2P 10DLC registration for business texting; Twilio
// walks you through it (~1-2 weeks, small one-time fee). Until it's approved,
// volume is throttled - fine for testing.

const axios = require('axios');

function normalizePhone(p) {
  const digits = String(p || '').replace(/[^0-9+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits.length >= 11 ? digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

async function send({ to, text }) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM: from } = process.env;
  if (!sid || !tok || !from) {
    console.log(`\n--- SMS (not sent: Twilio unset) ---\nTo: ${to}\n${text}\n---\n`);
    return { sent: false, reason: 'not_configured' };
  }
  const body = new URLSearchParams({ To: to, From: from, Body: text.slice(0, 1500) });
  const res = await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, body.toString(), {
    auth: { username: sid, password: tok }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000,
  });
  return { sent: true, sid: res.data?.sid };
}

module.exports = { send, normalizePhone };
