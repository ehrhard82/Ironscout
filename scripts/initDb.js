// Creates the database if it doesn't exist (local Postgres only), then applies database/schema.sql.
// With DATABASE_URL (Neon/Supabase/etc.) the database already exists; we just apply the schema.
// Safe to run again later: the schema uses IF NOT EXISTS everywhere.
// Usage: npm run db:init
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { config } = require('../lib/db');

(async () => {
  const cfg = config();
  if (!process.env.DATABASE_URL) {
    const dbName = cfg.database;
    const admin = new Client({ ...cfg, database: 'postgres' });
    await admin.connect();
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!exists.rows.length) { await admin.query(`CREATE DATABASE "${dbName}"`); console.log(`Created database ${dbName}`); }
    await admin.end();
  }
  const db = new Client(cfg);
  await db.connect();
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await db.end();
  console.log('Schema applied. IronScout is ready.\n  Next: npm start, open the site, sign up — the FIRST account created becomes admin.');
})().catch(e => { console.error(e.message); process.exit(1); });
