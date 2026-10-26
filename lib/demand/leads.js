// The one lead list behind the Find buyers tab. Public sources (RRC operators, FMCSA carriers) are
// synced into `leads` for everyone; what a company does with a lead lives in `lead_state`.
const pool = require('../db');

/** Operators (from permits) -> leads. Signal = permits this month, boosted by this week's. */
async function syncOperators() {
  const r = await pool.query(`
    INSERT INTO leads (kind, source_key, org_id, name, phone, city, st, zip, website, county, counties, signal, signal_text, meta, updated_at)
    SELECT 'operator', 'TX:' || o.operator_no, NULL, o.name, o.phone, o.city, o.st, o.zip, o.website,
           split_part(COALESCE(o.counties, ''), ',', 1),
           o.counties,
           COALESCE(o.permits_30d, 0) * 10 + COALESCE(w.last_7d, 0) * 15 + LEAST(COALESCE(o.permits_90d, 0), 50),
           CONCAT(o.permits_30d, ' permit', CASE WHEN o.permits_30d = 1 THEN '' ELSE 's' END, ' this month',
                  CASE WHEN COALESCE(w.last_7d, 0) > 0 THEN ' · ' || w.last_7d || ' this week' ELSE '' END,
                  CASE WHEN COALESCE(w.pending, 0) > 0 THEN ' · ' || w.pending || ' pending' ELSE '' END),
           json_build_object('permits_30d', o.permits_30d, 'permits_90d', o.permits_90d, 'last_7d', COALESCE(w.last_7d, 0), 'pending', COALESCE(w.pending, 0), 'last_permit_at', o.last_permit_at, 'operator_no', o.operator_no)::jsonb,
           NOW()
    FROM operators o
    LEFT JOIN (SELECT COALESCE(NULLIF(operator_no,''), 'name:' || lower(operator_name)) AS k,
                      COUNT(*) FILTER (WHERE COALESCE(issued_at, received_at) > NOW() - interval '7 days')::int AS last_7d,
                      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
               FROM permits GROUP BY 1) w ON w.k = o.operator_no
    WHERE o.state = 'TX' AND COALESCE(o.permits_90d, 0) > 0
    ON CONFLICT (kind, source_key, COALESCE(org_id, 0)) DO UPDATE SET
      name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, leads.phone), city = COALESCE(EXCLUDED.city, leads.city), st = COALESCE(EXCLUDED.st, leads.st),
      county = EXCLUDED.county, counties = EXCLUDED.counties, signal = EXCLUDED.signal, signal_text = EXCLUDED.signal_text, meta = EXCLUDED.meta, updated_at = NOW()`);
  return r.rowCount;
}

/** A buyer who came in through a rep's intake link -> a private lead for that company, already assigned. */
async function addIntakeLead({ orgId, repId, buyerId, name, phone, email, city, st, wants }) {
  const text = wants && wants.length ? 'Wants ' + wants.map(w => w.machine || w.product).filter(Boolean).slice(0, 3).join(', ') : 'Filled out your intake link';
  const l = await pool.query(`INSERT INTO leads (kind, source_key, org_id, name, phone, email, city, st, signal, signal_text, meta)
                              VALUES ('intake', $1, $2, $3, $4, $5, $6, $7, 500, $8, $9)
                              ON CONFLICT (kind, source_key, COALESCE(org_id, 0)) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = NOW() RETURNING id`,
    [buyerId ? `buyer:${buyerId}` : `intake:${Date.now()}`, orgId, name, phone, email, city, st, text, JSON.stringify({ wants: (wants || []).slice(0, 8) })]);
  await pool.query(`INSERT INTO lead_state (org_id, lead_id, assigned_to, assigned_by, assigned_at, status, buyer_id, last_touch_at, updated_by)
                    VALUES ($1,$2,$3,$3,NOW(),'assigned',$4,NOW(),$3) ON CONFLICT (org_id, lead_id) DO NOTHING`, [orgId, l.rows[0].id, repId, buyerId]);
  return l.rows[0].id;
}

const STATUSES = ['new', 'assigned', 'contacted', 'talking', 'customer', 'dead'];

