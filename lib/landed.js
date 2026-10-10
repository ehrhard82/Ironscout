// Landed cost: what a machine actually costs sitting in the buyer's yard.
//
//   hammer price
// + buyer's premium (per auction house; env BUYER_PREMIUM_<SOURCE> overrides)
// + freight to the yard (weight class × road miles, plus permits/escort for oversize)
// = delivered cost          -> profit after delivery = market value − delivered cost
//
// Freight numbers are ESTIMATES from typical 2025-26 heavy-haul rates and are labeled as
// such everywhere they appear; a hauler's quote replaces them. Tune via env:
//   FREIGHT_RATE_LIGHT / MEDIUM / HEAVY / OVERSIZE   $ per loaded mile
//   FREIGHT_MIN                                      minimum charge
//   FREIGHT_PERMITS_OVERSIZE                         flat permits + pilot car allowance
const { locate, roadMiles } = require('./geo');

const n = (k, d) => Number(process.env[k] || d);

// Default buyer's premiums by source (percent). GovDeals varies by seller; IronPlanet and
// Ritchie Bros publish schedules. Override with BUYER_PREMIUM_GOVDEALS=12.5 etc.
const PREMIUM = { govdeals: 12.5, ironplanet: 10, rbauction: 10, machinio: 0, ebay: 0, craigslist: 0 };
function premiumPct(source) {
  const env = process.env[`BUYER_PREMIUM_${String(source || '').toUpperCase()}`];
  if (env !== undefined && env !== '') return Number(env);
  if (source in PREMIUM) return PREMIUM[source];
  return n('BUYER_PREMIUM_PERCENT', 12);
}

// Weight class by what the machine is. "truck" = drives itself (driver + fuel, cheaper).
const CLASSES = [
  { re: /mini excavator|skid steer|compact track|utv|atv|dirt bike|motorcycle|forklift|generator|light tower|welder|compressor|trailer\b/, cls: 'light' },
  { re: /semi|truck tractor|sleeper|day cab|winch truck|rig truck|vacuum truck|water truck|kill truck|hot oil|dump truck|service truck|mechanic truck|pickup|boom truck|crane truck|bucket truck|fuel truck|\btruck\b/, cls: 'truck' },
  { re: /frac pump|frac(?:turing)? unit|drilling rig|workover rig|pulling unit|coil(?:ed)? tubing|cement(?:ing)? unit|nitrogen unit|mud pump|top drive|crane\b|d8|d9|d10|d11|988|990|992|994|980|982|350|374|390|excavator 3[5-9]\d|rock truck|haul truck|articulated/, cls: 'oversize' },
  { re: /wheel loader|front end loader|loader|dozer|bulldozer|excavator|backhoe|motor grader|grader|scraper|compactor|roller|drill rig|telehandler|reach forklift|paver|milling/, cls: 'medium' },
];
function weightClass(title = '', product = '') {
  const t = `${title} ${product}`.toLowerCase();
  for (const c of CLASSES) if (c.re.test(t)) return c.cls;
  return 'medium';
}

// $ per loaded mile and extras, by class.
function freight(cls, miles) {
  const rate = { light: n('FREIGHT_RATE_LIGHT', 2.75), truck: n('FREIGHT_RATE_TRUCK', 2.0), medium: n('FREIGHT_RATE_MEDIUM', 4.25), oversize: n('FREIGHT_RATE_OVERSIZE', 6.0) }[cls];
  const base = Math.max(n('FREIGHT_MIN', 650), miles * rate);
  const permits = cls === 'oversize' ? n('FREIGHT_PERMITS_OVERSIZE', 1400) : cls === 'medium' && miles > 300 ? n('FREIGHT_PERMITS_MEDIUM', 350) : 0;
  return Math.round((base + permits) / 50) * 50;
}

/**
 * deal: { price, market_price, source, title, product, latitude, longitude, city, state }
 * yard: { city, state, latitude?, longitude?, label? }
 * Returns null when either end can't be located at all.
 */
function landedCost(deal, yard) {
  if (!yard) return null;
  const from = locate(deal), to = locate(yard);
  if (!from || !to) return null;
  const miles = roadMiles(from, to);
  const cls = weightClass(deal.title, deal.product);
  const price = Number(deal.price), market = Number(deal.market_price);
  const pct = premiumPct(deal.source);
  const premium = Math.round(price * pct / 100);
  const fr = freight(cls, miles);
  const delivered = price + premium + fr;
  return {
    to: yard.label || [yard.city, yard.state].filter(Boolean).join(', '),
    miles, precision: from.precision === 'state' || to.precision === 'state' ? 'rough' : 'ok',
    weight_class: cls, premium_pct: pct, premium, freight: fr, delivered,
    profit_after_delivery: Number.isFinite(market) ? Math.round(market - delivered) : null,
  };
}

module.exports = { landedCost, weightClass, premiumPct, freight };

/**
 * Attach `landed` to each deal for this user. Yard priority: the user's own yard from
 * Settings; otherwise (staff only) the first matched buyer's location, labeled with the
 * buyer's name. Deals that can't be located get landed = null.
 */
function attachLanded(deals, user) {
  const yard = user && user.yard_state ? { city: user.yard_city, state: user.yard_state, label: `your yard (${[user.yard_city, user.yard_state].filter(Boolean).join(', ')})` } : null;
  for (const d of deals) {
    let y = yard;
    if (!y && Array.isArray(d.buyers) && d.buyers.length && d.buyers[0].state) {
      const b = d.buyers[0];
      y = { city: b.city, state: b.state, label: `${b.company}${b.city ? ' (' + b.city + ', ' + b.state + ')' : ''}` };
    }
    d.landed = y ? landedCost(d, y) : null;
  }
  return deals;
}
module.exports.attachLanded = attachLanded;
