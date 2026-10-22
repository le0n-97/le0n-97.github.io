import test from 'node:test';
import assert from 'node:assert/strict';
import { game, runtimeURL, MemoryD1 } from './helpers.mjs';

const leaderboardApi = await import(runtimeURL('leaderboard-route.mjs'));
const gameApi = await import(runtimeURL('route.mjs'));
const server = 'https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site';
const pages = 'https://le0n-97.github.io';
function setup(t) {
  const db = new MemoryD1();
  const clock = { now: 1_000_000 };
  globalThis.__gameTestDB = db;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => { db.close(); delete globalThis.__gameTestDB; });
  return { db, clock };
}
function rated(db, name, ratingMilli, games = 1) {
  const member = db.seedAccount(name);
  db.sqlite.prepare('UPDATE accounts SET rating_milli = ?, rated_games = ? WHERE id = ?').run(ratingMilli, games, member.id);
  return member;
}
async function leaderboard(token, query = '', options = {}) {
  const method = options.method ?? 'GET';
  const origin = Object.hasOwn(options, 'origin') ? options.origin : pages;
  const response = await leaderboardApi[method](new Request(`${server}/api/leaderboard${query}`, {
    method,
    headers: {
      ...(origin === undefined ? {} : { Origin: origin }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  }));
  const raw = await response.text();
  return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) : null, raw };
}
function assertPrivateCors(result, origin = pages) {
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin ?? null);
  assert.equal(result.headers.has('Access-Control-Allow-Credentials'), false);
  assert.match(result.headers.get('Cache-Control') ?? '', /no-store/);
  const vary = (result.headers.get('Vary') ?? '').toLowerCase().split(',').map(item => item.trim());
  assert.ok(vary.includes('origin'));
  assert.ok(vary.includes('authorization'));
}
function assertEntry(entry, expected) {
  assert.deepEqual(Object.keys(entry).sort(), ['isMe', 'position', 'rank', 'ratedGames', 'rating', 'username']);
  assert.deepEqual(entry, expected);
}

test('leaderboard requires an active account and denies former guest or malformed credentials', async t => {
  const { db, clock } = setup(t);
  const valid = rated(db, 'Alice', 1_100_000);
  const expired = db.seedAccount('Expired', { expiresAt: clock.now });
  const revoked = db.seedAccount('Revoked');
  const versionChanged = db.seedAccount('ChangedPassword');
  db.sqlite.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(revoked.id);
  db.sqlite.prepare('UPDATE accounts SET password_version = password_version + 1 WHERE id = ?').run(versionChanged.id);
  for (const token of [undefined, 'secret-old-guest', 'sq_guest_abc', 'sq_account_bad', `sq_account_${'0'.repeat(64)}`, expired.token, revoked.token, versionChanged.token]) {
    const result = await leaderboard(token);
    assert.equal(result.status, 401);
    assert.deepEqual(Object.keys(result.body), ['error']);
    assert.equal(typeof result.body.error, 'string');
    assertPrivateCors(result);
  }
  for (const authorization of ['Basic abc', 'bearer abc', 'Bearer', `Bearer ${'x'.repeat(201)}`]) {
    assert.equal((await leaderboard(undefined, '', { headers: { Authorization: authorization } })).status, 401);
  }
  assert.equal((await leaderboard(valid.token)).status, 200);
});

test('leaderboard preflight needs no database; foreign origins are rejected before database access', async () => {
  globalThis.__gameTestDB = undefined;
  for (const origin of [pages, server, undefined]) {
    const result = await leaderboard(undefined, '', { method: 'OPTIONS', origin, headers: {
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization',
    } });
    assert.equal(result.status, 204);
    assert.equal(result.raw, '');
    assertPrivateCors(result, origin ?? null);
    assert.ok(result.headers.get('Access-Control-Allow-Methods').split(/,\s*/).includes('GET'));
    assert.match(result.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  }
  for (const origin of ['null', 'https://evil.example', 'http://le0n-97.github.io', 'https://le0n-97.github.io.evil.example', `${pages}/`]) {
    for (const method of ['GET', 'OPTIONS']) {
      const result = await leaderboard('sq_account_' + '0'.repeat(64), '', { method, origin });
      assert.equal(result.status, 403);
      assertPrivateCors(result, null);
    }
  }
});

test('leaderboard accepts authenticated same-origin and direct requests without weakening cache isolation', async t => {
  const { db } = setup(t);
  const member = rated(db, 'Alice', 1_100_000);
  for (const origin of [pages, server, undefined]) {
    const result = await leaderboard(member.token, '', { origin });
    assert.equal(result.status, 200);
    assertPrivateCors(result, origin ?? null);
  }
});

test('unplayed accounts stay off the leaderboard while an empty leaderboard still returns the current profile', async t => {
  const { db, clock } = setup(t);
  const member = rated(db, 'NewPlayer', 1_000_000, 0);
  rated(db, 'UnplayedHighRating', 5_000_000, 0);
  const result = await leaderboard(member.token);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['entries', 'generatedAt', 'limit', 'me', 'offset', 'total']);
  assert.deepEqual(result.body.entries, []);
  assert.equal(result.body.total, 0);
  assert.equal(result.body.offset, 0);
  assert.equal(result.body.limit, 20);
  assert.equal(result.body.generatedAt, clock.now);
  assertEntry(result.body.me, { rank: null, position: null, username: member.username, rating: 1000, ratedGames: 0, isMe: true });
});

