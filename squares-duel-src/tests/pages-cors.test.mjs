import test from 'node:test';
import assert from 'node:assert/strict';
import { game, runtimeURL, MemoryD1, fixtureGameToken } from './helpers.mjs';

const gameApi = await import(runtimeURL('route.mjs'));
const chatApi = await import(runtimeURL('chat-route.mjs'));
const recordsApi = await import(runtimeURL('records-route.mjs'));
const server = 'https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site';
const pages = 'https://le0n-97.github.io';

function setup(t) {
  const db = new MemoryD1();
  const clock = { now: 1000 };
  globalThis.__gameTestDB = db;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => db.close());
  return { db, clock };
}
function tokens(header) {
  return (header ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
}
function assertCors(response, { origin = pages, chat = false } = {}) {
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin ?? null);
  assert.equal(response.headers.has('Access-Control-Allow-Credentials'), false,
    'Room bearer credentials must not enable ambient cookies.');
  const vary = tokens(response.headers.get('Vary'));
  assert.ok(vary.includes('origin'), 'Every response must vary by Origin, including absent or rejected origins.');
  if (chat) assert.ok(vary.includes('authorization'), 'Private chat caches must also vary by the room credential.');
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
}
async function request(api, route, options = {}) {
  const method = options.method ?? (Object.hasOwn(options, 'payload') || options.raw !== undefined ? 'POST' : 'GET');
  const origin = Object.hasOwn(options, 'origin') ? options.origin : pages;
  const headers = {
    ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    ...(origin === undefined ? {} : { Origin: origin }),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers ?? {}),
  };
  const response = await api[method](new Request(`${server}${route}`, {
    method, headers,
    ...(method === 'POST' ? { body: options.raw ?? JSON.stringify(options.payload) } : {}),
  }));
  const raw = await response.text();
  return { response, status: response.status, body: raw ? JSON.parse(raw) : null, raw };
}
const action = (payload, token, options = {}) => request(gameApi, '/api/game', { ...options, payload, token: globalThis.__gameTestDB ? fixtureGameToken(payload, token) : token });
const poll = (code, token, options = {}) => request(gameApi, `/api/game?code=${encodeURIComponent(code)}`, { ...options, token });
const message = (code, text = 'Hello from Pages') => ({ code, text, clientId: crypto.randomUUID() });
const chatPost = (payload, token, options = {}) => request(chatApi, '/api/chat', { ...options, payload, token });
const chatGet = (code, token, options = {}) => request(chatApi, `/api/chat?code=${encodeURIComponent(code)}`, { ...options, token });
async function lobby() {
  const host = await action({ action: 'create', name: 'Pages host', wordCount: 'small' });
  assert.equal(host.status, 201);
  const code = host.body.room.code;
  const guest = await action({ action: 'join', code, name: 'Original-site guest', teamId: 1 }, undefined, { origin: server });
  assert.equal(guest.status, 200);
  return { code, host: host.body, guest: guest.body };
}

test('Pages and original-site preflights work without a database and expose only the required capabilities', async () => {
  globalThis.__gameTestDB = undefined;
  for (const [api, pathname, chat] of [[gameApi, '/api/game', false], [chatApi, '/api/chat', true]]) {
    for (const origin of [pages, server, undefined]) {
      for (const method of ['GET', 'POST']) {
        const result = await request(api, pathname, { method: 'OPTIONS', origin, headers: {
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'aUtHoRiZaTiOn, cOnTeNt-TyPe',
        } });
        assert.equal(result.status, 204);
        assert.equal(result.raw, '');
        assertCors(result.response, { origin: origin ?? null, chat });
        assert.deepEqual(tokens(result.response.headers.get('Access-Control-Allow-Methods')).sort(), ['get', 'post']);
        assert.deepEqual(tokens(result.response.headers.get('Access-Control-Allow-Headers')).sort(), ['authorization', 'content-type']);
        assert.ok(Number(result.response.headers.get('Access-Control-Max-Age')) > 0);
      }
    }
  }
});

