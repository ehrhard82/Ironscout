// Tiny offline geocoder + distance. No API keys, no network.
//
// Resolution order for a place: exact lat/long if the source gave one -> known city ->
// state center. Accuracy is "good enough to estimate freight", not for directions.
// Add cities to CITIES as you go (name is lowercased "city|ST").

const STATE_CENTER = {
  AL: [32.8, -86.8], AK: [64.2, -149.5], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [36.8, -119.4], CO: [39.0, -105.5],
  CT: [41.6, -72.7], DE: [39.0, -75.5], DC: [38.9, -77.0], FL: [28.6, -82.4], GA: [32.7, -83.4], HI: [20.8, -156.3],
  ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3],
  LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3],
  MS: [32.7, -89.7], MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6],
  NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8],
  OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9], SD: [44.4, -100.2],
  TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5],
  WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43.0, -107.5],
};

// "city|ST": [lat, lon]  — oilfield / ag / construction country first, then major metros.
const CITIES = {
  // Texas
  'midland|TX': [31.997, -102.078], 'odessa|TX': [31.846, -102.368], 'big spring|TX': [32.250, -101.479], 'andrews|TX': [32.319, -102.546],
  'pecos|TX': [31.423, -103.493], 'monahans|TX': [31.594, -102.892], 'fort stockton|TX': [30.894, -102.879], 'carlsbad|NM': [32.421, -104.229],
  'hobbs|NM': [32.703, -103.136], 'artesia|NM': [32.842, -104.403], 'lovington|NM': [32.944, -103.349], 'roswell|NM': [33.394, -104.523],
  'lubbock|TX': [33.578, -101.855], 'levelland|TX': [33.587, -102.378], 'brownfield|TX': [33.181, -102.274], 'lamesa|TX': [32.738, -101.951], 'post|TX': [33.191, -101.379], 'plains|TX': [33.189, -102.828], 'denver city|TX': [32.965, -102.829], 'amarillo|TX': [35.222, -101.831], 'abilene|TX': [32.449, -99.733], 'san angelo|TX': [31.464, -100.437],
  'el paso|TX': [31.762, -106.485], 'laredo|TX': [27.506, -99.507], 'corpus christi|TX': [27.801, -97.396], 'victoria|TX': [28.805, -97.004],
  'san antonio|TX': [29.424, -98.494], 'austin|TX': [30.267, -97.743], 'houston|TX': [29.760, -95.370], 'dallas|TX': [32.777, -96.797],
  'fort worth|TX': [32.755, -97.331], 'waco|TX': [31.549, -97.147], 'tyler|TX': [32.351, -95.301], 'longview|TX': [32.500, -94.740],
  'beaumont|TX': [30.080, -94.127], 'kilgore|TX': [32.386, -94.876], 'wichita falls|TX': [33.914, -98.493], 'temple|TX': [31.098, -97.343],
  'bryan|TX': [30.674, -96.370], 'college station|TX': [30.628, -96.334], 'conroe|TX': [30.312, -95.456], 'katy|TX': [29.786, -95.824],
  'pleasanton|TX': [28.967, -98.479], 'cotulla|TX': [28.437, -99.235], 'carrizo springs|TX': [28.522, -99.861], 'kenedy|TX': [28.819, -97.849],
  'george west|TX': [28.332, -98.118], 'alice|TX': [27.752, -98.070], 'kermit|TX': [31.857, -103.093], 'seminole|TX': [32.719, -102.645],
  'snyder|TX': [32.718, -100.918], 'sweetwater|TX': [32.471, -100.406], 'brownwood|TX': [31.709, -98.991], 'stephenville|TX': [32.221, -98.202],
  'granbury|TX': [32.442, -97.794], 'decatur|TX': [33.234, -97.586], 'denton|TX': [33.215, -97.133], 'sherman|TX': [33.636, -96.609],
  'texarkana|TX': [33.425, -94.048], 'lufkin|TX': [31.338, -94.729], 'nacogdoches|TX': [31.603, -94.655], 'huntsville|TX': [30.723, -95.551],
  'brownsville|TX': [25.902, -97.497], 'mcallen|TX': [26.203, -98.230], 'harlingen|TX': [26.191, -97.696], 'del rio|TX': [29.363, -100.897],
  'plainview|TX': [34.185, -101.707], 'pampa|TX': [35.536, -100.960], 'borger|TX': [35.668, -101.397], 'dumas|TX': [35.865, -101.973],
  // Oklahoma
  'oklahoma city|OK': [35.468, -97.516], 'tulsa|OK': [36.154, -95.993], 'enid|OK': [36.396, -97.878], 'elk city|OK': [35.412, -99.404],
  'weatherford|OK': [35.526, -98.708], 'woodward|OK': [36.434, -99.390], 'lawton|OK': [34.609, -98.390], 'duncan|OK': [34.502, -97.958],
  'ardmore|OK': [34.174, -97.144], 'norman|OK': [35.222, -97.439], 'stillwater|OK': [36.116, -97.059], 'kingfisher|OK': [35.861, -97.932],
  'chickasha|OK': [35.053, -97.937], 'ada|OK': [34.775, -96.678], 'mcalester|OK': [34.933, -95.770], 'muskogee|OK': [35.748, -95.368],
  'guymon|OK': [36.683, -101.482], 'alva|OK': [36.805, -98.667], 'clinton|OK': [35.516, -98.967], 'shawnee|OK': [35.327, -96.925],
  // Louisiana / Mississippi / Arkansas
  'lafayette|LA': [30.224, -92.020], 'houma|LA': [29.596, -90.720], 'lake charles|LA': [30.213, -93.217], 'shreveport|LA': [32.525, -93.750],
  'new orleans|LA': [29.951, -90.072], 'baton rouge|LA': [30.451, -91.187], 'monroe|LA': [32.510, -92.119], 'alexandria|LA': [31.311, -92.445],
  'new iberia|LA': [30.004, -91.819], 'morgan city|LA': [29.700, -91.207], 'broussard|LA': [30.147, -91.961], 'jackson|MS': [32.299, -90.185],
  'hattiesburg|MS': [31.327, -89.290], 'laurel|MS': [31.694, -89.131], 'little rock|AR': [34.746, -92.290], 'fort smith|AR': [35.386, -94.399],
  'el dorado|AR': [33.208, -92.666],
  // New Mexico / Colorado / Wyoming / Utah
  'albuquerque|NM': [35.085, -106.651], 'farmington|NM': [36.728, -108.219], 'las cruces|NM': [32.320, -106.764], 'santa fe|NM': [35.687, -105.938],
  'denver|CO': [39.739, -104.990], 'greeley|CO': [40.423, -104.709], 'grand junction|CO': [39.064, -108.550], 'colorado springs|CO': [38.834, -104.821],
  'pueblo|CO': [38.254, -104.609], 'fort collins|CO': [40.585, -105.084], 'casper|WY': [42.867, -106.313], 'cheyenne|WY': [41.140, -104.820],
  'gillette|WY': [44.291, -105.502], 'rock springs|WY': [41.587, -109.203], 'evanston|WY': [41.268, -110.963], 'douglas|WY': [42.760, -105.382],
  'vernal|UT': [40.456, -109.529], 'salt lake city|UT': [40.761, -111.891], 'price|UT': [39.600, -110.811],
  // Dakotas / Montana / plains
  'williston|ND': [48.147, -103.618], 'dickinson|ND': [46.879, -102.790], 'minot|ND': [48.233, -101.296], 'bismarck|ND': [46.808, -100.784],
  'fargo|ND': [46.877, -96.790], 'watford city|ND': [47.802, -103.283], 'tioga|ND': [48.397, -102.938], 'sidney|MT': [47.717, -104.156],
  'billings|MT': [45.783, -108.506], 'great falls|MT': [47.506, -111.300], 'rapid city|SD': [44.081, -103.231], 'sioux falls|SD': [43.546, -96.731],
  'omaha|NE': [41.257, -95.935], 'lincoln|NE': [40.814, -96.703], 'north platte|NE': [41.124, -100.766], 'wichita|KS': [37.687, -97.330],
  'kansas city|KS': [39.114, -94.627], 'kansas city|MO': [39.100, -94.578], 'garden city|KS': [37.972, -100.873], 'liberal|KS': [37.043, -100.921],
  'hays|KS': [38.879, -99.327], 'dodge city|KS': [37.753, -100.017], 'des moines|IA': [41.587, -93.625], 'cedar rapids|IA': [41.978, -91.666],
  'minneapolis|MN': [44.978, -93.265], 'st paul|MN': [44.954, -93.090], 'duluth|MN': [46.787, -92.100],
  // Appalachia / Marcellus
  'pittsburgh|PA': [40.441, -79.996], 'williamsport|PA': [41.241, -77.001], 'washington|PA': [40.174, -80.246], 'harrisburg|PA': [40.273, -76.886],
  'philadelphia|PA': [39.953, -75.165], 'scranton|PA': [41.409, -75.663], 'erie|PA': [42.129, -80.085], 'morgantown|WV': [39.630, -79.956],
  'charleston|WV': [38.350, -81.633], 'clarksburg|WV': [39.281, -80.345], 'wheeling|WV': [40.064, -80.721], 'canton|OH': [40.799, -81.379],
  'columbus|OH': [39.961, -82.999], 'cleveland|OH': [41.499, -81.694], 'cincinnati|OH': [39.103, -84.512], 'toledo|OH': [41.654, -83.536],
  'youngstown|OH': [41.100, -80.650], 'zanesville|OH': [39.940, -82.013],
  // Southeast
  'atlanta|GA': [33.749, -84.388], 'savannah|GA': [32.081, -81.091], 'macon|GA': [32.841, -83.632], 'birmingham|AL': [33.519, -86.810],
  'mobile|AL': [30.695, -88.040], 'huntsville|AL': [34.730, -86.586], 'montgomery|AL': [32.367, -86.300], 'nashville|TN': [36.163, -86.782],
  'memphis|TN': [35.150, -90.049], 'knoxville|TN': [35.961, -83.921], 'chattanooga|TN': [35.046, -85.310], 'charlotte|NC': [35.227, -80.843],
  'raleigh|NC': [35.780, -78.639], 'greensboro|NC': [36.073, -79.792], 'columbia|SC': [34.001, -81.035], 'greenville|SC': [34.852, -82.394],
  'charleston|SC': [32.776, -79.931], 'jacksonville|FL': [30.332, -81.656], 'orlando|FL': [28.538, -81.379], 'tampa|FL': [27.951, -82.457],
  'miami|FL': [25.762, -80.192], 'fort myers|FL': [26.641, -81.861], 'tallahassee|FL': [30.438, -84.281], 'ocala|FL': [29.187, -82.140],
  'louisville|KY': [38.253, -85.758], 'lexington|KY': [38.040, -84.504], 'richmond|VA': [37.541, -77.436], 'norfolk|VA': [36.851, -76.286],
  'roanoke|VA': [37.271, -79.942],
  // Midwest
  'chicago|IL': [41.878, -87.630], 'peoria|IL': [40.694, -89.589], 'springfield|IL': [39.781, -89.650], 'rockford|IL': [42.271, -89.094],
  'indianapolis|IN': [39.768, -86.158], 'fort wayne|IN': [41.079, -85.139], 'evansville|IN': [37.971, -87.571], 'detroit|MI': [42.331, -83.046],
  'grand rapids|MI': [42.963, -85.668], 'lansing|MI': [42.733, -84.556], 'milwaukee|WI': [43.039, -87.906], 'madison|WI': [43.073, -89.401],
  'green bay|WI': [44.519, -88.020], 'st louis|MO': [38.627, -90.199], 'springfield|MO': [37.209, -93.292], 'joplin|MO': [37.084, -94.513],
  // West
  'phoenix|AZ': [33.448, -112.074], 'tucson|AZ': [32.222, -110.975], 'flagstaff|AZ': [35.198, -111.651], 'yuma|AZ': [32.692, -114.627],
  'las vegas|NV': [36.172, -115.140], 'reno|NV': [39.530, -119.814], 'elko|NV': [40.833, -115.763], 'los angeles|CA': [34.052, -118.244],
  'bakersfield|CA': [35.373, -119.019], 'fresno|CA': [36.738, -119.785], 'sacramento|CA': [38.582, -121.494], 'san diego|CA': [32.716, -117.161],
  'san jose|CA': [37.339, -121.895], 'san francisco|CA': [37.775, -122.419], 'oakland|CA': [37.804, -122.271], 'stockton|CA': [37.958, -121.291],
  'redding|CA': [40.587, -122.392], 'riverside|CA': [33.953, -117.396], 'fontana|CA': [34.092, -117.435], 'ontario|CA': [34.064, -117.651],
  'portland|OR': [45.515, -122.679], 'eugene|OR': [44.052, -123.087], 'medford|OR': [42.327, -122.876], 'bend|OR': [44.058, -121.315],
  'seattle|WA': [47.606, -122.332], 'tacoma|WA': [47.253, -122.444], 'spokane|WA': [47.659, -117.425], 'yakima|WA': [46.602, -120.506],
  'boise|ID': [43.615, -116.202], 'idaho falls|ID': [43.492, -112.034], 'twin falls|ID': [42.563, -114.461], 'pocatello|ID': [42.871, -112.445],
  'anchorage|AK': [61.218, -149.900], 'fairbanks|AK': [64.838, -147.716], 'honolulu|HI': [21.307, -157.858],
  // Northeast
  'new york|NY': [40.713, -74.006], 'staten island|NY': [40.579, -74.150], 'brooklyn|NY': [40.678, -73.944], 'bronx|NY': [40.845, -73.865],
  'queens|NY': [40.728, -73.795], 'buffalo|NY': [42.887, -78.879], 'rochester|NY': [43.157, -77.615], 'syracuse|NY': [43.048, -76.148],
  'albany|NY': [42.653, -73.757], 'long island|NY': [40.789, -73.135], 'newark|NJ': [40.736, -74.172], 'trenton|NJ': [40.217, -74.743],
  'boston|MA': [42.360, -71.059], 'worcester|MA': [42.263, -71.802], 'springfield|MA': [42.101, -72.590], 'hartford|CT': [41.766, -72.673],
  'providence|RI': [41.824, -71.413], 'manchester|NH': [42.996, -71.455], 'portland|ME': [43.661, -70.255], 'burlington|VT': [44.476, -73.212],
  'baltimore|MD': [39.290, -76.612], 'washington|DC': [38.907, -77.037], 'wilmington|DE': [39.746, -75.547], 'dover|DE': [39.158, -75.524],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Returns { lat, lon, precision: 'exact'|'city'|'state' } or null. */
function locate({ latitude, longitude, city, state } = {}) {
  const lat = Number(latitude), lon = Number(longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) return { lat, lon, precision: 'exact' };
  const st = String(state || '').toUpperCase();
  const c = norm(city);
  if (c && st && CITIES[`${c}|${st}`]) { const [a, b] = CITIES[`${c}|${st}`]; return { lat: a, lon: b, precision: 'city' }; }
  if (c && st) {                                   // "North Houston" -> "houston"
    for (const [k, v] of Object.entries(CITIES)) { const [name, s] = k.split('|'); if (s === st && (c.includes(name) || name.includes(c))) return { lat: v[0], lon: v[1], precision: 'city' }; }
  }
  if (st && STATE_CENTER[st]) { const [a, b] = STATE_CENTER[st]; return { lat: a, lon: b, precision: 'state' }; }
  return null;
}

/** Great-circle miles. */
function milesBetween(a, b) {
  const R = 3958.8, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Road miles ≈ straight line × 1.2 (typical US highway detour factor). */
const roadMiles = (a, b) => Math.round(milesBetween(a, b) * 1.2);

module.exports = { locate, milesBetween, roadMiles, CITIES, STATE_CENTER };
