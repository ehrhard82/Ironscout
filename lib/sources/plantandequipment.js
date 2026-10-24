// PlantAndEquipment.com — Dubai-based global marketplace (most listings UAE / Gulf, some Europe, Asia).
// Dealer "make offer" listings in USD, server-rendered HTML, no API and no fee: we read the category
// pages directly from this server. These rows are stored with their country so the machine page can
// show what the machine fetches abroad; they never feed the US market value or the deals list.
//
// Set PLANTEQUIP_LIVE=false in Render to switch it off.

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.plantandequipment.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// machine name (as typed in IronScout) -> category paths on the site. Add more via PLANTEQUIP_CATEGORIES
// in Render:  "winch truck=/used/trucks-and-transport/trucks/semi-trucks;water truck=/used/trucks-and-transport/trucks"
const DEFAULT = {
  'wheel loader': ['/used/construction/wheel-loaders'], 'loader': ['/used/construction/wheel-loaders'],
  'excavator': ['/used/construction/excavators'], 'mini excavator': ['/used/construction/excavators'],
  'dozer': ['/used/construction/dozer'], 'bulldozer': ['/used/construction/dozer'],
  'motor grader': ['/used/construction/motor-graders'], 'grader': ['/used/construction/motor-graders'],
  'skid steer': ['/used/construction/skid-steer-loaders'],
  'generator': ['/used/construction/generators'], 'light tower': ['/used/construction/light-towers'],
  'crusher': ['/used/construction/crushers-screens'],
  'semi truck': ['/used/trucks-and-transport/trucks/semi-trucks'], 'truck tractor': ['/used/trucks-and-transport/trucks/semi-trucks'],
  'dump truck': ['/used/trucks-and-transport/trucks/dump-trucks'], 'articulated dump truck': ['/used/trucks-and-transport/trucks/off-highway-adt'],
  'winch truck': ['/used/trucks-and-transport/trucks/semi-trucks'], 'water truck': ['/used/trucks-and-transport/trucks'],
  'vacuum truck': ['/used/trucks-and-transport/trucks'], 'crane': ['/used/cranes'], 'trailer': ['/used/trucks-and-transport/trailers'],
  'lowboy trailer': ['/used/trucks-and-transport/trailers'], 'forklift': ['/used/material-handling/lifts/forklifts'],
  'telehandler': ['/used/material-handling/lifts/telehandlers'], 'boom lift': ['/used/material-handling/lifts/articulated-boom-lifts'],
  'scissor lift': ['/used/material-handling/lifts/scissor-lifts'], 'tractor': ['/used/agricultural-equipment/tractors'],
};
function categories(q) {
  const key = String(q || '').toLowerCase().trim();
  const extra = {};
  for (const part of String(process.env.PLANTEQUIP_CATEGORIES || '').split(';')) {
    const [k, v] = part.split('=').map(s => (s || '').trim()); if (k && v) extra[k.toLowerCase()] = v.split(',').map(s => s.trim());
  }
  return extra[key] || DEFAULT[key] || [];
}

// country names as the site prints them -> ISO-2 (listings.country is VARCHAR(2))
const COUNTRIES = { 'united arab emirates': 'AE', 'uae': 'AE', 'saudi arabia': 'SA', 'qatar': 'QA', 'oman': 'OM', 'kuwait': 'KW', 'bahrain': 'BH',
  'egypt': 'EG', 'jordan': 'JO', 'iraq': 'IQ', 'turkey': 'TR', 'türkiye': 'TR', 'india': 'IN', 'pakistan': 'PK', 'china': 'CN', 'indonesia': 'ID',
  'malaysia': 'MY', 'singapore': 'SG', 'thailand': 'TH', 'vietnam': 'VN', 'philippines': 'PH', 'japan': 'JP', 'south korea': 'KR', 'australia': 'AU',
  'united kingdom': 'GB', 'germany': 'DE', 'netherlands': 'NL', 'belgium': 'BE', 'france': 'FR', 'spain': 'ES', 'italy': 'IT', 'poland': 'PL',
  'denmark': 'DK', 'sweden': 'SE', 'norway': 'NO', 'finland': 'FI', 'ireland': 'IE', 'portugal': 'PT', 'greece': 'GR', 'romania': 'RO', 'czech republic': 'CZ',
  'austria': 'AT', 'switzerland': 'CH', 'south africa': 'ZA', 'nigeria': 'NG', 'kenya': 'KE', 'ghana': 'GH', 'morocco': 'MA', 'algeria': 'DZ',
  'canada': 'CA', 'mexico': 'MX', 'brazil': 'BR', 'argentina': 'AR', 'chile': 'CL', 'colombia': 'CO', 'peru': 'PE', 'venezuela': 'VE', 'ecuador': 'EC',
  'united states of america': 'US', 'united states': 'US', 'usa': 'US', 'russia': 'RU', 'ukraine': 'UA', 'kazakhstan': 'KZ', 'new zealand': 'NZ' };
const COUNTRY_NAME = Object.fromEntries(Object.entries(COUNTRIES).filter(([k]) => !['uae', 'usa', 'united states', 'türkiye'].includes(k)).map(([k, v]) => [v, k.replace(/\b\w/g, c => c.toUpperCase()).replace('Of America', 'of America')]));
const countryCode = (name) => COUNTRIES[String(name || '').trim().toLowerCase()] || null;

