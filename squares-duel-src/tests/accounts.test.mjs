import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeURL, MemoryD1, assertPublic, legacyRoom } from './helpers.mjs';

const accountApi = await import(runtimeURL('account-route.mjs'));
const gameApi = await import(runtimeURL('route.mjs'));
const chatApi = await import(runtimeURL('chat-route.mjs'));
const { closedLegacyPage } = await import(runtimeURL('legacy-site.mjs'));
const server = 'https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site';
const origin = 'https://le0n-97.github.io';
const password = 'Correct horse 电池 17!';
function setup(t) {
  const db = new MemoryD1();
  globalThis.__gameTestDB = db;
  const clock = { now: 1_000_000 };
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => db.close());
  return { db, clock };
}
async function call(api, path, { payload, token, method = payload ? 'POST' : 'GET', headers = {}, raw } = {}) {
  const response = await api[method](new Request(server + path, {
    method, headers: { Origin: origin, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(method === 'POST' ? { body: raw ?? JSON.stringify(payload) } : {}),
  }));
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}
const account = (payload, token, extra) => call(accountApi, '/api/account', { payload, token, ...extra });
const register = (username = 'Alice', pass = password) => account({ action: 'register', username, password: pass });
const login = (username = 'Alice', pass = password) => account({ action: 'login', username, password: pass });
const me = token => call(accountApi, '/api/account', { token });
const gameAction = (payload, token) => call(gameApi, '/api/game', { payload, token });
const poll = (code, token) => call(gameApi, `/api/game?code=${code}`, { token });

// Pause real SQLite operations at a specific boundary without changing the KDF
// or production account code. Read snapshots can be captured before the pause.
function gateStatements(t, db, { matches, method, count = 1, snapshot = false }) {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const prepare = db.prepare.bind(db);
  let remaining = count;
  t.mock.method(db, 'prepare', sql => {
    function wrap(statement) {
      return {
        ...statement,
        bind: (...values) => wrap(statement.bind(...values)),
        [method]: async (...args) => {
          if (!matches(sql) || remaining <= 0) return statement[method](...args);
          remaining--;
          const result = snapshot ? await statement[method](...args) : undefined;
          if (!remaining) entered.resolve();
          await resumed.promise;
          return snapshot ? result : statement[method](...args);
        },
      };
    }
    return wrap(prepare(sql));
  });
  const release = () => resumed.resolve();
  t.after(release);
  t.signal.addEventListener('abort', () => { release(); entered.reject(t.signal.reason); }, { once: true });
  return { entered: entered.promise, release };
}

test('closed legacy pages return 410 while all API routes remain reachable', async () => {
  for (const path of ['/', '/?room=ABC234', '/admin', '/assets/old.js', '/signin-with-chatgpt']) {
    const response = closedLegacyPage(new Request(server + path));
    assert.equal(response.status, 410);
    assert.match(await response.text(), /https:\/\/le0n-97.github.io\/squares-duel\//);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
  }
  for (const path of ['/api/game', '/api/chat', '/api/account', '/api/admin/records']) assert.equal(closedLegacyPage(new Request(server + path)), null);
});

test('register stores only salted password hash and opaque hashed sessions; me exposes only profile', async t => {
  const { db } = setup(t);
  const first = await register();
  assert.equal(first.status, 201);
  assert.match(first.body.token, /^sq_account_/);
  assert.ok(first.body.token.length > 40);
  assert.equal(first.body.user.username.toLowerCase(), 'alice');
  assert.ok(first.body.expiresAt > Date.now());
  const stored = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'account%'").all();
  const serialized = stored.map(({ name }) => JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${name}`).all())).join('');
  assert.equal(serialized.includes(password), false);
  assert.equal(serialized.includes(first.body.token), false);
  const profile = await me(first.body.token);
  assert.equal(profile.status, 200);
  assert.deepEqual(Object.keys(profile.body.user).sort(), ['ratedGames', 'rating', 'username']);
  assert.equal(profile.body.user.rating, 1000);
  assert.equal(profile.body.user.ratedGames, 0);
  assert.match(profile.headers.get('Cache-Control'), /no-store/);
  assert.equal(profile.headers.get('Access-Control-Allow-Origin'), origin);
});

test('case insensitive login, generic invalid credentials, duplicate registration and password policy', async t => {
  setup(t);
  assert.equal((await register()).status, 201);
  assert.equal((await login('aLiCe')).status, 200);
  assert.equal((await register('ALICE')).status, 409);
  const wrong = await login('Alice', 'different password');
  const missing = await login('Nobody', 'different password');
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.body.error, missing.body.error);
  for (const [username, pass] of [['ab', password], ['a'.repeat(21), password], ['<script>', password], ['Valid', 'tiny'], ['Valid', 'a'.repeat(129)]]) {
    assert.equal((await register(username, pass)).status, 400);
  }
});

test('five-character passwords work for registration, login and password changes; four characters are rejected', async t => {
  setup(t);
  const first = await register('Alice', 'aB3!x');
  assert.equal(first.status, 201);
  assert.equal((await login('alice', 'aB3!x')).status, 200);
  assert.equal((await login('Alice', 'wrong')).status, 401);
  const short = await account({ action: 'password', password: 'aB3!x', newPassword: 'four' }, first.body.token);
  assert.equal(short.status, 400);
  const changed = await account({ action: 'password', password: 'aB3!x', newPassword: 'cD7?z' }, first.body.token);
  assert.equal(changed.status, 200);
  assert.equal((await login('Alice', 'aB3!x')).status, 401);
  assert.equal((await login('Alice', 'cD7?z')).status, 200);
});

test('logout and absolute expiry revoke account access to rooms and chat', async t => {
  const { clock } = setup(t);
  const registered = await register();
  const token = registered.body.token;
  const created = await gameAction({ action: 'create', name: 'Forged name' }, token);
  assert.equal(created.status, 201);
  const code = created.body.room.code;
  assert.equal((await account({ action: 'logout' }, token)).status, 200);
  assert.equal((await me(token)).status, 401);
  assert.equal((await poll(code, token)).status, 401);
  assert.equal((await call(chatApi, `/api/chat?code=${code}`, { token })).status, 401);
  const fresh = await login();
  assert.equal(fresh.status, 200);
  assert.equal((await poll(code, fresh.body.token)).status, 200);
  clock.now = fresh.body.expiresAt + 1;
  assert.equal((await me(fresh.body.token)).status, 401);
  assert.equal((await poll(code, fresh.body.token)).status, 401);
});

test('password change requires current password and revokes all other sessions', async t => {
  setup(t);
  const first = await register();
  const second = await login();
  const rejected = await account({ action: 'password', password: 'incorrect old password', newPassword: 'Brand new correct password' }, first.body.token);
  assert.equal(rejected.status, 401);
  const changed = await account({ action: 'password', password, newPassword: 'Brand new correct password' }, first.body.token);
  assert.equal(changed.status, 200);
  assert.match(changed.body.token, /^sq_account_/);
  for (const token of [first.body.token, second.body.token]) assert.equal((await me(token)).status, 401);
  assert.equal((await me(changed.body.token)).status, 200);
  assert.equal((await login('alice')).status, 401);
  assert.equal((await login('alice', 'Brand new correct password')).status, 200);
});

test('an old-password login verified before password change cannot create a session afterward', { timeout: 20_000 }, async t => {
  const { db } = setup(t);
  const registered = await register();
  const gate = gateStatements(t, db, {
    matches: sql => /^INSERT INTO account_sessions\b/.test(sql),
    method: 'run',
  });
  const oldLogin = login();
  let changed;
  let stale;
  try {
    // The old password has already passed scrypt; its session write is pending.
    await gate.entered;
    changed = await account({ action: 'password', password, newPassword: 'Replacement password 24!' }, registered.body.token);
    assert.equal(changed.status, 200);
    assert.equal((await me(changed.body.token)).status, 200);
  } finally {
    gate.release();
    stale = await oldLogin;
  }
  assert.equal(stale.status, 401);
  assert.equal(stale.body.token, undefined);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM account_sessions').get().count, 1);
  assert.equal((await me(registered.body.token)).status, 401);
  assert.equal((await me(changed.body.token)).status, 200);
  assert.equal((await login()).status, 401);
  assert.equal((await login('Alice', 'Replacement password 24!')).status, 200);
});

test('concurrent password changes have one winner and the loser cannot revoke the winning session', { timeout: 20_000 }, async t => {
  const { db } = setup(t);
  const first = await register();
  const second = await login();
  const nextPasswords = ['First competing password 17!', 'Second competing password 28!'];
  const gate = gateStatements(t, db, {
    matches: sql => /^SELECT\b.*\bpassword_hash\b.* FROM accounts WHERE id = \?$/.test(sql),
    method: 'first', count: 2, snapshot: true,
  });
  const changes = [first, second].map((session, index) => account({ action: 'password', password, newPassword: nextPasswords[index] }, session.body.token));
  let results;
  try {
    // Both changes observe the same original password version before either
    // verifies the password or writes its transaction.
    await gate.entered;
  } finally {
    gate.release();
    results = await Promise.all(changes);
  }
  assert.deepEqual(results.map(result => result.status).sort((a, b) => a - b), [200, 409]);
  const winner = results.findIndex(result => result.status === 200);
  const loser = 1 - winner;
  assert.equal(results[loser].body.token, undefined);
  assert.equal((await me(results[winner].body.token)).status, 200);
  for (const session of [first, second]) assert.equal((await me(session.body.token)).status, 401);
  const sessions = db.sqlite.prepare('SELECT password_version FROM account_sessions').all();
  assert.deepEqual(sessions.map(session => session.password_version), [1]);
  assert.equal((await login('Alice', nextPasswords[loser])).status, 401);
  assert.equal((await login('Alice', nextPasswords[winner])).status, 200);
});

test('account identity survives new session and reconnect never duplicates or changes existing team', async t => {
  setup(t);
  const a = await register();
  const created = await gameAction({ action: 'create', name: 'Impersonated' }, a.body.token);
  assert.equal(created.status, 201);
  const code = created.body.room.code;
  assert.equal(created.body.room.players[0].name.toLowerCase(), 'alice');
  assertPublic(assert, created.body.room);
  assert.equal(JSON.stringify(created.body.room).includes('accountId'), false);
  const b = await register('Bob');
  const joined = await gameAction({ action: 'join', code, name: 'Anything', teamId: 1 }, b.body.token);
  assert.equal(joined.status, 200);
  const refreshed = await login('bOB');
  const again = await gameAction({ action: 'join', code, name: 'Another', teamId: 0, role: 'spectator' }, refreshed.body.token);
  assert.equal(again.status, 200);
  assert.equal(again.body.playerId, joined.body.playerId);
  assert.equal(again.body.room.players.length, 2);
  assert.equal(again.body.room.spectators.length, 0);
  assert.equal(again.body.room.players.find(p => p.id === joined.body.playerId).teamId, 1);
  assert.equal((await gameAction({ action: 'start', code }, a.body.token)).status, 200);
  const playingReconnect = await gameAction({ action: 'join', code }, refreshed.body.token);
  assert.equal(playingReconnect.status, 200);
  assert.equal(playingReconnect.body.playerId, joined.body.playerId);
  assert.equal(playingReconnect.body.room.players.length, 2);
});

test('concurrent account join yields a single member and unknown/revoked account cannot act as guest', async t => {
  const { db } = setup(t);
  const hostAccount = db.seedAccount('Host');
  const host = await gameAction({ action: 'create' }, hostAccount.token);
  assert.equal(host.status, 201);
  const registered = await register();
  const code = host.body.room.code;
  db.syncNextReads(2);
  const results = await Promise.all([1, 2].map(() => gameAction({ action: 'join', code, teamId: 1 }, registered.body.token)));
  assert.ok(results.every(r => r.status === 200));
  assert.equal(results[0].body.playerId, results[1].body.playerId);
  assert.equal(db.room(code).players.length, 2);
  const intruder = await register('Intruder');
  assert.equal((await poll(code, intruder.body.token)).status, 401);
  assert.equal((await gameAction({ action: 'commit', code }, intruder.body.token)).status, 401);
  const forged = 'sq_account_' + '0'.repeat(64);
  assert.equal((await gameAction({ action: 'create', name: 'Fallback guest' }, forged)).status, 401);
});

test('account login is mandatory for creating rooms and joining as a player or spectator', async t => {
  const { db } = setup(t);
  const host = db.seedAccount('Host');
  const created = await gameAction({ action: 'create', name: 'Impersonated' }, host.token);
  assert.equal(created.status, 201);
  assert.equal(created.body.room.players[0].name, 'Host', 'The account username is authoritative.');
  const code = created.body.room.code;
  const expired = db.seedAccount('Expired', { expiresAt: Date.now() });
  const revoked = db.seedAccount('Revoked');
  db.sqlite.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(revoked.id);
  const baseline = [...db.rows];
  for (const token of [undefined, 'old-room-guest-token', 'sq_account_' + '0'.repeat(64), expired.token, revoked.token]) {
    assert.equal((await gameAction({ action: 'create', name: 'Visitor' }, token)).status, 401);
    for (const role of ['player', 'spectator']) {
      assert.equal((await gameAction({ action: 'join', code, name: 'Visitor', role, teamId: 1 }, token)).status, 401);
    }
  }
  assert.deepEqual([...db.rows], baseline, 'Denied create/join requests cannot create or alter rooms.');
});

test('stored legacy guest credentials cannot read, mutate or chat even after the room becomes overdue', async t => {
  const { db, clock } = setup(t);
  const token = 'previously-valid-guest-room-token';
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
  const legacy = legacyRoom(0, Date.now());
  legacy.players[0].secret = digest;
  legacy.spectators = [{ id: 'old-watcher', name: 'Old watcher', score: 0, committed: false, secret: digest }];
  db.seedRoom(legacy);
  const outsider = db.seedAccount('Unrelated');
  const baseline = [...db.rows];
  clock.now += 300_000;
  for (const credential of [undefined, token, outsider.token]) {
    assert.equal((await poll(legacy.code, credential)).status, 401);
    for (const action of ['start', 'team', 'word', 'commit', 'rematch']) {
      assert.equal((await gameAction({ action, code: legacy.code, role: 'spectator', word: 'TEST' }, credential)).status, 401);
    }
    assert.equal((await call(chatApi, `/api/chat?code=${legacy.code}`, { token: credential })).status, 401);
    assert.equal((await call(chatApi, '/api/chat', { token: credential, payload: {
      code: legacy.code, text: 'Guest chat must fail', clientId: crypto.randomUUID(),
    } })).status, 401);
  }
  assert.deepEqual([...db.rows], baseline, 'Denied legacy requests must not settle rooms or update timers.');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM room_chat').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM room_chat_rates').get().count, 0);
});

test('signed-in spectators retain lobby chat and board viewing while team permissions remain enforced', async t => {
  const { db } = setup(t);
  const host = db.seedAccount('Host');
  const opponent = db.seedAccount('Opponent');
  const watcher = db.seedAccount('Watcher');
  const created = await gameAction({ action: 'create', wordCount: 'small' }, host.token);
  const code = created.body.room.code;
  assert.equal((await gameAction({ action: 'join', code, teamId: 1 }, opponent.token)).status, 200);
  const spectating = await gameAction({ action: 'join', code, role: 'spectator' }, watcher.token);
  assert.equal(spectating.status, 200);
  assertPublic(assert, spectating.body.room);
  const sent = await call(chatApi, '/api/chat', { token: watcher.token, payload: {
    code, text: 'Ready to watch', clientId: crypto.randomUUID(),
  } });
  assert.equal(sent.status, 200);
  const received = await call(chatApi, `/api/chat?code=${code}`, { token: host.token });
  assert.deepEqual(received.body.messages.map(item => item.text), ['Ready to watch']);
  assert.equal((await gameAction({ action: 'start', code }, host.token)).status, 200);
  assert.equal((await poll(code, watcher.token)).body.room.board.length, 16);
  assert.equal((await gameAction({ action: 'commit', code }, watcher.token)).status, 403);
  assert.equal((await gameAction({ action: 'commit', code }, host.token)).status, 200);
  const settled = await gameAction({ action: 'commit', code }, opponent.token);
  assert.equal(settled.body.room.status, 'finished');
  assertPublic(assert, settled.body.room);
});

test('account API bounds request input and rejects foreign origins before touching storage', async t => {
  setup(t);
  assert.equal((await account(null, undefined, { method: 'POST', raw: '{' })).status, 400);
  assert.equal((await account(null, undefined, { method: 'POST', raw: 'x'.repeat(4097) })).status, 413);
  assert.equal((await account({ action: 'unknown' })).status, 400);
  globalThis.__gameTestDB = undefined;
  const forbidden = await account({ action: 'login', username: 'Alice', password }, undefined, { headers: { Origin: 'https://evil.example' } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null);
  const preflight = await call(accountApi, '/api/account', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
});

test('repeated login attempts are rate limited even when the username does not exist', async t => {
  setup(t);
  let limited = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await login('MissingUser', 'incorrect password');
    assert.ok([401, 429].includes(response.status));
    if (response.status === 429) { limited = true; break; }
  }
  assert.equal(limited, true);
});
