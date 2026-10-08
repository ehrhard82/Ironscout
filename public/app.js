// Shared helpers for every page.
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** fetch JSON; on 401 send to login, on 402 send to account (subscribe). */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !opts.quiet) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('login'); }
  if (res.status === 402 && !opts.quiet) { location.href = '/account.html?subscribe=1'; throw new Error('subscribe'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Returns the current user or redirects to login. */
async function requireUser() {
  try { return await api('/api/auth/me'); } catch (e) { throw e; }
}

function renderHeader(user, active) {
  const nav = [
    ['/', 'Deals'],
    ['/account.html', 'Watchlists & account'],
  ];
  if (user && (user.role === 'admin' || user.role === 'broker')) nav.splice(1, 0, ['/?view=broker', 'Broker board']);
  if (user && user.role === 'admin') nav.push(['/admin.html', 'Admin']);
  return `<h1><a href="/">Iron<span>Scout</span></a></h1>
    <nav>${nav.map(([h, t]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`).join('')}</nav>
    <div class="stats" id="hdr-stats">${user ? `${esc(user.email)} · <a href="#" id="logout" style="color:var(--muted)">log out</a>` : ''}</div>`;
}

function wireLogout() {
  const b = $('logout');
  if (b) b.onclick = async (e) => { e.preventDefault(); await api('/api/auth/logout', { method: 'POST', quiet: true }); location.href = '/login.html'; };
}

function dealCard(d, { broker = false, saved = null } = {}) {
  const where = [d.city, d.state].filter(Boolean).join(', ') || 'location unknown';
  const auction = d.sale_type === 'auction' && d.auction_ends ? ` · ends ${new Date(d.auction_ends).toLocaleDateString()}` : '';
  let actions = '';
  if (broker) {
    if (d.commission_status === 'open') actions = `<button onclick="brokerAct(${d.id},'claim')">Claim</button><button onclick="brokerAct(${d.id},'pass')">Pass</button>`;
    else if (d.commission_status === 'claimed') actions = `<button onclick="brokerSold(${d.id})">Mark sold</button><button onclick="brokerAct(${d.id},'pass')">Pass</button>`;
    else if (d.commission_status === 'sold') actions = `<button disabled>Sold</button>`;
  } else {
    actions = saved ? `<button onclick="unsaveDeal(${d.id})">Saved ✓</button>` : `<button onclick="saveDeal(${d.id})">Save</button>`;
    if (d.url) actions += `<a href="${esc(d.url)}" target="_blank" rel="noopener" style="flex:1"><button style="width:100%">View listing</button></a>`;
  }
  return `<div class="card status-${d.commission_status || 'open'}" id="deal-${d.id}">
    <div class="top">
      <div class="title"><a href="${esc(d.url || '#')}" target="_blank" rel="noopener">${esc(d.title)}</a></div>
      <div class="score">${d.deal_score}<small>score</small></div>
    </div>
    <div class="price">${money(d.price)}<span class="mkt">${money(d.market_price)}</span></div>
    <div class="save">est. margin ${money(d.estimated_margin)} · ${Math.round(d.discount_percent)}% below ${esc(d.compared_to)}</div>
    <div class="meta"><span class="tag">${esc(d.product)}</span><span>${esc(where)}</span>${d.year ? `<span>${d.year}</span>` : ''}${d.hours ? `<span>${Number(d.hours).toLocaleString()} hrs</span>` : ''}<span>${esc(d.source)}${auction}</span></div>
    <div class="actions">${actions}</div>
  </div>`;
}
