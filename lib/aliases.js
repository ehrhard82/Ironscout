// One machine, one name. "drill rig", "drilling rigs" and "Bobcat skid steer" should all open the
// machine we already track instead of spawning a new one (each new machine is a daily Apify bill
// and splits the sold-price data). Used by the search box and by "track this machine".
const pool = require('./db');

const BRANDS = /\b(bobcat|cat|caterpillar|case|deere|john deere|komatsu|volvo|kubota|jcb|hitachi|doosan|hyundai|liebherr|takeuchi|kenworth|peterbilt|freightliner|mack|international|western star|ford|chevy|dodge|ram)\b/g;
const ALIASES = {
  'drill rig': 'drilling rig', 'driller': 'drilling rig', 'rotary rig': 'drilling rig',
  'frac machine': 'frac pump', 'frac pumper': 'frac pump', 'fracturing pump': 'frac pump', 'frac unit': 'frac pump', 'pressure pumping unit': 'frac pump',
  'vac truck': 'vacuum truck', 'vacuum tank truck': 'vacuum truck', 'vac tank': 'vacuum truck',
  'trackhoe': 'excavator', 'track hoe': 'excavator', 'bulldozer': 'dozer', 'crawler dozer': 'dozer',
  'front end loader': 'wheel loader', 'rubber tire loader': 'wheel loader', 'loader': 'wheel loader', 'wheel loaders': 'wheel loader',
  'skidsteer': 'skid steer', 'skid loader': 'skid steer', 'skid steer loader': 'skid steer', 'compact track loader': 'skid steer', 'track loader': 'skid steer',
  'workover rig': 'well service rig', 'pulling unit': 'well service rig', 'service rig': 'well service rig', 'well servicing rig': 'well service rig',
  'semi': 'semi truck', 'truck tractor': 'semi truck', 'road tractor': 'semi truck', 'day cab': 'semi truck', 'sleeper truck': 'semi truck',
  'hot oiler': 'hot oil truck', 'hot oil unit': 'hot oil truck',
  'bed truck': 'winch truck', 'gin pole truck': 'winch truck', 'rig up truck': 'winch truck', 'oilfield bed truck': 'winch truck', 'winch tractor': 'winch truck',
  'coiled tubing unit': 'coil tubing unit', 'coil tubing': 'coil tubing unit', 'ctu': 'coil tubing unit',
  'nitrogen pump': 'nitrogen unit', 'n2 unit': 'nitrogen unit', 'nitrogen truck': 'nitrogen unit',
  'cement pump truck': 'cementing pump truck', 'cement truck': 'cementing pump truck', 'cementer': 'cementing unit',
  'blowout preventer': 'bop', 'blow out preventer': 'bop',
  'grader': 'motor grader', 'road grader': 'motor grader', 'backhoe loader': 'backhoe', 'loader backhoe': 'backhoe',
  'telescopic handler': 'telehandler', 'reach forklift': 'telehandler', 'fork lift': 'forklift', 'lift truck': 'forklift',
  'manlift': 'boom lift', 'man lift': 'boom lift', 'aerial lift': 'boom lift', 'genset': 'generator', 'gen set': 'generator',
  'lowboy': 'lowboy trailer', 'low boy trailer': 'lowboy trailer', 'water tanker': 'water truck', 'tanker truck': 'water truck',
  'kill pump truck': 'kill truck', 'power swivels': 'power swivel',
};

// Specs people type with the machine: "180k", "2500hp", "2016", "T800", "5000 gal", "3 axle". Peeled off the
// machine name and kept as a narrowing filter on titles.
const SPEC = /\b(\d{2,4}(?:,\d{3})?\s?(?:k|hp|gal|gallon|bbl|ton|hr|hrs|psi|yd|ft|axle)s?\b|\d{2,3}k\b|(?:19|20)\d{2}\b|[a-z]{1,2}\d{3,4}[a-z]{0,2}\b|\d{3,5}\b)/g;
function splitSpec(q) {
  const raw = String(q || '').toLowerCase().replace(/(\d),(\d{3})(?=\D|$)/g, '$1$2').replace(/[^a-z0-9 ]+/g, ' ');
  const specs = (raw.match(SPEC) || []).map(x => x.replace(/,/g, '').trim()).filter(Boolean);
  const name = raw.replace(SPEC, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return { name, specs };
}
function normalize(q) {
  let s = String(q || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(BRANDS, ' ').replace(/\s+/g, ' ').trim();           // "bobcat skid steer" -> "skid steer"
  if (ALIASES[s]) return ALIASES[s];
  const singular = s.replace(/(trucks|rigs|units|loaders|pumps|steers|excavators|dozers|graders|swivels|trailers|lifts|handlers|forklifts|generators)\b/, m => m.slice(0, -1));
  if (ALIASES[singular]) return ALIASES[singular];
  return singular || s;
}

/** The tracked machine this text means, if we already track one; otherwise the normalized name to create. */
async function resolve(q) {
  const name = normalize(q);
  if (!name) return { name: '', product: null };
  const exact = await pool.query('SELECT id, name FROM products WHERE name = $1 OR name = $2 LIMIT 1', [name, String(q || '').trim().toLowerCase()]);
  if (exact.rows.length) return { name: exact.rows[0].name, product: exact.rows[0] };
  // "drilling rigs" typed, "drilling rig" tracked: any alias of a tracked name counts too
  for (const [alias, canon] of Object.entries(ALIASES)) {
    if (alias === name) { const r = await pool.query('SELECT id, name FROM products WHERE name = $1', [canon]); if (r.rows.length) return { name: canon, product: r.rows[0] }; }
  }
  return { name, product: null };
}

module.exports = { normalize, resolve, splitSpec, ALIASES };
