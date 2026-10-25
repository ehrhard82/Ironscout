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

async function download(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000, maxRedirects: 5, headers: { 'User-Agent': 'IronScout/1.0 (equipment market research)' } });
  const buf = Buffer.from(r.data);
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  return { buf, files: isZip ? unzip(buf) : [{ name: 'file', data: buf }], contentType: r.headers['content-type'] };
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
    try {
      const { files } = await download(url);
      const rows = parse(files);
      out[kind] = { files: files.map(f => `${f.name} (${f.data.length} bytes)`), rows: rows.length, saved: await upsertRows(rows, kind) };
    } catch (e) { out[kind] = { error: e.response ? `${e.response.status} from RRC` : e.message }; }
  }
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('permits_refreshed_at', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [new Date().toISOString()]).catch(() => {});
  console.log('[permits]', JSON.stringify(out));
  return out;
}

/** Raw look at what RRC sends, for fitting the parser without guessing. */
async function sample(kind = 'daily') {
  const { files, contentType, buf } = await download(kind === 'pending' ? PENDING_URL : DAILY_URL);
  return { contentType, bytes: buf.length, files: files.map(f => ({ name: f.name, bytes: f.data.length, head: f.data.toString('latin1').slice(0, 1600) })),
           parsed: (kind === 'pending' ? parsePending(files) : parseDaily(Buffer.concat(files.map(x => x.data)))).slice(0, 5) };
}

module.exports = { refresh, sample, parseDaily, parsePending, countyName, unzip };
