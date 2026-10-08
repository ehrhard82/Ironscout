# IronScout

Finds listings for big-ticket equipment — semi trucks, wheel loaders, dozers,
rig-up and winch trucks, frac pumps, drilling rigs — works out what the market
is actually paying for that *year* of machine in that *state*, and surfaces the
ones priced far enough below it that there's real money in buying and reselling.
Comes with a broker workflow (claim → sold → commission) and a web viewer.

It is deliberately product-agnostic: "dirt bike" and "used car" go through the
same pipeline. The dollar-margin floor just means a $300 saving on a bike never
shows up as a deal, while $20k off a $400k loader does.

## What a user sees

1. **Log in, type a machine** ("wheel loader"). One page shows the US median, the
   typical price range, how many listings we track, and every listing priced under
   market that clears the user's own settings — with a Save button and a link to
   the listing.
2. **Settings** (one page): tick the machines to be alerted about; states; "at least
   X% below market"; "at least $Y margin"; email, text, or both; as-found / hourly /
   daily / weekly. Request a machine we don't track yet.
3. **Alerts** arrive on that schedule, never repeating a deal.

Roles: **admin** (you — `/admin.html`: fetch, approve requests, manage users),
**broker** (deals + the claim / sold / commission board at `/?view=broker`), and
**subscriber** (needs an active Stripe subscription; 7-day trial by default).
The **first account created becomes admin.**

## 5-minute local setup

Requirements: Node 18+, PostgreSQL 12+ (or a free Neon database — see DEPLOY.md).

```bash
npm install
cp .env.example .env          # set DB_PASSWORD (or DATABASE_URL); leave the rest blank for now
npm run db:init               # creates the database + tables
npm start                     # http://localhost:3000
```

