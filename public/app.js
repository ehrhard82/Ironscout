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
  const u = await api('/api/auth/me');
  window.IS_STAFF = !!u && ['admin', 'broker', 'agent'].includes(u.role);
  window.CAN_HIDE = !!u && (u.role === 'admin' || u.role === 'broker');   // agents work deals but can't hide listings for everyone
  return u;
}

function renderHeader(user, active) {
  const nav = [
    ['/', 'Deals'],
    ['/account.html', 'Settings'],
  ];
  if (user && ['admin', 'broker', 'agent'].includes(user.role)) nav.splice(1, 0, ['/broker.html', 'Broker board']);
  nav.push(['/help.html', 'How it works']);
  if (user && user.role === 'admin') nav.push(['/admin.html', 'Admin'], ['/status.html', 'Status']);
  return `<h1><a href="/"><svg class="logo" viewBox="0 0 100 100" width="26" height="26" aria-hidden="true"><polygon points="50,6 88,28 88,72 50,94 12,72 12,28" fill="#f5a524"/><text x="50" y="64" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="40" fill="#1a1200">IS</text></svg>Iron<span>Scout</span></a></h1>
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
const SOURCE_NAMES = { govdeals: 'GovDeals', ironplanet: 'IronPlanet', rbauction: 'Ritchie Bros', machinio: 'Machinio', ebay: 'eBay', craigslist: 'Craigslist', csv: 'Import', manual: 'Manual' };
const srcName = (s) => SOURCE_NAMES[s] || s;

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - new Date(ts)) / 60000));
  return m < 2 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`;
}
function untilWhen(ts) {
  const h = Math.round((new Date(ts) - Date.now()) / 3600000);
  return h <= 1 ? 'under an hour more' : h < 48 ? `about ${h} hr more` : `about ${Math.round(h / 24)} days more`;
}
function dealCard(d, { broker = false, saved = null } = {}) {
  const where = [d.city, d.state].filter(Boolean).join(', ') || 'location unknown';
  const isAuction = d.sale_type === 'auction';
  const msLeft = d.auction_ends ? new Date(d.auction_ends) - Date.now() : null;
  const urgent = msLeft !== null && msLeft < 24 * 3600000;
  const saleTag = isAuction
    ? `<span class="tag ${urgent ? 'hot' : ''}">Auction${d.auction_ends ? ' · ' + endsIn(d.auction_ends) : ''}</span>`
    : `<span class="tag">Buy now / offer</span>`;
  const verify = /verify/i.test(d.compared_to || '');
  const buyers = Array.isArray(d.buyers) ? d.buyers : [];
  const buyerLine = buyers.length ? `<div class="buyers">👤 <b>${buyers.length} buyer${buyers.length === 1 ? '' : 's'} want${buyers.length === 1 ? 's' : ''} this:</b> ${buyers.slice(0, 3).map(b =>
      `${esc(b.company)}${b.contact ? ` (${esc(b.contact)})` : ''}${b.phone ? ` <a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ''}${b.status === 'prospect' ? ' <span class="muted small">prospect</span>' : ''}`).join(' · ')}${buyers.length > 3 ? ` <span class="muted">+${buyers.length - 3} more</span>` : ''}</div>` : '';
  const why = `${money(d.discount_percent / 100 * d.market_price)} under what ${/sold/.test(d.compared_to || '') ? 'similar ones sold for' : 'similar ones are listed at'}`;
  let actions = '';
  if (broker) {
    if (d.commission_status === 'open') actions = `<button class="primary" onclick="brokerClaim(${d.id})">Claim${buyers.length ? ' for buyer' : ''}</button><button onclick="brokerAct(${d.id},'pass')">Pass</button>`;
    else if (d.commission_status === 'claimed' && d.claim && d.claim.by_me) actions = `<button class="primary" onclick="brokerSold(${d.id})">Mark sold</button><button onclick="brokerAct(${d.id},'release')">Release</button><button onclick="brokerAct(${d.id},'pass')">Pass</button>`;
    else if (d.commission_status === 'claimed') actions = `<button onclick="brokerClaim(${d.id})">Claim anyway</button>${window.CAN_HIDE ? `<button onclick="brokerAct(${d.id},'release')">Release theirs</button>` : ''}`;
    else if (d.commission_status === 'sold') actions = `<button disabled>Sold</button>`;
  } else {
    actions = saved ? `<button onclick="unsaveDeal(${d.id})">Saved ✓</button>` : `<button onclick="saveDeal(${d.id})">Save</button>`;
    if (d.url) actions += `<a href="${esc(d.url)}" target="_blank" rel="noopener" style="flex:1"><button class="primary" style="width:100%">View listing</button></a>`;
  }
  if (broker && d.url) actions += `<a href="${esc(d.url)}" target="_blank" rel="noopener" style="flex:1"><button style="width:100%">View</button></a>`;
  actions += blockBtn(d.listing_id);
  const claimed = d.commission_status === 'claimed' && d.claim;
  const claimLine = claimed ? `<div class="buyers">${d.claim.by_me ? '✅ <b>You claimed this</b>' : `⏳ <b>Claimed by ${esc(d.claim.by)}</b>`}${d.claimed_buyer ? ` for ${esc(d.claimed_buyer.company)}` : ' for a buyer'} · ${ago(d.claim.at)}${d.claim.expires_at ? ` · holds ${untilWhen(d.claim.expires_at)}` : ''}${d.claim.by_me ? '' : ' — better hurry!'}</div>` : '';
  return `<div class="card status-${d.commission_status || 'open'} ${verify ? 'verify' : ''} ${claimed && !d.claim.by_me ? 'claimed-other' : ''}" id="deal-${d.id}">
    ${d.image_url ? `<a class="photo" href="${esc(d.url || '#')}" target="_blank" rel="noopener"><img src="${esc(d.image_url)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></a>` : ''}
    <div class="top">
      <div class="title">${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a>` : esc(d.title)}</div>
      <div class="score">${d.deal_score}<small>score</small></div>
    </div>
    <div class="price">${money(d.price)}<span class="mkt">${money(d.market_price)}</span></div>
    ${claimLine}
    ${buyerLine}
    <div class="save">${why}</div>
    <div class="small muted">${Math.round(d.discount_percent)}% below ${esc(d.compared_to)}</div>
    ${d.my_commission ? `<div class="small"><b>Your commission (${d.my_commission.pct}%): ~${money(d.my_commission.amount)}</b> <span class="muted">on the ${money(d.price)} price</span></div>` : ''}
    ${d.landed ? `<div class="landed small"><b>Delivered to ${esc(d.landed.to)}: ~${money(d.landed.delivered)}</b> <span class="muted">(${d.landed.premium_pct}% premium ${money(d.landed.premium)} + freight est. ${money(d.landed.freight)}, ${d.landed.miles.toLocaleString()} mi${d.landed.precision === 'rough' ? ', rough' : ''})</span></div>` : ''}
    ${(d.buyer_landed && d.buyer_landed.length) ? `<div class="landed small"><b>Delivered to your buyers</b>${d.buyer_landed.map(b => `<br>${esc(b.company)} (${esc(b.to)}): <b>~${money(b.delivered)}</b> <span class="muted">freight est. ${money(b.freight)}, ${b.miles.toLocaleString()} mi${b.precision === 'rough' ? ', rough' : ''}</span>`).join('')}</div>` : ''}
    <div class="meta">${saleTag}<span>${esc(where)}</span>${d.year ? `<span>${d.year}</span>` : ''}${d.hours ? `<span>${Number(d.hours).toLocaleString()} hrs</span>` : ''}<span>${esc(srcName(d.source))}${d.also_on && d.also_on.length ? ' · also on ' + d.also_on.map(srcName).map(esc).join(', ') : ''}</span></div>
    <div class="actions">${actions}</div>
  </div>`;
}