test('exact Rating ties share competition rank, use username ordering and preserve thousandths including negative ratings', async t => {
  const { db } = setup(t);
  rated(db, 'Leader', 1_200_000, 4);
  const zulu = rated(db, 'zulu', 1_100_000, 2);
  const alpha = rated(db, 'Alpha', 1_100_000, 9);
  rated(db, 'AlmostEqual', 1_099_999, 3);
  rated(db, 'Negative', -1_001, 1);
  rated(db, 'Unplayed', 9_000_000, 0);
  const result = await leaderboard(zulu.token);
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 5);
  assert.deepEqual(result.body.entries.map(({ rank, position, username, rating, isMe }) => ({ rank, position, username, rating, isMe })), [
    { rank: 1, position: 1, username: 'Leader', rating: 1200, isMe: false },
    { rank: 2, position: 2, username: alpha.username, rating: 1100, isMe: false },
    { rank: 2, position: 3, username: zulu.username, rating: 1100, isMe: true },
    { rank: 4, position: 4, username: 'AlmostEqual', rating: 1099.999, isMe: false },
    { rank: 5, position: 5, username: 'Negative', rating: -1.001, isMe: false },
  ]);
  assertEntry(result.body.me, { rank: 2, position: 3, username: zulu.username, rating: 1100, ratedGames: 2, isMe: true });
  assert.deepEqual((await leaderboard(zulu.token)).body.entries, result.body.entries);
});

test('pagination uses ordinal positions across ties and always includes the current off-page profile', async t => {
  const { db } = setup(t);
  const members = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map(name => rated(db, name, 1_100_000));
  const first = await leaderboard(members[4].token, '?limit=2');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.entries.map(entry => entry.username), ['Alpha', 'Bravo']);
  assert.deepEqual(first.body.entries.map(entry => entry.rank), [1, 1]);
  assert.equal(first.body.me.rank, 1);
  assert.equal(first.body.me.position, 5);
  const middle = await leaderboard(members[4].token, '?offset=2&limit=2');
  assert.equal(middle.body.offset, 2);
  assert.equal(middle.body.limit, 2);
  assert.equal(middle.body.total, 5);
  assert.deepEqual(middle.body.entries.map(entry => entry.username), ['Charlie', 'Delta']);
  assert.deepEqual(middle.body.entries.map(entry => entry.position), [3, 4]);
  const last = await leaderboard(members[4].token, '?offset=4&limit=2');
  assert.deepEqual(last.body.entries, [last.body.me]);
  assert.equal(last.body.entries[0].position, 5);
  const pastEnd = await leaderboard(members[4].token, '?offset=1000000&limit=50');
  assert.equal(pastEnd.status, 200);
  assert.deepEqual(pastEnd.body.entries, []);
  assert.equal(pastEnd.body.total, 5);
  assert.deepEqual(pastEnd.body.me, first.body.me);
});

test('default page is bounded and maximum page sizes do not hide overall rank or total', async t => {
  const { db } = setup(t);
  const members = Array.from({ length: 55 }, (_, index) => rated(db, `Player_${String(index).padStart(2, '0')}`, 1_200_000 - index));
  const normal = await leaderboard(members[54].token);
  assert.equal(normal.status, 200);
  assert.equal(normal.body.entries.length, 20);
  assert.equal(normal.body.total, 55);
  assert.equal(normal.body.me.rank, 55);
  const max = await leaderboard(members[54].token, '?limit=50');
  assert.equal(max.status, 200);
  assert.equal(max.body.entries.length, 50);
  const next = await leaderboard(members[54].token, '?offset=50&limit=50');
  assert.equal(next.body.entries.length, 5);
  assert.equal(next.body.entries.at(-1).rank, 55);
  assert.equal(next.body.entries.at(-1).isMe, true);
  const smallest = await leaderboard(members[54].token, '?offset=0&limit=1');
  assert.equal(smallest.status, 200);
  assert.equal(smallest.body.entries.length, 1);
});

test('invalid or ambiguous pagination is rejected instead of silently truncating or wrapping input', async t => {
  const { db } = setup(t);
  const member = rated(db, 'Alice', 1_000_000);
  for (const query of [
    '?limit=0', '?limit=51', '?limit=-1', '?limit=1.5', '?limit=1e1', '?limit=NaN', '?limit=Infinity', '?limit=',
    '?limit=%2B1', '?limit=%201', '?limit=1%20', '?limit=01', '?limit=1&limit=2',
    '?offset=-1', '?offset=1000001', '?offset=0.5', '?offset=1e2', '?offset=', '?offset=00',
    '?offset=%2B1', '?offset=0&offset=1', '?offset=9007199254740992', '?limit=9007199254740992',
  ]) {
    const result = await leaderboard(member.token, query);
    assert.equal(result.status, 400, query);
    assert.deepEqual(Object.keys(result.body), ['error']);
    assertPrivateCors(result);
  }
});

