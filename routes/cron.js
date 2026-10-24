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
// The "last run" time lives in the database so a restart (redeploy, free-tier spin-down)
// doesn't forget it.
const pool = require('../lib/db');
async function lastScheduledIngest() {
  const r = await pool.query(`SELECT key, value FROM app_state WHERE key IN ('last_ingest_at', 'ingest_started_at')`).catch(() => ({ rows: [] }));
  const v = Object.fromEntries(r.rows.map(x => [x.key, new Date(x.value).getTime()]));
  const done = v.last_ingest_at || 0, started = v.ingest_started_at || 0;
  const retryMs = Number(process.env.INGEST_RETRY_MINUTES || 90) * 60_000;
  // A run that started recently but hasn't finished counts as "in progress" until the retry window passes.
  if (started > done && Date.now() - started < retryMs) return started;
  return done;
}
async function markIngestDone() {
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('last_ingest_at', $1, NOW())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [new Date().toISOString()]).catch(() => {});
  console.log('[cron] daily refresh finished');
}
require('../lib/ingestQueue').onDone = markIngestDone;
async function runScheduledIngest(reason) {
  const terms = await scheduledTerms();
  // Stamp "started" now (so two pings 5 min apart don't both start it), and stamp "done" when the
  // last machine finishes. A restart mid-run leaves only the start stamp, which expires after
  // INGEST_RETRY_MINUTES so the catch-up tries again.
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('ingest_started_at', $1, NOW())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [new Date().toISOString()]);
  for (const t of terms) ingestQueue.enqueue(t);          // one at a time, after anything already running
  ingestQueue.enqueue('__done__');                        // sentinel: runs after the last machine
  deactivateStale(14).catch(() => {});
  console.log(`[cron] daily refresh started (${reason}): ${terms.length} machine(s)`);
  return terms;
}
router.get('/ingest', async (req, res) => {
  try {
    const minHours = Number(process.env.INGEST_MIN_HOURS || 20);
    const since = (Date.now() - await lastScheduledIngest()) / 3600000;
    if (since < minHours && req.query.force !== '1') {
      return res.json({ started: false, reason: `already refreshed ${since.toFixed(1)}h ago; runs at most every ${minHours}h (add &force=1 to override)` });
    }
    const terms = await runScheduledIngest(req.query.force === '1' ? 'forced' : 'scheduled');
    res.json({ started: true, machines: terms, ...ingestQueue.status() });
  } catch (e) { res.status(500).json({ started: false, error: e.message }); }
});

// Safety net: the alerts job hits every 15 minutes. If the 6am refresh never arrived
// (sleeping host, timeout, missed cron), start it from here once the day's window has opened.
async function catchUpIngest() {
  const tz = process.env.BUDGET_TZ || 'America/New_York';
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
  const startHour = Number(process.env.INGEST_HOUR || 6);
  if (hour < startHour) return;
  const minHours = Number(process.env.INGEST_MIN_HOURS || 20);
  if ((Date.now() - await lastScheduledIngest()) / 3600000 < minHours) return;
  await runScheduledIngest('catch-up from alerts job');
}

router.get('/alerts', (req, res) => {
  res.json({ started: true });
  sendDigests().then(s => s.sent && console.log(`[cron] alerts: ${s.sent} sent`)).catch(e => console.error('cron alerts failed:', e));
  require('../lib/buyerMail').sendBuyerEmails().then(s => s.sent && console.log(`[cron] client emails: ${s.sent} sent`)).catch(e => console.error('client emails failed:', e.message));
  purgeExpiredSessions().catch(() => {});
  catchUpIngest().catch(e => console.error('catch-up ingest failed:', e.message));
});

router.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

module.exports = router;
module.exports.runScheduledIngest = runScheduledIngest;
module.exports.lastScheduledIngest = lastScheduledIngest;