// Staff only: hide a wrong match ("dental chair" under swivel) everywhere.
async function blockListing(listingId, btn) {
  if (!confirm('Hide this listing from IronScout? It will stop counting toward market values and deals.')) return;
  try {
    await api(`/api/broker/listings/${listingId}/block`, { method: 'POST', body: {} });
    const card = btn && btn.closest('.card'); if (card) card.remove();
  } catch (e) { alert(e.message); }
}
const blockBtn = (listingId) => window.CAN_HIDE && listingId ? `<button onclick="blockListing('${listingId}', this)" title="Wrong kind of machine">Not this machine</button>` : '';

// ---- broker actions (used by broker.html; the page defines reloadDeals()) ----
async function brokerAct(id, action, body) {
  try { await api(`/api/broker/deals/${id}/${action}`, { method: 'POST', body: body || {} }); if (typeof reloadDeals === 'function') reloadDeals(); }
  catch (e) { alert(e.message); }
}
async function brokerClaim(id) {
  const card = document.getElementById('deal-' + id);
  const names = card ? [...card.querySelectorAll('.buyers b')] : [];
  let buyer_id = null;
  if (window.lastDeals) {
    const d = window.lastDeals.find(x => x.id === id);
    if (d && d.buyers && d.buyers.length) {
      const pick = prompt('Claim for which buyer? Type a number:\n' + d.buyers.map((b, i) => `${i + 1}. ${b.company}${b.contact ? ' (' + b.contact + ')' : ''}`).join('\n') + '\n0. no specific buyer', '1');
      if (pick === null) return;
      const n = Number(pick); if (n >= 1 && n <= d.buyers.length) buyer_id = d.buyers[n - 1].id;
    }
  }
  try {
    await api(`/api/broker/deals/${id}/claim`, { method: 'POST', body: { buyer_id } });
  } catch (e) {
    if (!/already claimed/i.test(e.message)) { alert(e.message); return; }
    if (!confirm(e.message + ' Claim it for your buyer anyway?')) return;
    try { await api(`/api/broker/deals/${id}/claim`, { method: 'POST', body: { buyer_id, confirm: true } }); } catch (e2) { alert(e2.message); return; }
  }
  if (typeof reloadDeals === 'function') reloadDeals();

}
async function brokerSold(id) {
  const p = prompt('Sale price ($)?'); if (!p) return;
  return brokerAct(id, 'sold', { salePrice: Number(String(p).replace(/[^0-9.]/g, '')) });
}
