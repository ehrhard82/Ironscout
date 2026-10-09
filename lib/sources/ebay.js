// eBay Browse API source.
// Docs: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
// Free tier: 5,000 calls/day. Get keys at developer.ebay.com -> Application Keys.
// Uses the "client credentials" OAuth flow (no user login needed for public search).

const axios = require('axios');

const HOSTS = {
  production: { auth: 'https://api.ebay.com', api: 'https://api.ebay.com' },
  sandbox:    { auth: 'https://api.sandbox.ebay.com', api: 'https://api.sandbox.ebay.com' },
};

let tokenCache = { value: null, expires: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires - 60_000) return tokenCache.value;
  const env = HOSTS[process.env.EBAY_ENV || 'production'];
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    `${env.auth}/identity/v1/oauth2/token`,
    'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
  tokenCache = { value: res.data.access_token, expires: Date.now() + res.data.expires_in * 1000 };
  return tokenCache.value;
}

function mapItem(item) {
  const loc = item.itemLocation || {};
  return {
    source: 'ebay',
    source_id: item.itemId,
    title: item.title,
    description: item.shortDescription || null,
    price: Number(item.price?.value),
    currency: item.price?.currency || 'USD',
    condition: item.condition || null,
    city: loc.city || null,
    state: loc.stateOrProvince || null,
    zip: loc.postalCode ? String(loc.postalCode).replace(/\*/g, '') : null, // eBay masks as "797**"
    country: loc.country || 'US',
    url: item.itemWebUrl,
    image_url: item.image?.imageUrl || null,
    seller_name: item.seller?.username || null,
    posted_date: item.itemCreationDate ? new Date(item.itemCreationDate) : null,
  };
}

/** Fetch up to `max` fixed-price + auction listings for a search term. */
async function fetch(searchTerm, { max = 200 } = {}) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    if (process.env.SAMPLE_DATA === 'true') { console.log('  [ebay] no API keys set -> using sample data'); return sample(searchTerm); }
    const empty = []; empty.note = 'skipped: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set'; return empty;
  }
  const env = HOSTS[process.env.EBAY_ENV || 'production'];
  const token = await getToken();
  const out = [];
  let offset = 0;
  const limit = 50;
  while (out.length < max) {
    const res = await axios.get(`${env.api}/buy/browse/v1/item_summary/search`, {
      params: { q: searchTerm, limit, offset, filter: 'buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION}' },
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE || 'EBAY_US',
      },
    });
    const items = res.data.itemSummaries || [];
    out.push(...items.map(mapItem));
    if (items.length < limit || !res.data.next) break;
    offset += limit;
  }
  return out;
}

// Realistic sample data so the whole pipeline can be tested with no API keys.
// Prices scale with the kind of machine and depreciate with age, plus noise, so
// year-matched comparables actually matter in testing.
function baseFor(term) {
  const t = term.toLowerCase();
  if (/rig|drilling/.test(t)) return 650000;
  if (/frac|pump/.test(t)) return 420000;
  if (/loader|dozer|excavator/.test(t)) return 190000;
  if (/semi|peterbilt|kenworth|winch|truck/.test(t)) return 95000;
  if (/skid|bobcat/.test(t)) return 38000;
  if (/car|pickup/.test(t)) return 22000;
  if (/bike|atv/.test(t)) return 6000;
  return 50000;
}
function sample(term) {
  const states = ['TX','TX','TX','TX','OK','OK','LA','ND','NM','CO','PA','WY','TX','OK','LA','TX','CA','TX','OK','ND'];
  const notes = ['low hours','field ready','needs work','fleet unit','one owner','rebuilt engine','new tires','auction'];
  const base = baseFor(term);
  return states.map((st, i) => {
    const year = 2008 + ((i * 7) % 16);                         // 2008-2023
    const age = 2026 - year;
    const depreciation = Math.pow(0.92, age);                   // ~8%/yr
    const noise = 0.8 + ((i * 37) % 100) / 250;                  // 0.8x - 1.2x
    const price = Math.round(base * depreciation * noise / 500) * 500;
    return {
      source: 'ebay', source_id: `sample-ebay-${term}-${i}`,
      title: `SAMPLE: ${year} ${term} - ${notes[i % notes.length]} (not a real listing)`,
      price, condition: 'Used', state: st, city: null, year, hours: 1200 + age * 650,
      url: null, seller_name: `seller${i}`,
      posted_date: new Date(Date.now() - i * 86400000),
    };
  });
}

module.exports = { name: 'ebay', fetch };
