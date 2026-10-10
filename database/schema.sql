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
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS basis VARCHAR(10) DEFAULT 'asking';
ALTER TABLE users ADD COLUMN IF NOT EXISTS yard_city VARCHAR(100);   -- where the user takes delivery (landed cost)
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
  role                 VARCHAR(20) NOT NULL DEFAULT 'subscriber', -- admin | broker | subscriber
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
