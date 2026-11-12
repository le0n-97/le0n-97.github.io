import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { MemoryD1, runtimeURL } from './helpers.mjs';

const accountApi = await import(runtimeURL('account-route.mjs'));
const resetApi = await import(runtimeURL('password-reset-route.mjs'));
const server = 'https://backend.example';
const pagesOrigin = 'https://le0n-97.github.io';
const oldPassword = 'Original test password 17!';
const newPassword = 'Replacement test password 29!';

function setup(t) {
  const db = new MemoryD1();
  globalThis.__gameTestDB = db;
  t.mock.method(Date, 'now', () => 1_000_000);
  t.after(() => {
    delete globalThis.__gameTestDB;
    delete globalThis.__testPasswordReset;
    db.close();
  });
  return db;
}

function configure(username, { code = randomBytes(32).toString('hex'), expiresAt = Date.now() + 60_000 } = {}) {
  const tokenHash = createHash('sha256').update(code).digest('hex');
  globalThis.__testPasswordReset = JSON.stringify({ username, tokenHash, expiresAt });
  return code;
}

async function call(api, path, { payload, token, method = payload ? 'POST' : 'GET', origin = pagesOrigin } = {}) {
  const response = await api[method](new Request(`${server}${path}`, {
    method,
    headers: { Origin: origin, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }));
  const body = await response.text();
  return { status: response.status, headers: response.headers, body: body ? JSON.parse(body) : null };
}

const reset = (payload, options) => call(resetApi, '/api/account/reset', { payload, ...options });
const account = (payload, token) => call(accountApi, '/api/account', { payload, token });
const register = username => account({ action: 'register', username, password: oldPassword });
const login = (username, password) => account({ action: 'login', username, password });

test('disabled, wrong, expired, and missing-account reset codes all fail without changing a player', async t => {
  const db = setup(t);
  const player = db.seedAccount('RecoveryPlayer');
  const another = db.seedAccount('OtherPlayer');
  const noConfig = await reset({ code: randomBytes(32).toString('hex'), newPassword });
  const validCode = configure(player.username);
  const wrongCode = await reset({ code: randomBytes(32).toString('hex'), newPassword });
  configure(player.username, { code: validCode, expiresAt: Date.now() });
  const expired = await reset({ code: validCode, newPassword });
  const missing = await reset({ code: configure('MissingPlayer'), newPassword });
  for (const denied of [noConfig, wrongCode, expired, missing]) {
    assert.equal(denied.status, 410);
    assert.equal(typeof denied.body.error, 'string');
    assert.deepEqual(denied.body, noConfig.body);
  }
  assert.equal((await account(undefined, player.token)).status, 200);
  assert.equal((await account(undefined, another.token)).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM account_password_resets').get().count, 0);
});

test('reset honors trusted origins and a failed validation does not spend the code', async t => {
  setup(t).seedAccount('RecoveryPlayer');
  const code = configure('RecoveryPlayer');
  const forbidden = await reset({ code, newPassword }, { origin: 'https://not-trusted.example' });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null);
  const options = await call(resetApi, '/api/account/reset', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), pagesOrigin);
  const short = await reset({ code, newPassword: 'four' });
  assert.equal(short.status, 400);
  for (let i = 0; i < 2; i++) {
    const available = await reset({ code, checkOnly: true });
    assert.equal(available.status, 200);
    assert.deepEqual(available.body, { ok: true });
    assert.match(available.headers.get('Cache-Control'), /no-store/);
  }
});

test('successful reset changes only the designated account, preserves Rating and requires a fresh login', async t => {
  const db = setup(t);
  const registered = await register('RecoveryPlayer');
  const other = await register('OtherPlayer');
  assert.equal(registered.status, 201);
  assert.equal(other.status, 201);
  const anotherSession = await login('RecoveryPlayer', oldPassword);
  assert.equal(anotherSession.status, 200);
  db.sqlite.prepare('UPDATE accounts SET rating_milli = ?, rated_games = ? WHERE username_key = ?').run(1_236_750, 9, 'recoveryplayer');
  const readAccount = () => db.sqlite.prepare('SELECT id, username, rating_milli, rated_games FROM accounts WHERE username_key = ?').get('recoveryplayer');
  const before = readAccount();
  const code = configure('RecoveryPlayer');

  const recovered = await reset({ code, newPassword, username: 'OtherPlayer' });
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body, { ok: true }, 'Recovery must not return credentials or account details.');
  assert.deepEqual(readAccount(), before);
  for (const token of [registered.body.token, anotherSession.body.token]) assert.equal((await account(undefined, token)).status, 401);
  assert.equal((await account(undefined, other.body.token)).status, 200);
  assert.equal((await login('OtherPlayer', oldPassword)).status, 200);
  assert.equal((await login('RecoveryPlayer', oldPassword)).status, 401);
  const fresh = await login('RecoveryPlayer', newPassword);
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.user, { username: 'RecoveryPlayer', rating: 1236.75, ratedGames: 9 });
  assert.equal((await reset({ code, checkOnly: true })).status, 410);
  assert.equal((await reset({ code, newPassword: oldPassword })).status, 410);
  assert.equal((await account(undefined, fresh.body.token)).status, 200);
  const uses = db.sqlite.prepare('SELECT * FROM account_password_resets').all();
  assert.equal(uses.length, 1);
  assert.equal(JSON.stringify(uses).includes(code), false);
});

test('concurrent uses of the same reset code yield exactly one new password', { timeout: 20_000 }, async t => {
  const db = setup(t);
  const { token } = db.seedAccount('RecoveryPlayer');
  const code = configure('RecoveryPlayer');
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  t.signal.addEventListener('abort', () => gate.resolve(), { once: true });
  const batch = db.batch.bind(db);
  let arrived = 0;
  t.mock.method(db, 'batch', async statements => {
    if (statements.some(statement => /\bINSERT\b[\s\S]*?\bINTO\s+account_password_resets\b/i.test(statement.sql))) {
      if (++arrived === 2) gate.resolve();
      await gate.promise;
    }
    return batch(statements);
  });

  const passwords = ['First competing password 37!', 'Second competing password 64!'];
  const results = await Promise.all(passwords.map(newPassword => reset({ code, newPassword })));
  assert.equal(arrived, 2, 'Both requests must reach the write boundary before either proceeds.');
  assert.deepEqual(results.map(result => result.status).sort((a, b) => a - b), [200, 410]);
  const winner = results.findIndex(result => result.status === 200);
  const loser = 1 - winner;
  assert.equal((await account(undefined, token)).status, 401);
  assert.equal((await login('RecoveryPlayer', passwords[loser])).status, 401);
  assert.equal((await login('RecoveryPlayer', passwords[winner])).status, 200);
});
