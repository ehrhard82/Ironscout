// Location helpers: normalize messy location strings into city / state / zip.

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const CODES = new Set(Object.values(STATES));

// Craigslist city subdomain -> state (extend as you add cities)
const CRAIGSLIST_CITY_STATE = {
  dallas: 'TX', houston: 'TX', austin: 'TX', sanantonio: 'TX', odessa: 'TX', midland: 'TX',
  oklahomacity: 'OK', tulsa: 'OK', denver: 'CO', phoenix: 'AZ', losangeles: 'CA',
  neworleans: 'LA', batonrouge: 'LA', lafayette: 'LA', fargo: 'ND', bismarck: 'ND',
  pittsburgh: 'PA', casper: 'WY', farmington: 'NM', albuquerque: 'NM',
};

/** Pull a 2-letter state out of free text like "Odessa, Texas" or "Midland TX 79701". */
function extractState(text = '') {
  const t = String(text).toLowerCase();
  for (const [name, code] of Object.entries(STATES)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) return code;
  }
  const m = String(text).match(/\b([A-Z]{2})\b/g);
  if (m) for (const c of m) if (CODES.has(c)) return c;
  return null;
}

function extractZip(text = '') {
  const m = String(text).match(/\b\d{5}\b/);
  return m ? m[0] : null;
}

/** Normalize {city,state,zip,raw} from whatever a source gives us. */
function normalizeLocation({ city, state, zip, raw } = {}) {
  const combined = [city, state, zip, raw].filter(Boolean).join(' ');
  return {
    city: city ? String(city).trim() : null,
    state: (state && CODES.has(String(state).toUpperCase()) ? String(state).toUpperCase() : null)
      || extractState(combined),
    zip_code: (zip && /^\d{5}$/.test(String(zip).trim())) ? String(zip).trim() : extractZip(combined),
  };
}

module.exports = { normalizeLocation, extractState, extractZip, CRAIGSLIST_CITY_STATE, STATE_CODES: CODES };
