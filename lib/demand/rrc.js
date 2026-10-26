// Texas Railroad Commission drilling permits -> who is about to need iron.
//
// Two public files (no login, no fee), both documented at
// https://www.rrc.texas.gov/resource-center/research/data-sets-available-for-download/
//   - Daily file: every permit approved this month, cumulative, refreshed nightly (fixed-width, 510-byte records)
//   - Pending file: applications filed but not yet approved, refreshed twice a day ("}"-delimited)
// A permit is the earliest public signal that an operator is about to drill, which means trucks,
// pumps, rigs and service companies within weeks. We keep the operator, county and dates.
const axios = require('axios');
const zlib = require('zlib');
const pool = require('../db');

const DAILY_URL = process.env.RRC_DAILY_URL || 'https://mft.rrc.texas.gov/link/5f07cc72-2e79-4df8-ade1-9aeb792e03fc';
const PENDING_URL = process.env.RRC_PENDING_URL || 'https://mft.rrc.texas.gov/link/0ad92a65-4212-49a1-98a7-d667a55fb497';

// Texas county codes in RRC files are the 3-digit FIPS codes: alphabetical order, odd numbers from 001.
const TX_COUNTIES = 'Anderson,Andrews,Angelina,Aransas,Archer,Armstrong,Atascosa,Austin,Bailey,Bandera,Bastrop,Baylor,Bee,Bell,Bexar,Blanco,Borden,Bosque,Bowie,Brazoria,Brazos,Brewster,Briscoe,Brooks,Brown,Burleson,Burnet,Caldwell,Calhoun,Callahan,Cameron,Camp,Carson,Cass,Castro,Chambers,Cherokee,Childress,Clay,Cochran,Coke,Coleman,Collin,Collingsworth,Colorado,Comal,Comanche,Concho,Cooke,Coryell,Cottle,Crane,Crockett,Crosby,Culberson,Dallam,Dallas,Dawson,Deaf Smith,Delta,Denton,DeWitt,Dickens,Dimmit,Donley,Duval,Eastland,Ector,Edwards,Ellis,El Paso,Erath,Falls,Fannin,Fayette,Fisher,Floyd,Foard,Fort Bend,Franklin,Freestone,Frio,Gaines,Galveston,Garza,Gillespie,Glasscock,Goliad,Gonzales,Gray,Grayson,Gregg,Grimes,Guadalupe,Hale,Hall,Hamilton,Hansford,Hardeman,Hardin,Harris,Harrison,Hartley,Haskell,Hays,Hemphill,Henderson,Hidalgo,Hill,Hockley,Hood,Hopkins,Houston,Howard,Hudspeth,Hunt,Hutchinson,Irion,Jack,Jackson,Jasper,Jeff Davis,Jefferson,Jim Hogg,Jim Wells,Johnson,Jones,Karnes,Kaufman,Kendall,Kenedy,Kent,Kerr,Kimble,King,Kinney,Kleberg,Knox,Lamar,Lamb,Lampasas,La Salle,Lavaca,Lee,Leon,Liberty,Limestone,Lipscomb,Live Oak,Llano,Loving,Lubbock,Lynn,McCulloch,McLennan,McMullen,Madison,Marion,Martin,Mason,Matagorda,Maverick,Medina,Menard,Midland,Milam,Mills,Mitchell,Montague,Montgomery,Moore,Morris,Motley,Nacogdoches,Navarro,Newton,Nolan,Nueces,Ochiltree,Oldham,Orange,Palo Pinto,Panola,Parker,Parmer,Pecos,Polk,Potter,Presidio,Rains,Randall,Reagan,Real,Red River,Reeves,Refugio,Roberts,Robertson,Rockwall,Runnels,Rusk,Sabine,San Augustine,San Jacinto,San Patricio,San Saba,Schleicher,Scurry,Shackelford,Shelby,Sherman,Smith,Somervell,Starr,Stephens,Sterling,Stonewall,Sutton,Swisher,Tarrant,Taylor,Terrell,Terry,Throckmorton,Titus,Tom Green,Travis,Trinity,Tyler,Upshur,Upton,Uvalde,Val Verde,Van Zandt,Victoria,Walker,Waller,Ward,Washington,Webb,Wharton,Wheeler,Wichita,Wilbarger,Willacy,Williamson,Wilson,Winkler,Wise,Wood,Yoakum,Young,Zapata,Zavala'.split(',');
const countyName = (code) => { const n = Number(code); return Number.isInteger(n) && n % 2 === 1 && n >= 1 && n <= 507 ? TX_COUNTIES[(n - 1) / 2] : null; };

