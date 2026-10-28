// More free lead feeds, all public, none through Apify:
//   okPermits   Oklahoma Corporation Commission "Intent to Drill" (daily .xlsx)      -> operator leads (OK)
//   nmWells     New Mexico OCD wells (ArcGIS JSON, new/approved wells by operator)   -> operator leads (NM)
//   txNewBiz    Texas Comptroller sales-tax permits (Socrata): new oilfield-service / trucking outlets -> 'newco' leads
//   txPlugging  Texas RRC W-3 plugging reports (Socrata): operators plugging wells  -> 'seller' leads
// Every feed has a sample() so the field names can be checked against the real thing before trusting it.
const axios = require('axios');
const zlib = require('zlib');
const pool = require('../db');
const { unzip } = require('./rrc');

const UA = 'IronScout/1.0 (equipment market research)';
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const title = (s) => clean(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const toDate = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400e3)).toISOString().slice(0, 10);   // Excel serial
  const d = new Date(v); return Number.isFinite(d.getTime()) && d.getFullYear() > 1990 ? d.toISOString().slice(0, 10) : null;
};
const pick = (row, ...names) => { for (const n of names) { const k = Object.keys(row).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === n.toLowerCase().replace(/[^a-z0-9]/g, '')); if (k && row[k] !== '' && row[k] != null) return row[k]; } return null; };
const fuzzy = (row, re) => { const k = Object.keys(row).find(k => re.test(k)); return k ? row[k] : null; };

// ---- tiny .xlsx reader (first sheet, header row -> objects); enough for OCC's files, no dependency ----
function readXlsx(buf) {
  const files = unzip(buf);
  const get = (n) => files.find(f => f.name === n)?.data.toString('utf8') || '';
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  const wb = get('xl/workbook.xml');
  const firstRid = (wb.match(/<sheet[^>]*r:id="([^"]+)"/) || [])[1];
  const rels = get('xl/_rels/workbook.xml.rels');
  let sheetPath = (rels.match(new RegExp(`Id="${firstRid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${firstRid}"`)) || [])[1] || 'worksheets/sheet1.xml';
  sheetPath = 'xl/' + sheetPath.replace(/^\/?xl\//, '').replace(/^\//, '');
  const xml = get(sheetPath) || get('xl/worksheets/sheet1.xml');
  const rows = [];
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = c[1], attrs = c[2] || '', inner = c[3] || '';
      const t = (attrs.match(/t="([^"]+)"/) || [])[1];
      let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (t === 's') v = shared[Number(v)]; else if (t === 'inlineStr') v = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]; else if (v != null && v !== '' && !isNaN(Number(v))) v = Number(v);
      if (v != null) cells[col] = v;
    }
    rows.push(cells);
  }
  if (!rows.length) return { headers: [], rows: [] };
  const hdrIdx = rows.findIndex(r => Object.keys(r).length >= 3);
  const hdr = rows[hdrIdx] || {}; const headers = Object.fromEntries(Object.entries(hdr).map(([col, v]) => [col, clean(v)]));
  const out = rows.slice(hdrIdx + 1).map(r => Object.fromEntries(Object.entries(r).map(([col, v]) => [headers[col] || col, v]))).filter(r => Object.keys(r).length);
  return { headers: Object.values(headers), rows: out };
}

async function getBuf(url) { const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000, headers: { 'User-Agent': UA } }); return Buffer.from(r.data); }
async function getJson(url, params) { const r = await axios.get(url, { params, timeout: 120_000, headers: { 'User-Agent': UA, ...(process.env.SOCRATA_TOKEN ? { 'X-App-Token': process.env.SOCRATA_TOKEN } : {}) } }); return r.data; }

const NM_COUNTY = { '005': 'Chaves', '015': 'Eddy', '025': 'Lea', '045': 'San Juan', '039': 'Rio Arriba', '043': 'Sandoval', '031': 'McKinley', '041': 'Roosevelt', '007': 'Colfax', '059': 'Union', '021': 'Harding', '037': 'Quay', '009': 'Curry', '011': 'De Baca', '027': 'Lincoln', '053': 'Socorro', '003': 'Catron', '017': 'Grant', '023': 'Hidalgo', '035': 'Otero', '051': 'Sierra' };

