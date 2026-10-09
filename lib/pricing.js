// Pricing engine.
//
// The goal: find listings a buyer could purchase and resell at a profit. That
// means we care about DOLLARS of margin, not just percent off. 5% off a $400k
// loader ($20k) is a deal; 20% off a $1,500 dirt bike ($300) usually isn't.
//
// How a listing is judged:
//   1. Pick the tightest group of comparables that has at least MIN_SAMPLE_SIZE
//      active listings, trying in order:
//        a) same state, model year within ±YEAR_BAND
//        b) anywhere in the country, model year within ±YEAR_BAND
//        c) same state, any year
//        d) anywhere in the country, any year
//      (year-matching matters a lot on $100k+ machinery; a 2012 unit "20% below
//       the median of all units" is not a deal if the median is full of 2021s)
//   2. market_price = MEDIAN of that group (robust to junk listings).
//   3. discount_amount   = market_price - price
//      estimated_margin  = discount_amount - price * TRANSACTION_COST_PERCENT
//                          (rough allowance for transport, auction/buyer fees, time)
//   4. It's a deal if discount_percent >= DEAL_THRESHOLD_PERCENT
//                 AND estimated_margin  >= MIN_DEAL_DOLLARS
//   5. deal_score (0-10) blends three things:
//        - how deep the discount is (percent)
//        - how much money is on the table (log-scaled dollars, so $20k >> $2k
//          but $500k isn't 25x better than $20k)
//        - how much we trust the comparison (sample size)
//
// Auctions are different from listings and are handled in three ways:
//   - A current bid with days left is not a price. Auctions ending more than
//     AUCTION_MAX_HOURS out are never flagged as deals (they'd all look 70% off).
//     Inside that window the score is scaled by time left: ending in 6h = full
//     weight, 24h = 0.85, 48h = 0.6, 72h = 0.4.
//   - The buyer's premium (BUYER_PREMIUM_PERCENT, default 12) comes off the margin
//     for auction lots, on top of the general transaction cost.
//   - When we have enough completed SALES (hammer prices, last SOLD_WINDOW_DAYS)
//     those are the market, full stop. Asking prices only fill in when sales are thin.
//   - Market medians are built from "firm" prices only - fixed-price listings and
//     auctions in their final AUCTION_FIRM_HOURS - when there are enough of them,
//     so early bids don't drag the market down. Falls back to all prices if not.
//
// Deals are rebuilt from scratch every run so stale ones disappear, but rows the
// broker has claimed/sold/passed are preserved.

const pool = require('./db');

const cfg = () => ({
  THRESHOLD: Number(process.env.DEAL_THRESHOLD_PERCENT || 5),
  MIN_N: Number(process.env.MIN_SAMPLE_SIZE || 5),
  MIN_DOLLARS: Number(process.env.MIN_DEAL_DOLLARS || 2500),
  TX_COST: Number(process.env.TRANSACTION_COST_PERCENT || 3) / 100,
  YEAR_BAND: Number(process.env.YEAR_BAND || 3),
  PREMIUM: Number(process.env.BUYER_PREMIUM_PERCENT || 12) / 100,
  AUCTION_MAX_HOURS: Number(process.env.AUCTION_MAX_HOURS || 72),
  AUCTION_FIRM_HOURS: Number(process.env.AUCTION_FIRM_HOURS || 24),
  SOLD_DAYS: Number(process.env.SOLD_WINDOW_DAYS || 120),
});

// Machines that aren't really the machine: parts units, salvage, non-runners, attachments.
// They are neither comparables nor deals. (Shared with the SQL that loads rows.)
const JUNK_RE = String.raw`(inoperable|non-?running|not running|does not run|no engine|parts only|for parts|parts machine|salvage|scrap|burn(ed|t)|fire damage|rolled over|attachment only|bucket only|tires only)`;
const JUNK_SQL = `COALESCE(condition,'') ~* '${JUNK_RE}' OR title ~* '${JUNK_RE}'`;

const hoursLeft = (r, now = Date.now()) => r.auction_ends ? (new Date(r.auction_ends) - now) / 3600000 : null;

