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
// Quiet machines refresh every other day: if the last full pass for a machine (within SLOW_HOURS) added
// nothing new, it sits out today. Busy machines (anything new yesterday) keep refreshing daily.
async function dueTerms(all, force) {
  if (force) return all;
  const slowHours = Number(process.env.INGEST_SLOW_HOURS || 40);
  const r = await pool.query(`SELECT p.name, COALESCE(SUM(r.inserted), 0)::int AS added, COUNT(*)::int AS runs
                              FROM products p JOIN ingest_runs r ON r.product_id = p.id
                              WHERE p.name = ANY($1) AND r.source NOT LIKE '%:sold' AND r.finished_at IS NOT NULL AND r.error IS NULL
                                AND r.started_at > NOW() - ($2 || ' hours')::interval AND r.started_at < NOW() - interval '12 hours'
                              GROUP BY p.name`, [all, String(slowHours)]).catch(() => ({ rows: [] }));
  // Quiet machines rest every other day, staggered by name so the two halves alternate and the run never goes empty.
  const dayNo = Math.floor(Date.now() / 86400e3);
  const hash = (t) => [...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const quiet = new Set(r.rows.filter(x => x.runs > 0 && x.added === 0 && (hash(x.name) + dayNo) % 2 === 0).map(x => x.name));
  const due = all.filter(t => !quiet.has(t));
  if (quiet.size) console.log(`[cron] sitting out today (nothing new last pass): ${[...quiet].join(', ')}`);
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('sat_out_today', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify([...quiet])]).catch(() => {});
  return due;
}
async function runScheduledIngest(reason) {
  const force = /forced|admin/i.test(reason);
  const terms = await dueTerms(await scheduledTerms(), force);
  // Stamp "started" now (so two pings 5 min apart don't both start it), and stamp "done" when the
  // last machine finishes. A restart mid-run leaves only the start stamp, which expires after
  // INGEST_RETRY_MINUTES so the catch-up tries again.
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('ingest_started_at', $1, NOW())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [new Date().toISOString()]);
  for (const t of terms) ingestQueue.enqueue(t, { force }); // one at a time, after anything already running
  ingestQueue.enqueue('__done__');                        // sentinel: runs after the last machine
  deactivateStale(14).catch(() => {});
  require('../lib/demand/rrc').refresh().catch(e => console.error('permits refresh failed:', e.message));   // free; runs alongside
  require('../lib/demand/more').refreshAll().catch(e => console.error('more leads failed:', e.message));   // OK/NM permits, TX new businesses, plugging — free, daily
  const fmcsa = require('../lib/demand/fmcsa');
  fmcsa.due().then(d => d && fmcsa.refresh()).catch(e => console.error('carriers refresh failed:', e.message));   // weekly
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
  require('../lib/brief').sendBriefs().then(s => s.sent && console.log(`[cron] morning briefs: ${s.sent}`)).catch(e => console.error('briefs failed:', e.message));
  require('../lib/alerts').sendFollowupReminders().then(s => s.sent && console.log(`[cron] follow-up reminders: ${s.sent}`)).catch(e => console.error('followup reminders failed:', e.message));
  catchUpIngest().catch(e => console.error('catch-up ingest failed:', e.message));
});

router.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// On boot: if a daily run was started and never finished (a deploy or restart cut it off), pick it back up now
// instead of waiting for the 90-minute retry window. Machines already refreshed today sit out automatically.
async function resumeIfInterrupted() {
  const r = await pool.query(`SELECT key, value FROM app_state WHERE key IN ('last_ingest_at', 'ingest_started_at')`).catch(() => ({ rows: [] }));
  const v = Object.fromEntries(r.rows.map(x => [x.key, new Date(x.value).getTime()]));
  const started = v.ingest_started_at || 0, done = v.last_ingest_at || 0;
  if (!(started > done) || Date.now() - started > 6 * 3600e3) return { resumed: false };
  // only the machines that didn't get a finished run since this pass started
  const all = await scheduledTerms();
  const finished = new Set((await pool.query(`SELECT DISTINCT p.name FROM ingest_runs r JOIN products p ON p.id = r.product_id
    WHERE r.started_at >= to_timestamp($1 / 1000.0) AND r.finished_at IS NOT NULL AND r.source NOT LIKE '%:sold' AND r.error IS NULL AND COALESCE(r.note,'') NOT LIKE 'skipped:%'`, [started])).rows.map(x => x.name));
  const perMachineSources = (await pool.query(`SELECT p.name, COUNT(*)::int AS n FROM ingest_runs r JOIN products p ON p.id = r.product_id WHERE r.started_at >= to_timestamp($1 / 1000.0) AND r.finished_at IS NOT NULL AND r.source NOT LIKE '%:sold' GROUP BY p.name`, [started])).rows;
  const sourceCount = require('../lib/sources').length;
  const complete = new Set(perMachineSources.filter(x => x.n >= sourceCount).map(x => x.name));
  const remaining = all.filter(t => !complete.has(t));
  if (!remaining.length) { await markIngestDone(); return { resumed: false, reason: 'nothing left' }; }
  setTimeout(() => {
    for (const t of remaining) ingestQueue.enqueue(t, { force: true });
    ingestQueue.enqueue('__done__');
    console.log(`[cron] resumed interrupted refresh: ${remaining.length} machine(s) (${remaining.join(', ')})`);
  }, 20_000);   // give the server a moment to settle after boot
  return { resumed: true, remaining };
}

module.exports = router;
module.exports.runScheduledIngest = runScheduledIngest;
module.exports.resumeIfInterrupted = resumeIfInterrupted;
module.exports.lastScheduledIngest = lastScheduledIngest;
