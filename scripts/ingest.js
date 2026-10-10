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

function friendlyError(e) {
  const type = e.response?.data?.error?.type;
  if (type === 'insufficient-permissions' || type === 'record-not-found') return `this scraper is no longer available on Apify (${type}) - it needs replacing in lib/sources/apify.js`;
  if (type === 'platform-usage-limit-exceeded' || type === 'platform-feature-disabled') return 'Apify monthly usage limit reached - upgrade the Apify plan or wait for the next billing period';
  return e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message;
}

/** For sources that ignore keywords, retire previously-saved listings/sales that aren't about this machine. */
async function sweepMismatches(productId, sourceName, term) {
  const { ACTORS, matchesQuery } = require('../lib/sources/apify');
  if (!ACTORS[sourceName]?.filterByQuery) return;
  const rows = await pool.query(`SELECT id, title FROM listings WHERE product_id = $1 AND source = $2 AND is_active`, [productId, sourceName]);
  const bad = rows.rows.filter(r => !matchesQuery(r.title, term)).map(r => r.id);
  if (bad.length) await pool.query(`UPDATE listings SET is_active = FALSE WHERE id = ANY($1)`, [bad]);
  const sales = await pool.query(`SELECT id, title FROM sales WHERE product_id = $1 AND source = $2`, [productId, sourceName]);
  const badSales = sales.rows.filter(r => !matchesQuery(r.title, term)).map(r => r.id);
  if (badSales.length) await pool.query(`DELETE FROM sales WHERE id = ANY($1)`, [badSales]);
  if (bad.length || badSales.length) console.log(`  [${sourceName}] retired ${bad.length} listings / ${badSales.length} sales not about "${term}"`);
}

const SOLD_EVERY_DAYS = Number(process.env.SOLD_REFRESH_DAYS || 30);

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
      counts.fetched = rows.length; counts.returned = rows.returned || rows.length; note = rows.note || null;
      for (const r of rows) {
        try { const result = await upsertSale(productId, r); if (result in counts) counts[result]++; }
        catch (e) { note += `; save error: ${e.message.slice(0, 120)}`; }
      }
    } catch (e) {
      error = friendlyError(e);
    }
    await pool.query(`UPDATE ingest_runs SET fetched=$1, inserted=$2, updated=$3, error=$4, note=$5, returned=$7, finished_at=NOW() WHERE id=$6`,
      [counts.fetched, counts.inserted, counts.updated, error, note, runId, counts.returned || 0]).catch(() => {});
    out[src.name] = counts;
  }
  return out;
}

async function ingestProduct(term, { sold = true } = {}) {
  term = String(term || '').trim().toLowerCase();
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
      counts.fetched = rows.length; counts.returned = rows.returned || rows.length;
      note = rows.note || `source returned ${rows.length} rows`;
      await progress(`${note}; saving…`);
      for (const r of rows) {
        try {
          const result = await upsertListing(productId, r);
          if (result in counts) counts[result]++;
        } catch (e) { note += `; save error: ${e.message.slice(0, 120)}`; }
      }
      console.log(`  [${src.name}] fetched ${counts.fetched}, new ${counts.inserted}, refreshed ${counts.updated}`);
      await sweepMismatches(productId, src.name, term);
    } catch (e) {
      error = friendlyError(e);
      console.log(`  [${src.name}] ERROR: ${error}`);
    }
    await pool.query(
      `UPDATE ingest_runs SET fetched=$1, inserted=$2, updated=$3, error=$4, note=$5, returned=$7, finished_at=NOW() WHERE id=$6`,
      [counts.fetched, counts.inserted, counts.updated, error, note, runId, counts.returned || 0]).catch(e => console.error('could not record run:', e.message));
  }

  if (sold) await ingestSold(productId, term);
  const r = await recalculateProduct(productId);
  console.log(`  -> ${r.deals} deals flagged out of ${r.listings} active listings`);
}

/** What the daily run refreshes: every machine someone is watching, plus TRACKED_PRODUCTS. */
async function scheduledTerms() {
  const env = (process.env.TRACKED_PRODUCTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const watched = (await pool.query(`SELECT DISTINCT p.name FROM products p JOIN watchlists w ON w.product_id = p.id ORDER BY p.name`)).rows.map(r => r.name);
  const terms = [...new Set([...env, ...watched])];
  return terms.length ? terms : ['wheel loader'];
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const terms = args.length ? args : await scheduledTerms();
  console.log(`Refreshing ${terms.length} machine(s): ${terms.join(', ')}`);

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
module.exports = { ingestProduct, ingestSold, scheduledTerms, main };
