// Endpoints for an EXTERNAL scheduler to hit (cron-job.org, GitHub Actions, Render Cron, etc.).
// Needed when the server can't keep its own timer running — e.g. a free-tier host that
// sleeps when idle. Protected by CRON_SECRET in .env; pass it as ?key= or header x-cron-key.
//
//   GET /api/cron/ingest?key=...   -> fetch all TRACKED_PRODUCTS, recalc, send realtime alerts
//   GET /api/cron/alerts?key=...   -> send any due hourly/daily/weekly digests
//   GET /api/cron/ping?key=...     -> does nothing but keeps a sleepy host awake
//
// Set up (free): cron-job.org -> new job -> URL above -> schedule. Ingest once a day
// (6am), alerts every 15 minutes. Both respond immediately and do the work in the
// background so the scheduler never times out.
const router = require('express').Router();
const { main: ingestAll } = require('../scripts/ingest');
const { sendDigests } = require('../lib/alerts');
const { purgeExpiredSessions } = require('../lib/auth');

let ingesting = false;

router.use((req, res, next) => {
  const key = req.query.key || req.headers['x-cron-key'];
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not set' });
  if (key !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Bad key' });
  next();
});

router.get('/ingest', (req, res) => {
  if (ingesting) return res.json({ started: false, reason: 'already running' });
  ingesting = true;
  res.json({ started: true });
  ingestAll().catch(e => console.error('cron ingest failed:', e)).finally(() => { ingesting = false; });
});

router.get('/alerts', (req, res) => {
  res.json({ started: true });
  sendDigests().then(s => s.sent && console.log(`[cron] alerts: ${s.sent} sent`)).catch(e => console.error('cron alerts failed:', e));
  purgeExpiredSessions().catch(() => {});
});

router.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

module.exports = router;
