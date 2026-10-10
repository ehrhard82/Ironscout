// Apify-hosted scrapers as data sources.
//
// None of the big-iron sites (GovDeals, IronPlanet, Ritchie Bros, MachineryTrader)
// offer a public API. Apify (apify.com) hosts community-maintained scrapers
// ("actors") for them that return JSON over a plain REST call, priced per 1,000
// results. That turns "write and babysit three scrapers" into "one adapter and an
// API token". Sign up at apify.com -> Settings -> Integrations -> API token.
//
// Each entry in ACTORS below is one source. Enable the ones you want in .env:
//   APIFY_TOKEN=apify_api_xxx
//   APIFY_SOURCES=govdeals,ironplanet,rbauction
//
// Actor field names drift as their authors update them, so mapItem() looks for
// several plausible names per field and the first ingest run after enabling a
// source should be eyeballed in the web viewer. Add more actors by copying an
// entry: find the actor on apify.com, note its id ("username~actor-name"), and
// check its README for the input shape.

const axios = require('axios');

// How many listings to pull per source per machine per fetch. Deals live in auctions ending
// soon, so 100 sorted by "ending soonest" catches them; 300 just costs 3x more.
const MAX_ITEMS = () => Number(process.env.APIFY_MAX_ITEMS || 100);
const MAX_SOLD = () => Number(process.env.APIFY_MAX_SOLD_ITEMS || 100);

// Ritchie Bros category pages by machine. Add a line to cover a new machine; a machine with
// no category is skipped for this source (no Apify cost) and the run note says so.
const RB_CATEGORIES = [
  [/frac pump|frac pumper|fracturing pump|pressure pump/, ['frac-pump', 'frac-pumping-unit']],
  [/^frac$|fracturing|frac unit|frac equipment/, ['fracturing']],
  [/frac tank/, ['frac-tank']],
  [/cement/, ['well-cementing']],
  [/coil(ed)? tubing/, ['coiled-tubing']],
  [/wireline|slickline/, ['wireline-and-slickline-equipment']],
  [/service rig|well service|workover|work over|pulling unit/, ['well-service-well-service-rig', 'work-over-rig']],
  [/hot oil/, ['hot-oil-truck']],
  [/pressure truck|pump truck|acid truck|nitrogen/, ['pressure-truck']],
  [/kill truck/, ['kill-truck']],
  [/drilling rig|drill rig/, ['drilling-rigs']],
  [/\bbop\b|blowout|well control/, ['well-control']],
  [/winch truck|bed truck|rig.?up truck|gin pole/, ['bed-and-rig-up-trucks', 'gin-pole-truck']],
  [/oilfield trailer|lowboy/, ['oil-and-gas-trailers']],
  [/vacuum truck|vac truck/, ['vacuum-truck']],
  [/wheel loader|front end loader/, ['wheel-loader', 'wheel-loaders']],
  [/excavator/, ['excavators', 'excavator']],
  [/dozer|bulldozer/, ['dozers', 'crawler-tractor']],
  [/skid steer/, ['skid-steer-loaders', 'skid-steer-loader']],
  [/backhoe/, ['backhoe-loaders']],
  [/grader/, ['motor-graders']],
  [/semi truck|truck tractor|sleeper|day cab/, ['truck-tractors', 'truck-tractor']],
  [/telehandler/, ['telehandlers']],
  [/crane/, ['cranes']],
];
function rbCategoryUrls(q) {
  const t = String(q || '').toLowerCase();
  for (const [re, slugs] of RB_CATEGORIES) if (re.test(t)) return slugs.map(s => `https://www.rbauction.com/cp/${s}`);
  return [];
}

