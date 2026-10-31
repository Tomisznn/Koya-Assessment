
const BASE = (process.env.BASE || '').replace(/\/$/, '');
const KEY = process.env.KEY;
if (!BASE || !KEY) {
  console.error('Set BASE and KEY');
  process.exit(1);
}

let failed = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`);
  if (!ok) failed++;
};

async function call(method, path, body, headers = {}, key = KEY) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (key) h['X-API-Key'] = key;
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json, headers: res.headers };
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const future = (days, mins = 0) => Date.now() + days * 864e5 + mins * 6e4;
const slot = (id, provider, startMs) => ({ id, provider, start: iso(startMs), end: iso(startMs + 18e5) });

(async () => {
  // Level 1
  const r0 = await call('POST', '/reset', {
    slots: [
      slot('s1', 'Dr Ade', future(2)),
      slot('s2', 'Dr Ade', future(2, 30)),
      slot('s3', 'Dr Bisi', future(1)),
      slot('s4', 'Dr Bisi', future(3)),
      slot('past', 'Dr Ade', Date.now() - 36e5),
    ],
  });
  check('reset 200', r0.status === 200, r0.status);

  const sl = await call('GET', '/slots');
  check('slots sorted, with available flag', sl.status === 200 && sl.json.slots[0].id === 'past' && sl.json.slots[1].id === 's3' && sl.json.slots.every((s) => s.available === true), JSON.stringify(sl.json));
  const byProv = await call('GET', '/slots?provider=Dr%20Bisi');
  check('provider filter', byProv.json.slots.length === 2);

  const b1 = await call('POST', '/bookings', { slot_id: 's1', name: '  Ada Obi ', email: '  ADA@Example.com ' });
  check('book 201, trimmed, lower-cased email', b1.status === 201 && b1.json.status === 'confirmed' && b1.json.name === 'Ada Obi' && b1.json.email === 'ada@example.com', JSON.stringify(b1.json));
  const got = await call('GET', '/bookings/' + b1.json.id);
  check('get booking', got.status === 200 && got.json.id === b1.json.id);
  check('get unknown booking 404', (await call('GET', '/bookings/nope')).status === 404);
  const after = await call('GET', '/slots');
  check('booked slot unavailable', after.json.slots.find((s) => s.id === 's1').available === false);

  // Level 2
  check('no key 401', (await call('GET', '/slots', undefined, {}, '')).status === 401);
  check('wrong key 401', (await call('GET', '/slots', undefined, {}, 'wrong')).status === 401);
  const bad = [
    [{ name: 'A', email: 'a@b.co' }, 'missing slot_id'],
    [{ slot_id: 's2', email: 'a@b.co' }, 'missing name'],
    [{ slot_id: 's2', name: '   ', email: 'a@b.co' }, 'blank name'],
    [{ slot_id: 's2', name: 'A' }, 'missing email'],
    [{ slot_id: 's2', name: 'A', email: 'not-an-email' }, 'invalid email'],
    [{ slot_id: 'past', name: 'A', email: 'a@b.co' }, 'slot already started'],
  ];
  for (const [body, label] of bad) {
    const r = await call('POST', '/bookings', body);
    check(`400 for ${label}`, r.status === 400 && typeof r.json?.error === 'string', r.status);
  }
  check('404 unknown slot', (await call('POST', '/bookings', { slot_id: 'zzz', name: 'A', email: 'z@b.co' })).status === 404);

  // Level 3
  const dup = await call('POST', '/bookings', { slot_id: 's1', name: 'Other', email: 'other@example.com' });
  check('second booking of a slot 409', dup.status === 409, dup.status);
  const race = await Promise.all(
    Array.from({ length: 20 }, (_, i) => call('POST', '/bookings', { slot_id: 's2', name: 'R' + i, email: `race${i}@example.com` }))
  );
  const wins = race.filter((r) => r.status === 201).length;
  const losses = race.filter((r) => r.status === 409).length;
  check('20 simultaneous requests: exactly one 201, rest 409', wins === 1 && losses === 19, `201=${wins} 409=${losses}`);

  const c1 = await call('DELETE', '/bookings/' + b1.json.id);
  check('cancel 200', c1.status === 200 && c1.json.status === 'cancelled');
  check('cancel again 409', (await call('DELETE', '/bookings/' + b1.json.id)).status === 409);
  check('cancel unknown 404', (await call('DELETE', '/bookings/nope')).status === 404);
  const rebook = await call('POST', '/bookings', { slot_id: 's1', name: 'Next', email: 'next@example.com' });
  check('cancelled slot can be booked again', rebook.status === 201, rebook.status);

  // Level 4: idempotency
  const body = { slot_id: 's3', name: 'Ife', email: 'ife@example.com' };
  const k = { 'Idempotency-Key': 'key-' + Date.now() };
  const [i1, i2, i3] = await Promise.all([1, 2, 3].map(() => call('POST', '/bookings', body, k)));
  check('same key + body: same status and id, even in parallel', i1.status === 201 && i2.status === 201 && i3.status === 201 && i1.json.id === i2.json.id && i2.json.id === i3.json.id, JSON.stringify([i1.status, i2.status, i3.status]));
  const i4 = await call('POST', '/bookings', body, k);
  check('later retry returns the same booking', i4.status === 201 && i4.json.id === i1.json.id);
  const i5 = await call('POST', '/bookings', { ...body, name: 'Different' }, k);
  check('same key, different body 422', i5.status === 422, i5.status);
  const mine = await call('GET', '/bookings?email=IFE@example.com');
  check('only one booking was created', mine.json.bookings.length === 1);

  // Level 4: pagination
  await call('POST', '/reset', { slots: Array.from({ length: 7 }, (_, i) => slot('p' + i, 'Dr Ade', future(5, i * 30))) });
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const r = await call('POST', '/bookings', { slot_id: 'p' + i, name: 'Pat', email: 'pat@example.com' });
    ids.push(r.json.id);
  }
  const seen = [];
  let cursor = null, pages = 0;
  do {
    const r = await call('GET', `/bookings?email=PAT@example.com&limit=3${cursor ? '&cursor=' + cursor : ''}`);
    seen.push(...r.json.bookings.map((b) => b.id));
    cursor = r.json.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  check('pagination: 3 pages, all 7 in order, last next_cursor null', pages === 3 && seen.join() === ids.join() && cursor === null, `pages=${pages}`);
  check('limit 0 -> 400', (await call('GET', '/bookings?email=pat@example.com&limit=0')).status === 400);
  check('limit 51 -> 400', (await call('GET', '/bookings?email=pat@example.com&limit=51')).status === 400);
  check('limit abc -> 400', (await call('GET', '/bookings?email=pat@example.com&limit=abc')).status === 400);

  // Level 5
  await call('POST', '/reset', { slots: [slot('r1', 'Dr Ade', future(2))] });
  const spam = 'spam@example.com';
  const codes = [];
  let last;
  for (let i = 0; i < 6; i++) {
    last = await call('POST', '/bookings', { slot_id: 'nope', name: 'S', email: spam });
    codes.push(last.status);
  }
  check('5 failed attempts count, 6th is 429', codes.slice(0, 5).every((c) => c === 404) && codes[5] === 429, codes.join());
  const ra = Number(last.headers.get('Retry-After'));
  check('Retry-After is whole seconds (1-60)', Number.isInteger(ra) && ra >= 1 && ra <= 60, String(ra));
  const other = await call('POST', '/bookings', { slot_id: 'r1', name: 'Fine', email: 'fine@example.com' });
  check('other emails are unaffected', other.status === 201, other.status);

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();