Open it, sign up (you're admin), go to `/admin.html`, type `wheel loader`, click
**Fetch now**. Sample data loads; the front page shows deals. Emails and texts print
to the terminal until you add provider keys.

To track more machines from the command line:

```bash
npm run ingest -- "drilling rig" "dozer"
```

**Deploying for real** — including a $0/month path — is in `DEPLOY.md`.

## Getting real data

**eBay (recommended first step — free, reliable, legal).**
Sign up at https://developer.ebay.com → *Application Keys* → create a production
keyset. Put the Client ID / Client Secret in `.env` as `EBAY_CLIENT_ID` /
`EBAY_CLIENT_SECRET`. That's it; the next `npm run ingest` pulls live listings
(up to 200 per product per source per run). Free tier is 5,000 calls/day.

**Your broker's inventory / spreadsheets.**
Put rows in a CSV with columns `product,title,price` (plus optional
`condition,year,hours,city,state,zip,url,seller,description`) and run:

```bash
npm run import:csv -- data/example.csv
```

**GovDeals, IronPlanet, Ritchie Bros — the big-iron sources.** None has a
public API, but Apify (apify.com) hosts maintained scrapers for each that return
JSON over REST, priced ~$1.50–3 per 1,000 listings. Sign up, copy your API token
into `.env` as `APIFY_TOKEN`, and set `APIFY_SOURCES=govdeals,ironplanet,rbauction`.
That's it — `npm run ingest` pulls from them like any other source. See
`lib/sources/apify.js` to add more actors (MachineryTrader, TruckPaper, Purple
Wave scrapers exist there too). Eyeball the first run in the web viewer: actor
field names drift, and the mapper is tolerant but not psychic.

**Craigslist.** No API; scraping is best-effort and may get blocked. Set
`CRAIGSLIST_LIVE=true` and `CRAIGSLIST_CITIES=dallas,houston,...` to try it. For
anything serious use a scraping proxy service.

**Adding another source (IronPlanet, MachineryTrader, Facebook, a dealer feed…).**
Create `lib/sources/<name>.js` exporting `{ name, fetch(searchTerm) }` that
returns an array of listing objects (see the shape in `lib/listings.js`), and add
it to `lib/sources/index.js`. Nothing else changes.

## How a deal is decided

`lib/pricing.js`, rerun after every ingest. The question it answers is "could
someone buy this and resell it at a profit?", so it works in dollars of margin,
not just percent.

1. **Comparables are year-matched.** For a listing with a known model year, the
   engine looks for at least `MIN_SAMPLE_SIZE` other listings of the same product
   within ±`YEAR_BAND` years — same state first, then nationwide. If there aren't
   enough it widens the band (±6, ±9) before it ever compares across all years.
   A 2010 unit measured against a median full of 2021s looks like a bargain and
   isn't; if the engine is forced into that comparison it says so in
   `compared_to` and halves the score.
2. **Market price = the median** of that group (robust to "$1 call for price"
   junk; listings under `MIN_VALID_PRICE` are dropped entirely, as are titles
   containing a product's `exclude_terms` — parts, toys, manuals, decals).
3. `discount_amount = market − price`
   `estimated_margin = discount_amount − price × TRANSACTION_COST_PERCENT`
   (a rough allowance for transport, auction/buyer fees, and your time).
4. **It's a deal if** `discount ≥ DEAL_THRESHOLD_PERCENT` **and**
   `estimated_margin ≥ MIN_DEAL_DOLLARS`. Defaults: 5% and $2,500.
5. **deal_score (0–10)** blends discount depth (45%) with dollars on the table
   (55%, log-scaled so $20k ≫ $2k but $500k isn't 25× better than $20k), then
   scales by how much data backs the comparison. Scores are modest while a
   product has only a dozen listings and rise as the pool grows — that's
   intentional.

Every deal records exactly what it was compared to, e.g.
`TX 2013-2019 median (n=14)`, so the broker can sanity-check it in one glance.

Listings not seen for 14 days are marked inactive (probably sold). Price drops
are recorded in `price_history`. Deals are rebuilt from scratch each run so stale
ones vanish; claimed / sold / passed ones are kept.

Tune in `.env`: `DEAL_THRESHOLD_PERCENT`, `MIN_DEAL_DOLLARS`,
`TRANSACTION_COST_PERCENT`, `YEAR_BAND`, `MIN_SAMPLE_SIZE`, `MIN_VALID_PRICE`.
Per-product exclude words live in `products.exclude_terms`.

## Where $100k–$1M listings actually live (sourcing roadmap)

eBay is wired up first because it's free, legal, has an API, and is a fine
proving ground — but it is **not** where the volume of big iron trades. Add
sources in roughly this order; each is one file in `lib/sources/`:

| Source | What's there | Access | Notes |
|---|---|---|---|
| **GovDeals / GovPlanet / Public Surplus** | Government & municipal surplus: dump trucks, loaders, graders, fire apparatus, fleet semis | Public pages, RSS on some | Often the single best source of *under*-market heavy equipment because sellers are mandated to liquidate, not maximize. Start here after eBay. |
| **Ritchie Bros / IronPlanet / Marketplace-E** | The largest heavy-equipment auction house; oilfield equipment auctions in Odessa, Fort Worth, Houston | Public listings; a partner API exists for approved integrators | Auction results are also the best *market price* data in the industry — worth storing even when you don't buy. |
| **MachineryTrader / TruckPaper** (Sandhills) | The de-facto classifieds for construction equipment and commercial trucks | No public API; scraping is against ToS | Treat like Craigslist: best-effort, proxy service, expect maintenance. |
| **Purple Wave, BigIron, Proxibid** | Regional online auctions, ag + construction + trucks, strong in the Plains states | Public pages | Good for OK/KS/ND/TX inventory. |
| **Commercial Truck Trader / Equipment Trader** | Dealer-heavy classifieds | Public pages | |
| **Oilfield-specific:** Kraken Oilfield Equipment, Oilfield Surplus, Energy Equipment auctions (e.g. Kruse) | Rigs, frac pumps, mud pumps, rig-up trucks | Public pages, small volume, high ticket | Your broker likely knows which of these he already watches — ask him. |
| **Broker CSV import** | His own inventory and what competitors quote him | `npm run import:csv` | Already works. |

Two things make big-iron sourcing different from consumer goods: (1) a lot of
it clears at **auction**, so "list price" is a hammer price with a date — store
`posted_date` carefully and consider adding `sale_type` (listing / auction) and
`auction_ends`; (2) **location drives price** because transport on a 60,000 lb
machine is $3–8/mile — the state-level comparison already helps, and a
zip→lat/long table + PostGIS radius query is the next step.

## Running it on a schedule

```bash
npm run schedule          # re-ingests all TRACKED_PRODUCTS daily at 6am (INGEST_CRON)
```

On a server, keep both processes alive with pm2:

```bash
npm i -g pm2
pm2 start server.js --name deals-api
pm2 start scripts/schedule.js --name deals-scheduler
pm2 save && pm2 startup
```

## API

| Method | Path | What |
|---|---|---|
| POST | `/api/auth/signup` `/login` `/logout` `/forgot` `/reset` `/password`; GET `/me` | Accounts |
| GET/PUT | `/api/settings` | States, % below, $ margin, channel (email/sms/both/none), frequency (realtime/hourly/daily/weekly), phone |
| GET/PUT/POST/DELETE | `/api/watchlists` | Machines the user watches; `GET /deals` = everything matching; `POST /request`; `/saved` |
| GET | `/api/lookup?q=wheel loader` | The front page: market stats + deals for one machine, filtered by the user's settings (`&all=1` to ignore them) |
| POST | `/api/billing/checkout` `/portal`; GET `/status`; POST `/webhook` (Stripe) | Subscriptions |
| GET | `/api/cron/ingest` `/alerts` `/ping` `?key=CRON_SECRET` | For an external scheduler (free hosting) |
| GET | `/api/deals?product=&states=TX,OK&minPrice=&maxPrice=&minMargin=&minScore=&status=open&sort=score` | Deals. `sort`: score, margin, discount, savings, price_low, newest. `status`: open, claimed, sold, all |
| GET | `/api/deals/:id` | One deal + market stats, price history, broker activity |
| GET | `/api/search?q=&product=&state=&minPrice=&maxPrice=&source=&sort=` | All active listings (deal info attached when present) |
| GET | `/api/products` | Tracked products with counts and US median |
| POST | `/api/products` `{name}` | Start tracking a product |
| GET | `/api/products/:id/market` | Per-state medians for a product |
| GET | `/api/broker/dashboard` | Open/claimed/sold counts, commission earned, recent activity |
| POST | `/api/broker/deals/:id/claim` | Broker is pursuing it |
| POST | `/api/broker/deals/:id/sold` `{salePrice}` | Records sale, computes commission at `COMMISSION_PERCENTAGE` |
| POST | `/api/broker/deals/:id/pass` | Not interested |
| POST | `/api/admin/ingest` `{product}` | Trigger an ingest from the UI (admin only — this costs Apify credit) |
| GET/POST/PATCH | `/api/admin/users` | Create accounts (e.g. the broker), change roles, comp a subscription |
| GET/POST | `/api/admin/requests`, `/:id/approve`, `/:id/reject` | Machines subscribers asked for |
| POST | `/api/admin/recalculate` | Rebuild deals without fetching |
| GET | `/api/admin/runs` | Last 50 ingest runs — spot a source that's gone quiet |
| GET | `/health` | DB check |

Everything above is what the web pages in `public/` call, so a mobile app later would use exactly these endpoints.

## Layout

```
server.js               Express app, serves /public and /api
lib/auth.js             passwords (scrypt), sessions, role guards
lib/alerts.js           email/SMS digests on each user's schedule
lib/mailer.js, lib/sms.js   Resend + Twilio over plain HTTP; print to console when unconfigured
routes/auth, settings, watchlists, lookup, billing, cron   the v4 additions
public/index.html       "type a machine" front page    public/account.html   settings
public/mine.html        all deals across my machines    public/admin.html     admin
public/login/signup/reset.html, terms.html, privacy.html
DEPLOY.md               free hosting path + VPS path
render.yaml             one-click Render blueprint
lib/db.js               shared Postgres pool
lib/pricing.js          the deal engine (read this one first)
lib/listings.js         upsert + dedup + price history + stale cleanup
lib/location.js         "Odessa, Texas 79762" -> {state:'TX', zip:'79762'}
lib/sources/            one file per data source; index.js is the registry
routes/                 deals, search, products, broker, admin
scripts/ingest.js       fetch all sources for product(s), then recalc
scripts/schedule.js     cron wrapper around ingest
scripts/importCsv.js    CSV -> listings
scripts/initDb.js       create DB + apply schema
database/schema.sql
public/index.html       the deal viewer
data/example.csv        sample broker inventory
```

## Known limits / what to build next

- **Location is state-level.** Good enough for "deals in TX/OK/LA". For true
  radius search, add a zip→lat/long table (free from the US Census) and PostGIS.
- **Hours/mileage aren't used in comparables yet.** Year is. A 2016 loader with
  2,000 hrs vs one with 9,000 hrs is a big price difference; next step is an
  hours band alongside the year band when the sample is big enough.
- **Product matching is by search term**, so "wheel loader" and "front end
  loader" are two products. Add a `aliases` column later, or just track both
  terms — the dedup key is (source, source_id) so a listing found twice is still
  stored once per product, not globally. Fine for now, worth fixing at scale.
- **"Real time" alerts are as real-time as the ingest schedule.** Daily ingest = daily
  alerts even for users who chose "as found." Run ingest hourly if you want hourly
  (costs more Apify credit); the cron setup in DEPLOY.md makes that one line.
- **Auction prices are current bids, not hammer prices.** An auction with four days
  left will look like a deal and may not be. Next: weight by time remaining and
  compare against *closed* auction results.
- **Alerts.** A tiny addition to `scripts/ingest.js`: after recalc, email/SMS
  any new deal with `deal_score >= 6`.

## Notes for whoever (or whatever) maintains this next

All business logic lives in `lib/`. Routes are thin SQL wrappers. Sources are
plug-ins. The schema is additive-friendly (`CREATE TABLE IF NOT EXISTS`), so to
add a column, add it to `schema.sql` *and* write an `ALTER TABLE … ADD COLUMN IF
NOT EXISTS` in a new `database/migrations/` file. `ingest_runs` is the first
place to look when something stops working.