const ACTORS = {
  govdeals: {
    // Live listings: https://apify.com/123webdata/govdeals-scraper  (URL-driven, ~$0.89 / 1,000)
    // Sold prices:   https://apify.com/parseforge/govdeals-scraper  (closed auctions only, ~$16 / 1,000)
    // (crawlerbros~govdeals-scraper, used originally, was removed from the Apify store on 2026-10-09.)
    actor: '123webdata~govdeals-scraper',
    input: (q) => ({ categoryUrls: [`https://www.govdeals.com/en/search?kWord=${encodeURIComponent(q)}`], maxResultsPerScrape: MAX_ITEMS(), usePagination: true, scrapeProductDetails: false }),
    soldActor: 'parseforge~govdeals-scraper',
    soldInput: (q) => ({ searchText: q, maxItems: MAX_SOLD(), sortField: 'auctionEnd', sortOrder: 'desc' }),
    sale_type: 'auction',
  },
  ironplanet: {
    // https://apify.com/crawloop/ironplanet-scraper  (IronPlanet + Marketplace-E)
    actor: 'crawloop~ironplanet-scraper',
    input: (q) => ({ searchQuery: q, platforms: ['IronPlanet', 'Marketplace-E'], listingMode: 'active', country: 'USA', runMode: 'listings', maxItems: MAX_ITEMS(), maxPages: 3 }),
    soldInput: (q) => ({ searchQuery: q, platforms: ['IronPlanet', 'Marketplace-E'], listingMode: 'sold', country: 'USA', runMode: 'listings', maxItems: MAX_SOLD(), maxPages: 3 }),
    sale_type: 'auction',
  },
  rbauction: {
    // https://apify.com/rastriq/rbauction-scraper  (Ritchie Bros live auctions + sold history)
    // Its keyword field is ignored, so we point it at Ritchie Bros' own category pages instead.
    // outputSchema must be 'english' or fields come back in Spanish (marca, modelo, valor...).
    actor: 'rastriq~rbauction-scraper',
    categoryUrls: (q) => rbCategoryUrls(q),
    input: (q) => ({ data_freshness: 'live', directCategoryUrls: rbCategoryUrls(q).join('\n'), listingStatuses: ['Open'], country: 'USA',
                     outputSchema: 'english', fetchBidStatus: true, sortField: 'eventEndDateTime', sortOrder: 'asc', maxItems: MAX_ITEMS(), maxPages: 2 }),
    soldInput: (q) => ({ data_freshness: 'live', directCategoryUrls: rbCategoryUrls(q).join('\n'), listingStatuses: ['Sold'], country: 'USA',
                         outputSchema: 'english', fetchDetails: true, sortField: 'eventEndDateTime', sortOrder: 'desc', maxItems: MAX_SOLD(), maxPages: 2 }),
    sale_type: 'auction',
    filterByQuery: true,        // belt and braces: still keep only titles that match the machine
  },
};

const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const coord = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };
const saneDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isFinite(d.getTime()) && d.getFullYear() >= 2000 ? d : null; };

