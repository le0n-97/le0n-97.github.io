import test from 'node:test';
import assert from 'node:assert/strict';
import { game, puzzles, runtimeURL, MemoryD1, assertPublic } from './helpers.mjs';

const gameApi = await import(runtimeURL('route.mjs'));
const accountApi = await import(runtimeURL('account-route.mjs'));
const server = 'https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site';
const origin = 'https://le0n-97.github.io';
function setup(t) {
  const db = new MemoryD1();
  const clock = { now: 1_000_000 };
  globalThis.__gameTestDB = db;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => { db.close(); delete globalThis.__adminRecordsDev; });
  return { db, clock };
}
async function call(api, path, token, payload) {
  const response = await api[payload ? 'POST' : 'GET'](new Request(server + path, {
    method: payload ? 'POST' : 'GET', headers: { Origin: origin, Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }));
  return { status: response.status, body: await response.json() };
}
const post = (payload, token) => call(gameApi, '/api/game', token, payload);
const poll = (code, token) => call(gameApi, `/api/game?code=${code}`, token);
const profile = token => call(accountApi, '/api/account', token);
function stats(db, member) {
  return db.sqlite.prepare('SELECT rating_milli, rated_games FROM accounts WHERE id = ?').get(member.id);
}
function ledgerCounts(db) {
  return { rounds: db.sqlite.prepare('SELECT COUNT(*) AS n FROM rating_rounds').get().n, changes: db.sqlite.prepare('SELECT COUNT(*) AS n FROM rating_changes').get().n };
}
async function lobby(db, members, teams = members.map((_, index) => index % 2)) {
  const host = await post({ action: 'create', wordCount: 'small' }, members[0].token);
  assert.equal(host.status, 201);
  const code = host.body.room.code;
  const playerIds = [host.body.playerId];
  if (teams[0] !== 0) assert.equal((await post({ action: 'team', code, role: 'player', teamId: teams[0] }, members[0].token)).status, 200);
  for (let i = 1; i < members.length; i++) {
    const joined = await post({ action: 'join', code, teamId: teams[i] }, members[i].token);
    assert.equal(joined.status, 200);
    playerIds.push(joined.body.playerId);
  }
  return { code, members, playerIds };
}
async function start(room) {
  const result = await post({ action: 'start', code: room.code }, room.members[0].token);
  assert.equal(result.status, 200);
  return result.body.room;
}
function scoresFor(db, room, scores) {
  const stored = db.room(room.code);
  // Only fixture outcomes are set directly. Rating snapshots/auth/CAS/settlement
  // all run through the real route and SQLite transaction.
  stored.players.forEach((player, index) => { player.score = scores[index]; });
  if (scores.some(score => score > 0)) {
    const word = game.puzzleForGame(stored).words[0];
    stored.words = [{ word, points: word.length, bonus: false, playerId: stored.players[0].id, teamId: stored.players[0].teamId, at: Date.now() }];
  }
  db.replaceRoom(room.code, stored);
}
async function finish(room) {
  let last;
  for (const member of room.members) {
    last = await post({ action: 'commit', code: room.code }, member.token);
    assert.equal(last.status, 200);
  }
  assert.equal(last.body.room.status, 'finished');
  return last.body.room;
}

test('accounts start at 1000; live unequal-team snapshots expose score-share expectations and hide account identities', async t => {
  const { db } = setup(t);
  const members = ['Solo', 'BlueOne', 'BlueTwo'].map(name => db.seedAccount(name));
  assert.equal((await profile(members[0].token)).body.user.rating, 1000);
  const room = await lobby(db, members, [0, 1, 1]);
  const started = await start(room);
  assert.ok(Math.abs(started.rating.expectedShares[0] - 1 / 3) < 1e-12);
  assert.ok(Math.abs(started.rating.expectedShares[1] - 2 / 3) < 1e-12);
  assertPublic(assert, started);
  assert.equal('ratingRound' in started, false);
  const publicJSON = JSON.stringify(started);
  for (const member of members) assert.equal(publicJSON.includes(member.id), false);
  assert.equal(started.players[0].rating, 1000);
  assert.equal(ledgerCounts(db).rounds, 0);
});

test('a solo player can gain after a close loss; team transfer is split and spectators are untouched', async t => {
  const { db } = setup(t);
  const members = ['Solo', 'BlueOne', 'BlueTwo'].map(name => db.seedAccount(name));
  const watcher = db.seedAccount('Watcher');
  const room = await lobby(db, members, [0, 1, 1]);
  assert.equal((await post({ action: 'join', code: room.code, role: 'spectator' }, watcher.token)).status, 200);
  await start(room);
  scoresFor(db, room, [40, 30, 30]);
  const ended = await finish(room);
  assert.equal(ended.ratingResult.rated, true);
  assert.deepEqual(ended.ratingResult.actualShares, [0.4, 0.6]);
  assert.ok(ended.ratingResult.changes.find(change => change.playerId === room.playerIds[0]).delta > 0);
  const updated = members.map(member => stats(db, member));
  assert.equal(updated.reduce((total, row) => total + row.rating_milli, 0), 3_000_000);
  assert.ok(updated[0].rating_milli > 1_000_000);
  assert.ok(updated.slice(1).every(row => row.rating_milli < 1_000_000));
  assert.ok(updated.every(row => row.rated_games === 1));
  assert.deepEqual({ ...stats(db, watcher) }, { rating_milli: 1_000_000, rated_games: 0 });
  assert.deepEqual(ledgerCounts(db), { rounds: 1, changes: 3 });
  const current = await profile(members[0].token);
  assert.equal(current.body.user.rating, updated[0].rating_milli / 1000);
  assert.equal(current.body.user.ratedGames, 1);
  assert.equal(JSON.stringify(ended.ratingResult).includes('accountId'), false);
});

test('normal API word submission, exhaustive-board finish and repeated polls apply Rating exactly once', async t => {
  const { db } = setup(t);
  const members = ['Alice', 'Bobby'].map(name => db.seedAccount(name));
  const room = await lobby(db, members);
  await start(room);
  const stored = db.room(room.code);
  const word = game.puzzleForGame(stored).words[0];
  stored.generatedPuzzle.words = [word];
  db.replaceRoom(room.code, stored);
  const claim = await post({ action: 'word', code: room.code, word, path: game.findPath(stored.board, word) }, members[0].token);
  assert.equal(claim.status, 200);
  assert.equal(claim.body.room.status, 'finished');
  assert.equal(claim.body.room.ratingResult.rated, true);
  assert.deepEqual(members.map(member => stats(db, member).rating_milli), [1_016_000, 984_000]);
  for (let i = 0; i < 3; i++) assert.equal((await poll(room.code, members[i % 2].token)).status, 200);
  assert.deepEqual(ledgerCounts(db), { rounds: 1, changes: 2 });
  assert.ok(members.every(member => stats(db, member).rated_games === 1));
});

test('empty games and old games already in progress do not alter Rating or rated-game counts', async t => {
  const { db } = setup(t);
  const members = ['Alice', 'Bobby'].map(name => db.seedAccount(name));
  const empty = await lobby(db, members);
  await start(empty);
  const result = await finish(empty);
  assert.equal(result.ratingResult.rated, false);
  assert.equal(result.ratingResult.reason, 'no_words');
  const old = await lobby(db, members);
  await start(old);
  const state = db.room(old.code);
  delete state.ratingRound;
  db.replaceRoom(old.code, state);
  scoresFor(db, old, [20, 10]);
  const legacy = await finish(old);
  assert.equal(legacy.ratingResult.rated, false);
  assert.equal(legacy.ratingResult.reason, 'legacy');
  assert.ok(members.every(member => stats(db, member).rating_milli === 1_000_000 && stats(db, member).rated_games === 0));
});

test('rematches discard old snapshots, freeze current ratings at start and keep previous rounds idempotent', async t => {
  const { db } = setup(t);
  const members = ['Alice', 'Bobby'].map(name => db.seedAccount(name));
  const room = await lobby(db, members);
  await start(room);
  scoresFor(db, room, [100, 0]);
  await finish(room);
  const next = await post({ action: 'rematch', code: room.code }, members[0].token);
  assert.equal(next.status, 200);
  assert.equal(next.body.room.round, 2);
  assert.equal(next.body.room.ratingResult, undefined);
  assert.equal(db.room(room.code).ratingRound, undefined);
  db.sqlite.prepare('UPDATE accounts SET rating_milli = ? WHERE id = ?').run(1_200_000, members[0].id);
  const newStarted = await start(room);
  assert.equal(newStarted.players.find(player => player.id === room.playerIds[0]).rating, 1200);
  const snapshot = db.room(room.code).ratingRound;
  assert.equal(snapshot.players.find(player => player.accountId === members[0].id).ratingMilli, 1_200_000);
  assert.ok(newStarted.rating.expectedShares[0] > 0.5);
  assert.deepEqual(ledgerCounts(db), { rounds: 1, changes: 2 });
});

test('a settlement CAS conflict and a simultaneous final Commit cannot apply duplicate Rating', async t => {
  const { db } = setup(t);
  const members = ['Alice', 'Bobby'].map(name => db.seedAccount(name));
  const room = await lobby(db, members);
  await start(room);
  scoresFor(db, room, [100, 0]);
  assert.equal((await post({ action: 'commit', code: room.code }, members[0].token)).status, 200);
  db.syncNextReads(2);
  const results = await Promise.all([1, 2].map(() => post({ action: 'commit', code: room.code }, members[1].token)));
  assert.ok(results.some(result => result.status === 200));
  assert.ok(db.conflicts > 0);
  assert.deepEqual(ledgerCounts(db), { rounds: 1, changes: 2 });
  assert.deepEqual(members.map(member => stats(db, member).rating_milli), [1_016_000, 984_000]);
});

test('two different rooms finishing concurrently add both changes without overwriting current account ratings', async t => {
  const { db } = setup(t);
  const members = ['Alice', 'Bobby'].map(name => db.seedAccount(name));
  const rooms = await Promise.all([lobby(db, members), lobby(db, members)]);
  for (const room of rooms) { await start(room); scoresFor(db, room, [100, 0]); await post({ action: 'commit', code: room.code }, members[0].token); }
  db.syncNextReads(2);
  const results = await Promise.all(rooms.map(room => post({ action: 'commit', code: room.code }, members[1].token)));
  assert.ok(results.every(result => result.status === 200));
  assert.deepEqual(members.map(member => stats(db, member).rating_milli), [1_032_000, 968_000]);
  assert.ok(members.every(member => stats(db, member).rated_games === 2));
  assert.deepEqual(ledgerCounts(db), { rounds: 2, changes: 4 });
});

test('a failed rating write rolls back the room result, ledger and every account change together', async t => {
  const { db } = setup(t);
  const members = ['Alice', 'Bobby'].map(name => db.seedAccount(name));
  const room = await lobby(db, members);
  await start(room);
  scoresFor(db, room, [100, 0]);
  await post({ action: 'commit', code: room.code }, members[0].token);
  const baseline = db.rows.get(room.code).state;
  const original = db.run.bind(db);
  let failed = false;
  t.mock.method(db, 'run', (sql, values) => {
    if (!failed && /^UPDATE accounts SET rating_milli/i.test(sql)) { failed = true; throw new Error('Simulated profile write failure'); }
    return original(sql, values);
  });
  const result = await post({ action: 'commit', code: room.code }, members[1].token);
  assert.equal(failed, true);
  assert.equal(result.status, 503);
  assert.equal(db.rows.get(room.code).state, baseline);
  assert.deepEqual(ledgerCounts(db), { rounds: 0, changes: 0 });
  assert.ok(members.every(member => stats(db, member).rating_milli === 1_000_000 && stats(db, member).rated_games === 0));
  assert.equal((await post({ action: 'commit', code: room.code }, members[1].token)).status, 200);
  assert.deepEqual(ledgerCounts(db), { rounds: 1, changes: 2 });
});

test('timeout settlement and local archives settle rating inside the same room transaction', async t => {
  const { db, clock } = setup(t);
  globalThis.__adminRecordsDev = true;
  const members = ['Alice', 'Bobby'].map(name => db.seedAccount(name));
  const room = await lobby(db, members);
  await start(room);
  scoresFor(db, room, [100, 0]);
  clock.now += 180_000;
  const result = await poll(room.code, members[0].token);
  assert.equal(result.status, 200);
  assert.equal(result.body.room.status, 'finished');
  assert.equal(result.body.room.ratingResult.rated, true);
  assert.equal(db.records.size, 1);
  assert.deepEqual(ledgerCounts(db), { rounds: 1, changes: 2 });
  assert.equal((await profile(members[0].token)).body.user.ratedGames, 1);
});

test('a full 64-player unequal room settles everyone within the database query and parameter limits', async t => {
  const { db, clock } = setup(t);
  const members = Array.from({ length: 64 }, (_, index) => db.seedAccount(`Player_${index}`));
  const room = await lobby(db, members, members.map((_, index) => index < 31 ? 0 : 1));
  const started = await start(room);
  assert.deepEqual(started.rating.expectedShares, [31 / 64, 33 / 64]);
  scoresFor(db, room, [100, ...Array(63).fill(0)]);
  const originalBatch = db.batch.bind(db);
  const batches = [];
  t.mock.method(db, 'batch', statements => {
    batches.push(statements);
    return originalBatch(statements);
  });
  clock.now += 180_000;
  const result = await poll(room.code, members[0].token);
  assert.equal(result.status, 200);
  assert.equal(result.body.room.ratingResult.changes.length, 64);
  assert.deepEqual(ledgerCounts(db), { rounds: 1, changes: 64 });
  assert.equal(members.reduce((total, member) => total + stats(db, member).rating_milli, 0), 64_000_000);
  assert.ok(members.every(member => stats(db, member).rated_games === 1));
  assert.equal(batches.length, 1);
  assert.ok(batches[0].length <= 7);
  assert.ok(batches[0].every(statement => statement.values.length <= 100));
});
