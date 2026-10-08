// Import listings from a CSV file (e.g. your broker's own inventory, or a
// spreadsheet you built from auction results). Then recalculates deals.
//
//   npm run import:csv -- data/example.csv
//
// Required columns:  product, title, price
// Optional columns:  source_id, condition, year, hours, city, state, zip, url, seller, description, posted_date
// If source_id is blank one is generated from the row contents.

require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const pool = require('../lib/db');
const { getOrCreateProduct, upsertListing } = require('../lib/listings');
const { recalculateProduct } = require('../lib/pricing');

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: npm run import:csv -- path/to/file.csv');
    process.exit(1);
  }
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
  const touched = new Set();
  let ok = 0, skipped = 0;

  for (const r of rows) {
    if (!r.product || !r.title || !r.price) { skipped++; continue; }
    const productId = await getOrCreateProduct(r.product);
    touched.add(productId);
    const sourceId = r.source_id || crypto.createHash('md5').update(`${r.product}|${r.title}|${r.price}|${r.city || ''}`).digest('hex');
    const result = await upsertListing(productId, {
      source: 'csv', source_id: sourceId, title: r.title, description: r.description,
      price: Number(String(r.price).replace(/[^0-9.]/g, '')), condition: r.condition,
      year: r.year ? Number(r.year) : null, hours: r.hours ? Number(r.hours) : null,
      city: r.city, state: r.state, zip: r.zip, url: r.url, seller_name: r.seller,
      posted_date: r.posted_date ? new Date(r.posted_date) : new Date(),
    });
    result === 'skipped' ? skipped++ : ok++;
  }

  for (const id of touched) {
    const res = await recalculateProduct(id);
    console.log(`product #${id}: ${res.deals} deals`);
  }
  console.log(`Imported ${ok} rows, skipped ${skipped}.`);
}

main().then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
