// Keeps running and re-ingests all tracked products on a schedule (default 6am daily).
//   npm run schedule
// On a server, run this under pm2:  pm2 start scripts/schedule.js --name deals-scheduler
require('dotenv').config();
const cron = require('node-cron');
const { main: ingestAll } = require('./ingest');
const { sendDigests } = require('../lib/alerts');
const { purgeExpiredSessions } = require('../lib/auth');

const expr = process.env.INGEST_CRON || '0 6 * * *';
if (!cron.validate(expr)) { console.error(`Invalid INGEST_CRON: ${expr}`); process.exit(1); }

let running = false;
async function tick() {
  if (running) return console.log('Previous ingest still running, skipping');
  running = true;
  console.log(`\n[${new Date().toISOString()}] scheduled ingest starting`);
  try { await ingestAll(); } catch (e) { console.error('Ingest failed:', e.message); }
  running = false;
}

cron.schedule(expr, tick);

// Hourly / daily / weekly digests: check every 15 minutes who is due.
cron.schedule('*/15 * * * *', async () => {
  try { const s = await sendDigests(); if (s.sent) console.log(`[${new Date().toISOString()}] alerts: ${s.sent} sent`); }
  catch (e) { console.error('alerts tick failed:', e.message); }
});
cron.schedule('30 3 * * *', () => purgeExpiredSessions().catch(() => {}));

console.log(`Scheduler running. Ingest cron: "${expr}". Alert check every 15 min. Running ingest once now...`);
tick();
