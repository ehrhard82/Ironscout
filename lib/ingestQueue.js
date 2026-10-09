// One-at-a-time ingest queue so a user typing a brand-new machine on the front page
// can kick off a fetch without colliding with another one already running.
const { ingestProduct } = require('../scripts/ingest');
const { sendDigests } = require('../lib/alerts');

const queue = [];
let running = null;

function enqueue(term) {
  term = String(term || '').trim();
  if (!term) return { queued: false };
  if (running === term || queue.includes(term)) return { queued: true, position: running === term ? 0 : queue.indexOf(term) + 1 };
  queue.push(term);
  tick();
  return { queued: true, position: queue.length };
}

function tick() {
  if (running || !queue.length) return;
  running = queue.shift();
  ingestProduct(running)
    .then(() => sendDigests({ realtimeOnly: true }))
    .catch(e => console.error(`ingest "${running}" failed:`, e))
    .finally(() => { running = null; tick(); });
}

const status = () => ({ running, queued: [...queue] });
const isBusy = () => Boolean(running);

module.exports = { enqueue, status, isBusy };
