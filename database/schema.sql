-- IronScout schema
-- Run with: npm run db:init   (creates the database if needed, then applies this file)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Equipment types being tracked ("bobcat skid steer", "oil rig truck", ...)
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL UNIQUE,
  category    VARCHAR(100) NOT NULL DEFAULT 'heavy_equipment',
  description TEXT,
  -- titles containing any of these words are ignored (parts, toys, manuals...)
  exclude_terms TEXT[] NOT NULL DEFAULT ARRAY['parts','part','manual','decal','sticker','toy','diecast','die-cast','1:50','1/50','1:64','brochure','keychain','salvage title'],
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Every listing we've seen, from any source
CREATE TABLE IF NOT EXISTS listings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source        VARCHAR(50)  NOT NULL,          -- ebay | craigslist | csv | manual
  source_id     VARCHAR(255) NOT NULL,          -- id on the source site (dedup key)
  title         VARCHAR(500) NOT NULL,
  description   TEXT,
  price         NUMERIC(12,2) NOT NULL,
  currency      VARCHAR(3) DEFAULT 'USD',
  condition     VARCHAR(100),
  year          INTEGER,
  hours         INTEGER,                        -- machine hours, when known
  city          VARCHAR(100),
  state         VARCHAR(50),                    -- 2-letter where possible
  zip_code      VARCHAR(12),
  country       VARCHAR(2) DEFAULT 'US',
  latitude      NUMERIC(10,7),
  longitude     NUMERIC(10,7),
  url           TEXT,
  image_url     TEXT,
  seller_name   VARCHAR(255),
  sale_type     VARCHAR(20) DEFAULT 'listing',    -- listing | auction
  auction_ends  TIMESTAMP,                        -- for auctions: when bidding closes
  posted_date   TIMESTAMP,
  first_seen    TIMESTAMP DEFAULT NOW(),
  last_seen     TIMESTAMP DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  UNIQUE (source, source_id)
);

