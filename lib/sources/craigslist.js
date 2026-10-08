// Craigslist source.
//
// HONEST STATUS: Craigslist has no API and actively blocks automated requests.
// This scraper works against the current HTML when it works at all, and may get
// your IP blocked if run aggressively. Treat it as best-effort. Keep
// CRAIGSLIST_LIVE=false until you're ready to deal with that, and consider a
// proxy service (e.g. ScraperAPI, Bright Data) for production.

const axios = require('axios');
const cheerio = require('cheerio');
const { CRAIGSLIST_CITY_STATE } = require('../location');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function scrapeCity(city, term) {
  // "hva" = heavy equipment category. "sss" = all for-sale.
  const url = `https://${city}.craigslist.org/search/hva?query=${encodeURIComponent(term)}&sort=date`;
  const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
  const $ = cheerio.load(res.data);
  const out = [];
  // Craigslist changes markup regularly; these selectors cover the 2024-25 layouts.
  $('li.cl-static-search-result, li.cl-search-result, .result-row').each((_, el) => {
    const a = $(el).find('a').first();
    const href = a.attr('href');
    const title = $(el).find('.titlestring, .result-title, .title, .label').first().text().trim() || a.text().trim();
    const priceTxt = $(el).find('.priceinfo, .result-price, .price').first().text();
    const price = Number(String(priceTxt).replace(/[^0-9.]/g, ''));
    const hood = $(el).find('.location, .result-hood, .meta').first().text().trim();
    if (!href || !title || !price) return;
    const id = (href.match(/\/(\d+)\.html/) || [])[1] || href;
    out.push({
      source: 'craigslist', source_id: id, title, price, condition: 'Used',
      state: CRAIGSLIST_CITY_STATE[city] || null, raw_location: hood,
      url: href.startsWith('http') ? href : `https://${city}.craigslist.org${href}`,
      seller_name: 'Craigslist seller', posted_date: new Date(),
    });
  });
  return out;
}

async function fetch(term) {
  if (String(process.env.CRAIGSLIST_LIVE).toLowerCase() !== 'true') {
    console.log('  [craigslist] CRAIGSLIST_LIVE is not true -> using sample data');
    return sample(term);
  }
  const cities = (process.env.CRAIGSLIST_CITIES || 'dallas').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const city of cities) {
    try {
      const rows = await scrapeCity(city, term);
      console.log(`  [craigslist] ${city}: ${rows.length} listings`);
      out.push(...rows);
    } catch (e) {
      console.log(`  [craigslist] ${city}: failed (${e.response?.status || e.message})`);
    }
    await sleep(2500 + Math.random() * 2000);   // be polite; reduces blocking
  }
  return out;
}

function sample(term) {
  const t = term.toLowerCase();
  const base = /rig|drilling/.test(t) ? 650000 : /frac|pump/.test(t) ? 420000 : /loader|dozer|excavator/.test(t) ? 190000
    : /truck|semi|winch/.test(t) ? 95000 : /skid|bobcat/.test(t) ? 38000 : 50000;
  const cities = [['Odessa','TX',2014],['Midland','TX',2018],['Oklahoma City','OK',2012],['Lafayette','LA',2016],['Williston','ND',2015],['Houston','TX',2020]];
  return cities.map(([city, st, year], i) => ({
    source: 'craigslist', source_id: `sample-cl-${term}-${i}`,
    title: `SAMPLE: ${year} ${term} for sale - ${city} (not a real listing)`, year,
    price: Math.round(base * Math.pow(0.92, 2026 - year) * (0.62 + i * 0.09) / 500) * 500,   // first few are underpriced
    condition: 'Used', city, state: st, url: null,
    seller_name: 'Private seller', posted_date: new Date(Date.now() - i * 2 * 86400000),
  }));
}

module.exports = { name: 'craigslist', fetch };