test('leaderboard exposes only public profile fields and performs no account, room or ledger writes', async t => {
  const { db } = setup(t);
  const mine = rated(db, 'Alice', 1_002_133, 2);
  const other = rated(db, 'Bobby', 997_867, 2);
  const changesBefore = db.sqlite.prepare('SELECT total_changes() AS n').get().n;
  const result = await leaderboard(mine.token);
  assert.equal(result.status, 200);
  assert.equal(db.sqlite.prepare('SELECT total_changes() AS n').get().n, changesBefore);
  for (const entry of [...result.body.entries, result.body.me]) {
    assert.deepEqual(Object.keys(entry).sort(), ['isMe', 'position', 'rank', 'ratedGames', 'rating', 'username']);
  }
  for (const value of [mine.id, other.id, mine.token, other.token, 'fixture-password-not-used', 'password_hash', 'password_version', 'token_hash', 'username_key', 'rating_changes', 'rating_rounds', 'room', 'record_json']) {
    assert.equal(result.raw.includes(value), false, `does not publish ${value}`);
  }
});

test('entry list, count and my rank reflect one profile snapshot even if ratings change after authentication', async t => {
  const { db } = setup(t);
  const mine = db.seedAccount('Alice');
  rated(db, 'Bobby', 1_100_000);
  const prepare = db.prepare.bind(db);
  let changed = false;
  t.mock.method(db, 'prepare', sql => {
    function wrap(statement) {
      return { ...statement, bind: (...values) => wrap(statement.bind(...values)), first: async () => {
        const result = await statement.first();
        if (!changed && /FROM account_sessions\b/.test(sql)) {
          changed = true;
          db.sqlite.prepare('UPDATE accounts SET rating_milli = ?, rated_games = 1 WHERE id = ?').run(1_200_001, mine.id);
        }
        return result;
      } };
    }
    return wrap(prepare(sql));
  });
  const result = await leaderboard(mine.token);
  assert.equal(changed, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 2);
  assertEntry(result.body.me, { rank: 1, position: 1, username: mine.username, rating: 1200.001, ratedGames: 1, isMe: true });
  assert.deepEqual(result.body.entries[0], result.body.me);
});

test('a real settled game immediately adds both players to the leaderboard and repeated reads never apply Rating again', async t => {
  const { db } = setup(t);
  const members = ['Alice', 'Bobby'].map(name => db.seedAccount(name));
  const post = async (token, payload) => {
    const response = await gameApi.POST(new Request(`${server}/api/game`, {
      method: 'POST', headers: { Origin: pages, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }));
    assert.ok([200, 201].includes(response.status));
    return response.json();
  };
  const before = await leaderboard(members[0].token);
  assert.equal(before.body.total, 0);
  const created = await post(members[0].token, { action: 'create', wordCount: 'small' });
  const code = created.room.code;
  await post(members[1].token, { action: 'join', code, teamId: 1 });
  await post(members[0].token, { action: 'start', code });
  const state = db.room(code);
  const word = game.puzzleForGame(state).words[0];
  state.generatedPuzzle.words = [word];
  db.replaceRoom(code, state);
  const ended = await post(members[0].token, { action: 'word', code, word, path: game.findPath(state.board, word) });
  assert.equal(ended.room.status, 'finished');
  assert.equal(ended.room.ratingResult.rated, true);
  const settledChanges = db.sqlite.prepare('SELECT total_changes() AS n').get().n;
  for (const token of [members[0].token, members[1].token, members[0].token]) {
    const result = await leaderboard(token);
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 2);
    assert.deepEqual(result.body.entries.map(({ username, rating, ratedGames }) => ({ username, rating, ratedGames })), [
      { username: 'Alice', rating: 1016, ratedGames: 1 }, { username: 'Bobby', rating: 984, ratedGames: 1 },
    ]);
    assert.equal(result.body.me.username, token === members[0].token ? 'Alice' : 'Bobby');
    assert.ok(result.body.entries.find(entry => entry.isMe));
  }
  assert.equal(db.sqlite.prepare('SELECT total_changes() AS n').get().n, settledChanges);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM rating_rounds').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM rating_changes').get().n, 2);
});

test('leaderboard database failures return a private retryable error without SQL or credential details', async t => {
  const { db } = setup(t);
  const member = rated(db, 'Alice', 1_000_000);
  const secret = 'private-rating-query-and-password-hash';
  const logged = t.mock.method(console, 'error', () => {});
  t.mock.method(db, 'prepare', () => { throw new Error(secret); });
  const result = await leaderboard(member.token);
  assert.equal(result.status, 503);
  assert.deepEqual(Object.keys(result.body), ['error']);
  assert.equal(typeof result.body.error, 'string');
  assert.equal(result.raw.includes(secret), false);
  assert.equal(JSON.stringify(logged.mock.calls.map(call => call.arguments)).includes(secret), false);
  assertPrivateCors(result);
});