const titleFromSlug = (slug) => slug.replace(/-\d+$/, '').split('-').map(w => (/\d/.test(w) || w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');

/** Parse a category page. Keys off the listing links; everything else is read from the text around them. */
function parseListings(html) {
  const $ = cheerio.load(html);
  const out = new Map();
  $('a[href*="/equipment-items/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/equipment-items\/([a-z0-9-]+?)-(\d+)\/?(?:[?#].*)?$/i);
    if (!m) return;
    const [, slug, id] = m;
    if (out.has(id)) return;
    // climb to the smallest ancestor that contains a price or a location line
    let node = $(a), text = '';
    for (let i = 0; i < 6; i++) {
      node = node.parent(); if (!node.length) break;
      text = node.text().replace(/\s+/g, ' ').trim();
      if (/\$\s?[\d,]{3,}/.test(text) && text.length < 1200) break;
    }
    const price = Number((text.match(/\$\s?([\d,]{3,})/) || [])[1]?.replace(/,/g, ''));
    const loc = (text.match(/(?:^|\s)((?:[A-Z][a-z'.-]+\s?){1,4}),\s*((?:[A-Z][a-z'.-]+\s?){1,4})(?=\s*(?:\$|View|Make|Used|New|\d{4}\b|$))/) || []);
    const country = countryCode(loc[2]);
    const year = Number((slug.match(/^(19|20)\d{2}/) || [])[0]) || null;
    out.set(id, {
      source: 'plantandequipment', source_id: id, title: titleFromSlug(slug), price: price || null, year,
      city: loc[1] ? loc[1].trim() : null, state: null, country: country || null, raw_location: loc[0] || null,
      url: href.startsWith('http') ? href : BASE + href, seller_name: null, condition: 'Used', sale_type: 'listing', posted_date: new Date(),
    });
  });
  return [...out.values()];
}

async function get(url) {
  const r = await axios.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 20000 });
  return r.data;
}

async function fetch(term, onProgress = () => {}) {
  if (String(process.env.PLANTEQUIP_LIVE || 'true').toLowerCase() === 'false') { const e = []; e.note = 'skipped: PLANTEQUIP_LIVE is false'; return e; }
  const cats = categories(term);
  if (!cats.length) { const e = []; e.note = `skipped: no PlantAndEquipment category mapped for "${term}" (add PLANTEQUIP_CATEGORIES in Render)`; return e; }
  const pages = Number(process.env.PLANTEQUIP_PAGES || 3);
  const out = [];
  let seenPages = 0;
  for (const cat of cats) {
    for (let page = 1; page <= pages; page++) {
      const url = `${BASE}${cat}${page > 1 ? `?page=${page}` : ''}`;
      await onProgress(`reading ${url}`);
      const rows = parseListings(await get(url));
      seenPages++;
      out.push(...rows);
      if (rows.length < 10) break;
      await sleep(1500 + Math.random() * 1000);
    }
  }
  const priced = out.filter(r => r.price && r.price >= 500 && r.country);
  const note = `${seenPages} page(s): ${out.length} listings, ${priced.length} with a USD price and a country`;
  console.log(`  [plantandequipment] ${note}`);
  priced.note = note; priced.returned = out.length;
  return priced;
}

/** Dealer directory -> [{name, country, inventory, url}] (names only; the site keeps phones behind a login). */
let dealerCache = { at: 0, rows: [] };
async function dealers(maxPages = Number(process.env.PLANTEQUIP_DEALER_PAGES || 25)) {
  if (Date.now() - dealerCache.at < 24 * 3600e3 && dealerCache.rows.length) return dealerCache.rows;
  const rows = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const $ = cheerio.load(await get(`${BASE}/machinery-dealers?page=${page}`));
    let found = 0;
    $('a[href*="/machinery-equipment-dealers/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const slug = (href.match(/\/machinery-equipment-dealers\/([a-z0-9-]+)/i) || [])[1];
      if (!slug || rows.has(slug)) return;
      let node = $(a), text = '';
      for (let i = 0; i < 5; i++) { node = node.parent(); if (!node.length) break; text = node.text().replace(/\s+/g, ' ').trim(); if (/\(\d+\)|Dealer/i.test(text) && text.length < 400) break; }
      const name = $(a).text().replace(/\s+/g, ' ').trim() || titleFromSlug(slug);
      if (!name || /^view/i.test(name)) return;
      const country = Object.keys(COUNTRIES).map(k => k.replace(/\b\w/g, c => c.toUpperCase())).find(k => text.includes(k)) || null;
      const inventory = Number((text.match(/\((\d+)\)/) || [])[1]) || null;
      rows.set(slug, { name, country, country_code: countryCode(country), inventory, url: BASE + '/machinery-equipment-dealers/' + slug });
      found++;
    });
    if (!found) break;
    await sleep(1200);
  }
  dealerCache = { at: Date.now(), rows: [...rows.values()] };
  return dealerCache.rows;
}

module.exports = { name: 'plantandequipment', fetch, dealers, parseListings, categories, COUNTRY_NAME, countryCode };
