// Single shared PostgreSQL pool. Everything imports this instead of making its own.
//
// Two ways to configure:
//   DATABASE_URL=postgres://user:pass@host/db?sslmode=require   (Neon, Supabase, Render, Railway...)
//   or the individual DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME settings (local Postgres)
require('dotenv').config();
const { Pool } = require('pg');

/**
 * Find the Postgres connection string. Prefers DATABASE_URL, but is forgiving of
 * the ways it gets mangled when typed on a phone: a stray "DATABASE_URL=" pasted
 * into the value, whitespace, or the string sitting under a slightly different
 * variable name. Returns { url, from } or null.
 */
function findDatabaseUrl() {
  const clean = (v) => {
    const m = String(v || '').match(/postgres(?:ql)?:\/\/\S+/i);
    return m ? m[0].replace(/["'`]+$/, '') : null;
  };
  if (clean(process.env.DATABASE_URL)) return { url: clean(process.env.DATABASE_URL), from: 'DATABASE_URL' };
  for (const [k, v] of Object.entries(process.env)) {
    if (/postgres(?:ql)?:\/\//i.test(String(v))) return { url: clean(v), from: k };
    if (/postgres(?:ql)?:\/\//i.test(k)) return { url: clean(k), from: `${k.slice(0, 20)}… (the string was pasted into the KEY box)` };
  }
  return null;
}

function config() {
  const found = findDatabaseUrl();
  if (found) {
    const needsSsl = /sslmode=require|neon\.tech|supabase|render\.com|railway/i.test(found.url);
    return { connectionString: found.url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: 5 };
  }
  return {
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'ironscout', max: 10,
  };
}

const pool = new Pool(config());
pool.on('error', (err) => console.error('Unexpected DB error', err));

module.exports = pool;
module.exports.config = config;
module.exports.findDatabaseUrl = findDatabaseUrl;
