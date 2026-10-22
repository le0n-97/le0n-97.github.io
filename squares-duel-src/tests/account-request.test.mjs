import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeURL, MemoryD1 } from './helpers.mjs';

const { requestAccount, readAccount, AccountRequestError } = await import(runtimeURL('account-request.mjs'));
const accountApi = await import(runtimeURL('account-route.mjs'));
const server = 'https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site';
const origin = 'https://le0n-97.github.io';
const fields = { username: 'TestPlayer', password: 'aB3!x' };
const token = 'sq_account_' + 'a'.repeat(64);
const success = { user: { username: fields.username, rating: 1000, ratedGames: 0 }, token, expiresAt: Date.now() + 60_000 };
const json = (data = success, status = 200) => Response.json(data, { status });
const options = fetch => ({ fetch, retryDelayMs: 0 });

test('login retries a transient network failure once, without a session header or preflight-triggering content type', async () => {
  const calls = [];
  const result = await requestAccount('login', fields, 'stale-session', options(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    return json();
  }));
  assert.deepEqual(result, success);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, '/api/account');
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    assert.equal(new Headers(init.headers).get('Content-Type'), 'text/plain;charset=UTF-8');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(JSON.parse(init.body), { action: 'login', ...fields });
  }
});

test('repeated network failures produce a Chinese retry message after a bounded attempt count', async () => {
  let calls = 0;
  await assert.rejects(requestAccount('login', fields, undefined, options(async () => {
    calls++; throw new TypeError('Failed to fetch');
  })), error => error instanceof AccountRequestError && /连接.*重试/.test(error.message) && !/Failed to fetch/.test(error.message));
  assert.equal(calls, 2);
});

test('timeouts use AbortController and stop after one retry', async () => {
  let calls = 0;
  await assert.rejects(requestAccount('login', fields, undefined, {
    retryDelayMs: 0, timeoutMs: 5,
    fetch: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    },
  }), error => error instanceof AccountRequestError && /超时/.test(error.message));
  assert.equal(calls, 2);
});

test('HTTP 5xx and broken gateway responses can recover, while application errors are not retried', async () => {
  let calls = 0;
  assert.deepEqual(await requestAccount('login', fields, undefined, options(async () => {
    return ++calls === 1 ? new Response('<html>temporary gateway error</html>', { status: 502 }) : json();
  })), success);
  assert.equal(calls, 2);
  for (const status of [400, 401, 409, 429]) {
    calls = 0;
    await assert.rejects(requestAccount('login', fields, undefined, options(async () => {
      calls++; return json({ error: '请稍后重试。' }, status);
    })), error => error instanceof AccountRequestError && error.status === status && error.message === '请稍后重试。');
    assert.equal(calls, 1);
  }
});

test('profile reads retry temporary failures, preserve Bearer auth and do not retry expired sessions', async () => {
  let calls = 0;
  const result = await readAccount(token, options(async (_url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${token}`);
    if (++calls === 1) throw new TypeError('Network error');
    return json({ user: success.user });
  }));
  assert.deepEqual(result.user, success.user);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(readAccount(token, options(async () => {
    calls++; return json({ error: '请重新登录。' }, 401);
  })), { status: 401 });
  assert.equal(calls, 1);
});

function database(t) {
  const db = new MemoryD1();
  globalThis.__gameTestDB = db;
  t.after(() => { db.close(); delete globalThis.__gameTestDB; });
  return db;
}
async function route(init) {
  return accountApi[init.method](new Request(server + '/api/account', {
    ...init, headers: { ...init.headers, Origin: origin },
  }));
}

test('a lost registration response recovers the actual account with its password, without creating it twice', async t => {
  const db = database(t);
  const actions = [];
  const result = await requestAccount('register', fields, undefined, options(async (_url, init) => {
    actions.push(JSON.parse(init.body).action);
    const response = await route(init);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    if (actions.length === 1) { assert.equal(response.status, 201); throw new TypeError('Failed to fetch'); }
    return response;
  }));
  assert.deepEqual(actions, ['register', 'login']);
  assert.equal(result.user.username, fields.username);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1);
  const restored = await readAccount(result.token, options((_url, init) => route(init)));
  assert.equal(restored.user.username, fields.username);
});

test('registration retries creation only after credential recovery confirms that no matching account exists', async t => {
  const db = database(t);
  const actions = [];
  const result = await requestAccount('register', fields, undefined, options(async (_url, init) => {
    actions.push(JSON.parse(init.body).action);
    if (actions.length === 1) throw new TypeError('Failed to fetch');
    return route(init);
  }));
  assert.deepEqual(actions, ['register', 'login', 'register']);
  assert.equal(result.user.username, fields.username);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1);
});

test('registration recovery respects rate limits and never treats a wrong password as successful registration', async t => {
  database(t);
  let calls = 0;
  await assert.rejects(requestAccount('register', fields, undefined, options(async () => {
    if (++calls === 1) throw new TypeError('Failed to fetch');
    return json({ error: '尝试次数过多。' }, 429);
  })), { status: 429 });
  assert.equal(calls, 2);
  await requestAccount('register', fields, undefined, options((_url, init) => route(init)));
  calls = 0;
  await assert.rejects(requestAccount('register', { ...fields, password: 'wrong' }, undefined, options(async (_url, init) => {
    if (++calls === 1) throw new TypeError('Failed to fetch');
    return route(init);
  })), { status: 409 });
  assert.equal(calls, 3);
});

test('password changes are not automatically resubmitted after an uncertain response', async () => {
  let calls = 0;
  await assert.rejects(requestAccount('password', { password: 'oldpw', newPassword: 'newpw' }, token, options(async (_url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${token}`);
    throw new TypeError('Failed to fetch');
  })), AccountRequestError);
  assert.equal(calls, 1);
});
