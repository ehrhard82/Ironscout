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

const ACTORS = {
  govdeals: {
    // https://apify.com/crawlerbros/govdeals-scraper  (government surplus auctions)
    actor: 'crawlerbros~govdeals-scraper',
    input: (q) => ({ mode: 'search', searchText: q, auctionStatus: 'open', sortBy: 'endingSoonest', maxItems: 300 }),
    soldInput: (q) => ({ mode: 'search', searchText: q, auctionStatus: 'closed', sortBy: 'endingLatest', maxItems: 300 }),
    sale_type: 'auction',
  },
  ironplanet: {
    // https://apify.com/crawloop/ironplanet-scraper  (IronPlanet + Marketplace-E)
    actor: 'crawloop~ironplanet-scraper',
    input: (q) => ({ searchQuery: q, platforms: ['IronPlanet', 'Marketplace-E'], listingMode: 'active', country: 'USA', runMode: 'listings', maxItems: 300, maxPages: 5 }),
    soldInput: (q) => ({ searchQuery: q, platforms: ['IronPlanet', 'Marketplace-E'], listingMode: 'sold', country: 'USA', runMode: 'listings', maxItems: 300, maxPages: 5 }),
    sale_type: 'auction',
  },
  rbauction: {
    // https://apify.com/rastriq/rbauction-scraper  (Ritchie Bros live auctions)
    actor: 'rastriq~rbauction-scraper',
    input: (q) => ({ runPreset: 'active_inventory', keywords: q, listingStatuses: ['Open'], country: 'United States', maxItems: 300, maxPages: 6 }),
    soldInput: (q) => ({ runPreset: 'active_inventory', keywords: q, listingStatuses: ['Sold', 'Closed'], country: 'United States', maxItems: 300, maxPages: 6 }),
    sale_type: 'auction',
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
  const price = num(pick(item, 'buyNowPrice', 'price', 'currentBid', 'currentPrice', 'bid', 'startPrice', 'amount'));
  const title = pick(item, 'title', 'name', 'description')
    || [pick(item, 'modelYear', 'year'), pick(item, 'makeBrand', 'make', 'manufacturer'), pick(item, 'model')].filter(Boolean).join(' ');
  return {
    source: srcName,
    // GovDeals reuses assetId across seller accounts, so prefer the full URL / account pair as the id
    source_id: String(pick(item, 'sourceUrl', 'url', 'link', 'itemUrl')
      || (pick(item, 'assetId') && pick(item, 'accountId') ? `${item.accountId}/${item.assetId}` : null)
      || pick(item, 'assetId', 'auctionId', 'id', 'itemId', 'lotId') || ''),
    title,
    price,
    currency: pick(item, 'currency') || 'USD',
    condition: pick(item, 'condition') || (item.ironCladAssurance ? 'Used - IronClad inspected' : item.inoperable ? 'Inoperable' : 'Used'),
    year: num(pick(item, 'modelYear', 'year')),
    hours: num(pick(item, 'hours', 'meterHours', 'hourMeter')),
    city: pick(item, 'city', 'locationCity', 'location.city', 'itemLocation.city'),
    state: pick(item, 'state', 'locationState', 'stateCode', 'location.state', 'itemLocation.state'),
    zip: pick(item, 'zip', 'locationZip', 'zipCode', 'postalCode', 'location.zip'),
    raw_location: pick(item, 'location', 'itemLocation', 'locationText', 'locationStateName'),
    latitude: coord(pick(item, 'latitude', 'lat')),
    longitude: coord(pick(item, 'longitude', 'lng', 'lon')),
    url: pick(item, 'sourceUrl', 'url', 'link', 'itemUrl'),
    image_url: pick(item, 'imageUrl', 'image', 'mainImage', 'thumbnail', 'thumbnailUrl', 'images.0.url', 'images.0', 'photos.0.url', 'photos.0', 'imageUrls.0'),
    seller_name: pick(item, 'sellerName', 'seller', 'agency', 'auctionName'),
    description: pick(item, 'description', 'summary', 'features') || [pick(item, 'categoryName', 'category'), pick(item, 'auctionTypeName', 'buyingFormat')].filter(Boolean).join(' · ') || null,
    posted_date: saneDate(pick(item, 'startDate', 'auctionStartDate', 'auctionStartAt', 'listedAt', 'createdAt')) || saneDate(pick(item, 'scrapedAt')) || new Date(),
    sale_type: /make offer|buy now|fixed/i.test(String(pick(item, 'buyingFormat') || '')) ? 'listing' : def.sale_type,
    auction_ends: saneDate(pick(item, 'endDate', 'auctionEndDate', 'auctionEndAt', 'auctionEnd', 'closingDate')),
  };
}

const API = 'https://api.apify.com/v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Start an actor run, wait for it to finish (polling, so there is no 5-minute cap like
 * run-sync has), then download its dataset. `onProgress(text)` is called at each stage so
 * the ingest run row shows where things stand even if the server restarts mid-way.
 */
async function runActor(def, input, token, onProgress = () => {}, maxMinutes = 20) {
  const start = await axios.post(`${API}/acts/${def.actor}/runs`, input,
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
  const finalPrice = num(pick(item, 'soldPrice', 'salePrice', 'finalPrice', 'hammerPrice', 'winningBid', 'finalBid', 'highBid', 'soldFor', 'sold_price', 'closingBid'));
  const soldAt = saneDate(pick(item, 'soldDate', 'soldAt', 'saleDate', 'closedAt', 'closeDate', 'endDate', 'auctionEndDate', 'auctionEndAt', 'auctionEnd', 'closingDate'));
  const status = String(pick(item, 'status', 'auctionStatus', 'listingStatus', 'saleStatus') || '').toLowerCase();
  const unsold = /unsold|no sale|not sold|cancel|withdrawn|reserve not met|passed/.test(status) || item.sold === false;
  return { ...base, price: finalPrice || base.price, sold_at: soldAt || base.auction_ends || null, unsold };
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
      const { items, status, runId } = await runActor(def, def.input(term), token, onProgress);
      const mapped = items.map(i => mapItem(i, name, def)).filter(i => i.source_id && i.price);
      const note = `actor run ${runId} ${status}: ${items.length} items, ${mapped.length} usable` +
        (items.length && !mapped.length ? `; keys: ${Object.keys(items[0]).slice(0, 30).join(', ')}` : '');
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
      const { items, status, runId } = await runActor(def, def.soldInput(term), token, onProgress);
      const all = items.map(i => mapSale(i, name, def));
      const mapped = all.filter(i => i.source_id && i.price && !i.unsold);
      const note = `actor run ${runId} ${status}: ${items.length} closed items, ${mapped.length} with a final price` +
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
  const input = { ...(mode === 'sold' ? def.soldInput(term) : def.input(term)), maxItems: 5, maxPages: 1 };
  const { items, status, runId } = await runActor(def, input, (process.env.APIFY_TOKEN || '').trim(), () => {}, 5);
  return { token_present: Boolean((process.env.APIFY_TOKEN || '').trim()), actor: def.actor, input, run_id: runId, run_status: status, count: items.length,
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

module.exports = { enabledSources, makeSource, mapItem, mapSale, rawSample, ACTORS };
