// Runs every data source for one or more products, then recalculates deals.
//
//   npm run ingest                         -> all products in TRACKED_PRODUCTS (.env)
//   npm run ingest -- "oil rig truck"      -> just that product
//   npm run ingest -- bobcat excavator     -> several
//
require('dotenv').config();
const pool = require('../lib/db');
const sources = require('../lib/sources');
const { getOrCreateProduct, upsertListing, upsertSale, deactivateStale } = require('../lib/listings');
const { recalculateProduct } = require('../lib/pricing');
const { sendDigests } = require('../lib/alerts');

const SOLD_EVERY_DAYS = Number(process.env.SOLD_REFRESH_DAYS || 7);

/** Pull completed sales (hammer prices) for a product from every source that has them. */
async function ingestSold(productId, term, { force = false } = {}) {
  if (!force) {
    const last = await pool.query(
      `SELECT MAX(started_at) AS t FROM ingest_runs WHERE product_id = $1 AND source LIKE '%:sold' AND error IS NULL`, [productId]);
    if (last.rows[0].t && (Date.now() - new Date(last.rows[0].t)) < SOLD_EVERY_DAYS * 86400000) return { skipped: true };
  }
  const out = {};
  for (const src of sources) {
    if (typeof src.fetchSold !== 'function') continue;
    const run = await pool.query(
      'INSERT INTO ingest_runs (product_id, source, note) VALUES ($1,$2,$3) RETURNING id', [productId, `${src.name}:sold`, 'starting…']);
    const runId = run.rows[0].id;
    const progress = (text) => pool.query('UPDATE ingest_runs SET note=$1 WHERE id=$2', [text, runId]).catch(() => {});
    const counts = { fetched: 0, inserted: 0, updated: 0 };
    let error = null, note = null;
    try {
      const rows = await src.fetchSold(term, progress);
      counts.fetched = rows.length; note = rows.note || null;
      for (const r of rows) {
        try { const result = await upsertSale(productId, r); if (result in counts) counts[result]++; }
        catch (e) { note += `; save error: ${e.message.slice(0, 120)}`; }
      }
    } catch (e) {
      error = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message;
    }
    await pool.query(`UPDATE ingest_runs SET fetched=$1, inserted=$2, updated=$3, error=$4, note=$5, finished_at=NOW() WHERE id=$6`,
      [counts.fetched, counts.inserted, counts.updated, error, note, runId]).catch(() => {});
    out[src.name] = counts;
  }
  return out;
}

async function ingestProduct(term, { sold = true } = {}) {
  console.log(`\n=== ${term} ===`);
  const productId = await getOrCreateProduct(term);

  for (const src of sources) {
    const run = await pool.query(
      'INSERT INTO ingest_runs (product_id, source, note) VALUES ($1,$2,$3) RETURNING id', [productId, src.name, 'starting…']);
    const runId = run.rows[0].id;
    const progress = (text) => pool.query('UPDATE ingest_runs SET note=$1 WHERE id=$2', [text, runId]).catch(() => {});
    const counts = { fetched: 0, inserted: 0, updated: 0 };
    let error = null, note = null;
    try {
      const rows = await src.fetch(term, progress);
      counts.fetched = rows.length;
      note = rows.note || `source returned ${rows.length} rows`;
      await progress(`${note}; saving…`);
      for (const r of rows) {
        try {
          const result = await upsertListing(productId, r);
          if (result in counts) counts[result]++;
        } catch (e) { note += `; save error: ${e.message.slice(0, 120)}`; }
      }
      console.log(`  [${src.name}] fetched ${counts.fetched}, new ${counts.inserted}, refreshed ${counts.updated}`);
    } catch (e) {
      error = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message;
      console.log(`  [${src.name}] ERROR: ${error}`);
    }
    await pool.query(
      `UPDATE ingest_runs SET fetched=$1, inserted=$2, updated=$3, error=$4, note=$5, finished_at=NOW() WHERE id=$6`,
      [counts.fetched, counts.inserted, counts.updated, error, note, runId]).catch(e => console.error('could not record run:', e.message));
  }

  if (sold) await ingestSold(productId, term);
  const r = await recalculateProduct(productId);
  console.log(`  -> ${r.deals} deals flagged out of ${r.listings} active listings`);
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const terms = args.length ? args
    : (process.env.TRACKED_PRODUCTS || 'bobcat skid steer').split(',').map(s => s.trim()).filter(Boolean);

  for (const t of terms) await ingestProduct(t);
  const stale = await deactivateStale(14);
  if (stale) console.log(`\nDeactivated ${stale} listings not seen in 14 days`);
  const a = await sendDigests({ realtimeOnly: true });
  console.log(`Realtime alerts: ${a.sent} sent (${a.skipped_no_access} without access skipped)`);
  console.log('\nDone.');
}

if (require.main === module) {
  main().then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
}
module.exports = { ingestProduct, ingestSold, main };