function mapItem(item, srcName, def) {
  const price = num(pick(item, 'buyNowPrice', 'price', 'currentBid', 'current_bid', 'currentBidAmount', 'currentPrice', 'bid', 'highBid', 'startPrice', 'startingBid', 'amount', 'valor'));
  const title = pick(item, 'title', 'name', 'assetDescription', 'lotTitle', 'description')
    || [pick(item, 'modelYear', 'year', 'manufactureYear', 'anio'), pick(item, 'makeBrand', 'make', 'manufacturer', 'manufacturerName', 'marca'), pick(item, 'model', 'modelName', 'modelo')].filter(Boolean).join(' ');
  return {
    source: srcName,
    // GovDeals reuses assetId across seller accounts, so prefer the full URL / account pair as the id
    source_id: String(pick(item, 'sourceUrl', 'url', 'canonical_url', 'link', 'itemUrl')
      || (pick(item, 'assetId') && pick(item, 'accountId') ? `${item.accountId}/${item.assetId}` : null)
      || pick(item, 'assetId', 'auctionId', 'id', 'itemId', 'lotId') || ''),
    title,
    price,
    currency: pick(item, 'currency') || 'USD',
    condition: pick(item, 'condition') || (item.ironCladAssurance ? 'Used - IronClad inspected' : item.inoperable ? 'Inoperable' : 'Used'),
    year: num(pick(item, 'modelYear', 'year', 'manufactureYear', 'anio')),
    hours: num(pick(item, 'hours', 'meterHours', 'hourMeter', 'usageHours', 'tiempo_uso')),
    city: pick(item, 'city', 'locationCity', 'location.city', 'itemLocation.city'),
    state: pick(item, 'state', 'locationState', 'stateCode', 'location.state', 'itemLocation.state'),
    zip: pick(item, 'zip', 'locationZip', 'zipCode', 'postalCode', 'location.zip'),
    raw_location: typeof item.location === 'string' ? item.location : pick(item, 'itemLocation', 'locationText', 'locationStateName', 'location.name', 'ubicacion', 'eventLocation'),
    latitude: coord(pick(item, 'latitude', 'lat')),
    longitude: coord(pick(item, 'longitude', 'lng', 'lon')),
    url: pick(item, 'sourceUrl', 'url', 'canonical_url', 'link', 'itemUrl', 'assetUrl'),
    image_url: pick(item, 'imageUrl', 'image', 'mainImage', 'main_image', 'imagenes.0', 'primaryImage', 'thumbnail', 'thumbnailUrl', 'images.0.url', 'images.0', 'photos.0.url', 'photos.0', 'imageUrls.0'),
    seller_name: pick(item, 'sellerName', 'seller', 'agency', 'auctionName'),
    description: pick(item, 'description', 'summary', 'features') || [pick(item, 'categoryName', 'category'), pick(item, 'auctionTypeName', 'buyingFormat')].filter(Boolean).join(' · ') || null,
    posted_date: saneDate(pick(item, 'startDate', 'auctionStartDate', 'auctionStartAt', 'listedAt', 'createdAt')) || saneDate(pick(item, 'scrapedAt')) || new Date(),
    sale_type: /make offer|buy now|fixed/i.test(String(pick(item, 'buyingFormat', 'auction_type', 'auctionTypeName') || '')) ? 'listing' : def.sale_type,
    auction_ends: saneDate(pick(item, 'endDate', 'auctionEndDate', 'auctionEndAt', 'auctionEnd', 'auction_end', 'eventEndDateTime', 'eventEndDate', 'closingDate')),
  };
}

const API = 'https://api.apify.com/v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Start an actor run, wait for it to finish (polling, so there is no 5-minute cap like
 * run-sync has), then download its dataset. `onProgress(text)` is called at each stage so
 * the ingest run row shows where things stand even if the server restarts mid-way.
 */
async function runActor(def, input, token, onProgress = () => {}, maxMinutes = 20, actorId = def.actor) {
  const start = await axios.post(`${API}/acts/${actorId}/runs`, input,
    { params: { token, memory: 1024, timeout: maxMinutes * 60 }, timeout: 60_000 });
  const run = start.data.data;
  await onProgress(`actor run ${run.id} started`);
  const deadline = Date.now() + (maxMinutes + 1) * 60_000;
  let status = run.status, info = run;
  while (!['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(status)) {
    if (Date.now() > deadline) throw new Error(`actor run ${run.id} still ${status} after ${maxMinutes} min`);
    const r = await axios.get(`${API}/actor-runs/${run.id}`, { params: { token, waitForFinish: 60 }, timeout: 90_000 });
    info = r.data.data; status = info.status;
    await onProgress(`actor run ${run.id} ${status.toLowerCase()} (${Math.round((Date.now() - new Date(run.startedAt)) / 1000)}s)`);
  }
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await axios.get(`${API}/datasets/${info.defaultDatasetId}/items`,
      { params: { token, clean: true, format: 'json', offset, limit: 1000 }, timeout: 120_000 });
    const page = Array.isArray(r.data) ? r.data : [];
    items.push(...page);
    if (page.length < 1000) break;
  }
  return { items, status, runId: run.id };
}