/** 0..1 weight for an auction by time remaining. Non-auctions and unknown end dates -> 1 / 0.5. */
function timeWeight(r, c) {
  if (r.sale_type !== 'auction') return 1;
  const h = hoursLeft(r);
  if (h === null) return 0.5;
  if (h <= 6) return 1;
  if (h <= 24) return 0.85;
  if (h <= 48) return 0.6;
  return 0.4;
}

/** A price we believe: fixed-price listing, or an auction in its final hours. */
const isFirm = (r, c) => r.sale_type !== 'auction' || (hoursLeft(r) !== null && hoursLeft(r) <= c.AUCTION_FIRM_HOURS);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(prices) {
  const s = [...prices].sort((a, b) => a - b);
  return {
    median: percentile(s, 0.5), p25: percentile(s, 0.25), p75: percentile(s, 0.75),
    mean: s.reduce((a, b) => a + b, 0) / s.length, min: s[0], max: s[s.length - 1], n: s.length,
  };
}

/** Trust 0..1 for a sample of size n. 5 -> ~0.3, 15 -> ~0.63, 45 -> ~0.95. */
const confidence = (n) => 1 - Math.exp(-n / 15);

/**
 * Score 0-10.
 *  pct component:    0 at 0%, 1 at 35%+
 *  dollar component: 0 at $1k, ~0.5 at $10k, ~0.75 at $30k, 1 at $100k+   (log scale)
 *  Weighted 45% pct / 55% dollars, then scaled by confidence.
 */
function scoreDeal(discountPct, margin, n) {
  const pctPart = Math.min(Math.max(discountPct, 0) / 35, 1);
  const dollarPart = Math.min(Math.max(Math.log10(Math.max(margin, 1) / 1000) / 2, 0), 1);
  const raw = (0.45 * pctPart + 0.55 * dollarPart) * 10;
  return Math.round(raw * confidence(n) * 10) / 10;
}

/**
 * Find the best comparable set for one listing. Returns {stats, label, penalty} or null.
 *
 * If the listing's year is known we try progressively wider year bands
 * (±YEAR_BAND, ±2x, ±3x), state first then national, BEFORE ever comparing across
 * all years. An old machine measured against a median full of new machines looks
 * like a bargain and isn't. If we're forced to compare across all years anyway,
 * the label says so and the score is halved (penalty = 0.5).
 */
function pickComparables(listing, rows, c, sales = []) {
  const others = rows.filter(r => r.id !== listing.id);
  const sameState = (r) => listing.state && r.state === listing.state;
  const attempts = [];

  if (listing.year) {
    for (const mult of [1, 2, 3]) {
      const band = c.YEAR_BAND * mult;
      const inBand = (r) => r.year && Math.abs(r.year - listing.year) <= band;
      const yrs = `${listing.year - band}-${listing.year + band}`;
      attempts.push({ f: (r) => sameState(r) && inBand(r), label: (n) => `${listing.state} ${yrs} median (n=${n})`, penalty: 1 });
      attempts.push({ f: inBand,                            label: (n) => `US ${yrs} median (n=${n})`, penalty: 1 });
    }
  }
  const allYears = listing.year ? ', all years - year not matched' : ', year unknown';
  const penalty = listing.year ? 0.5 : 0.6;
  attempts.push({ f: sameState,  label: (n) => `${listing.state} median (n=${n}${allYears})`, penalty });
  attempts.push({ f: () => true, label: (n) => `US median (n=${n}${allYears})`, penalty });

  // Best evidence first: completed sales, then firm asking prices, then everything.
  const tiers = [
    { cands: sales, suffix: ' sold', basis: 'sold' },
    { cands: others.filter(r => isFirm(r, c)), suffix: '', basis: 'asking' },
    { cands: others, suffix: ', incl. open bids', basis: 'asking' },
  ];
  for (const t of tiers) {
    for (const a of attempts) {
      const group = t.cands.filter(a.f).map(r => r.price);
      if (group.length >= c.MIN_N) return { stats: stats(group), label: a.label(group.length).replace(' median', `${t.suffix} median`), penalty: a.penalty, basis: t.basis };
    }
  }
  return null;
}

