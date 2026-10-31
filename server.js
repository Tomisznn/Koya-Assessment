const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { pool, init, insertSlots } = require('./db');

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('API_KEY is required');
  process.exit(1);
}
// The web page is served by this app. By default it gets the key built in so it works
// as soon as it opens. Set EMBED_KEY=false and it asks the visitor for the key instead.
const EMBED_KEY = process.env.EMBED_KEY !== 'false';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

const app = express();
app.disable('x-powered-by');

const fail = (res, status, message) => res.status(status).json({ error: message });
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const bookingOut = (r) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: r.created_at.toISOString(),
});

// ---- Public: the web page, CORS preflight --------------------------------------------
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get('/', (req, res) => {
  const key = JSON.stringify(EMBED_KEY ? API_KEY : '').replace(/</g, '\\u003c');
  res.type('html').send(PAGE.replace('__API_KEY__', () => key));
});

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'X-API-Key, Idempotency-Key, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'Retry-After',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Level 2: API key on everything else 
app.use((req, res, next) => {
  const given = req.get('X-API-Key');
  if (!given || !crypto.timingSafeEqual(sha(given), sha(API_KEY))) {
    return fail(res, 401, 'missing or invalid API key');
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

//  Level 1: reset and slots 
app.post('/reset', async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) return fail(res, 400, 'slots must be an array');

  const rows = [];
  const seen = new Set();
  for (const s of slots) {
    const ok =
      s && typeof s === 'object' &&
      ['id', 'provider', 'start', 'end'].every((k) => typeof s[k] === 'string' && s[k].trim());
    if (!ok) return fail(res, 400, 'every slot needs id, provider, start and end');
    const t = Date.parse(s.start);
    if (Number.isNaN(t) || Number.isNaN(Date.parse(s.end))) {
      return fail(res, 400, 'slot start and end must be date-times');
    }
    if (seen.has(s.id)) return fail(res, 400, `duplicate slot id: ${s.id}`);
    seen.add(s.id);
    rows.push([s.id, s.provider, s.start, s.end, new Date(t).toISOString()]);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE bookings, idempotency_keys, attempts');
    await client.query('DELETE FROM slots');
    await insertSlots(client, rows);
    await client.query('COMMIT');
    res.json({ ok: true, slots: rows.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

app.get('/slots', async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE ($1::text IS NULL OR s.provider = $1)
      ORDER BY s.start_at, s.id`,
    [provider]
  );
  res.json({ slots: rows });
});

// ---- Book a slot (levels 1-5) ---------------------------------------------------------
app.post('/bookings', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const idemKey = req.get('Idempotency-Key') || null;
  const bodyHash = crypto
    .createHash('sha256')
    .update(JSON.stringify([body.slot_id ?? null, body.name ?? null, body.email ?? null]))
    .digest('hex');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Level 4: claim the key. A concurrent request with the same key waits here until the
    // first one commits, then finds its stored response instead of booking again.
    if (idemKey) {
      const claim = await client.query(
        'INSERT INTO idempotency_keys (key, body_hash) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key',
        [idemKey, bodyHash]
      );
      if (claim.rowCount === 0) {
        const { rows } = await client.query(
          'SELECT body_hash, status, response FROM idempotency_keys WHERE key = $1',
          [idemKey]
        );
        await client.query('ROLLBACK');
        const saved = rows[0];
        if (saved.body_hash !== bodyHash) {
          return fail(res, 422, 'Idempotency-Key was already used with a different request body');
        }
        return res.status(saved.status).json(saved.response);
      }
    }

    // Level 5: 5 attempts per email per minute, failed ones included. The advisory lock
    // makes the count-then-insert safe when requests for one email arrive together.
    if (email) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
      const now = Date.now();
      const { rows } = await client.query(
        'SELECT count(*)::int AS n, min(at_ms) AS oldest FROM attempts WHERE email = $1 AND at_ms > $2',
        [email, now - WINDOW_MS]
      );
      if (rows[0].n >= MAX_ATTEMPTS) {
        await client.query('ROLLBACK');
        const wait = Math.max(1, Math.ceil((Number(rows[0].oldest) + WINDOW_MS - now) / 1000));
        res.set('Retry-After', String(wait));
        return fail(res, 429, 'too many booking attempts for this email, try again later');
      }
      await client.query('INSERT INTO attempts (email, at_ms) VALUES ($1, $2)', [email, now]);
      await client.query('DELETE FROM attempts WHERE at_ms < $1', [now - 3_600_000]);
    }

    const finish = async (status, payload) => {
      if (idemKey) {
        await client.query('UPDATE idempotency_keys SET status = $2, response = $3 WHERE key = $1', [
          idemKey,
          status,
          JSON.stringify(payload),
        ]);
      }
      await client.query('COMMIT');
      return res.status(status).json(payload);
    };

    // Level 2: validation
    const slotId = typeof body.slot_id === 'string' ? body.slot_id : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!slotId.trim()) return finish(400, { error: 'slot_id is required' });
    if (!name) return finish(400, { error: 'name is required' });
    if (!email) return finish(400, { error: 'email is required' });
    if (!EMAIL_RE.test(email)) return finish(400, { error: 'email is not valid' });

    const { rows: found } = await client.query('SELECT id, start_at FROM slots WHERE id = $1', [slotId]);
    if (!found.length) return finish(404, { error: 'slot not found' });
    if (found[0].start_at.getTime() <= Date.now()) {
      return finish(400, { error: 'slot has already started' });
    }

    // Level 3: the partial unique index decides. Of several simultaneous requests for one
    const ins = await client.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING *`,
      [crypto.randomUUID(), found[0].id, name, email]
    );
    if (ins.rowCount === 0) return finish(409, { error: 'slot is already booked' });
    return finish(201, bookingOut(ins.rows[0]));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

//  Level 4: a person's bookings, cursor pagination 
app.get('/bookings', async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) return fail(res, 400, 'email is required');

  let limit = 10;
  if (req.query.limit !== undefined) {
    const raw = req.query.limit;
    if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) {
      return fail(res, 400, 'limit must be a whole number from 1 to 50');
    }
    limit = Number(raw);
    if (limit < 1 || limit > 50) return fail(res, 400, 'limit must be a whole number from 1 to 50');
  }

  let after = 0;
  const cursor = req.query.cursor;
  if (cursor !== undefined && cursor !== '') {
    const decoded = typeof cursor === 'string' ? Buffer.from(cursor, 'base64url').toString() : '';
    if (!/^\d{1,15}$/.test(decoded)) return fail(res, 400, 'invalid cursor');
    after = Number(decoded);
  }

  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3',
    [email, after, limit + 1]
  );
  const page = rows.slice(0, limit);
  const next =
    rows.length > limit ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url') : null;
  res.json({ bookings: page.map(bookingOut), next_cursor: next });
});

app.get('/bookings/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) return fail(res, 404, 'booking not found');
  res.json(bookingOut(rows[0]));
});

//  Level 3: cancel 
app.delete('/bookings/:id', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`,
    [req.params.id]
  );
  if (rows.length) return res.json(bookingOut(rows[0]));
  const exists = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  return exists.rowCount ? fail(res, 409, 'booking is already cancelled') : fail(res, 404, 'booking not found');
});

app.use((req, res) => fail(res, 404, 'not found'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'request body must be valid JSON');
  if (err.type === 'entity.too.large') return fail(res, 413, 'request body too large');
  console.error(err);
  fail(res, 500, 'internal error');
});

const port = process.env.PORT || 3000;
init()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`listening on ${port}`)))
  .catch((e) => {
    console.error('startup failed', e);
    process.exit(1);
  });
