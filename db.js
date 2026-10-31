const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon and Render Postgres need TLS. Set DATABASE_SSL=false for a local database.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 10,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_raw text NOT NULL,
  end_raw   text NOT NULL,
  start_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial UNIQUE,
  id         text PRIMARY KEY,
  slot_id    text NOT NULL,
  name       text NOT NULL,
  email      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('confirmed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Level 3: the database itself refuses a second confirmed booking for a slot.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

-- Level 4: stored responses for Idempotency-Key.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key       text PRIMARY KEY,
  body_hash text NOT NULL,
  status    int,
  response  jsonb
);

-- Level 5: one row per booking attempt.
CREATE TABLE IF NOT EXISTS attempts (
  id    bigserial PRIMARY KEY,
  email text NOT NULL,
  at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_email_at ON attempts (email, at_ms);
`;

async function insertSlots(client, rows) {
  if (!rows.length) return;
  await client.query(
    `INSERT INTO slots (id, provider, start_raw, end_raw, start_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
    [0, 1, 2, 3, 4].map((i) => rows.map((r) => r[i]))
  );
}

// Gives the web page something to show on a fresh database. POST /reset replaces it.
async function seed() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM slots');
  if (rows[0].n > 0) return;
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const providers = ['Dr Ade', 'Dr Bisi'];
  const out = [];
  let n = 1;
  for (let d = 1; d <= 7; d++) {
    for (const provider of providers) {
      for (let half = 0; half < 6; half++) {
        const start = new Date(day.getTime() + d * 864e5 + (9 * 60 + half * 30) * 6e4);
        const end = new Date(start.getTime() + 30 * 6e4);
        const s = start.toISOString().replace('.000Z', 'Z');
        out.push([`s${n++}`, provider, s, end.toISOString().replace('.000Z', 'Z'), s]);
      }
    }
  }
  await insertSlots(pool, out);
}

async function init() {
  await pool.query(SCHEMA);
  await seed();
}

module.exports = { pool, init, insertSlots };
