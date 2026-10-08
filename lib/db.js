// Single shared PostgreSQL pool. Everything imports this instead of making its own.
//
// Two ways to configure:
//   DATABASE_URL=postgres://user:pass@host/db?sslmode=require   (Neon, Supabase, Render, Railway...)
//   or the individual DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME settings (local Postgres)
require('dotenv').config();
const { Pool } = require('pg');

function config() {
  if (process.env.DATABASE_URL) {
    const needsSsl = /sslmode=require|neon\.tech|supabase|render\.com|railway/i.test(process.env.DATABASE_URL);
    return { connectionString: process.env.DATABASE_URL, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: 5 };
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