/** The list a company sees: public leads + its own, with its own state. */
async function list(user, q = {}) {
  const org = Number(user.org_id) || 0;
  const params = [org];
  const where = [`(l.org_id IS NULL OR l.org_id = $1)`];
  if (q.kind && q.kind !== 'all') { params.push(q.kind); where.push(`l.kind = $${params.length}`); }
  if (q.county) { params.push(`%${q.county}%`); where.push(`(l.counties ILIKE $${params.length} OR l.county ILIKE $${params.length})`); }
  if (q.st) { params.push(String(q.st).toUpperCase()); where.push(`l.st = $${params.length}`); }
  if (q.q) { params.push(`%${q.q}%`); where.push(`(l.name ILIKE $${params.length} OR COALESCE(l.city,'') ILIKE $${params.length})`); }
  if (q.status === 'new') where.push(`COALESCE(s.status, 'new') = 'new'`);
  else if (q.status === 'open') where.push(`COALESCE(s.status, 'new') NOT IN ('dead', 'customer')`);
  else if (q.status && q.status !== 'all') { params.push(q.status); where.push(`s.status = $${params.length}`); }
  if (q.assigned === 'me') { params.push(user.id); where.push(`s.assigned_to = $${params.length}`); }
  else if (q.assigned === 'none') where.push(`s.assigned_to IS NULL`);
  else if (q.assigned && q.assigned !== 'any') { params.push(Number(q.assigned)); where.push(`s.assigned_to = $${params.length}`); }
  if (q.days) { params.push(String(Math.min(Number(q.days) || 30, 365))); where.push(`(l.kind <> 'operator' OR (l.meta->>'last_permit_at')::date > NOW() - ($${params.length} || ' days')::interval)`); }
  if (q.active === '1') where.push(`(l.kind <> 'operator' OR (l.meta->>'last_7d')::int > 0)`);
  const order = { hot: 'l.signal DESC, l.updated_at DESC', newest: 'l.first_seen DESC', name: 'l.name ASC', touched: 's.last_touch_at DESC NULLS LAST, l.signal DESC' }[q.sort] || 'l.signal DESC, l.updated_at DESC';
  const limit = Math.min(Number(q.limit) || 200, 1000);
  const rows = (await pool.query(`
    SELECT l.id, l.kind, l.name, l.phone, l.email, l.website, l.city, l.st, l.county, l.counties, l.signal, l.signal_text, l.meta, l.first_seen,
           COALESCE(s.status, 'new') AS status, s.assigned_to, s.assigned_at, s.notes, s.buyer_id, s.last_touch_at,
           u.name AS assigned_name
    FROM leads l LEFT JOIN lead_state s ON s.lead_id = l.id AND s.org_id = $1 LEFT JOIN users u ON u.id = s.assigned_to
    WHERE ${where.join(' AND ')}
    ORDER BY ${order} LIMIT ${limit}`, params)).rows;
  const counts = (await pool.query(`
    SELECT l.kind, COUNT(*)::int AS n FROM leads l WHERE (l.org_id IS NULL OR l.org_id = $1) GROUP BY l.kind`, [org])).rows;
  const counties = (await pool.query(`SELECT county, COUNT(*)::int AS n FROM leads WHERE (org_id IS NULL OR org_id = $1) AND county IS NOT NULL AND county <> '' GROUP BY county ORDER BY n DESC LIMIT 80`, [org])).rows;
  const team = (await pool.query(`SELECT id, name, email, role FROM users WHERE org_id = $1 AND role IN ('admin','broker','agent') ORDER BY name`, [org])).rows;
  const mine = (await pool.query(`SELECT COUNT(*)::int AS n FROM lead_state WHERE org_id = $1 AND assigned_to = $2 AND status NOT IN ('dead','customer')`, [org, user.id])).rows[0].n;
  return { count: rows.length, leads: rows, counts: Object.fromEntries(counts.map(c => [c.kind, c.n])), counties, team, mine, statuses: STATUSES };
}

async function assign(user, ids, assignedTo) {
  const org = Number(user.org_id);
  if (assignedTo) {
    const ok = (await pool.query(`SELECT 1 FROM users WHERE id = $1 AND org_id = $2`, [assignedTo, org])).rows.length;
    if (!ok) throw Object.assign(new Error('That person is not in your company'), { status: 400 });
  }
  let n = 0;
  const before = assignedTo ? new Set((await pool.query(`SELECT lead_id FROM lead_state WHERE org_id = $1 AND assigned_to = $2 AND lead_id = ANY($3::int[])`, [org, assignedTo, ids])).rows.map(r => r.lead_id)) : new Set();
  for (const id of ids) {
    const r = await pool.query(`INSERT INTO lead_state (org_id, lead_id, assigned_to, assigned_by, assigned_at, status, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,NOW(),$5,$4,NOW())
      ON CONFLICT (org_id, lead_id) DO UPDATE SET assigned_to = EXCLUDED.assigned_to, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW(),
        status = CASE WHEN lead_state.status IN ('new','assigned') THEN EXCLUDED.status ELSE lead_state.status END, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [org, id, assignedTo || null, user.id, assignedTo ? 'assigned' : 'new']);
    n += r.rowCount;
  }
  // tell the salesman (email, when mail is set up; the badge on their tab updates regardless)
  const fresh = ids.filter(id => !before.has(id));
  if (assignedTo && assignedTo !== user.id && fresh.length) {
    try {
      const rep = (await pool.query(`SELECT email, name FROM users WHERE id = $1`, [assignedTo])).rows[0];
      const names = (await pool.query(`SELECT name FROM leads WHERE id = ANY($1::int[]) ORDER BY signal DESC LIMIT 6`, [fresh])).rows.map(r => r.name);
      const origin = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
      if (rep && rep.email) await require('../mailer').send({ to: rep.email, subject: `${user.name || 'Your broker'} handed you ${fresh.length} lead${fresh.length === 1 ? '' : 's'}`,
        text: `${user.name || 'Your broker'} put ${fresh.length} lead${fresh.length === 1 ? '' : 's'} on your plate:\n\n${names.map(x => '• ' + x).join('\n')}${fresh.length > names.length ? `\n…and ${fresh.length - names.length} more` : ''}\n\nOpen them: ${origin}/broker.html#demand` });
    } catch (e) { console.log('assign mail skipped:', e.message); }
  }
  return n;
}

async function update(user, id, { status, notes, buyer_id }) {
  const org = Number(user.org_id);
  if (status && !STATUSES.includes(status)) throw Object.assign(new Error('bad status'), { status: 400 });
  const r = await pool.query(`INSERT INTO lead_state (org_id, lead_id, status, notes, buyer_id, last_touch_at, updated_by, updated_at)
    VALUES ($1,$2,COALESCE($3,'new'),$4,$5,NOW(),$6,NOW())
    ON CONFLICT (org_id, lead_id) DO UPDATE SET status = COALESCE($3, lead_state.status), notes = COALESCE($4, lead_state.notes), buyer_id = COALESCE($5, lead_state.buyer_id),
      last_touch_at = NOW(), updated_by = $6, updated_at = NOW() RETURNING *`, [org, id, status || null, notes ?? null, buyer_id || null, user.id]);
  return r.rows[0];
}

module.exports = { syncOperators, addIntakeLead, list, assign, update, STATUSES };
