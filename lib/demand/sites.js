// Visits a lead's website (home + about/services/contact/equipment pages) and pulls out what a salesman wants to know
// before the call: what they do, the iron they run, where they work, real contact names, and whether they're hiring
// or selling. Free; a few pages per site; runs in the background a batch at a time. Results live in leads.meta.site.
const axios = require('axios');
const cheerio = require('cheerio');
const pool = require('../db');

const UA = 'Mozilla/5.0 (compatible; IronScout/1.0; +https://ironscout-jbgv.onrender.com)';
const PAGE_TIMEOUT = Number(process.env.SITE_PAGE_TIMEOUT_MS || 12_000);
const MAX_PAGES = Number(process.env.SITE_MAX_PAGES || 6);
const CONCURRENCY = Number(process.env.SITE_CONCURRENCY || 4);

// what they do — tag: patterns found in page text
const SERVICES = {
  'vac trucks': /\bvac(uum)? (truck|trucks|service|services)\b|\bvacuum trucks?\b/i,
  'hot oil': /\bhot oil(er|ers|ing)?\b/i,
  'wireline': /\bwireline|slickline|e-?line\b/i,
  'roustabout': /\broustabout/i,
  'cranes': /\bcrane(s| service| rental| rentals)?\b/i,
  'winch trucks': /\bwinch truck|\bgin pole|\bpole truck/i,
  'heavy haul': /\bheavy haul|\boversize|\blowboy|\brig move|\brig moving|\brig-up|\brigging/i,
  'frac tanks': /\bfrac tank/i,
  'water transfer': /\bwater transfer|\bwater hauling|\bfresh ?water/i,
  'saltwater disposal': /\bsaltwater disposal|\bsalt water disposal|\bswd\b|\bproduced water/i,
  'pressure pumping': /\bpressure pumping|\bfrac(k|king|turing)\b|\bhydraulic fracturing/i,
  'cementing': /\bcement(ing)? (service|services|unit|units|trucks?)\b|\bcementing\b/i,
  'acidizing': /\bacidiz|\bacid (job|jobs|service|services)\b/i,
  'coiled tubing': /\bcoil(ed)? tubing/i,
  'workover rigs': /\bworkover|\bpulling unit|\bwell servic(e|ing) rig/i,
  'drilling': /\bdrilling (rig|rigs|contractor|services)\b/i,
  'nitrogen': /\bnitrogen (unit|units|pumping|service|services)\b/i,
  'swabbing': /\bswab(bing)?\b/i,
  'flowback': /\bflowback|\bwell testing/i,
  'pipeline': /\bpipeline (construction|services|maintenance)\b/i,
  'construction': /\blocation (building|construction)|\bdirt work|\bpad (building|construction)|\bcaliche|\bexcavat/i,
  'welding': /\bwelding|\bfabrication/i,
  'equipment rental': /\bequipment rental|\brental (fleet|equipment|tools)|\brentals\b/i,
  'trucking': /\btrucking|\bhauling services|\bfreight/i,
  'crude hauling': /\bcrude (oil )?haul|\bcrude transport|\boil haul/i,
  'tank cleaning': /\btank clean/i,
  'hydro excavation': /\bhydro ?excavat|\bhydrovac/i,
  'safety / H2S': /\bh2s\b|\bsafety (services|training|consulting)\b/i,
  'solids control': /\bsolids control|\bmud (system|logging)/i,
  'electrical': /\belectrical (services|contractor)|\boilfield electric/i,
  'pumps & compressors': /\bcompressor|\bpump jack|\bpumping unit/i,
  'environmental': /\bremediation|\bspill response|\benvironmental services/i,
};
// iron they mention — the machines IronScout tracks and their cousins
const FLEET = ['vac truck', 'vacuum truck', 'winch truck', 'hot oil truck', 'hot oil unit', 'kill truck', 'pump truck', 'frac tank', 'gin pole truck', 'pole truck', 'crane', 'excavator', 'dozer', 'bulldozer', 'loader', 'wheel loader', 'motor grader', 'backhoe', 'skid steer', 'telehandler', 'forklift', 'lowboy', 'tractor', 'tandem', 'belly dump', 'end dump', 'water truck', 'fuel truck', 'pulling unit', 'workover rig', 'swab rig', 'coil unit', 'nitrogen unit', 'cement pumper', 'acid pump', 'generator', 'light tower', 'manlift', 'boom truck', 'roustabout truck', 'pickup', 'trailer', 'kenworth', 'peterbilt', 'mack', 'freightliner', 'international', 'western star', 'caterpillar', 'cat ', 'john deere', 'komatsu', 'case', 'bobcat', 'jlg', 'genie', 'grove', 'link-belt', 'terex', 'national crane', 'manitex'];
const BASINS = ['permian', 'delaware basin', 'midland basin', 'eagle ford', 'haynesville', 'barnett', 'anadarko', 'scoop', 'stack', 'bakken', 'dj basin', 'marcellus', 'utica', 'san juan', 'powder river', 'uinta', 'gulf coast', 'east texas', 'west texas', 'south texas', 'panhandle', 'new mexico', 'oklahoma', 'north dakota', 'wyoming', 'colorado', 'louisiana'];
const TX_YARDS = ['midland', 'odessa', 'pecos', 'monahans', 'kermit', 'andrews', 'big spring', 'snyder', 'lubbock', 'levelland', 'seminole', 'hobbs', 'carlsbad', 'artesia', 'jal', 'eunice', 'lovington', 'fort stockton', 'alpine', 'san angelo', 'abilene', 'sweetwater', 'graham', 'wichita falls', 'pampa', 'borger', 'amarillo', 'perryton', 'cotulla', 'pleasanton', 'kenedy', 'karnes city', 'three rivers', 'george west', 'laredo', 'victoria', 'longview', 'kilgore', 'tyler', 'carthage', 'houston', 'san antonio', 'dallas', 'fort worth', 'corpus christi', 'elk city', 'woodward', 'oklahoma city', 'weatherford', 'chickasha', 'duncan', 'kingfisher', 'enid', 'farmington'];

