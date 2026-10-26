// FMCSA motor-carrier census (US DOT, public, daily) -> trucking and service companies that haul oilfield
// equipment, with phone numbers. These are the people who actually buy winch trucks, vac trucks and lowboys.
// Dataset az4n-8mr2 on data.transportation.gov (Socrata). No key needed; a free app token avoids throttling.
const axios = require('axios');
const pool = require('../db');

const BASE = process.env.FMCSA_URL || 'https://data.transportation.gov/resource/az4n-8mr2.json';
const STATES = () => (process.env.FMCSA_STATES || 'TX,OK,NM').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const PAGE = 5000;
const CARGO = ['crgo_oilfield', 'crgo_machlrg'];                     // self-reported cargo: "Oil Field Equipment", "Machinery, Large Objects"
const SELECT = ['dot_number', 'legal_name', 'dba_name', 'phone', 'cell_phone', 'email_address', 'phy_street', 'phy_city', 'phy_state', 'phy_zip', 'power_units', 'total_drivers',
  'carrier_operation', 'hm_ind', 'status_code', 'mcs150_date', 'add_date', 'company_officer_1', ...CARGO, 'crgo_construct', 'crgo_liqgas', 'crgo_drybulk', 'crgo_waterwell'];

function where(states) {
  const st = states.map(s => `'${s}'`).join(',');
  const cargo = CARGO.map(c => `${c} in('Y','X')`).join(' OR ');
  return `status_code='A' AND phy_state in(${st}) AND (${cargo}) AND phone IS NOT NULL`;
}
const headers = () => ({ 'User-Agent': 'IronScout/1.0', ...(process.env.SOCRATA_TOKEN ? { 'X-App-Token': process.env.SOCRATA_TOKEN } : {}) });

async function fetchPage(states, offset, limit = PAGE, select = SELECT) {
  const params = { $select: select.join(','), $where: where(states), $order: ':id', $limit: limit, $offset: offset };
  const r = await axios.get(BASE, { params, headers: headers(), timeout: 120_000 });
  return Array.isArray(r.data) ? r.data : [];
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const phoneFmt = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : clean(p) || null; };
const OP = { A: 'interstate', B: 'intrastate hazmat', C: 'intrastate' };

function toLead(c) {
  const name = clean(c.dba_name) && clean(c.dba_name).toLowerCase() !== clean(c.legal_name).toLowerCase() ? `${clean(c.legal_name)} (${clean(c.dba_name)})` : clean(c.legal_name);
  const trucks = Number(c.power_units) || 0, drivers = Number(c.total_drivers) || 0;
  const cargo = [];
  if (['Y', 'X'].includes(c.crgo_oilfield)) cargo.push('oilfield equipment');
  if (['Y', 'X'].includes(c.crgo_machlrg)) cargo.push('heavy machinery');
  if (['Y', 'X'].includes(c.crgo_liqgas)) cargo.push('liquids');
  if (['Y', 'X'].includes(c.crgo_drybulk)) cargo.push('dry bulk');
  if (['Y', 'X'].includes(c.crgo_waterwell)) cargo.push('water well');
  const mcs = String(c.mcs150_date || '').slice(0, 10);
  return {
    source_key: `dot:${c.dot_number}`, name: name.slice(0, 200), phone: phoneFmt(c.phone || c.cell_phone), email: clean(c.email_address).toLowerCase().slice(0, 255) || null,
    city: clean(c.phy_city).toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase()).slice(0, 100) || null, st: clean(c.phy_state).toUpperCase().slice(0, 2) || null, zip: clean(c.phy_zip).slice(0, 12) || null,
    signal: Math.min(trucks, 200) * 3 + Math.min(drivers, 200) + (['Y', 'X'].includes(c.crgo_oilfield) ? 40 : 0),
    signal_text: `${cargo.join(', ') || 'hauler'} · ${trucks} truck${trucks === 1 ? '' : 's'}${drivers ? ` · ${drivers} driver${drivers === 1 ? '' : 's'}` : ''}${OP[c.carrier_operation] ? ' · ' + OP[c.carrier_operation] : ''}`.slice(0, 200),
    meta: { dot: c.dot_number, trucks, drivers, cargo, officer: clean(c.company_officer_1) || null, hazmat: c.hm_ind === 'Y', mcs150_date: mcs || null, registered: String(c.add_date || '').slice(0, 10) || null },
  };
}