async function upsertOperatorLeads(rows, state) {
  // rows: { operator_no, name, county, permits_30d, last_at, extra }
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200), vals = [], params = [];
    chunk.forEach((r, j) => {
      const b = j * 9;
      vals.push(`('operator',$${b + 1},NULL,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8}::jsonb,$${b + 9},NOW())`);
      params.push(`${state}:${r.operator_no || 'name:' + r.name.toLowerCase()}`, r.name.slice(0, 200), r.phone || null, state, r.county || null, r.counties || r.county || null,
        Math.min(r.permits_30d, 60) * 10 + Math.min(r.last_7d || 0, 30) * 15,
        JSON.stringify({ permits_30d: r.permits_30d, last_7d: r.last_7d || 0, last_permit_at: r.last_at, operator_no: r.operator_no || null, state, ...(r.extra || {}) }),
        `${r.permits_30d} permit${r.permits_30d === 1 ? '' : 's'} this month (${state})${r.last_7d ? ` · ${r.last_7d} this week` : ''}`);
    });
    await pool.query(`INSERT INTO leads (kind, source_key, org_id, name, phone, st, county, counties, signal, meta, signal_text, updated_at) VALUES ${vals.join(',')}
      ON CONFLICT (kind, source_key, COALESCE(org_id, 0)) DO UPDATE SET name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, leads.phone), county = EXCLUDED.county, counties = EXCLUDED.counties, signal = EXCLUDED.signal, meta = EXCLUDED.meta, signal_text = EXCLUDED.signal_text, updated_at = NOW()`, params);
    n += chunk.length;
  }
  return n;
}
function rollup(permits, state) {
  // permits: { operator_no, name, county, date } -> operator rows
  const by = new Map();
  const cutoff30 = Date.now() - 30 * 86400e3, cutoff7 = Date.now() - 7 * 86400e3;
  for (const p of permits) {
    if (!p.name) continue;
    const key = p.operator_no || 'name:' + p.name.toLowerCase();
    const o = by.get(key) || { operator_no: p.operator_no, name: p.name, countySet: new Set(), permits_30d: 0, last_7d: 0, last_at: null, phone: p.phone || null };
    const t = p.date ? new Date(p.date).getTime() : 0;
    if (t >= cutoff30) o.permits_30d++;
    if (t >= cutoff7) o.last_7d++;
    if (p.county) o.countySet.add(p.county);
    if (!o.last_at || (p.date && p.date > o.last_at)) o.last_at = p.date;
    by.set(key, o);
  }
  return [...by.values()].filter(o => o.permits_30d > 0).map(o => ({ ...o, county: [...o.countySet][0] || null, counties: [...o.countySet].sort().join(', ') }));
}

// ---- Oklahoma ----
const OK_URL = process.env.OK_ITD_URL || 'https://oklahoma.gov/content/dam/ok/en/occ/documents/og/ogdatafiles/ITD-wells-formations-base.xlsx';
function okRows(parsed) {
  return parsed.rows.map(r => ({
    operator_no: clean(pick(r, 'operator_number', 'operator_no', 'otc_number', 'operatornumber', 'operator number') || '') || null,
    name: title(pick(r, 'operator_name', 'operator', 'operatorname', 'operator name') || fuzzy(r, /operator/i) || ''),
    county: title(pick(r, 'county', 'county_name') || ''), api: clean(pick(r, 'api_number', 'api') || ''),
    date: toDate(pick(r, 'approved_date', 'approval_date', 'itd_approved', 'permit_date', 'date_approved', 'approved', 'issued_date', 'spud_date') || fuzzy(r, /approv|issue|permit.?date/i)),
  })).filter(r => r.name);
}
async function okPermits() {
  const buf = await getBuf(OK_URL);
  const parsed = readXlsx(buf);
  const all = okRows(parsed);
  const seen = new Set(); const perms = all.filter(p => { const k = p.api || p.name + p.date; if (seen.has(k)) return false; seen.add(k); return true; });
  const ops = rollup(perms, 'OK');
  const saved = await upsertOperatorLeads(ops, 'OK');
  return { headers: parsed.headers, rows: parsed.rows.length, permits: perms.length, operators: ops.length, saved, dated: all.filter(p => p.date).length };
}

// ---- New Mexico ----
const NM_URL = process.env.NM_WELLS_URL || 'https://mercator.env.nm.gov/server/rest/services/emnrd/ocd_wells/MapServer';
async function nmWells() {
  const since = new Date(Date.now() - 45 * 86400e3);
  const sinceStr = since.toISOString().slice(0, 10);
  const perms = [];
  let fetched = 0, fields = null;
  for (const layer of [0, 1, 2, 3]) {
    for (let offset = 0; offset < 20000; offset += 2000) {
      const data = await getJson(`${NM_URL}/${layer}/query`, { where: `apr_date >= DATE '${sinceStr}' OR spud_date >= DATE '${sinceStr}'`, outFields: 'API,wellname,ogrid,ogrid_name,status,apr_date,spud_date,ulstr,district', resultOffset: offset, resultRecordCount: 2000, f: 'json' });
      if (data.error) throw new Error(`NM map service: ${JSON.stringify(data.error).slice(0, 200)}`);
      if (!fields && data.fields) fields = data.fields.map(f => f.name);
      const feats = data.features || [];
      fetched += feats.length;
      for (const f of feats) {
        const a = f.attributes || {};
        const api = String(a.API || '').replace(/\D/g, '');
        const cc = api.length >= 5 ? api.slice(2, 5) : null;
        const apr = a.apr_date ? (typeof a.apr_date === 'number' ? new Date(a.apr_date).toISOString().slice(0, 10) : toDate(a.apr_date)) : null;
        perms.push({ operator_no: a.ogrid ? String(a.ogrid) : null, name: title(a.ogrid_name || ''), county: NM_COUNTY[cc] || (cc ? 'NM-' + cc : null), api, date: apr || toDate(a.spud_date) });
      }
      if (feats.length < 2000) break;
    }
  }
  const ops = rollup(perms.filter(p => p.date), 'NM');
  const saved = await upsertOperatorLeads(ops, 'NM');
  return { fields, fetched, permits: perms.length, operators: ops.length, saved };
}

