const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  // Cron's check cycle runs up to 20 concurrent workers, each holding a
  // connection briefly per row — keep the pool at least that large so workers
  // aren't waiting on each other for a DB connection (the real bottleneck is
  // GHL's rate limiter, not Postgres).
  max: 25,
});

module.exports = { pool };
