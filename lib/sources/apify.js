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
    sale_type: 'auction',
  },
  ironplanet: {
    // https://apify.com/crawloop/ironplanet-scraper  (IronPlanet + Marketplace-E)
    actor: 'crawloop~ironplanet-scraper',
    input: (q) => ({ searchQuery: q, platforms: ['IronPlanet', 'Marketplace-E'], listingMode: 'active', country: 'USA', runMode: 'listings', maxItems: 300, maxPages: 5 }),
    sale_type: 'auction',
  },
  rbauction: {
    // https://apify.com/rastriq/rbauction-scraper  (Ritchie Bros live auctions)
    actor: 'rastriq~rbauction-scraper',
    input: (q) => ({ runPreset: 'active_inventory', keywords: q, listingStatuses: ['Open'], country: 'United States', maxItems: 300, maxPages: 6 }),
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

function mapItem(item, srcName, def) {
  const price = num(pick(item, 'buyNowPrice', 'price', 'currentBid', 'currentPrice', 'bid', 'startPrice', 'amount'));
  const title = pick(item, 'title', 'name', 'description')
    || [pick(item, 'modelYear', 'year'), pick(item, 'makeBrand', 'make', 'manufacturer'), pick(item, 'model')].filter(Boolean).join(' ');
  return {
    source: srcName,
    source_id: String(pick(item, 'assetId', 'auctionId', 'id', 'itemId', 'lotId', 'sourceUrl', 'url') || ''),
    title,
    description: pick(item, 'description', 'summary'),
    price,
    currency: pick(item, 'currency') || 'USD',
    condition: pick(item, 'condition', 'ironCladStatus', 'inspectionStatus') || 'Used',
    year: num(pick(item, 'modelYear', 'year')),
    hours: num(pick(item, 'hours', 'meterHours', 'hourMeter')),
    city: pick(item, 'city', 'location.city', 'itemLocation.city'),
    state: pick(item, 'state', 'stateCode', 'location.state', 'itemLocation.state'),
    zip: pick(item, 'zip', 'zipCode', 'postalCode', 'location.zip'),
    raw_location: pick(item, 'location', 'itemLocation', 'locationText'),
    latitude: num(pick(item, 'latitude', 'lat')),
    longitude: num(pick(item, 'longitude', 'lng', 'lon')),
    url: pick(item, 'sourceUrl', 'url', 'link', 'itemUrl'),
    image_url: pick(item, 'imageUrl', 'image', 'images.0', 'thumbnail'),
    seller_name: pick(item, 'sellerName', 'seller', 'agency', 'auctionName'),
    posted_date: pick(item, 'startDate', 'auctionStartAt', 'listedAt', 'createdAt') ? new Date(pick(item, 'startDate', 'auctionStartAt', 'listedAt', 'createdAt')) : new Date(),
    sale_type: def.sale_type,
    auction_ends: pick(item, 'endDate', 'auctionEndAt', 'auctionEnd', 'closingDate') ? new Date(pick(item, 'endDate', 'auctionEndAt', 'auctionEnd', 'closingDate')) : null,
  };
}

function makeSource(name) {
  const def = ACTORS[name];
  if (!def) throw new Error(`Unknown Apify source "${name}". Known: ${Object.keys(ACTORS).join(', ')}`);
  return {
    name,
    async fetch(term) {
      const token = process.env.APIFY_TOKEN;
      if (!token) { console.log(`  [${name}] APIFY_TOKEN not set -> skipping`); return []; }
      // run-sync-get-dataset-items: starts the actor, waits (up to 5 min), returns the results
      const res = await axios.post(
        `https://api.apify.com/v2/acts/${def.actor}/run-sync-get-dataset-items`,
        def.input(term),
        { params: { token, timeout: 300, memory: 1024 }, timeout: 320_000 });
      const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
      const mapped = items.map(i => mapItem(i, name, def)).filter(i => i.source_id && i.price);
      const note = `actor returned ${items.length} items, ${mapped.length} usable` +
        (items.length && !mapped.length ? `; keys: ${Object.keys(items[0]).slice(0, 30).join(', ')}` : '') +
        (!items.length && res.data && !Array.isArray(res.data) ? `; response: ${JSON.stringify(res.data).slice(0, 200)}` : '');
      console.log(`  [${name}] ${note}`);
      mapped.note = note;
      return mapped;
    },
  };
}

/** Raw call for diagnostics: returns the first few untouched items from an actor. */
async function rawSample(name, term, n = 2) {
  const def = ACTORS[name];
  if (!def) throw new Error(`Unknown source ${name}`);
  const res = await axios.post(`https://api.apify.com/v2/acts/${def.actor}/run-sync-get-dataset-items`,
    { ...def.input(term), maxItems: 5 }, { params: { token: process.env.APIFY_TOKEN, timeout: 300, memory: 1024 }, timeout: 320_000 });
  const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
  return { actor: def.actor, input: { ...def.input(term), maxItems: 5 }, count: items.length,
           keys: items[0] ? Object.keys(items[0]) : [], sample: items.slice(0, n), mapped: items.slice(0, n).map(i => mapItem(i, name, def)) };
}

/** Sources enabled via APIFY_SOURCES in .env */
function enabledSources() {
  return (process.env.APIFY_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean).map(makeSource);
}

module.exports = { enabledSources, makeSource, mapItem, rawSample, ACTORS };
