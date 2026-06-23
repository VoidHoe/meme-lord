// Thin Postgres layer for the Clout economy.
//
// If DATABASE_URL is unset, the economy is disabled: `enabled` is false and
// `query()` throws a sentinel so the economy wrappers (economy.js) fall back to
// safe no-ops. When the URL is present we create a single shared Pool with SSL
// relaxed (Railway requires SSL but uses a self-signed cert chain).

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = !!DATABASE_URL;

let pool = null;

if (enabled) {
  // Require pg lazily so the server can still boot if pg isn't installed yet
  // and the economy is disabled.
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  pool.on('error', (err) => {
    console.error('[db] pool error:', err.message);
  });
}

// Sentinel thrown when the economy is disabled. Wrappers catch this and no-op.
class EconomyDisabledError extends Error {
  constructor() {
    super('economy disabled (no DATABASE_URL)');
    this.name = 'EconomyDisabledError';
  }
}

async function query(text, params) {
  if (!enabled) throw new EconomyDisabledError();
  return pool.query(text, params);
}

// Create the tables (idempotent). Called once on server boot.
async function init() {
  if (!enabled) return false;
  await query(`
    CREATE TABLE IF NOT EXISTS players (
      username      TEXT PRIMARY KEY,
      clout         INTEGER NOT NULL DEFAULT 100,
      total_earned  INTEGER NOT NULL DEFAULT 100,
      unlocks       JSONB   NOT NULL DEFAULT '["spin","fade","size-s","size-m"]',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS drop_reactions (
      drop_id  TEXT NOT NULL,
      reactor  TEXT NOT NULL,
      PRIMARY KEY (drop_id, reactor)
    )
  `);
  return true;
}

module.exports = { query, init, enabled, EconomyDisabledError };