test('preflight never grants unexpected verbs or headers even when the Pages caller requests them', async () => {
  globalThis.__gameTestDB = undefined;
  for (const [api, pathname] of [[gameApi, '/api/game'], [chatApi, '/api/chat']]) {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const result = await request(api, pathname, { method: 'OPTIONS', headers: {
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'Authorization, X-Admin-Override',
      } });
      assertCors(result.response, { chat: api === chatApi });
      assert.equal(tokens(result.response.headers.get('Access-Control-Allow-Methods')).includes(method.toLowerCase()), false);
      assert.equal(tokens(result.response.headers.get('Access-Control-Allow-Headers')).includes('x-admin-override'), false);
    }
  }
});

test('foreign, opaque and lookalike Origins are rejected for reads, writes and preflight before database access', async () => {
  globalThis.__gameTestDB = undefined;
  const origins = ['null', 'http://le0n-97.github.io', 'https://le0n-97.github.io.evil.example',
    'https://evil.example', 'https://le0n-97.github.io:444', 'https://le0n-97.github.io/path',
    'https://le0n-97.github.io/', 'https://LE0N-97.github.io'];
  for (const [api, pathname, chat] of [[gameApi, '/api/game', false], [chatApi, '/api/chat', true]]) {
    for (const origin of origins) {
      for (const method of ['GET', 'POST', 'OPTIONS']) {
        const result = await request(api, pathname, { method, origin,
          ...(method === 'POST' ? { payload: {} } : {}),
          ...(method === 'OPTIONS' ? { headers: { 'Access-Control-Request-Method': 'POST' } } : {}),
        });
        assert.equal(result.status, 403, `${pathname} ${method} rejects ${origin}`);
        assertCors(result.response, { origin: null, chat });
      }
    }
  }
});

test('Pages and original-site participants share one authenticated room and word score', async t => {
  const { db, clock } = setup(t);
  const room = await lobby();
  const originalPoll = await poll(room.code, room.host.token, { origin: server });
  assert.equal(originalPoll.status, 200);
  assertCors(originalPoll.response, { origin: server });
  assert.equal(originalPoll.body.room.status, 'waiting');
  assert.deepEqual(originalPoll.body.room.board, []);
  const pagesPoll = await poll(room.code, room.guest.token);
  assert.equal(pagesPoll.status, 200);
  assertCors(pagesPoll.response);
  assert.equal(pagesPoll.body.playerId, room.guest.playerId);
  assert.equal('token' in pagesPoll.body, false);
  assert.ok(pagesPoll.body.room.players.every(player => !('secret' in player)));
  const started = await action({ action: 'start', code: room.code, round: 1 }, room.host.token);
  assert.equal(started.status, 200);
  assertCors(started.response);
  assert.equal(started.body.room.status, 'playing');
  const word = game.puzzleForGame(db.room(room.code)).words[0];
  clock.now += 1000;
  const found = await action({ action: 'word', code: room.code, round: 1, word }, room.guest.token, { origin: server });
  assert.equal(found.status, 200);
  assertCors(found.response, { origin: server });
  const observed = await poll(room.code, room.host.token);
  assert.equal(observed.status, 200);
  assertCors(observed.response);
  assert.equal(observed.body.room.words[0].word, word);
  assert.equal(observed.body.room.words[0].playerId, room.guest.playerId);
  assert.equal(observed.body.room.teams[1].score, word.length);
});

test('trusted cross-origin errors preserve CORS without bypassing room authentication, host or round checks', async t => {
  setup(t);
  const room = await lobby();
  const cases = [
    [() => poll(room.code), 401],
    [() => poll(room.code, 'forged'), 401],
    [() => poll('ABC234', room.host.token), 404],
    [() => action({ action: 'start', code: room.code }, room.guest.token), 403],
    [() => action({ action: 'commit', code: room.code }, room.host.token), 409],
    [() => action({ action: 'create', name: '' }, null), 401],
    [() => action({}, undefined, { raw: '{' }), 400],
    [() => action({}, undefined, { raw: 'x'.repeat(2049) }), 413],
  ];
  for (const [perform, status] of cases) {
    const result = await perform();
    assert.equal(result.status, status);
    assertCors(result.response);
    assert.equal(typeof result.body.error, 'string');
  }
  await action({ action: 'start', code: room.code }, room.host.token);
  for (const payload of [{ action: 'word', code: room.code, word: 'NOT-A-WORD' },
    { action: 'commit', code: room.code, round: 999 }]) {
    const result = await action(payload, room.host.token);
    assert.equal(result.status, payload.round ? 409 : 400);
    assertCors(result.response);
  }
  const committed = await action({ action: 'commit', code: room.code }, room.host.token);
  assert.equal(committed.status, 200);
  assertCors(committed.response);
  assert.equal(committed.body.room.teams[0].committed, true);
  assert.equal(committed.body.room.commitDeadline, 61000);
});

