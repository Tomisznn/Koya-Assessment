# Clinic booking API

Express + Postgres. The same app serves the JSON API and the booking web page at `/`.

## How each level is met

| Level | How |
|---|---|
| 1 | `GET /slots`, `POST /bookings`, `GET /bookings/:id`, `POST /reset` |
| 2 | `X-API-Key` middleware (401); validation, trimming and lower-cased email (400/404) |
| 3 | A partial unique index on `bookings(slot_id) WHERE status='confirmed'` plus `INSERT ... ON CONFLICT DO NOTHING`, so the database decides who wins, even for simultaneous requests. `DELETE /bookings/:id` cancels and frees the slot |
| 4 | `Idempotency-Key` claimed inside the booking transaction, so parallel retries wait and replay the stored response (422 if the body differs). `GET /bookings?email=` uses cursor pagination on a sequence number |
| 5 | Attempts stored in Postgres, 5 per email per 60s, failed ones included; a per-email advisory lock keeps the count correct under concurrency. 429 with `Retry-After` |

## Run locally

    cp .env.example .env     # then edit; export the variables or use your shell's loader
    npm install
    API_KEY=dev DATABASE_URL=postgresql://localhost/clinic DATABASE_SSL=false npm start

## Deploy (free)

1. **Neon**: create a project and copy the connection string (it ends in `?sslmode=require`).
2. Push this folder to a public GitHub repo.
3. **Render**: New > Web Service > pick the repo. Build `npm install`, start `npm start`.
   Add env vars `API_KEY` (any long random string you choose) and `DATABASE_URL` (the Neon string).
4. Open the Render URL: that is both your base URL and your web page URL.

Render's free tier sleeps after inactivity, so the first request can take ~30s. Open the URL once just before you submit.

## Check it

    BASE=https://your-service.onrender.com KEY=your-key npm run smoke

The smoke test calls `/reset`, so run it before you submit. Tables are created on startup and
a week of sample slots is added if the database has none.

## Notes

- The page has the key built in so it works on open. Set `EMBED_KEY=false` to make it ask for the key instead.
- Tables: `slots`, `bookings`, `idempotency_keys`, `attempts` (see `db.js`).