// ---- Texas new businesses (sales-tax permits with NAICS 213* oil & gas support, 484* trucking, 2131, 2389?) ----
const TXBIZ_URL = process.env.TXBIZ_URL || 'https://data.texas.gov/resource/jrea-zgmq.json';
async function txNewBiz() {
  const since = new Date(Date.now() - Number(process.env.TXBIZ_DAYS || 120) * 86400e3).toISOString().slice(0, 10);
  const rows = await getJson(TXBIZ_URL, { $where: `(starts_with(outlet_naics_code,'213') OR starts_with(outlet_naics_code,'484') OR starts_with(outlet_naics_code,'2131')) AND outlet_permit_issue_date >= '${since}'`, $limit: 5000, $order: 'outlet_permit_issue_date DESC' });
  if (!Array.isArray(rows)) throw new Error('unexpected reply: ' + JSON.stringify(rows).slice(0, 200));
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200), vals = [], params = [];
    chunk.forEach((r, j) => {
      const b = j * 10;
      const name = title(pick(r, 'taxpayer_name', 'outlet_name') || ''); if (!name) return;
      const naics = String(pick(r, 'outlet_naics_code') || ''), issued = toDate(pick(r, 'outlet_permit_issue_date'));
      const kind = naics.startsWith('484') ? 'trucking' : 'oilfield services';
      vals.push(`('newco',$${b + 1},NULL,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8}::jsonb,$${b + 9},$${b + 10},NOW())`);
      params.push(`TX:${pick(r, 'taxpayer_number') || name.toLowerCase()}:${pick(r, 'outlet_number') || ''}`, name.slice(0, 200), clean(pick(r, 'taxpayer_phone_number', 'outlet_phone_number', 'phone') || '') || null,
        title(pick(r, 'outlet_city', 'taxpayer_city') || '') || null, 'TX', clean(pick(r, 'outlet_zip_code', 'taxpayer_zip_code') || '').slice(0, 12) || null,
        150 + (issued && (Date.now() - new Date(issued)) < 30 * 86400e3 ? 50 : 0),
        JSON.stringify({ naics, issued, taxpayer_number: pick(r, 'taxpayer_number'), kind }),
        `new ${kind} company · permit issued ${issued || 'recently'}`, title(pick(r, 'outlet_county') || '') || null);
    });
    if (!vals.length) continue;
    await pool.query(`INSERT INTO leads (kind, source_key, org_id, name, phone, city, st, zip, signal, meta, signal_text, county, updated_at) VALUES ${vals.join(',')}
      ON CONFLICT (kind, source_key, COALESCE(org_id, 0)) DO UPDATE SET name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, leads.phone), signal = EXCLUDED.signal, meta = EXCLUDED.meta, signal_text = EXCLUDED.signal_text, updated_at = NOW()`, params);
    n += vals.length;
  }
  return { fetched: rows.length, saved: n, keys: rows[0] ? Object.keys(rows[0]) : [] };
}

