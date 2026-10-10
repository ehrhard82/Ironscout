// Upsert helpers used by every data source.
const pool = require('./db');
const { normalizeLocation } = require('./location');

async function getOrCreateProduct(name) {
  const clean = name.trim().toLowerCase();
  const found = await pool.query('SELECT id FROM products WHERE name = $1', [clean]);
  if (found.rows.length) return found.rows[0].id;
  const made = await pool.query(
    'INSERT INTO products (name) VALUES ($1) RETURNING id', [clean]);
  return made.rows[0].id;
}

const excludeCache = new Map();
async function excludeTermsFor(productId) {
  if (!excludeCache.has(productId)) {
    const r = await pool.query('SELECT exclude_terms FROM products WHERE id = $1', [productId]);
    excludeCache.set(productId, (r.rows[0]?.exclude_terms || []).map(t => t.toLowerCase()));
  }
  return excludeCache.get(productId);
}

/** True if the title contains any excluded term as a whole word/phrase. */
function isExcluded(title, terms) {
  const t = ` ${String(title).toLowerCase().replace(/[^a-z0-9:/.-]+/g, ' ')} `;
  return terms.some(term => t.includes(` ${term} `));
}

/**
 * Insert a listing, or if we've seen (source, source_id) before, refresh it.
 * Returns 'inserted' | 'updated' | 'skipped'.
 * Expected shape: { source, source_id, title, description, price, currency, condition,
 *                   year, hours, city, state, zip, raw_location, url, image_url,
 *                   seller_name, posted_date }
 */
/** Whole number within [lo, hi], else null (sources send "899.62" hours, "2014.0" years, or junk). */
function intOrNull(v, lo, hi) {
  const n = Math.round(Number(String(v ?? '').replace(/[^0-9.]/g, '')));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

async function upsertListing(productId, l) {
  const minPrice = Number(process.env.MIN_VALID_PRICE || 500);
  const price = Number(l.price);
  if (!l.source_id || !l.title || !Number.isFinite(price) || price < minPrice) return 'skipped';
  if (isExcluded(l.title, await excludeTermsFor(productId))) return 'skipped';
  l.year = intOrNull(l.year, 1900, 2100); l.hours = intOrNull(l.hours, 0, 500000);

  // Pull a model year out of the title if the source didn't give one ("2016 Peterbilt 389")
  if (!l.year) {
    const m = String(l.title).match(/\b(19[6-9]\d|20[0-4]\d)\b/);
    if (m) l.year = Number(m[1]);
  }

  const loc = normalizeLocation({ city: l.city, state: l.state, zip: l.zip, raw: l.raw_location });

  const existing = await pool.query(
    'SELECT id, price FROM listings WHERE source = $1 AND source_id = $2',
    [l.source, String(l.source_id)]);

  if (existing.rows.length) {
    const row = existing.rows[0];
    if (Number(row.price) !== price) {
      await pool.query(
        'INSERT INTO price_history (listing_id, old_price, new_price) VALUES ($1,$2,$3)',
        [row.id, row.price, price]);
    }
    await pool.query(
      `UPDATE listings SET price=$1, title=$2, last_seen=NOW(), is_active=TRUE,
         city=COALESCE($3,city), state=COALESCE($4,state), zip_code=COALESCE($5,zip_code),
         year=COALESCE($6,year), hours=COALESCE($7,hours), auction_ends=COALESCE($8,auction_ends)
       WHERE id=$9`,
      [price, l.title, loc.city, loc.state, loc.zip_code, l.year || null, l.hours || null, l.auction_ends || null, row.id]);
    return 'updated';
  }

  await pool.query(
    `INSERT INTO listings (product_id, source, source_id, title, description, price, currency,
       condition, year, hours, city, state, zip_code, country, latitude, longitude, url, image_url,
       seller_name, sale_type, auction_ends, posted_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [productId, l.source, String(l.source_id), l.title, l.description || null, price,
     l.currency || 'USD', l.condition || null, l.year || null, l.hours || null,
     loc.city, loc.state, loc.zip_code, l.country || 'US', l.latitude || null, l.longitude || null,
     l.url || null, l.image_url || null, l.seller_name || null, l.sale_type || 'listing',
     l.auction_ends || null, l.posted_date || new Date()]);
  return 'inserted';
}

/** Listings not seen in N days are probably sold/removed. Deactivate them. */
async function deactivateStale(days = 14) {
  const r = await pool.query(
    `UPDATE listings SET is_active = FALSE
     WHERE is_active AND source <> 'csv' AND last_seen < NOW() - ($1 || ' days')::interval`,
    [String(days)]);
  return r.rowCount;
}

/** Record a completed sale. Returns 'inserted' | 'updated' | 'skipped'. */
async function upsertSale(productId, l) {
  const minPrice = Number(process.env.MIN_VALID_PRICE || 500);
  const price = Number(l.price);
  if (!l.source_id || !l.title || !Number.isFinite(price) || price < minPrice) return 'skipped';
  if (isExcluded(l.title, await excludeTermsFor(productId))) return 'skipped';
  l.year = intOrNull(l.year, 1900, 2100); l.hours = intOrNull(l.hours, 0, 500000);
  if (!l.year) { const m = String(l.title).match(/\b(19[6-9]\d|20[0-4]\d)\b/); if (m) l.year = Number(m[1]); }
  const loc = normalizeLocation({ city: l.city, state: l.state, zip: l.zip, raw: l.raw_location });
  const r = await pool.query(
    `INSERT INTO sales (product_id, source, source_id, title, price, year, hours, city, state, url, sold_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (source, source_id) DO UPDATE SET price = EXCLUDED.price, sold_at = COALESCE(EXCLUDED.sold_at, sales.sold_at)
     RETURNING (xmax = 0) AS inserted`,
    [productId, l.source, String(l.source_id), String(l.title).slice(0, 500), price, l.year || null, l.hours || null,
     loc.city, loc.state, l.url || null, l.sold_at || null]);
  return r.rows[0].inserted ? 'inserted' : 'updated';
}

module.exports = { upsertSale, getOrCreateProduct, upsertListing, deactivateStale };