/** Map a closed/sold item to a sale row. Final price field names vary by actor, so try many. */
function mapSale(item, srcName, def) {
  const base = mapItem(item, srcName, def);
  const finalPrice = num(pick(item, 'soldPrice', 'sold_price', 'hammerPrice', 'hammer_price', 'precio_venta', 'salePrice', 'sale_price', 'finalPrice', 'final_price', 'hammerPrice', 'winningBid', 'winning_bid', 'winningBidAmount', 'finalBid', 'final_bid', 'closingBid', 'closing_bid', 'closingBidAmount', 'highBid', 'high_bid', 'soldFor', 'soldAmount', 'currentBid', 'current_bid'));
  const soldAt = saneDate(pick(item, 'soldDate', 'sold_date', 'soldAt', 'saleDate', 'closedAt', 'closeDate', 'endDate', 'end_date', 'auctionEndDate', 'auctionEndAt', 'auctionEnd', 'auction_end', 'closingDate'));
  const status = String(pick(item, 'status', 'auctionStatus', 'listingStatus', 'saleStatus') || '').toLowerCase();
  const unsold = /unsold|no sale|not sold|cancel|withdrawn|reserve not met|passed/.test(status) || item.sold === false;
  return { ...base, price: finalPrice || base.price, sold_at: soldAt || base.auction_ends || null, unsold };
}

/** Hard stop: Apify listings fetched TODAY (midnight-to-midnight in BUDGET_TZ, all sources incl. sold) stay under APIFY_DAILY_ITEMS. */
async function budgetLeft() {
  const cap = Number(process.env.APIFY_DAILY_ITEMS || 1500);
  const tz = process.env.BUDGET_TZ || 'America/New_York';
  const pool = require('../db');
  const r = await pool.query(`SELECT COALESCE(SUM(fetched),0)::int AS n FROM ingest_runs
    WHERE (started_at AT TIME ZONE 'UTC' AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date
      AND (source IN (${Object.keys(ACTORS).map(k => `'${k}'`).join(',')}) OR source LIKE '%:sold')`, [tz]);
  return { cap, used: r.rows[0].n, left: cap - r.rows[0].n, resets: `midnight ${tz}` };
}

/** Does a listing title plausibly describe the machine searched for? Every word of the
 *  query (stemmed to its first 4-5 letters) must appear: "frac pump" matches "SPM Frac Pumper",
 *  not "Cat 950 Wheel Loader". */
function matchesQuery(title, q) {
  const t = String(title || '').toLowerCase();
  const words = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  if (!words.length) return true;
  return words.every(w => t.includes(w.length >= 6 ? w.slice(0, 5) : w.length >= 5 ? w.slice(0, 4) : w));
}
function applyQueryFilter(def, mapped, q) {
  if (!def.filterByQuery) return { kept: mapped, dropped: 0 };
  if (def.categoryUrls && def.categoryUrls(q).length) return { kept: mapped, dropped: 0 };   // category page is already precise
  const kept = mapped.filter(m => matchesQuery(m.title, q));
  return { kept, dropped: mapped.length - kept.length };
}