// --- minimal ZIP reader (stored or deflated entries; enough for RRC's files; no extra dependency) ---
function unzip(buf) {
  const out = [];
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(data) : data });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// The RRC's "link" pages are a GoAnywhere GoDrive share: a JSF page listing files; clicking a file name
// submits a form. We do the same: GET the page (session cookie + ViewState), find the row for the file
// we want, POST the form the way the link's onclick would, and read back the bytes.
const WANT_FILE = { daily: process.env.RRC_DAILY_FILE || 'daf420.dat', pending: process.env.RRC_PENDING_FILE || '' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
function decodeEntities(t) { return String(t || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function anchorsOf(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(m => {
    const attrs = m[1], text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1] || '', onclick = decodeEntities((attrs.match(/\bonclick="([^"]*)"/) || [])[1] || '');
    return { id, text, onclick };
  });
}
async function download(url, wantFile) {
  const origin = new URL(url).origin;
  const r1 = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000, maxRedirects: 5, headers: { 'User-Agent': UA } });
  const buf = Buffer.from(r1.data);
  const contentType = String(r1.headers['content-type'] || '');
  if (!/html/i.test(contentType)) {                                           // some links hand over the file directly
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    return { buf, files: isZip ? unzip(buf) : [{ name: 'file', data: buf }], contentType, steps: ['direct file'] };
  }
  const html = buf.toString('utf8');
  const cookies = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  const viewState = decodeEntities((html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/) || html.match(/value="([^"]*)"[^>]*name="javax\.faces\.ViewState"/) || [])[1] || '');
  const anchors = anchorsOf(html);
  const files = anchors.filter(a => /\.(dat|txt|csv|zip)(\.|$)/i.test(a.text));
  const target = wantFile ? files.find(a => a.text === wantFile) : files[0];
  const steps = [`page: ${files.length} file links, viewState ${viewState ? 'found' : 'MISSING'}, cookies ${cookies ? 'set' : 'none'}`];
  if (!target) throw new Error(`file "${wantFile}" not in the list (${files.slice(0, 5).map(f => f.text).join(', ')})`);
  if (!target.id) throw new Error(`the "${target.text}" link has no id; onclick=${target.onclick.slice(0, 200)}`);
  // which form the click submits: PrimeFaces.addSubmitParam('fileList', {...}).submit('fileList') or mojarra.jsfcljs(document.getElementById('fileList'),...)
  const formId = (target.onclick.match(/addSubmitParam\('([^']+)'/) || target.onclick.match(/getElementById\('([^']+)'\)/) || target.onclick.match(/\.submit\('([^']+)'\)/) || [])[1] || target.id.split(':')[0];
  const formTag = (html.match(new RegExp(`<form[^>]*\\bid="${formId}"[^>]*>`)) || [])[0] || '';
  const action = (formTag.match(/action="([^"]+)"/) || [])[1] || '/webclient/godrive/PublicGoDrive.xhtml';
  // every hidden field inside that form (JSF needs them all), then the clicked row's parameter on top
  const formStart = html.indexOf(formTag), formEnd = html.indexOf('</form>', formStart);
  const formHtml = formStart >= 0 ? html.slice(formStart, formEnd) : '';
  const params = {};
  for (const m of formHtml.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const nm = (m[0].match(/\bname="([^"]+)"/) || [])[1], val = (m[0].match(/\bvalue="([^"]*)"/) || [])[1];
    if (nm) params[nm] = decodeEntities(val || '');
  }
  params[formId] = formId;
  if (viewState && !params['javax.faces.ViewState']) params['javax.faces.ViewState'] = viewState;
  const m1 = target.onclick.match(/\{\s*'([^']+)'\s*:\s*'([^']*)'/);
  if (m1) params[m1[1]] = m1[2]; else params[target.id] = target.id;
  steps.push(`submitting ${formId} -> ${action} with ${Object.keys(params).join(', ')}`);
  const body = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const r2 = await axios.post(origin + action, body, { responseType: 'arraybuffer', timeout: 180_000, maxRedirects: 5,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, Referer: url }, validateStatus: () => true });
  const out = Buffer.from(r2.data), ct2 = String(r2.headers['content-type'] || '');
  steps.push(`response ${r2.status} ${ct2} ${out.length} bytes`);
  if (/html|xml/i.test(ct2) && out.length < 400_000 && /<(html|partial-response)/i.test(out.toString('utf8', 0, 400))) {
    // Ajax-style answer: PrimeFaces may reply with a redirect to a download URL
    const txt = out.toString('utf8');
    const redirect = (txt.match(/<redirect url="([^"]+)"/) || txt.match(/window\.location\s*=\s*'([^']+)'/) || [])[1];
    if (redirect) {
      const r3 = await axios.get(redirect.startsWith('http') ? redirect : origin + decodeEntities(redirect), { responseType: 'arraybuffer', timeout: 180_000, headers: { 'User-Agent': UA, Cookie: cookies } });
      const b3 = Buffer.from(r3.data); steps.push(`followed redirect -> ${r3.headers['content-type']} ${b3.length} bytes`);
      return { buf: b3, files: b3[0] === 0x50 && b3[1] === 0x4b ? unzip(b3) : [{ name: target.text, data: b3 }], contentType: String(r3.headers['content-type'] || ''), steps };
    }
    const err = new Error(`the form submit returned a page, not the file (${ct2})`); err.steps = steps; err.head = txt.slice(0, 800); err.anchor = target; throw err;
  }
  return { buf: out, files: out[0] === 0x50 && out[1] === 0x4b ? unzip(out) : [{ name: target.text, data: out }], contentType: ct2, steps };
}

const yyyymmdd = (s) => (/^\d{8}$/.test(s) && s !== '00000000') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Daily file: 510-byte fixed records; "01" root rows carry operator, county, lease, dates. */
function parseDaily(buf) {
  const rows = [];
  const text = buf.toString('latin1');
  const hasNewlines = text.indexOf('\n') > 0 && text.indexOf('\n') < 600;
  const records = hasNewlines ? text.split(/\r?\n/) : Array.from({ length: Math.floor(text.length / 510) }, (_, i) => text.substr(i * 510, 510));
  for (const r of records) {
    if (r.slice(0, 2) !== '01') continue;
    const f = (start, len) => r.substr(start - 1, len);
    const row = {
      status: 'approved', permit_no: clean(f(113, 7)) || clean(f(3, 7)), county_code: clean(f(12, 3)), lease_name: clean(f(15, 32)), district: clean(f(47, 2)),
      operator_no: clean(f(49, 6)), received_at: yyyymmdd(clean(f(59, 8))), operator_name: clean(f(67, 32)), issued_at: yyyymmdd(clean(f(120, 8))), well_no: clean(f(157, 6)),
    };
    if (row.operator_name && row.permit_no) rows.push(row);
  }
  return rows;
}

/** Pending file: "}"-delimited dp_drilling_permit_pending (operator name col 44, number 45, submit date 38, lease 19, status no 4, district 47). */
function parsePending(files) {
  const main = files.find(f => /drilling_permit_pending/i.test(f.name)) || files[0];
  const wellbore = files.find(f => /wellbore_pending/i.test(f.name));
  const countyByDoc = new Map();
  if (wellbore) for (const line of wellbore.data.toString('latin1').split(/\r?\n/)) { const c = line.split('}'); if (c.length > 25) countyByDoc.set(clean(c[0]), clean(c[24])); }
  const rows = [];
  for (const line of main.data.toString('latin1').split(/\r?\n/)) {
    const c = line.split('}');
    if (c.length < 47) continue;
    const row = {
      status: 'pending', permit_no: clean(c[3]), doc_no: clean(c[2]), lease_name: clean(c[18]), received_at: toDate(c[37]) || toDate(c[38]), operator_name: clean(c[43]), operator_no: clean(c[44]), district: clean(c[46]),
      county_code: countyByDoc.get(clean(c[2])) || null, issued_at: null, well_no: null,
    };
    if (row.operator_name && row.permit_no) rows.push(row);
  }
  return rows;
}
function toDate(s) { s = clean(s); if (!s) return null; const d = new Date(s); return Number.isFinite(d.getTime()) && d.getFullYear() > 2000 ? d.toISOString().slice(0, 10) : yyyymmdd(s.replace(/\D/g, '').slice(0, 8)); }

async function upsertRows(rows, sourceFile) {
  let n = 0;
  for (const r of rows) {
    await pool.query(`INSERT INTO permits (state, permit_no, status, operator_no, operator_name, county_code, county, district, lease_name, well_no, received_at, issued_at, source_file)
      VALUES ('TX',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (state, permit_no, status) DO UPDATE SET operator_name = EXCLUDED.operator_name, county = COALESCE(EXCLUDED.county, permits.county), issued_at = COALESCE(EXCLUDED.issued_at, permits.issued_at), last_seen = NOW()`,
      [r.permit_no, r.status, r.operator_no || null, r.operator_name, r.county_code || null, countyName(r.county_code), r.district || null, r.lease_name || null, r.well_no || null, r.received_at, r.issued_at, sourceFile]);
    n++;
  }
  // roll up operators: permits in the last 30 / 90 days, counties, last date
  await pool.query(`INSERT INTO operators (state, operator_no, name, permits_30d, permits_90d, counties, last_permit_at, first_seen)
    SELECT 'TX', COALESCE(NULLIF(operator_no,''), 'name:' || lower(operator_name)), MAX(operator_name),
           COUNT(*) FILTER (WHERE COALESCE(issued_at, received_at) > NOW() - interval '30 days')::int,
           COUNT(*) FILTER (WHERE COALESCE(issued_at, received_at) > NOW() - interval '90 days')::int,
           STRING_AGG(DISTINCT county, ', ' ORDER BY county), MAX(COALESCE(issued_at, received_at)), NOW()
    FROM permits WHERE state = 'TX' GROUP BY 2
    ON CONFLICT (state, operator_no) DO UPDATE SET name = EXCLUDED.name, permits_30d = EXCLUDED.permits_30d, permits_90d = EXCLUDED.permits_90d,
      counties = EXCLUDED.counties, last_permit_at = EXCLUDED.last_permit_at, updated_at = NOW()`);
  return n;
}

async function refresh() {
  const out = {};
  for (const [kind, url, parse] of [['daily', DAILY_URL, (f) => parseDaily(Buffer.concat(f.map(x => x.data)))], ['pending', PENDING_URL, parsePending]]) {
    if (kind === 'pending' && !WANT_FILE.pending) { out[kind] = { skipped: 'no RRC_PENDING_FILE name set yet' }; continue; }
    try {
      const { files, contentType, steps } = await download(url, WANT_FILE[kind]);
      if (/html/i.test(String(contentType))) throw new Error('RRC sent a web page instead of the file');
      const rows = parse(files);
      out[kind] = { files: files.map(f => `${f.name} (${f.data.length} bytes)`), rows: rows.length, saved: await upsertRows(rows, kind), steps };
    } catch (e) { out[kind] = { error: e.response ? `${e.response.status} from RRC` : e.message, steps: e.steps, head: e.head, anchor: e.anchor }; }
  }
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('permits_refreshed_at', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [new Date().toISOString()]).catch(() => {});
  console.log('[permits]', JSON.stringify(out));
  return out;
}

/** Raw look at what RRC sends, for fitting the parser without guessing. */
async function sample(kind = 'daily') {
  let dl;
  try { dl = await download(kind === 'pending' ? PENDING_URL : DAILY_URL, WANT_FILE[kind] || undefined); }
  catch (e) { return { error: e.message, steps: e.steps, head: e.head, anchor: e.anchor }; }
  const { files, contentType, buf, steps } = dl;
  const html = /html/i.test(String(contentType)) ? buf.toString('utf8') : '';
  const page = html ? {
    title: (html.match(/<title>([^<]*)/i) || [])[1],
    links: [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() })).filter(l => !/\.css|\.js|javax\.faces/.test(l.href)).slice(0, 40),
    forms: [...html.matchAll(/<form[^>]*>/gi)].map(m => m[0]).slice(0, 10),
    buttons: [...html.matchAll(/<(?:button|input)[^>]*(?:type="submit"|download|Download)[^>]*>/gi)].map(m => m[0]).slice(0, 20),
    download_words: [...html.matchAll(/.{0,120}download.{0,160}/gi)].map(m => m[0].replace(/\s+/g, ' ')).slice(0, 12),
  } : null;
  return { contentType, bytes: buf.length, steps, page, files: files.map(f => ({ name: f.name, bytes: f.data.length, head: f.data.toString('latin1').slice(0, 600) })),
           parsed: (kind === 'pending' ? parsePending(files) : parseDaily(Buffer.concat(files.map(x => x.data)))).slice(0, 5) };
}

module.exports = { refresh, sample, parseDaily, parsePending, countyName, unzip };
