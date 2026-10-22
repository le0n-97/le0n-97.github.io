import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeURL, MemoryD1, fixtureGameToken } from './helpers.mjs';

const { GET, POST } = await import(runtimeURL('chat-route.mjs'));
const chat = await import(runtimeURL('chat.mjs'));
const { POST: gamePost } = await import(runtimeURL('route.mjs'));
const origin = 'https://squares.example';
function setup(t) {
  const db = new MemoryD1();
  const clock = { now: 1000 };
  globalThis.__gameTestDB = db;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => db.close());
  return { db, clock };
}
async function request(handler, pathname, payload, token, extra = {}) {
  const response = await handler(new Request(`${origin}${pathname}`, {
    ...(payload === undefined ? {} : { method: 'POST', body: extra.raw ?? JSON.stringify(payload) }),
    headers: {
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extra.headers ?? {}),
    },
  }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const gameAction = (payload, token) => request(gamePost, '/api/game', payload, fixtureGameToken(payload, token));
const post = (payload, token, extra) => request(POST, '/api/chat', payload, token, extra);
const get = (code, token, after, extra) => request(GET,
  `/api/chat?code=${encodeURIComponent(code)}${after === undefined ? '' : `&after=${encodeURIComponent(after)}`}`,
  undefined, token, extra);
const message = (code, text = 'Hello!', clientId = crypto.randomUUID()) => ({ code, text, clientId });
async function room(join = true) {
  const host = await gameAction({ action: 'create', name: 'Alice', wordCount: 'small' });
  assert.equal(host.status, 201);
  const code = host.body.room.code;
  const guest = join ? await gameAction({ action: 'join', code, name: 'Bob' }) : null;
  if (guest) assert.equal(guest.status, 200);
  return { code, host: host.body, guest: guest?.body };
}

test('chat is private to room participants and exposes only public message fields', async t => {
  setup(t);
  const game = await room();
  const other = await room(false);
  for (const token of [undefined, 'forged', other.host.token]) {
    assert.equal((await get(game.code, token)).status, 401);
    assert.equal((await post(message(game.code), token)).status, 401);
  }
  assert.deepEqual((await get(game.code, game.host.token)).body, { messages: [], cursor: 0, hasMore: false });
  const sent = await post(message(game.code, '你好，Bob 👋'), game.host.token);
  assert.equal(sent.status, 200);
  assert.match(sent.headers.get('Cache-Control'), /no-store/);
  const received = await get(game.code.toLowerCase(), game.guest.token);
  assert.equal(received.status, 200);
  assert.match(received.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(received.body.messages, [sent.body.message]);
  assert.deepEqual(Object.keys(sent.body.message).sort(), ['at', 'clientId', 'id', 'playerId', 'text']);
  assert.equal(sent.body.message.playerId, game.host.playerId);
  assert.equal(sent.body.message.text, '你好，Bob 👋');
  assert.equal(sent.body.message.at, 1000);
  assert.equal(received.body.cursor, sent.body.message.id);
  assert.equal(received.body.hasMore, false);
  assert.deepEqual((await get(other.code, other.host.token)).body.messages, []);
  assert.equal(JSON.stringify(received.body).includes(game.host.token), false);
});

test('chat rejects invalid requests, foreign origins and malformed cursors without writing', async t => {
  setup(t);
  const game = await room();
  const token = game.host.token;
  for (const payload of [null, [], {}, { code: game.code }, message(game.code, ''), message(game.code, ' \r\n\t '),
    message(game.code, 42), message(game.code, 'x'.repeat(301)), message(game.code, '😃'.repeat(301)),
    message(game.code, 'hello', 'not-a-uuid'), message('INVALID')]) {
    assert.equal((await post(payload, token)).status, 400, `Reject ${JSON.stringify(payload)}`);
  }
  assert.equal((await post({}, token, { raw: '{' })).status, 400);
  assert.equal((await post({}, token, { raw: 'x'.repeat(4097) })).status, 413);
  assert.equal((await post(message(game.code), token, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await get('INVALID', token)).status, 400);
  assert.equal((await get('ABC234', token)).status, 404);
  for (const cursor of ['-1', '1.2', 'NaN', 'Infinity', '9007199254740992', '1x']) {
    assert.equal((await get(game.code, token, cursor)).status, 400, `Reject cursor ${cursor}`);
  }
  assert.deepEqual((await get(game.code, token)).body.messages, []);
});

test('chat accepts 300 Unicode characters and normalizes newlines while preserving literal markup as text', async t => {
  const { clock } = setup(t);
  const game = await room();
  const first = await post(message(game.code, ` \r\n${'😃'.repeat(300)}\r\n `), game.host.token);
  assert.equal(first.status, 200);
  assert.equal(first.body.message.text, '😃'.repeat(300));
  clock.now += 1000;
  const second = await post(message(game.code, ' \tHello\r\n<script>alert(1)</script>\rbye\u0000 '), game.host.token);
  assert.equal(second.status, 200);
  assert.equal(second.body.message.text, 'Hello\n<script>alert(1)</script>\nbye');
  assert.deepEqual((await get(game.code, game.guest.token)).body.messages.map(item => item.text),
    ['😃'.repeat(300), second.body.message.text]);
});

test('message retries are idempotent before the send throttle and conflicting reuse is rejected', async t => {
  const { clock } = setup(t);
  const game = await room();
  const payload = message(game.code, '  hello\r\nBob  ');
  const sent = await post(payload, game.host.token);
  assert.equal(sent.status, 200);
  const retry = await post({ ...payload, text: 'hello\nBob' }, game.host.token);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.message, sent.body.message);
  assert.equal((await post({ ...payload, text: 'different' }, game.host.token)).status, 409);
  assert.equal((await post(message(game.code, 'too soon'), game.host.token)).status, 429);
  clock.now += 999;
  assert.equal((await post(message(game.code, 'still too soon'), game.host.token)).status, 429);
  clock.now++;
  assert.equal((await post(message(game.code, 'now allowed'), game.host.token)).status, 200);
  assert.equal((await get(game.code, game.guest.token)).body.messages.length, 2);
});

test('simultaneous chat sends enforce one message per player and keep opposite-player sends', async t => {
  const { clock } = setup(t);
  const game = await room();
  const race = await Promise.all([
    post(message(game.code, 'first'), game.host.token),
    post(message(game.code, 'second'), game.host.token),
  ]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 429]);
  clock.now += 1000;
  const both = await Promise.all([
    post(message(game.code, 'Alice again'), game.host.token),
    post(message(game.code, 'Bob joins'), game.guest.token),
  ]);
  assert.deepEqual(both.map(result => result.status), [200, 200]);
  const received = await get(game.code, game.guest.token);
  assert.equal(received.body.messages.length, 3);
  assert.equal(new Set(received.body.messages.map(item => item.id)).size, 3);
});

test('chat is available only in the lobby, including spectators, and returns after a host rematch', async t => {
  const { db, clock } = setup(t);
  const game = await room(false);
  async function unchangedSend(text, token = game.host.token) {
    const baseline = structuredClone(db.rows.get(game.code));
    const sent = await post(message(game.code, text), token);
    assert.equal(sent.status, 200);
    assert.deepEqual(db.rows.get(game.code), baseline, 'Chat cannot change room state, revision, scores, timers or round.');
    assert.equal((await get(game.code, token)).status, 200);
    assert.deepEqual(db.rows.get(game.code), baseline, 'Chat polling cannot settle or extend a game.');
    clock.now += 1000;
  }
  await unchangedSend('Waiting for Bob');
  const joined = await gameAction({ action: 'join', code: game.code, name: 'Bob' });
  game.guest = joined.body;
  await unchangedSend('Ready');
  const watcher = await gameAction({ action: 'join', code: game.code, name: 'Watcher', role: 'spectator' });
  assert.equal(watcher.status, 200);
  await unchangedSend('Watching!', watcher.body.token);
  assert.equal((await gameAction({ action: 'start', code: game.code }, game.host.token)).status, 200);
  assert.equal((await gameAction({ action: 'commit', code: game.code }, game.host.token)).status, 200);
  for (const token of [game.host.token, game.guest.token, watcher.body.token]) {
    const baseline = structuredClone(db.rows.get(game.code));
    assert.equal((await post(message(game.code, 'During game'), token)).status, 409);
    const hidden = await get(game.code, token);
    assert.equal(hidden.status, 409);
    assert.equal('messages' in hidden.body, false);
    assert.deepEqual(db.rows.get(game.code), baseline);
  }
  assert.equal((await gameAction({ action: 'commit', code: game.code }, game.guest.token)).body.room.status, 'finished');
  assert.equal((await get(game.code, watcher.body.token)).status, 409);
  assert.equal((await post(message(game.code, 'Good game!'), game.guest.token)).status, 409);
  const rematched = await gameAction({ action: 'rematch', code: game.code }, game.host.token);
  assert.equal(rematched.body.room.round, 2);
  assert.equal(rematched.body.room.status, 'waiting');
  await unchangedSend('Round two');
  assert.deepEqual((await get(game.code, game.host.token)).body.messages.map(item => item.text),
    ['Waiting for Bob', 'Ready', 'Watching!', 'Round two']);
});

test('chat cannot postpone inactivity or Commit deadlines even when the game is already overdue', async t => {
  const { db, clock } = setup(t);
  const game = await room();
  await gameAction({ action: 'start', code: game.code }, game.host.token);
  await gameAction({ action: 'commit', code: game.code }, game.host.token);
  const baseline = structuredClone(db.rows.get(game.code));
  clock.now += 300000;
  assert.equal((await post(message(game.code, 'Still here'), game.host.token)).status, 409);
  assert.equal((await get(game.code, game.guest.token)).status, 409);
  assert.deepEqual(db.rows.get(game.code), baseline);
  const settled = await gameAction({ action: 'commit', code: game.code }, game.guest.token);
  assert.equal(settled.body.room.endReason, 'commit_timeout');
  assert.equal(settled.body.room.endedAt, 61000);
  assert.equal(settled.body.room.words.length, 0);
});

test('chat database phase guards prevent a stale lobby snapshot from sending or exposing messages after start', async t => {
  const { db, clock } = setup(t);
  const game = await room();
  const sent = await post(message(game.code, 'Lobby only'), game.host.token);
  assert.equal(sent.status, 200);
  const lobbySnapshot = db.room(game.code);
  await gameAction({ action: 'start', code: game.code }, game.host.token);
  const baseline = structuredClone(db.rows.get(game.code));
  clock.now += 1000;
  await assert.rejects(chat.sendMessage(db, lobbySnapshot, game.host.playerId,
    crypto.randomUUID(), 'Stale lobby request', clock.now), { status: 409 });
  assert.deepEqual(await chat.readMessages(db, lobbySnapshot), { messages: [], cursor: 0, hasMore: false });
  assert.deepEqual(db.rows.get(game.code), baseline);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM room_chat').get().n, 1);
});

test('chat pages deterministically, retains the latest 200 and does not replay pages with an unchanged cursor', async t => {
  const { db, clock } = setup(t);
  const game = await room();
  const baseline = structuredClone(db.rows.get(game.code));
  const accepted = [];
  for (let i = 0; i < 205; i++) {
    const sent = await post(message(game.code, `message-${i}`), game.host.token);
    assert.equal(sent.status, 200, `Message ${i}`);
    accepted.push(sent.body.message);
    clock.now += 1000;
  }
  const initial = await get(game.code, game.guest.token);
  assert.deepEqual(initial.body.messages, accepted.slice(-100));
  assert.equal(initial.body.hasMore, false);
  const first = await get(game.code, game.guest.token, 0);
  assert.deepEqual(first.body.messages, accepted.slice(-200, -100));
  assert.equal(first.body.hasMore, true);
  const second = await get(game.code, game.guest.token, first.body.cursor);
  assert.deepEqual(second.body.messages, accepted.slice(-100));
  assert.equal(second.body.hasMore, false);
  const empty = await get(game.code, game.guest.token, second.body.cursor);
  assert.deepEqual(empty.body, { messages: [], cursor: second.body.cursor, hasMore: false });
  assert.deepEqual(db.rows.get(game.code), baseline);
});

test('reusing a room code does not expose old messages or carry over its send throttle', async t => {
  const { db, clock } = setup(t);
  const old = await room();
  await post(message(old.code, 'Old private conversation'), old.host.token);
  clock.now += 1;
  const replacement = await room();
  const next = db.room(replacement.code);
  next.code = old.code;
  db.replaceRoom(old.code, next);
  assert.equal((await get(old.code, old.host.token)).status, 401);
  assert.deepEqual((await get(old.code, replacement.host.token)).body.messages, []);
  const sent = await post(message(old.code, 'New room conversation'), replacement.host.token);
  assert.equal(sent.status, 200);
  assert.deepEqual((await get(old.code, replacement.guest.token)).body.messages.map(item => item.text), ['New room conversation']);
  assert.deepEqual((await get(replacement.code, replacement.host.token)).body.messages, [], 'Room code is also part of the isolation key.');
});
