// Outbound email. Uses Resend's HTTP API (resend.com - free for 3,000 emails/month,
// takes five minutes to set up: add your domain, copy the API key). No SMTP to
// configure. With no RESEND_API_KEY set, emails are printed to the console
// instead, so everything works in development.
//
// To use a different provider, replace send() - the rest of the app only calls
// mailer.send({ to, subject, text, html }).

const axios = require('axios');

const FROM = () => process.env.MAIL_FROM || 'IronScout <alerts@ironscout.local>';

async function send({ to, subject, text, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`\n--- EMAIL (not sent: RESEND_API_KEY unset) ---\nTo: ${to}\nSubject: ${subject}\n\n${text || html}\n---\n`);
    return { sent: false, reason: 'no_api_key' };
  }
  const res = await axios.post('https://api.resend.com/emails',
    { from: FROM(), to: [to], subject, text, html },
    { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 });
  return { sent: true, id: res.data?.id };
}

module.exports = { send };
