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

function endsIn(when) {
  const ms = new Date(when) - Date.now();
  if (ms <= 0) return 'auction ended';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h < 1) return `ends in ${m} min`;
  if (h < 48) return `ends in ${h}h ${m}m`;
  return `ends ${new Date(when).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}
const SOURCE_NAMES = { govdeals: 'GovDeals', ironplanet: 'IronPlanet', rbauction: 'Ritchie Bros', ebay: 'eBay', craigslist: 'Craigslist', csv: 'Import', manual: 'Manual' };
const srcName = (s) => SOURCE_NAMES[s] || s;

function dealCard(d, { broker = false, saved = null } = {}) {
  const where = [d.city, d.state].filter(Boolean).join(', ') || 'location unknown';
  const isAuction = d.sale_type === 'auction';
  const msLeft = d.auction_ends ? new Date(d.auction_ends) - Date.now() : null;
  const urgent = msLeft !== null && msLeft < 24 * 3600000;
  const saleTag = isAuction
    ? `<span class="tag ${urgent ? 'hot' : ''}">Auction${d.auction_ends ? ' · ' + endsIn(d.auction_ends) : ''}</span>`
    : `<span class="tag">Buy now / offer</span>`;
  const verify = /verify/i.test(d.compared_to || '');
  const why = `${money(d.discount_percent / 100 * d.market_price)} under what ${/sold/.test(d.compared_to || '') ? 'similar ones sold for' : 'similar ones are listed at'}`;
  let actions = '';
  if (broker) {
    if (d.commission_status === 'open') actions = `<button onclick="brokerAct(${d.id},'claim')">Claim</button><button onclick="brokerAct(${d.id},'pass')">Pass</button>`;
    else if (d.commission_status === 'claimed') actions = `<button onclick="brokerSold(${d.id})">Mark sold</button><button onclick="brokerAct(${d.id},'pass')">Pass</button>`;
    else if (d.commission_status === 'sold') actions = `<button disabled>Sold</button>`;
  } else {
    actions = saved ? `<button onclick="unsaveDeal(${d.id})">Saved ✓</button>` : `<button onclick="saveDeal(${d.id})">Save</button>`;
    if (d.url) actions += `<a href="${esc(d.url)}" target="_blank" rel="noopener" style="flex:1"><button class="primary" style="width:100%">View listing</button></a>`;
  }
  return `<div class="card status-${d.commission_status || 'open'} ${verify ? 'verify' : ''}" id="deal-${d.id}">
    ${d.image_url ? `<a class="photo" href="${esc(d.url || '#')}" target="_blank" rel="noopener"><img src="${esc(d.image_url)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></a>` : ''}
    <div class="top">
      <div class="title">${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a>` : esc(d.title)}</div>
      <div class="score">${d.deal_score}<small>score</small></div>
    </div>
    <div class="price">${money(d.price)}<span class="mkt">${money(d.market_price)}</span></div>
    <div class="save">${why}</div>
    <div class="small muted">Est. profit after fees ${money(d.estimated_margin)} · ${Math.round(d.discount_percent)}% below ${esc(d.compared_to)}</div>
    <div class="meta">${saleTag}<span>${esc(where)}</span>${d.year ? `<span>${d.year}</span>` : ''}${d.hours ? `<span>${Number(d.hours).toLocaleString()} hrs</span>` : ''}<span>${esc(srcName(d.source))}</span></div>
    <div class="actions">${actions}</div>
  </div>`;
}
