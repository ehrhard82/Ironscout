// Endpoints for an EXTERNAL scheduler to hit (cron-job.org, GitHub Actions, Render Cron, etc.).
// Needed when the server can't keep its own timer running — e.g. a free-tier host that
// sleeps when idle. Protected by CRON_SECRET in .env; pass it as ?key= or header x-cron-key.
//
//   GET /api/cron/ingest?key=...   -> refresh every watched machine (+TRACKED_PRODUCTS), recalc, realtime alerts
//   GET /api/cron/alerts?key=...   -> send any due hourly/daily/weekly digests
//   GET /api/cron/ping?key=...     -> does nothing but keeps a sleepy host awake
//
// Set up (free): cron-job.org -> new job -> URL above -> schedule. Ingest once a day
// (6am), alerts every 15 minutes. Both respond immediately and do the work in the
// background so the scheduler never times out.
const router = require('express').Router();
const { scheduledTerms } = require('../scripts/ingest');
const ingestQueue = require('../lib/ingestQueue');
const { deactivateStale } = require('../lib/listings');
const { sendDigests } = require('../lib/alerts');
const { purgeExpiredSessions } = require('../lib/auth');

router.use((req, res, next) => {
  const key = req.query.key || req.headers['x-cron-key'];
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not set' });
  if (key !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Bad key' });
  next();
});

// A full refresh costs real money (Apify), so even if a scheduler calls this every few
// minutes by mistake it only runs once per INGEST_MIN_HOURS. Add &force=1 to override.
let lastIngestAt = 0;
router.get('/ingest', async (req, res) => {
  try {
    const minHours = Number(process.env.INGEST_MIN_HOURS || 20);
    const since = (Date.now() - lastIngestAt) / 3600000;
    if (lastIngestAt && since < minHours && req.query.force !== '1') {
      return res.json({ started: false, reason: `already refreshed ${since.toFixed(1)}h ago; runs at most every ${minHours}h (add &force=1 to override)` });
    }
    lastIngestAt = Date.now();
    const terms = await scheduledTerms();
    for (const t of terms) ingestQueue.enqueue(t);          // one at a time, after anything already running
    deactivateStale(14).catch(() => {});
    res.json({ started: true, machines: terms, ...ingestQueue.status() });
  } catch (e) { res.status(500).json({ started: false, error: e.message }); }
});

router.get('/alerts', (req, res) => {
  res.json({ started: true });
  sendDigests().then(s => s.sent && console.log(`[cron] alerts: ${s.sent} sent`)).catch(e => console.error('cron alerts failed:', e));
  purgeExpiredSessions().catch(() => {});
});

router.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

module.exports = router;
