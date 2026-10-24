// One-at-a-time ingest queue so a user typing a brand-new machine on the front page
// can kick off a fetch without colliding with another one already running.
const { ingestProduct } = require('../scripts/ingest');
const { sendDigests } = require('../lib/alerts');

const queue = [];
let running = null, startedAt = 0;
const MAX_MINUTES = () => Number(process.env.INGEST_MAX_MINUTES || 45);   // per machine, all sources

// Free-tier hosts spin down after ~15 min without an incoming request - even mid-refresh.
// While the queue is working, request our own public URL every few minutes to stay awake.
let keepAlive = null;
function selfUrl() {
  const base = process.env.PUBLIC_URL || (process.env.RENDER_EXTERNAL_URL) || '';
  return base ? base.replace(/\/$/, '') + '/version' : null;
}
function startKeepAlive() {
  const url = selfUrl(); if (!url || keepAlive) return;
  keepAlive = setInterval(() => { require('axios').get(url, { timeout: 20_000 }).catch(() => {}); }, 4 * 60_000);
  keepAlive.unref();
}
function stopKeepAlive() { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } }

function withTimeout(promise, minutes, label) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} still running after ${minutes} min - skipped so the rest of the queue can go`)), minutes * 60_000); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

const forced = new Set();   // terms queued by a person (admin button, "Fetch now"): skip the cost-saving skips
function enqueue(term, { force = false } = {}) {
  term = String(term || '').trim();
  if (!term) return { queued: false };
  if (force) forced.add(term);
  if (running === term || queue.includes(term)) return { queued: true, position: running === term ? 0 : queue.indexOf(term) + 1 };
  queue.push(term);
  tick();
  return { queued: true, position: queue.length };
}

function tick() {
  if (running) return;
  if (!queue.length) { stopKeepAlive(); return; }
  startKeepAlive();
  running = queue.shift(); startedAt = Date.now();
  const term = running;
  if (term === '__done__') { running = null; (module.exports.onDone || (() => {}))(); tick(); return; }
  const force = forced.delete(term);
  withTimeout(ingestProduct(term, { force }), MAX_MINUTES(), `ingest "${term}"`)
    .then(() => sendDigests({ realtimeOnly: true }))
    .catch(e => {
      console.error(`ingest "${term}" failed:`, e.message || e);
      // leave a visible trace on any run row still open for this machine
      require('../lib/db').query(`UPDATE ingest_runs SET error = $1, finished_at = NOW() WHERE finished_at IS NULL AND product_id = (SELECT id FROM products WHERE name = $2)`, [String(e.message || e).slice(0, 300), term]).catch(() => {});
    })
    .finally(() => { running = null; tick(); });
}

const status = () => ({ running, running_minutes: running ? Math.round((Date.now() - startedAt) / 60000) : 0, queued: queue.filter(q => q !== '__done__') });
const isBusy = () => Boolean(running);

module.exports = { enqueue, status, isBusy, onDone: null };