const stripWww = (d) => String(d || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();

async function getPage(url) {
  const r = await axios.get(url, { timeout: PAGE_TIMEOUT, maxRedirects: 5, maxContentLength: 3 * 1024 * 1024, responseType: 'text', validateStatus: (s) => s < 400,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' } });
  const ct = String(r.headers['content-type'] || '');
  if (ct && !/html|xml|text/i.test(ct)) throw new Error('not html');
  return { html: String(r.data || ''), url: r.request && r.request.res && r.request.res.responseUrl || url };
}

function textOf($) {
  $('script, style, noscript, svg, iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

// pages worth a look, found from the homepage nav
function interestingLinks($, base) {
  const want = /about|service|what-we-do|equipment|fleet|rental|contact|team|staff|locations?|yards?|careers?|jobs?|employment|hiring|for-?sale|inventory/i;
  const out = new Map();
  $('a[href]').each((_, a) => {
    const href = String($(a).attr('href') || '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let u; try { u = new URL(href, base); } catch { return; }
    if (u.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) return;
    if (/\.(pdf|jpg|jpeg|png|gif|zip|mp4|doc|docx|xls|xlsx)$/i.test(u.pathname)) return;
    const key = u.pathname.replace(/\/$/, '') || '/';
    const label = ($(a).text() || '').trim();
    if (want.test(key) || want.test(label)) { const score = /contact|team|staff/i.test(key + label) ? 3 : /equipment|fleet|rental|for-?sale|inventory/i.test(key + label) ? 2 : 1; if (!out.has(key) || out.get(key).score < score) out.set(key, { url: u.origin + u.pathname, score }); }
  });
  return [...out.values()].sort((a, b) => b.score - a.score).map(x => x.url).slice(0, MAX_PAGES - 1);
}

function extract(pages, domain) {
  const all = pages.map(p => p.text).join(' \n ');
  const low = all.toLowerCase();
  const tags = Object.entries(SERVICES).filter(([, re]) => re.test(all)).map(([t]) => t);
  const fleet = FLEET.filter(f => low.includes(f.trim())).map(f => f.trim()).slice(0, 15);
  const fleetSizes = [...all.matchAll(/\b(\d{1,3})\+?\s+(vac(?:uum)? trucks?|winch trucks?|trucks|units|rigs|cranes|pieces of equipment|pulling units|hot oil units?)\b/gi)].map(m => `${m[1]} ${m[2].toLowerCase()}`).slice(0, 6);
  const basins = BASINS.filter(b => low.includes(b));
  const yards = TX_YARDS.filter(c => new RegExp(`\\b${c.replace(/ /g, '\\s+')}\\b`, 'i').test(all)).slice(0, 8);
  const emails = [...new Set([...all.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map(m => m[0].toLowerCase()).filter(e => !/\.(png|jpg|gif|svg|css|js)$/.test(e) && !/example|sentry|wixpress|godaddy|squarespace/.test(e)))].slice(0, 8);
  const phones = [...new Set([...all.matchAll(/\(?\b(\d{3})\)?[-.\s](\d{3})[-.\s](\d{4})\b/g)].map(m => `${m[1]}-${m[2]}-${m[3]}`))].slice(0, 6);
  // names next to a title: "John Smith, Operations Manager" / "Owner: Jane Doe"
  const people = [];
  for (const m of all.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+){1,2})\s*[,–\-|]\s*((?:[A-Z][a-z]+ ){0,3}(?:Owner|President|CEO|COO|Manager|Director|Sales|Operations|Dispatch|Dispatcher|Founder|Partner|Superintendent|Supervisor|Coordinator|Vice President|VP)\b[^.,|\n]{0,30})/g)) {
    if (people.length >= 8) break;
    const t = m[2].split(/[·|•\d(]/)[0].trim();
    if (!people.some(p => p.name === m[1])) people.push({ name: m[1], title: t });
  }
  const hiring = /\b(now hiring|we're hiring|we are hiring|join our team|careers|apply (now|today)|job openings|employment opportunities)\b/i.test(all);
  const forSale = /\b(for sale|equipment sales|used equipment|surplus (equipment|inventory)|auction)\b/i.test(all);
  const founded = (all.match(/\b(?:since|established|founded|est\.?)\s+(?:in\s+)?((?:19|20)\d{2})\b/i) || [])[1] || null;
  const socials = [...new Set(pages.flatMap(p => p.links || []).filter(h => /facebook\.com|linkedin\.com\/company|instagram\.com/i.test(h)))].slice(0, 3);
  const title = (pages[0] && pages[0].title || '').slice(0, 120);
  const blurb = (pages[0] && pages[0].description || '').slice(0, 240);
  return { domain, title, blurb, tags, fleet, fleet_sizes: fleetSizes, basins, yards, emails, phones, people, hiring, for_sale: forSale, founded, socials, pages: pages.map(p => p.url), crawled_at: new Date().toISOString() };
}

async function crawlSite(domain) {
  const base = `https://${stripWww(domain)}/`;
  let home;
  try { home = await getPage(base); } catch (e) { try { home = await getPage(base.replace('https://', 'http://')); } catch (e2) { return { domain: stripWww(domain), error: (e2.code || e2.message || 'unreachable').slice(0, 80), crawled_at: new Date().toISOString() }; } }
  const $ = cheerio.load(home.html);
  const links = interestingLinks($, home.url);
  const pages = [{ url: home.url, title: $('title').first().text().trim(), description: $('meta[name="description"]').attr('content') || '', links: $('a[href]').map((_, a) => $(a).attr('href')).get(), text: textOf($) }];
  for (const u of links) {
    try { const p = await getPage(u); const $$ = cheerio.load(p.html); pages.push({ url: p.url, text: textOf($$) }); } catch { /* skip */ }
  }
  return extract(pages, stripWww(domain));
}

// ---- batch runner ----
let running = null, progress = null;
async function pickLeads({ st = 'TX', segment = 'service', limit = 200, recrawl = false, org = null } = {}) {
  const params = [limit];
  let where = `l.kind = 'carrier' AND l.website IS NOT NULL AND l.website <> ''`;
  if (st && st !== 'ALL') { params.push(st); where += ` AND l.st = $${params.length}`; }
  if (segment === 'service') where += ` AND l.meta->>'segment' = 'service'`; else if (segment === 'trucking') where += ` AND COALESCE(l.meta->>'segment','trucking') <> 'service'`;
  where += ` AND l.meta->>'oilfield' = 'true'`;
  if (!recrawl) where += ` AND (l.meta->'site' IS NULL OR (l.meta->'site'->>'error' IS NOT NULL AND (l.meta->'site'->>'crawled_at')::timestamptz < NOW() - interval '30 days'))`;
  // same order the broker sees: hottest first
  return (await pool.query(`SELECT l.id, l.name, l.website FROM leads l WHERE ${where} ORDER BY l.signal DESC, l.updated_at DESC LIMIT $1`, params)).rows;
}
async function saveSite(id, site) {
  await pool.query(`UPDATE leads SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('site', $2::jsonb), updated_at = NOW() WHERE id = $1`, [id, JSON.stringify(site)]);
}
async function runBatch(opts) {
  const leads = await pickLeads(opts);
  progress = { total: leads.length, done: 0, ok: 0, failed: 0, started_at: new Date().toISOString(), opts };
  let i = 0;
  const worker = async () => {
    while (i < leads.length) {
      const l = leads[i++];
      try { const site = await crawlSite(l.website); await saveSite(l.id, site); site.error ? progress.failed++ : progress.ok++; }
      catch (e) { progress.failed++; await saveSite(l.id, { domain: stripWww(l.website), error: String(e.message || e).slice(0, 80), crawled_at: new Date().toISOString() }).catch(() => {}); }
      progress.done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leads.length || 1) }, worker));
  progress.finished_at = new Date().toISOString();
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('sites_last_result', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(progress)]).catch(() => {});
  console.log('[sites]', JSON.stringify(progress));
  return progress;
}
function runInBackground(opts) {
  if (running) return { started: false, reason: 'already running', progress };
  running = runBatch(opts).catch(e => { progress = { ...(progress || {}), error: e.message, finished_at: new Date().toISOString() }; }).finally(() => { running = null; });
  return { started: true };
}
async function status() {
  const last = progress || (await pool.query(`SELECT value FROM app_state WHERE key = 'sites_last_result'`).then(r => r.rows[0] ? JSON.parse(r.rows[0].value) : null).catch(() => null));
  const counts = (await pool.query(`SELECT COUNT(*) FILTER (WHERE meta->'site' IS NOT NULL AND meta->'site'->>'error' IS NULL)::int AS crawled,
    COUNT(*) FILTER (WHERE meta->'site'->>'error' IS NOT NULL)::int AS failed,
    COUNT(*) FILTER (WHERE website IS NOT NULL AND meta->'site' IS NULL)::int AS waiting FROM leads WHERE kind = 'carrier'`)).rows[0];
  return { running: Boolean(running), progress: last, counts };
}
// the tags seen so far, for the "Does" dropdown
async function tagCounts(org) {
  return (await pool.query(`SELECT t AS tag, COUNT(*)::int AS n FROM leads l, jsonb_array_elements_text(l.meta->'site'->'tags') t WHERE (l.org_id IS NULL OR l.org_id = $1) GROUP BY t ORDER BY n DESC`, [org])).rows;
}

module.exports = { crawlSite, extract, runInBackground, status, pickLeads, tagCounts, SERVICES };