-- Completed sales (hammer prices). What a machine actually SOLD for is the real market;
-- asking prices and open bids are only a proxy. Filled by the weekly "sold" fetch.
CREATE TABLE IF NOT EXISTS sales (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source        VARCHAR(50)  NOT NULL,
  source_id     VARCHAR(255) NOT NULL,
  title         VARCHAR(500) NOT NULL,
  price         NUMERIC(12,2) NOT NULL,          -- final / hammer price
  year          INTEGER,
  hours         INTEGER,
  city          VARCHAR(100),
  state         VARCHAR(50),
  url           TEXT,
  sold_at       TIMESTAMP,
  first_seen    TIMESTAMP DEFAULT NOW(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_product ON sales(product_id, sold_at DESC);

-- Price changes over time (a seller dropping price is itself a signal)
CREATE TABLE IF NOT EXISTS price_history (
  id          SERIAL PRIMARY KEY,
  listing_id  UUID REFERENCES listings(id) ON DELETE CASCADE,
  old_price   NUMERIC(12,2),
  new_price   NUMERIC(12,2),
  changed_at  TIMESTAMP DEFAULT NOW()
);

-- Market stats per product per region. region_type = 'state' | 'country'
CREATE TABLE IF NOT EXISTS market_stats (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  region_type   VARCHAR(20) NOT NULL,
  region        VARCHAR(50) NOT NULL,
  median_price  NUMERIC(12,2),
  mean_price    NUMERIC(12,2),
  p25_price     NUMERIC(12,2),
  p75_price     NUMERIC(12,2),
  min_price     NUMERIC(12,2),
  max_price     NUMERIC(12,2),
  sample_size   INTEGER,
  calculated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (product_id, region_type, region)
);

-- Listings currently priced below market. Rebuilt from scratch on every ingest run,
-- EXCEPT rows the broker has claimed/sold, which are preserved.
CREATE TABLE IF NOT EXISTS deals (
  id                SERIAL PRIMARY KEY,
  listing_id        UUID NOT NULL UNIQUE REFERENCES listings(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  compared_to       VARCHAR(80),                -- e.g. "TX 2013-2019 median (n=14)" or "US median (n=61)"
  market_price      NUMERIC(12,2),
  actual_price      NUMERIC(12,2),
  discount_percent  NUMERIC(5,2),
  discount_amount   NUMERIC(12,2),              -- market_price - actual_price
  estimated_margin  NUMERIC(12,2),              -- discount_amount minus transaction costs (transport, fees)
  deal_score        NUMERIC(4,1),               -- 0-10, see lib/pricing.js
  flagged_at        TIMESTAMP DEFAULT NOW(),
  commission_status VARCHAR(20) DEFAULT 'open', -- open | claimed | sold | passed
  sale_price        NUMERIC(12,2),
  commission_earned NUMERIC(12,2) DEFAULT 0,
  notes             TEXT
);

-- The broker team's buyers: who wants what. Deals are matched to wants automatically.
-- status: customer (someone we know) | prospect (from a public business list, not yet contacted)
CREATE TABLE IF NOT EXISTS buyers (
  id            SERIAL PRIMARY KEY,
  company       VARCHAR(200) NOT NULL,
  contact_name  VARCHAR(200),
  phone         VARCHAR(40),
  email         VARCHAR(255),
  city          VARCHAR(100),
  state         VARCHAR(2),
  notes         TEXT,
  status        VARCHAR(20) DEFAULT 'customer',   -- customer | prospect
  source        VARCHAR(40) DEFAULT 'manual',     -- manual | fmcsa | rrc | import
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- salesperson who owns the relationship
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS buyer_wants (
  id          SERIAL PRIMARY KEY,
  buyer_id    INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  max_price   NUMERIC(12,2),
  states      TEXT[],                              -- empty = anywhere
  min_year    INTEGER,
  notes       TEXT,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_buyer_wants_product ON buyer_wants(product_id) WHERE active;
-- Where the buyer wants machines delivered (may differ from their own address); a want can override it
ALTER TABLE buyers      ADD COLUMN IF NOT EXISTS deliver_city  VARCHAR(100);
ALTER TABLE buyers      ADD COLUMN IF NOT EXISTS deliver_state CHAR(2);
ALTER TABLE buyer_wants ADD COLUMN IF NOT EXISTS deliver_city  VARCHAR(100);
ALTER TABLE buyer_wants ADD COLUMN IF NOT EXISTS deliver_state CHAR(2);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS buyer_id INTEGER REFERENCES buyers(id) ON DELETE SET NULL;  -- who it was claimed for
ALTER TABLE deals ALTER COLUMN compared_to TYPE VARCHAR(160);

-- Audit log of what the broker did with each deal
CREATE TABLE IF NOT EXISTS broker_interactions (
  id         SERIAL PRIMARY KEY,
  deal_id    INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  broker_id  VARCHAR(255),
  action     VARCHAR(50),
  notes      TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Log of every ingest run, so you can see if a source has gone quiet
CREATE TABLE IF NOT EXISTS ingest_runs (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER REFERENCES products(id) ON DELETE CASCADE,
  source        VARCHAR(50),
  fetched       INTEGER DEFAULT 0,
  inserted      INTEGER DEFAULT 0,
  updated       INTEGER DEFAULT 0,
  error         TEXT,
  note          TEXT,                         -- e.g. 'actor returned 120 items, 0 usable; keys: ...'
  started_at    TIMESTAMP DEFAULT NOW(),
  finished_at   TIMESTAMP
);

ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS returned INTEGER DEFAULT 0;   -- items the scraper billed us for (fetched = ones we kept)
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS basis VARCHAR(10) DEFAULT 'asking';
ALTER TABLE users ADD COLUMN IF NOT EXISTS yard_city VARCHAR(100);   -- where the user takes delivery (landed cost)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_phone VARCHAR(40);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2);   -- the user's own cut; shown only to them
ALTER TABLE users ADD COLUMN IF NOT EXISTS yard_state VARCHAR(2);   -- 'sold' when built from completed sales
CREATE INDEX IF NOT EXISTS idx_listings_product   ON listings(product_id);
CREATE INDEX IF NOT EXISTS idx_listings_state     ON listings(state);
CREATE INDEX IF NOT EXISTS idx_listings_price     ON listings(price);
CREATE INDEX IF NOT EXISTS idx_listings_active    ON listings(is_active);
CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_deals_score        ON deals(deal_score DESC);
CREATE INDEX IF NOT EXISTS idx_deals_status       ON deals(commission_status);

-- ============================================================================
-- v4: accounts, subscriptions, watchlists, alerts
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  email                VARCHAR(255) NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  name                 VARCHAR(255),
  role                 VARCHAR(20) NOT NULL DEFAULT 'subscriber', -- admin | broker | agent | subscriber
  -- Stripe
  stripe_customer_id   VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255),
  subscription_status  VARCHAR(30) DEFAULT 'none',  -- none | trialing | active | past_due | canceled
  subscription_ends_at TIMESTAMP,                    -- current period end (access continues until then)
  -- alert preferences (apply to every machine the user watches)
  phone                VARCHAR(30),                  -- E.164, e.g. +14325551234, for SMS
  alert_channel        VARCHAR(10) DEFAULT 'email',  -- email | sms | both | none
  alert_frequency      VARCHAR(10) DEFAULT 'daily',  -- realtime | hourly | daily | weekly
  alert_states         TEXT[],                       -- NULL = anywhere in the US
  alert_min_discount   NUMERIC(5,2) DEFAULT 5,       -- % below market
  alert_min_margin     NUMERIC(12,2) DEFAULT 2500,   -- $ after transaction costs
  alert_max_price      NUMERIC(12,2),
  alert_min_year       INTEGER,
  last_digest_at       TIMESTAMP,
  -- housekeeping
  reset_token          VARCHAR(128),
  reset_expires        TIMESTAMP,
  last_login           TIMESTAMP,
  created_at           TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token       VARCHAR(128) PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- The machines each user watches. Filters live on the user (alert_* columns); the
-- per-row columns below are optional overrides and are NULL by default.
CREATE TABLE IF NOT EXISTS watchlists (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  states      TEXT[],                 -- NULL = anywhere
  min_margin  NUMERIC(12,2),
  min_discount NUMERIC(5,2),
  max_price   NUMERIC(12,2),
  min_year    INTEGER,
  alerts      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);

-- Which deals we've already emailed to whom (so nobody gets the same deal twice)
CREATE TABLE IF NOT EXISTS alert_log (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id  INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  sent_at  TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, deal_id)
);

-- Subscribers asking you to track something new (admin approves -> it becomes a product)
CREATE TABLE IF NOT EXISTS product_requests (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  term       VARCHAR(255) NOT NULL,
  status     VARCHAR(20) DEFAULT 'pending',  -- pending | approved | rejected
  created_at TIMESTAMP DEFAULT NOW()
);

-- Companies: each account belongs to one. The listing/market data is shared by everyone;
-- claims, hidden listings and the team are per company.
CREATE TABLE IF NOT EXISTS organizations (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;

-- Listings staff marked "not this machine". org_id NULL = hidden for everyone (made by the platform
-- admin, also kept out of market values); otherwise hidden only for that company.
CREATE TABLE IF NOT EXISTS listing_blocks (
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  blocked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  blocked_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE listing_blocks ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE listing_blocks DROP CONSTRAINT IF EXISTS listing_blocks_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_blocks_uq ON listing_blocks (listing_id, COALESCE(org_id, 0));
-- kind: 'hide' = wrong machine, gone; 'parts' = real listing but a part/attachment/tire set: kept in a
-- separate "Parts & attachments" pile on the machine page, never in the market value or the deals.
ALTER TABLE listing_blocks ADD COLUMN IF NOT EXISTS kind VARCHAR(10) DEFAULT 'hide';

ALTER TABLE broker_interactions ADD COLUMN IF NOT EXISTS org_id INTEGER;

-- A company's claim on a listing (one per company): claimed -> sold, or passed. Claims lapse
-- (expires_at) so a deal can't sit locked forever.
CREATE TABLE IF NOT EXISTS deal_claims (
  listing_id        UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  org_id            INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  buyer_id          INTEGER,
  status            VARCHAR(20) NOT NULL DEFAULT 'claimed',   -- claimed | sold | passed
  claimed_at        TIMESTAMP DEFAULT NOW(),
  expires_at        TIMESTAMP,
  sale_price        NUMERIC(12,2),
  commission_earned NUMERIC(12,2) DEFAULT 0,
  notes             TEXT,
  PRIMARY KEY (listing_id, org_id)
);

-- Small key/value store for app state that must survive restarts (e.g. last scheduled refresh)
CREATE TABLE IF NOT EXISTS app_state (
  key   VARCHAR(60) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Emails to a broker's clients when a machine they want shows up (sent in the rep's name).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_emails BOOLEAN DEFAULT FALSE;   -- switched on per company once their sending domain is set
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS emails BOOLEAN DEFAULT TRUE;                   -- per buyer opt-out
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS last_mailed_at TIMESTAMP;
CREATE TABLE IF NOT EXISTS buyer_alert_log (
  buyer_id   INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sent_at    TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (buyer_id, listing_id)
);

-- Follow-ups: "call Joe Tuesday about the loader". Per person.
CREATE TABLE IF NOT EXISTS followups (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  buyer_id   INTEGER REFERENCES buyers(id) ON DELETE SET NULL,
  title      VARCHAR(255),
  note       TEXT,
  due_at     TIMESTAMP,
  done_at    TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(user_id, done_at, due_at);

-- Who did what (for the owner to see how accounts are used)
CREATE TABLE IF NOT EXISTS activity (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action  VARCHAR(40) NOT NULL,
  detail  VARCHAR(200),
  at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at DESC);

-- Subscribers' own saved deals (independent of the broker claim workflow)
CREATE TABLE IF NOT EXISTS saved_deals (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id  INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  note     TEXT,
  saved_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, deal_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_watchlists_user  ON watchlists(user_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe     ON users(stripe_customer_id);

-- ---- Find buyers (demand side) ----
-- Companies pay extra for this tab; admin always sees it.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS demand_access BOOLEAN DEFAULT FALSE;
-- Each rep gets a public "tell me what you're looking for" link; what comes in lands in that rep's buyers.
ALTER TABLE users ADD COLUMN IF NOT EXISTS intake_slug VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_intake_slug ON users (intake_slug) WHERE intake_slug IS NOT NULL;

-- Drilling permits (Texas RRC public files). A permit = an operator about to need iron.
CREATE TABLE IF NOT EXISTS permits (
  id            SERIAL PRIMARY KEY,
  state         VARCHAR(2) NOT NULL DEFAULT 'TX',
  permit_no     VARCHAR(20) NOT NULL,
  status        VARCHAR(10) NOT NULL,          -- pending | approved
  operator_no   VARCHAR(20),
  operator_name VARCHAR(120) NOT NULL,
  county_code   VARCHAR(5),
  county        VARCHAR(40),
  district      VARCHAR(4),
  lease_name    VARCHAR(80),
  well_no       VARCHAR(20),
  received_at   DATE,
  issued_at     DATE,
  source_file   VARCHAR(20),
  first_seen    TIMESTAMP DEFAULT NOW(),
  last_seen     TIMESTAMP DEFAULT NOW(),
  UNIQUE (state, permit_no, status)
);
CREATE INDEX IF NOT EXISTS idx_permits_dates ON permits (COALESCE(issued_at, received_at) DESC);

CREATE TABLE IF NOT EXISTS operators (
  id             SERIAL PRIMARY KEY,
  state          VARCHAR(2) NOT NULL DEFAULT 'TX',
  operator_no    VARCHAR(60) NOT NULL,
  name           VARCHAR(120) NOT NULL,
  phone          VARCHAR(40),
  address        VARCHAR(200),
  city           VARCHAR(80),
  st             VARCHAR(2),
  zip            VARCHAR(12),
  website        VARCHAR(200),
  notes          TEXT,
  permits_30d    INTEGER DEFAULT 0,
  permits_90d    INTEGER DEFAULT 0,
  counties       TEXT,
  last_permit_at DATE,
  first_seen     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE (state, operator_no)
);

-- Demand heat: auction activity we already see on every listing.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS bids INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS watchers INTEGER;

-- Buyer intake: "tell us what you're looking for" links, one per company; rows land in buyers.
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS intake_note TEXT;

-- One lead list for the Find buyers tab. Rows from public data (operators, carriers) are shared by every
-- company; rows a company brought in itself (intake link, imports) carry its org_id. Who's working a lead,
-- and how it's going, is per company in lead_state.
CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  kind        VARCHAR(20) NOT NULL,            -- operator | carrier | intake | dealer | import
  source_key  VARCHAR(120) NOT NULL,
  org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,   -- NULL = public data
  name        VARCHAR(200) NOT NULL,
  phone       VARCHAR(40),
  email       VARCHAR(255),
  website     VARCHAR(200),
  city        VARCHAR(100),
  st          VARCHAR(2),
  zip         VARCHAR(12),
  county      VARCHAR(40),
  counties    TEXT,
  signal      INTEGER DEFAULT 0,               -- ranking: permits this month, fleet size...
  signal_text VARCHAR(200),
  meta        JSONB,
  first_seen  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_uq ON leads (kind, source_key, COALESCE(org_id, 0));
CREATE INDEX IF NOT EXISTS idx_leads_kind ON leads (kind, signal DESC);

CREATE TABLE IF NOT EXISTS lead_state (
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at   TIMESTAMP,
  status        VARCHAR(20) DEFAULT 'new',     -- new | assigned | contacted | talking | customer | dead
  notes         TEXT,
  buyer_id      INTEGER REFERENCES buyers(id) ON DELETE SET NULL,
  last_touch_at TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (org_id, lead_id)
);
-- A company's own contact info for a lead (looked up by a rep): shown to that company, never overwritten by the public data
ALTER TABLE lead_state ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
ALTER TABLE lead_state ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE lead_state ADD COLUMN IF NOT EXISTS contact_name VARCHAR(120);
-- Who a hauler / buyer works for (operators they deliver to), learned on the phone. Builds the map nobody publishes.
ALTER TABLE lead_state ADD COLUMN IF NOT EXISTS works_for TEXT;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS works_for TEXT;