test('Pages chat interoperates with the original site while maintaining authentication and game-phase restrictions', async t => {
  setup(t);
  const room = await lobby();
  const sent = await chatPost(message(room.code), room.host.token);
  assert.equal(sent.status, 200);
  assertCors(sent.response, { chat: true });
  const received = await chatGet(room.code, room.guest.token, { origin: server });
  assert.equal(received.status, 200);
  assertCors(received.response, { origin: server, chat: true });
  assert.deepEqual(received.body.messages, [sent.body.message]);
  assert.equal(JSON.stringify(received.body).includes(room.host.token), false);
  for (const perform of [() => chatGet(room.code), () => chatPost(message(room.code), 'forged')]) {
    const result = await perform();
    assert.equal(result.status, 401);
    assertCors(result.response, { chat: true });
  }
  const tooSoon = await chatPost(message(room.code, 'Too soon'), room.host.token);
  assert.equal(tooSoon.status, 429);
  assertCors(tooSoon.response, { chat: true });
  await action({ action: 'start', code: room.code }, room.host.token);
  for (const perform of [() => chatGet(room.code, room.host.token), () => chatPost(message(room.code), room.guest.token)]) {
    const result = await perform();
    assert.equal(result.status, 409);
    assertCors(result.response, { chat: true });
    assert.equal('messages' in result.body, false);
  }
  await action({ action: 'commit', code: room.code }, room.host.token);
  await action({ action: 'commit', code: room.code }, room.guest.token);
  const finishedChat = await chatGet(room.code, room.host.token);
  assert.equal(finishedChat.status, 409);
  assertCors(finishedChat.response, { chat: true });
});

test('absent-Origin clients and original-site requests retain their existing API behavior', async t => {
  setup(t);
  const created = await action({ action: 'create', name: 'Original browser', wordCount: 'small' }, undefined, { origin: undefined });
  assert.equal(created.status, 201);
  assertCors(created.response, { origin: null });
  const code = created.body.room.code;
  const read = await poll(code, created.body.token, { origin: undefined });
  assert.equal(read.status, 200);
  assertCors(read.response, { origin: null });
  const sent = await chatPost(message(code), created.body.token, { origin: server });
  assert.equal(sent.status, 200);
  assertCors(sent.response, { origin: server, chat: true });
  const received = await chatGet(code, created.body.token, { origin: undefined });
  assert.equal(received.status, 200);
  assertCors(received.response, { origin: null, chat: true });
  assert.equal(received.body.messages.length, 1);
});

test('trusted request service failures are readable to Pages without broadening the CORS policy', async t => {
  globalThis.__gameTestDB = undefined;
  t.mock.method(console, 'error', () => {});
  for (const [api, pathname, chat, payload] of [[gameApi, '/api/game', false, { action: 'create', name: 'Host' }],
    [chatApi, '/api/chat', true, message('ABC234')]]) {
    const result = await request(api, pathname, { payload });
    assert.equal(result.status, 503);
    assertCors(result.response, { chat });
    assert.equal(typeof result.body.error, 'string');
  }
});

test('production records stay unavailable to Pages and emit no cross-origin permission even with loopback URLs', async () => {
  globalThis.__adminRecordsDev = false;
  globalThis.__gameTestDB = undefined;
  for (const url of [`${server}/api/admin/records`, 'http://127.0.0.1:5173/api/admin/records']) {
    for (const origin of [pages, server, 'null']) {
      const response = await recordsApi.GET(new Request(url, { headers: { Origin: origin, Host: '127.0.0.1:5173' } }));
      assert.equal(response.status, 404);
      assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
      assert.equal(response.headers.has('Access-Control-Allow-Credentials'), false);
      assert.match(response.headers.get('Cache-Control'), /no-store/);
    }
  }
});