// ---- Texas plugging (W-3 reports): operators plugging wells lately -> sellers ----
const TXPLUG_URL = process.env.TXPLUG_URL || 'https://data.texas.gov/resource/wfzn-9fje.json';
async function txPlugging() {
  const rows = await getJson(TXPLUG_URL, { $limit: 5000, $order: ':updated_at DESC' });
  if (!Array.isArray(rows)) throw new Error('unexpected reply: ' + JSON.stringify(rows).slice(0, 200));
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  const since = Date.now() - 120 * 86400e3;
  const by = new Map();
  for (const r of rows) {
    const name = title(fuzzy(r, /oper.*name|operator$/i) || pick(r, 'operator_name', 'plug_operator_name', 'operator') || '');
    const no = clean(fuzzy(r, /oper.*(no|num)/i) || pick(r, 'operator_number', 'operator_no') || '');
    const date = toDate(fuzzy(r, /plug.*date|date.*plug|w3.*date/i) || pick(r, 'plug_date', 'date_plugged'));
    const county = title(fuzzy(r, /county/i) || '');
    if (!name || !date || new Date(date).getTime() < since) continue;
    const key = no || 'name:' + name.toLowerCase();
    const o = by.get(key) || { no, name, n: 0, last: null, counties: new Set() };
    o.n++; if (!o.last || date > o.last) o.last = date; if (county) o.counties.add(county);
    by.set(key, o);
  }
  let n = 0;
  for (const o of by.values()) {
    await pool.query(`INSERT INTO leads (kind, source_key, org_id, name, st, county, counties, signal, meta, signal_text, updated_at) VALUES ('seller',$1,NULL,$2,'TX',$3,$4,$5,$6::jsonb,$7,NOW())
      ON CONFLICT (kind, source_key, COALESCE(org_id, 0)) DO UPDATE SET signal = GREATEST(leads.signal, EXCLUDED.signal), meta = leads.meta || EXCLUDED.meta, signal_text = CASE WHEN leads.signal_text LIKE '%RRC%' THEN leads.signal_text || ' · ' || EXCLUDED.signal_text ELSE EXCLUDED.signal_text END, counties = COALESCE(leads.counties, EXCLUDED.counties), updated_at = NOW()`,
      [`TX:${o.no || 'name:' + o.name.toLowerCase()}`, o.name.slice(0, 200), [...o.counties][0] || null, [...o.counties].sort().join(', ') || null, 120 + Math.min(o.n, 30) * 6, JSON.stringify({ plugged_120d: o.n, last_plug: o.last }), `plugged ${o.n} well${o.n === 1 ? '' : 's'} recently (last ${o.last}) · winding down?`]);
    n++;
  }
  return { fetched: rows.length, keys, operators: by.size, saved: n };
}

// ---- runner / status ----
const FEEDS = { okPermits, nmWells, txNewBiz, txPlugging };
let running = null;
async function refreshAll() {
  const out = {};
  for (const [k, fn] of Object.entries(FEEDS)) { try { out[k] = await fn(); } catch (e) { out[k] = { error: e.response ? `${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message }; } }
  try { out.auto_assigned = await require('./leads').applyRulesEverywhere(); } catch {}
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('more_leads_result', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(out).slice(0, 6000)]).catch(() => {});
  console.log('[more leads]', JSON.stringify(out).slice(0, 1500));
  return out;
}
function refreshInBackground() { if (running) return { started: false }; running = refreshAll().catch(e => ({ error: e.message })).then(o => { running = null; return o; }); return { started: true }; }
async function status() {
  const r = await pool.query(`SELECT value, updated_at FROM app_state WHERE key = 'more_leads_result'`).catch(() => ({ rows: [] }));
  let last = null; try { last = r.rows[0] ? JSON.parse(r.rows[0].value) : null; } catch {}
  const counts = (await pool.query(`SELECT kind, COALESCE(st,'?') AS st, COUNT(*)::int AS n FROM leads WHERE org_id IS NULL GROUP BY kind, st ORDER BY kind, st`)).rows;
  return { running: Boolean(running), last, last_at: r.rows[0]?.updated_at || null, counts };
}
/** Raw look at one feed's first rows/headers, for fitting field names. */
async function sample(which) {
  if (which === 'okPermits') { const parsed = readXlsx(await getBuf(OK_URL)); return { headers: parsed.headers, rows: parsed.rows.slice(0, 3), mapped: okRows({ rows: parsed.rows.slice(0, 3) }) }; }
  if (which === 'nmWells') { const d = await getJson(`${NM_URL}/0/query`, { where: '1=1', outFields: '*', resultRecordCount: 2, f: 'json' }); return { fields: (d.fields || []).map(f => f.name), features: (d.features || []).map(f => f.attributes), error: d.error }; }
  if (which === 'txNewBiz') { const cols = await getJson('https://data.texas.gov/api/views/jrea-zgmq/columns.json').catch(e => ({ error: e.message })); const rows = await getJson(TXBIZ_URL, { $limit: 2 }); return { columns: Array.isArray(cols) ? cols.map(c => c.fieldName) : cols, rows }; }
  if (which === 'txPlugging') { const cols = await getJson('https://data.texas.gov/api/views/wfzn-9fje/columns.json').catch(e => ({ error: e.message })); const rows = await getJson(TXPLUG_URL, { $limit: 2 }); return { columns: Array.isArray(cols) ? cols.map(c => c.fieldName) : cols, rows }; }
  throw new Error('unknown feed');
}
module.exports = { refreshAll, refreshInBackground, status, sample, readXlsx, FEEDS };
