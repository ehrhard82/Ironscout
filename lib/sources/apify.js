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
    image_url: pick(item, 'imageUrl', 'image', 'images.0', 'thumbnail'),
    seller_name: pick(item, 'sellerName', 'seller', 'agency', 'auctionName'),
    description: pick(item, 'description', 'summary', 'features') || [pick(item, 'categoryName', 'category'), pick(item, 'auctionTypeName', 'buyingFormat')].filter(Boolean).join(' · ') || null,
    posted_date: saneDate(pick(item, 'startDate', 'auctionStartDate', 'auctionStartAt', 'listedAt', 'createdAt')) || saneDate(pick(item, 'scrapedAt')) || new Date(),
    sale_type: /make offer|buy now|fixed/i.test(String(pick(item, 'buyingFormat') || '')) ? 'listing' : def.sale_type,
    auction_ends: saneDate(pick(item, 'endDate', 'auctionEndDate', 'auctionEndAt', 'auctionEnd', 'closingDate')),
  };
}

function makeSource(name) {
  const def = ACTORS[name];
  if (!def) throw new Error(`Unknown Apify source "${name}". Known: ${Object.keys(ACTORS).join(', ')}`);
  return {
    name,
    async fetch(term) {
      const token = (process.env.APIFY_TOKEN || '').trim();
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
    { ...def.input(term), maxItems: 5 }, { params: { token: (process.env.APIFY_TOKEN || '').trim(), timeout: 300, memory: 1024 }, timeout: 320_000 });
  const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
  return { token_present: Boolean((process.env.APIFY_TOKEN || '').trim()), actor: def.actor, input: { ...def.input(term), maxItems: 5 }, count: items.length,
           keys: items[0] ? Object.keys(items[0]) : [], sample: items.slice(0, n), mapped: items.slice(0, n).map(i => mapItem(i, name, def)) };
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

module.exports = { enabledSources, makeSource, mapItem, rawSample, ACTORS };