async function upsertLeads(rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200), vals = [], params = [];
    chunk.forEach((l, j) => {
      const b = j * 10;
      vals.push(`('carrier',$${b + 1},NULL,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10}::jsonb,NOW())`);
      params.push(l.source_key, l.name, l.phone, l.email, l.city, l.st, l.zip, l.signal, l.signal_text, JSON.stringify(l.meta));
    });
    await pool.query(`INSERT INTO leads (kind, source_key, org_id, name, phone, email, city, st, zip, signal, signal_text, meta, updated_at) VALUES ${vals.join(',')}
      ON CONFLICT (kind, source_key, COALESCE(org_id, 0)) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = COALESCE(EXCLUDED.email, leads.email), city = EXCLUDED.city, st = EXCLUDED.st,
        zip = EXCLUDED.zip, signal = EXCLUDED.signal, signal_text = EXCLUDED.signal_text, meta = EXCLUDED.meta, updated_at = NOW()`, params);
    n += chunk.length;
  }
  return n;
}

let running = null;
async function refresh() {
  const states = STATES();
  const out = { states, pages: 0, fetched: 0, saved: 0, skipped_stale: 0 };
  const cutoff = new Date(Date.now() - Number(process.env.FMCSA_MAX_AGE_YEARS || 3) * 365 * 86400e3).toISOString().slice(0, 10);
  for (let offset = 0; offset < 200_000; offset += PAGE) {
    const page = await fetchPage(states, offset);
    out.pages++; out.fetched += page.length;
    const fresh = page.filter(c => !c.mcs150_date || String(c.mcs150_date).slice(0, 10) >= cutoff);   // biennial update required; stale = probably gone
    out.skipped_stale += page.length - fresh.length;
    out.saved += await upsertLeads(fresh.map(toLead).filter(l => l.name && l.phone));
    if (page.length < PAGE) break;
  }
  await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('carriers_refreshed_at', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [new Date().toISOString()]).catch(() => {});
  console.log('[carriers]', JSON.stringify(out));
  return out;
}
function refreshInBackground() {
  if (running) return { started: false, reason: 'already running' };
  running = refresh().catch(e => ({ error: e.response ? `${e.response.status} from data.transportation.gov: ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message })).then(async (out) => {
    await pool.query(`INSERT INTO app_state (key, value, updated_at) VALUES ('carriers_last_result', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(out).slice(0, 4000)]).catch(() => {});
    running = null; return out;
  });
  return { started: true };
}
async function status() {
  const r = await pool.query(`SELECT key, value, updated_at FROM app_state WHERE key IN ('carriers_last_result', 'carriers_refreshed_at')`).catch(() => ({ rows: [] }));
  const o = Object.fromEntries(r.rows.map(x => [x.key, x]));
  let last = null; try { last = o.carriers_last_result ? JSON.parse(o.carriers_last_result.value) : null; } catch {}
  const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM leads WHERE kind = 'carrier'`)).rows[0].n;
  return { running: Boolean(running), last, refreshed_at: o.carriers_refreshed_at?.value || null, carriers: n };
}
/** Should the daily job pull carriers today? Weekly is plenty; the file barely changes day to day. */
async function due() {
  const r = await pool.query(`SELECT value FROM app_state WHERE key = 'carriers_refreshed_at'`).catch(() => ({ rows: [] }));
  return !r.rows[0] || (Date.now() - new Date(r.rows[0].value).getTime()) > Number(process.env.FMCSA_EVERY_DAYS || 7) * 86400e3;
}
/** First two raw rows + the real column list, for fitting without guessing. */
async function sample() {
  const r = await axios.get(BASE, { params: { $limit: 2, $where: where(STATES()) }, headers: headers(), timeout: 60_000, validateStatus: () => true });
  const counts = await axios.get(BASE, { params: { $select: 'crgo_oilfield,count(*)', $group: 'crgo_oilfield' }, headers: headers(), timeout: 60_000, validateStatus: () => true }).catch(e => ({ status: 0, data: e.message }));
  return { status: r.status, keys: Array.isArray(r.data) && r.data[0] ? Object.keys(r.data[0]) : null, rows: r.data, as_leads: Array.isArray(r.data) ? r.data.map(toLead) : null, oilfield_flag_values: counts.data };
}

module.exports = { refresh, refreshInBackground, status, due, sample, toLead };
