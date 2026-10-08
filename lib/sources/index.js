// Registry of data sources. To add one: create lib/sources/<name>.js exporting
// { name, fetch(searchTerm) -> [listing, ...] } and add it here.
// Apify-hosted scrapers (GovDeals, IronPlanet, Ritchie Bros...) are enabled via
// APIFY_SOURCES in .env — see lib/sources/apify.js.
module.exports = [
  require('./ebay'),
  require('./craigslist'),
  ...require('./apify').enabledSources(),
];