async function recalculateProduct(productId) {
  const c = cfg();
  const { rows } = await pool.query(
    `SELECT id, price::float AS price, state, year, sale_type, auction_ends FROM listings
     WHERE product_id = $1 AND is_active AND (auction_ends IS NULL OR auction_ends > NOW())
       AND NOT (${JUNK_SQL})`, [productId]);
  const sales = (await pool.query(
    `SELECT id, price::float AS price, state, year FROM sales
     WHERE product_id = $1 AND (sold_at IS NULL OR sold_at > NOW() - ($2 || ' days')::interval)
       AND NOT (title ~* '${JUNK_RE}')`, [productId, c.SOLD_DAYS])).rows;
  if (!rows.length && !sales.length) return { deals: 0, listings: 0, sales: 0 };

  // --- market_stats table (for the UI / API): per state + national, all years.
  //     Basis: sales if we have enough, else firm asking prices, else everything. ---
  const firm = rows.filter(r => isFirm(r, c));
  const basis = sales.length >= c.MIN_N ? sales : firm.length >= c.MIN_N ? firm : rows;
  const basisName = basis === sales ? 'sold' : 'asking';
  const byStateFirm = {};
  for (const r of basis) if (r.state) (byStateFirm[r.state] ||= []).push(r.price);
  const regions = [['country', 'US', stats(basis.map(r => r.price))],
    ...Object.entries(byStateFirm).map(([st, p]) => ['state', st, stats(p)])];
  await pool.query('DELETE FROM market_stats WHERE product_id = $1', [productId]);
  for (const [type, region, s] of regions) {
    await pool.query(
      `INSERT INTO market_stats (product_id, region_type, region, median_price, mean_price,
         p25_price, p75_price, min_price, max_price, sample_size, basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [productId, type, region, s.median, s.mean, s.p25, s.p75, s.min, s.max, s.n, basisName]);
  }
  if (!rows.length) return { deals: 0, listings: 0, sales: sales.length };

  // --- deals ---
  await pool.query(`DELETE FROM deals WHERE product_id = $1 AND commission_status = 'open'`, [productId]);
  const kept = new Set((await pool.query(
    `SELECT listing_id FROM deals WHERE product_id = $1`, [productId])).rows.map(r => r.listing_id));

  let count = 0;
  for (const r of rows) {
    if (kept.has(r.id)) continue;
    const h = hoursLeft(r);
    if (r.sale_type === 'auction' && h !== null && h > c.AUCTION_MAX_HOURS) continue;   // not a price yet
    const comp = pickComparables(r, rows, c, sales);
    if (!comp) continue;
    const market = comp.stats.median;
    const discountPct = ((market - r.price) / market) * 100;
    const discount = market - r.price;
    const costs = r.price * (c.TX_COST + (r.sale_type === 'auction' ? c.PREMIUM : 0));
    const margin = discount - costs;
    if (discountPct < c.THRESHOLD || margin < c.MIN_DOLLARS) continue;
    // More than 60% under market is almost never a bargain - it's usually the wrong machine,
    // a parts unit, or an early bid. Keep it visible but push it down the list.
    const sanity = discountPct > 60 ? 0.35 : 1;
    const label = comp.label + (discountPct > 60 ? ' - verify: unusually low' : '');
    await pool.query(
      `INSERT INTO deals (listing_id, product_id, compared_to, market_price, actual_price,
         discount_percent, discount_amount, estimated_margin, deal_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.id, productId, label, market, r.price, discountPct.toFixed(2),
       discount.toFixed(2), margin.toFixed(2),
       Math.round(scoreDeal(discountPct, margin, comp.stats.n) * comp.penalty * timeWeight(r, c) * sanity * 10) / 10]);
    count++;
  }
  return { deals: count, listings: rows.length, sales: sales.length };
}

async function recalculateAll() {
  const { rows } = await pool.query('SELECT id, name FROM products ORDER BY id');
  const out = [];
  for (const p of rows) out.push({ product: p.name, ...(await recalculateProduct(p.id)) });
  return out;
}

module.exports = { recalculateProduct, recalculateAll, scoreDeal, stats, pickComparables, timeWeight, isFirm };