function makeSource(name) {
  const def = ACTORS[name];
  if (!def) throw new Error(`Unknown Apify source "${name}". Known: ${Object.keys(ACTORS).join(', ')}`);
  return {
    name,
    async fetch(term, onProgress) {
      const token = (process.env.APIFY_TOKEN || '').trim();
      if (!token) {
        console.log(`  [${name}] APIFY_TOKEN not set -> skipping`);
        const empty = []; empty.note = 'skipped: APIFY_TOKEN is not set on this server'; return empty;
      }
      if (def.categoryUrls && !def.categoryUrls(term).length) { const e = []; e.note = `skipped: no Ritchie Bros category mapped for "${term}" (add one in lib/sources/apify.js RB_CATEGORIES)`; return e; }
      const b = await budgetLeft();
      if (b.left <= 0) { const e = []; e.note = `skipped: daily Apify budget used (${b.used}/${b.cap} listings in 24h). Raise APIFY_DAILY_ITEMS to allow more.`; return e; }
      const { items, status, runId } = await runActor(def, { ...def.input(term), maxItems: Math.min(MAX_ITEMS(), b.left) }, token, onProgress);
      const all = items.map(i => mapItem(i, name, def)).filter(i => i.source_id && i.price);
      const { kept: mapped, dropped } = applyQueryFilter(def, all, term);
      const note = `actor run ${runId} ${status}: ${items.length} items, ${mapped.length} usable` +
        (dropped ? ` (${dropped} not about "${term}" dropped)` : '') +
        (items.length && !all.length ? `; keys: ${Object.keys(items[0]).slice(0, 30).join(', ')}` : '');
      console.log(`  [${name}] ${note}`);
      mapped.note = note;
      return mapped;
    },
    /** Completed sales for this machine (hammer prices). Returns [] with a note if the actor has no sold mode. */
    async fetchSold(term, onProgress) {
      const token = (process.env.APIFY_TOKEN || '').trim();
      const empty = [];
      if (!token) { empty.note = 'skipped: APIFY_TOKEN is not set'; return empty; }
      if (!def.soldInput) { empty.note = 'this source has no sold-results mode'; return empty; }
      if (def.categoryUrls && !def.categoryUrls(term).length) { empty.note = `skipped: no Ritchie Bros category mapped for "${term}"`; return empty; }
      const b = await budgetLeft();
      if (b.left <= 0) { empty.note = `skipped: daily Apify budget used (${b.used}/${b.cap} listings in 24h)`; return empty; }
      const { items, status, runId } = await runActor(def, { ...def.soldInput(term), maxItems: Math.min(MAX_SOLD(), b.left) }, token, onProgress, 20, def.soldActor || def.actor);
      const all = items.map(i => mapSale(i, name, def));
      const priced = all.filter(i => i.source_id && i.price && !i.unsold);
      const { kept: mapped, dropped } = applyQueryFilter(def, priced, term);
      const note = `actor run ${runId} ${status}: ${items.length} closed items, ${mapped.length} with a final price` +
        (dropped ? ` (${dropped} not about "${term}" dropped)` : '') +
        (items.length && !mapped.length ? `; keys: ${Object.keys(items[0]).slice(0, 30).join(', ')}` : '');
      console.log(`  [${name}:sold] ${note}`);
      mapped.note = note;
      return mapped;
    },
  };
}

/** Raw call for diagnostics: returns the first few untouched items from an actor. */
async function rawSample(name, term, n = 2, mode = 'active') {
  const def = ACTORS[name];
  if (!def) throw new Error(`Unknown source ${name}`);
  if (mode === 'sold' && !def.soldInput) throw new Error(`${name} has no sold-results mode`);
  const input = { ...(mode === 'sold' ? def.soldInput(term) : def.input(term)), maxItems: 5, maxPages: 1, maxResultsPerScrape: 5 };
  const actorId = mode === 'sold' ? (def.soldActor || def.actor) : def.actor;
  const { items, status, runId } = await runActor(def, input, (process.env.APIFY_TOKEN || '').trim(), () => {}, 5, actorId);
  return { token_present: Boolean((process.env.APIFY_TOKEN || '').trim()), actor: actorId, input, run_id: runId, run_status: status, count: items.length,
           keys: items[0] ? Object.keys(items[0]) : [], sample: items.slice(0, n), mapped: items.slice(0, n).map(i => mode === 'sold' ? mapSale(i, name, def) : mapItem(i, name, def)) };
}

/** Sources enabled via APIFY_SOURCES in .env */
function enabledSources() {
  const token = (process.env.APIFY_TOKEN || '').trim();
  let list = (process.env.APIFY_SOURCES || '').split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length && token) list = ['govdeals', 'ironplanet'];     // sensible default once a token exists
  const known = list.filter(n => ACTORS[n]);
  const unknown = list.filter(n => !ACTORS[n]);
  if (unknown.length) console.warn(`APIFY_SOURCES: ignoring unknown source(s) ${unknown.join(', ')}. Known: ${Object.keys(ACTORS).join(', ')}`);
  if (!token && known.length) console.warn('APIFY_SOURCES set but APIFY_TOKEN missing - those sources will be skipped');
  return known.map(makeSource);
}

module.exports = { enabledSources, makeSource, mapItem, mapSale, rawSample, budgetLeft, matchesQuery, ACTORS };
