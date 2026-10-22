import test from 'node:test';
import assert from 'node:assert/strict';
import { game, puzzles, assertPublic, runtimeURL, MemoryD1, fixtureGameToken } from './helpers.mjs';

const { GET, POST } = await import(runtimeURL('route.mjs'));
const origin = 'https://squares.example';
function setup(t) {
  const db = new MemoryD1();
  const clock = { now: 1000 };
  globalThis.__gameTestDB = db;
  t.mock.method(Date, 'now', () => clock.now);
  return { db, clock };
}
async function post(payload, token, extra = {}) {
  token = fixtureGameToken(payload, token);
  const response = await POST(new Request(`${origin}/api/game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra.headers ?? {}) },
    body: extra.raw ?? JSON.stringify(payload),
  }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function get(code, token) {
  const response = await GET(new Request(`${origin}/api/game?code=${encodeURIComponent(code)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function active(wordCount) {
  const host = await post({ action: 'create', name: 'Alice', ...(wordCount ? { wordCount } : {}) });
  assert.equal(host.status, 201);
  const guest = await post({ action: 'join', code: host.body.room.code, name: 'Bob' });
  assert.equal(guest.status, 200);
  const started = await post({ action: 'start', code: host.body.room.code }, host.body.token);
  assert.equal(started.status, 200);
  host.body.room = started.body.room;
  guest.body.room = started.body.room;
  return { code: host.body.room.code, host: host.body, guest: guest.body };
}
function wordsFor(db, code) { return game.puzzleForGame(db.room(code)).words; }
function useLegacyPuzzle(db, code, puzzleId = 0) {
  const room = db.room(code);
  delete room.generatedPuzzle;
  delete room.boardHistory;
  room.puzzleId = puzzleId;
  room.puzzleHistory = [puzzleId];
  room.board = [...puzzles[puzzleId].board];
  db.replaceRoom(code, room);
  return room;
}
function seedRegularClaims(db, code, unclaimed = []) {
  const room = db.room(code);
  room.players.forEach(player => { player.score = 0; });
  room.words = game.puzzleForGame(room).words.filter(word => !unclaimed.includes(word)).map((word, index) => {
    const player = room.players[index % 2];
    player.score += word.length;
    return { word, playerId: player.id, points: word.length, bonus: false, at: 2000 };
  });
  room.lastWordAt = 2000;
  db.replaceRoom(code, room);
  return room;
}

test('account create and join expose no private account identity or hidden answers', async (t) => {
  const { db } = setup(t);
  const created = await post({ action: 'create', name: '  Alice\u0000  ' });
  assert.equal(created.status, 201);
  assert.match(created.body.room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.body.room.players[0].name, 'Alice');
  assert.equal(created.body.room.status, 'waiting');
  assert.equal(created.body.room.players[0].committedAt, null);
  assert.ok(created.body.token.length > 40);
  assertPublic(assert, created.body.room);
  assert.equal(created.body.room.words.length, 0);
  assert.match(created.headers.get('Cache-Control'), /no-store/);
  const stored = db.room(created.body.room.code);
  assert.equal(stored.players[0].secret, '');
  assert.ok(stored.players[0].accountId);
  assert.equal(JSON.stringify(stored).includes(created.body.token), false);
  assert.equal(stored.wordCount, 'any');
  assert.equal(created.body.room.wordCount, 'any');
  assert.equal(created.body.room.foundWords, 0);
  assert.equal(created.body.room.remainingWords, created.body.room.totalWords);
  const joined = await post({ action: 'join', code: created.body.room.code.toLowerCase(), name: 'Bob' });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.room.status, 'waiting');
  assert.deepEqual(joined.body.room.board, []);
  assert.equal(joined.body.room.deadline, null);
  assert.equal(joined.body.room.players.length, 2);
  assert.ok(joined.body.room.players.every(player => player.committedAt === null));
  assert.notEqual(joined.body.token, created.body.token);
  assertPublic(assert, joined.body.room);
  const fetched = await get(created.body.room.code, created.body.token);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.playerId, created.body.playerId);
  assert.equal('token' in fetched.body, false);
});

test('API rejects malformed, oversized, cross-origin and invalid room requests', async (t) => {
  setup(t);
  assert.equal((await post(null, null, { raw: '{' })).status, 400);
  assert.equal((await post([])).status, 400);
  assert.equal((await post(null)).status, 400);
  assert.equal((await post({ action: 'create', name: 'Alice' }, null, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await post(null, null, { raw: 'x'.repeat(2049) })).status, 413);
  assert.equal((await post({ action: 'unknown' })).status, 400);
  assert.equal((await get('INVALID')).status, 400);
  assert.equal((await get('ABC234')).status, 404);
});

test('all game reads and mutations require a credential belonging to this room', async (t) => {
  const { db } = setup(t);
  const room = await active();
  const other = await post({ action: 'create', name: 'Eve' });
  const baseline = db.rows.get(room.code).state;
  for (const token of [undefined, 'forged', other.body.token]) {
    assert.equal((await get(room.code, token)).status, 401);
    for (const action of ['word', 'commit', 'rematch']) {
      assert.equal((await post({ action, code: room.code, word: wordsFor(db, room.code)[0] }, token)).status, 401);
    }
  }
  assert.equal(db.rows.get(room.code).state, baseline);
});

test('simultaneous claims of one word award exactly one player even after a CAS conflict', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  const word = wordsFor(db, room.code)[0];
  clock.now = 2000;
  db.syncNextReads(2);
  const claims = await Promise.all([
    post({ action: 'word', code: room.code, word }, room.host.token),
    post({ action: 'word', code: room.code, word }, room.guest.token),
  ]);
  assert.deepEqual(claims.map(result => result.status).sort(), [200, 409]);
  assert.ok(db.conflicts >= 1, 'The loser must retry against the winning revision.');
  const state = db.room(room.code);
  assert.equal(state.words.length, 1);
  assert.equal(state.words[0].word, word);
  assert.equal(state.players.reduce((sum, player) => sum + player.score, 0), word.length);
  assert.equal(state.lastWordAt, 2000);
});

test('simultaneous claims of different words both survive the CAS retry', async (t) => {
  const { db } = setup(t);
  const room = await active();
  const [first, second] = wordsFor(db, room.code);
  db.syncNextReads(2);
  const claims = await Promise.all([
    post({ action: 'word', code: room.code, word: first }, room.host.token),
    post({ action: 'word', code: room.code, word: second }, room.guest.token),
  ]);
  assert.deepEqual(claims.map(result => result.status), [200, 200]);
  assert.ok(db.conflicts >= 1);
  const state = db.room(room.code);
  assert.equal(state.words.length, 2);
  assert.equal(state.players[0].score, first.length);
  assert.equal(state.players[1].score, second.length);
});

test('simultaneous joins preserve all team members through the CAS retry without starting the game', async (t) => {
  const { db } = setup(t);
  const host = await post({ action: 'create', name: 'Alice' });
  const code = host.body.room.code;
  db.syncNextReads(2);
  const joins = await Promise.all([
    post({ action: 'join', code, name: 'Bob' }),
    post({ action: 'join', code, name: 'Charlie' }),
  ]);
  assert.deepEqual(joins.map(result => result.status), [200, 200]);
  assert.equal(db.room(code).players.length, 3);
  assert.equal(db.room(code).status, 'waiting');
  assert.equal(db.room(code).startedAt, null);
});

test('invalid words do not reset the timer; valid words reset it; deadline rejects even valid words', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  const [word, nextWord] = wordsFor(db, room.code);
  clock.now = 180999;
  assert.equal((await post({ action: 'word', code: room.code, word: 'CAT' }, room.host.token)).status, 400);
  assert.equal(db.room(room.code).lastWordAt, 1000);
  assert.equal((await post({ action: 'word', code: room.code, word }, room.host.token)).status, 200);
  assert.equal(db.room(room.code).lastWordAt, 180999);
  clock.now = 181000;
  assert.equal((await get(room.code, room.guest.token)).body.room.status, 'playing');
  clock.now = 360999;
  const late = await post({ action: 'word', code: room.code, word: nextWord }, room.guest.token);
  assert.equal(late.status, 200);
  assert.equal(late.body.room.status, 'finished');
  assert.equal(late.body.room.endReason, 'timeout');
  assert.equal(late.body.room.endedAt, 360999);
  assert.equal(late.body.room.words.length, 1);
  assert.equal(late.body.room.players[1].score, 0);
});

test('an idle room expires on authenticated polling and an unseated player cannot join it', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  clock.now = 181000;
  const extra = await post({ action: 'join', code: room.code, name: 'Charlie' });
  assert.equal(extra.status, 409);
  const polled = await get(room.code, room.host.token);
  assert.equal(polled.status, 200);
  assert.equal(polled.body.room.status, 'finished');
  assert.equal(polled.body.room.endedAt, 181000);
  assert.equal(polled.body.room.deadline, null);
  assert.equal(db.room(room.code).players.length, 2);
});

test('simultaneous solo-team commits settle equally and only the host prepares the next waiting round', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  clock.now = 2000;
  db.syncNextReads(2);
  const commits = await Promise.all([
    post({ action: 'commit', code: room.code }, room.host.token),
    post({ action: 'commit', code: room.code }, room.guest.token),
  ]);
  assert.deepEqual(commits.map(result => result.status), [200, 200]);
  const ended = db.room(room.code);
  assert.equal(ended.status, 'finished');
  assert.equal(ended.endReason, 'committed');
  assert.deepEqual(ended.players.map(player => player.committedAt), [2000, 2000]);
  assert.equal(ended.players[0].score, ended.players[1].score);
  assert.equal((await post({ action: 'rematch', code: room.code }, room.guest.token)).status, 403);
  clock.now = 3000;
  const restarted = await post({ action: 'rematch', code: room.code }, room.host.token);
  assert.equal(restarted.body.room.status, 'waiting');
  assert.equal(restarted.body.room.round, 2);
  assert.equal(restarted.body.room.deadline, null);
  assert.deepEqual(restarted.body.room.board, []);
  assert.notEqual(game.canonicalBoardSignature(db.room(room.code).board), game.canonicalBoardSignature(ended.board));
  assert.deepEqual(restarted.body.room.words, []);
  assert.ok(restarted.body.room.players.every(player => !player.committed && player.score === 0));
  assert.ok(restarted.body.room.players.every(player => player.committedAt === null));
  const next = await post({ action: 'start', code: room.code, round: 2 }, room.host.token);
  assert.equal(next.body.room.status, 'playing');
  assert.equal(next.body.room.deadline, 183000);
});

test('one commit prevents further claims from that player while allowing the opponent to continue', async (t) => {
  const { db } = setup(t);
  const room = await active();
  const word = wordsFor(db, room.code)[0];
  assert.equal((await post({ action: 'commit', code: room.code }, room.host.token)).body.room.status, 'playing');
  assert.equal((await post({ action: 'word', code: room.code, word }, room.host.token)).status, 409);
  assert.equal((await post({ action: 'word', code: room.code, word }, room.guest.token)).status, 200);
  const settled = await post({ action: 'commit', code: room.code }, room.guest.token);
  assert.equal(settled.body.room.status, 'finished');
  assert.equal(settled.body.room.players[0].score, 0);
  assert.equal(settled.body.room.players[1].score, word.length);
});

test('a host rematch at the deadline settles the old round before preparing the next lobby', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  const previousPuzzle = game.canonicalBoardSignature(db.room(room.code).board);
  clock.now = 181000;
  const first = await post({ action: 'rematch', code: room.code }, room.host.token);
  assert.equal(first.status, 200);
  assert.equal(first.body.room.status, 'waiting');
  assert.equal(first.body.room.round, 2);
  assert.equal(first.body.room.endReason, null);
  assert.deepEqual(first.body.room.rematchVotes, []);
  clock.now = 182000;
  assert.equal((await post({ action: 'start', code: room.code }, room.guest.token)).status, 403);
  const second = await post({ action: 'start', code: room.code }, room.host.token);
  assert.equal(second.status, 200);
  assert.equal(second.body.room.status, 'playing');
  assert.equal(second.body.room.round, 2);
  assert.equal(second.body.room.deadline, 362000);
  assert.notEqual(game.canonicalBoardSignature(db.room(room.code).board), previousPuzzle);
});

test('invalid word-count preferences cannot create rooms', async (t) => {
  const { db } = setup(t);
  for (const wordCount of [null, '', 'tiny', 'SMALL', 40, false, [], {}]) {
    const result = await post({ action: 'create', name: 'Alice', wordCount });
    assert.equal(result.status, 400, `Reject ${JSON.stringify(wordCount)}`);
  }
  assert.equal(db.rows.size, 0);
});

test('creation persists a requested word-count tier and host rematches retain it', async (t) => {
  const { db, clock } = setup(t);
  for (const tier of ['any', 'small', 'medium', 'large']) {
    const room = await active(tier);
    const original = db.room(room.code);
    assert.equal(original.wordCount, tier);
    assert.equal(room.host.room.wordCount, tier);
    assert.equal(room.guest.room.wordCount, tier);
    const matches = count => tier === 'any' || (tier === 'small' && count >= 30 && count <= 40) || (tier === 'medium' && count > 40 && count <= 55) || (tier === 'large' && count > 55 && count <= 70);
    assert.ok(matches(room.host.room.totalWords));
    await post({ action: 'commit', code: room.code }, room.host.token);
    await post({ action: 'commit', code: room.code }, room.guest.token);
    const voted = await post({ action: 'rematch', code: room.code }, room.host.token);
    assert.equal(voted.body.room.status, 'waiting');
    assert.equal(voted.body.room.wordCount, tier);
    clock.now += 100;
    const restarted = await post({ action: 'start', code: room.code }, room.host.token);
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.room.status, 'playing');
    assert.equal(restarted.body.room.wordCount, tier);
    assert.equal(db.room(room.code).wordCount, tier);
    assert.notEqual(game.canonicalBoardSignature(db.room(room.code).board), game.canonicalBoardSignature(original.board));
    assert.ok(matches(restarted.body.room.totalWords));
    assert.equal(restarted.body.room.foundWords, 0);
    assert.equal(restarted.body.room.remainingWords, restarted.body.room.totalWords);
  }
});

test('concurrent final different-word claims preserve both scores and finish the exhausted board', async (t) => {
  const { db, clock } = setup(t);
  const room = await active('small');
  const [first, second] = wordsFor(db, room.code);
  const baseline = seedRegularClaims(db, room.code, [first, second]);
  clock.now = 3000;
  db.syncNextReads(2);
  const claims = await Promise.all([
    post({ action: 'word', code: room.code, word: first }, room.host.token),
    post({ action: 'word', code: room.code, word: second }, room.guest.token),
  ]);
  assert.deepEqual(claims.map(result => result.status), [200, 200]);
  assert.ok(db.conflicts >= 1, 'Both requests must race against the same revision.');
  const state = db.room(room.code);
  assert.equal(state.players[0].score, baseline.players[0].score + first.length);
  assert.equal(state.players[1].score, baseline.players[1].score + second.length);
  assert.equal(state.words.length, game.puzzleForGame(state).words.length);
  assert.equal(new Set(state.words.map(item => item.word)).size, state.words.length);
  assert.equal(state.status, 'finished');
  assert.equal(state.endReason, 'all_words');
  assert.equal(state.endedAt, 3000);
  const polled = await get(room.code, room.host.token);
  assert.equal(polled.body.room.foundWords, polled.body.room.totalWords);
  assert.equal(polled.body.room.remainingWords, 0);
  assert.equal(polled.body.room.deadline, null);
  const snapshot = structuredClone(state);
  assert.equal((await post({ action: 'word', code: room.code, word: first }, room.guest.token)).status, 409);
  assert.deepEqual(db.room(room.code), snapshot);
  assert.equal((await post({ action: 'rematch', code: room.code }, room.host.token)).body.room.status, 'waiting');
  const restarted = await post({ action: 'start', code: room.code }, room.host.token);
  assert.equal(restarted.body.room.status, 'playing');
  assert.equal(restarted.body.room.round, 2);
  assert.equal(restarted.body.room.wordCount, 'small');
  assert.equal(restarted.body.room.foundWords, 0);
  assert.ok(restarted.body.room.players.every(player => player.score === 0));
});

test('concurrent claims of the final word award it once and reject the loser after retry', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  const [word] = wordsFor(db, room.code);
  const baseline = seedRegularClaims(db, room.code, [word]);
  clock.now = 3000;
  db.syncNextReads(2);
  const claims = await Promise.all([
    post({ action: 'word', code: room.code, word }, room.host.token),
    post({ action: 'word', code: room.code, word }, room.guest.token),
  ]);
  assert.deepEqual(claims.map(result => result.status).sort(), [200, 409]);
  assert.ok(db.conflicts >= 1);
  const state = db.room(room.code);
  const winner = claims[0].status === 200 ? 0 : 1;
  state.players.forEach((player, index) => assert.equal(player.score, baseline.players[index].score + (index === winner ? word.length : 0)));
  assert.equal(state.words.filter(item => item.word === word).length, 1);
  assert.equal(state.status, 'finished');
  assert.equal(state.endReason, 'all_words');
  assert.equal(state.endedAt, 3000);
});

test('authenticated reads settle exhausted legacy rooms before timeout and rematch defaults to any', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  useLegacyPuzzle(db, room.code);
  const legacy = seedRegularClaims(db, room.code);
  delete legacy.wordCount;
  db.replaceRoom(room.code, legacy);
  clock.now = 200000;
  const polled = await get(room.code, room.host.token);
  assert.equal(polled.status, 200);
  assert.equal(polled.body.room.status, 'finished');
  assert.equal(polled.body.room.endReason, 'all_words');
  assert.equal(polled.body.room.endedAt, 2000);
  assert.equal(polled.body.room.wordCount, 'any');
  assert.equal(polled.body.room.remainingWords, 0);
  assert.deepEqual(polled.body.room.players.map(player => player.score), legacy.players.map(player => player.score));
  assert.equal(db.room(room.code).endReason, 'all_words');
  await post({ action: 'rematch', code: room.code }, room.host.token);
  const restarted = await post({ action: 'start', code: room.code }, room.host.token);
  assert.equal(restarted.body.room.status, 'playing');
  assert.equal(restarted.body.room.wordCount, 'any');
  assert.equal(db.room(room.code).wordCount, 'any');
});

test('finished solutions require room credentials, stay out of storage, and disappear when the host prepares the next round', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  assert.equal('solutions' in room.host.room, false);
  assert.equal('solutions' in room.guest.room, false);
  const [word] = wordsFor(db, room.code);
  const claimed = await post({ action: 'word', code: room.code, word }, room.host.token);
  assert.equal('solutions' in claimed.body.room, false);
  const firstCommit = await post({ action: 'commit', code: room.code }, room.host.token);
  assert.equal('solutions' in firstCommit.body.room, false);
  clock.now = 2000;
  const finished = await post({ action: 'commit', code: room.code }, room.guest.token);
  assert.equal(finished.body.room.status, 'finished');
  const stored = db.room(room.code);
  assert.equal('solutions' in stored, false);
  const puzzle = game.puzzleForGame(stored);
  const solutions = finished.body.room.solutions;
  assert.deepEqual(solutions.map(item => item.word).sort(), [...puzzle.words, ...puzzle.bonus].sort());
  assert.ok(solutions.every(item => game.validPath(stored.board, item.word, item.path)));
  assert.equal(solutions.filter(item => !item.bonus).length, finished.body.room.totalWords);
  assert.equal(solutions.reduce((sum, item) => sum + item.points, 0), finished.body.room.totalPoints);
  assertPublic(assert, finished.body.room);
  const baseline = db.rows.get(room.code).state;
  for (const token of [undefined, 'forged']) {
    const denied = await get(room.code, token);
    assert.equal(denied.status, 401);
    assert.equal('room' in denied.body, false);
    assert.equal('solutions' in denied.body, false);
  }
  for (const token of [room.host.token, room.guest.token]) {
    const polled = await get(room.code, token);
    assert.equal(polled.status, 200);
    assert.deepEqual(polled.body.room.solutions, solutions);
  }
  assert.equal(db.rows.get(room.code).state, baseline, 'Answer reads must not rewrite scores or persist the dictionary.');
  const voted = await post({ action: 'rematch', code: room.code }, room.host.token);
  assert.equal(voted.body.room.status, 'waiting');
  assert.equal('solutions' in voted.body.room, false);
  assert.deepEqual(voted.body.room.board, []);
  assert.equal('solutions' in db.room(room.code), false);
  const restarted = await post({ action: 'start', code: room.code }, room.host.token);
  assert.equal(restarted.body.room.status, 'playing');
  assert.equal(restarted.body.room.round, 2);
  assert.equal('solutions' in restarted.body.room, false);
  const polled = await get(room.code, room.host.token);
  assert.equal('solutions' in polled.body.room, false);
  assert.equal('solutions' in db.room(room.code), false);
});

test('bonus API claims award one point and report the new points in the message and finished solutions', async (t) => {
  const { db } = setup(t);
  const room = await active();
  useLegacyPuzzle(db, room.code);
  const puzzle = game.puzzleForGame(db.room(room.code));
  const word = puzzle.bonus[0];
  assert.ok(word);
  const claimed = await post({ action: 'word', code: room.code, word, round: 1 }, room.host.token);
  assert.equal(claimed.status, 200);
  assert.match(claimed.body.message, /附加词 \+1$/);
  assert.equal(claimed.body.room.players[0].score, 1);
  assert.equal(claimed.body.room.words[0].points, 1);
  assert.equal(claimed.body.room.foundWords, 0);
  await post({ action: 'commit', code: room.code, round: 1 }, room.host.token);
  const finished = await post({ action: 'commit', code: room.code, round: 1 }, room.guest.token);
  assert.equal(finished.body.room.solutions.find(item => item.word === word).points, 1);
  assert.equal(finished.body.room.totalPoints, puzzle.words.reduce((sum, item) => sum + item.length, 0) + puzzle.bonus.length);
});

test('Commit countdown is fixed across repeated requests and later claims, then settles inclusively', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  const [first, second] = wordsFor(db, room.code);
  clock.now = 2000;
  const committed = await post({ action: 'commit', code: room.code }, room.host.token);
  assert.equal(committed.body.room.commitDeadline, 62000);
  assert.equal(committed.body.room.deadline, 62000);
  assert.equal(committed.body.room.players[0].committedAt, 2000);
  assert.equal(committed.body.room.players[1].committedAt, null);
  clock.now = 3000;
  const repeated = await post({ action: 'commit', code: room.code, committed: false }, room.host.token);
  assert.equal(repeated.body.room.commitDeadline, 62000);
  assert.equal(repeated.body.room.players[0].committed, true, 'A false flag cannot withdraw Commit.');
  assert.equal(repeated.body.room.players[0].committedAt, 2000, 'A false flag and a repeated request cannot change the Commit time.');
  assert.equal(db.room(room.code).players[0].committedAt, 2000);
  assert.equal((await post({ action: 'word', code: room.code, word: first }, room.host.token)).status, 409);
  clock.now = 61999;
  const claimed = await post({ action: 'word', code: room.code, word: first }, room.guest.token);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.room.status, 'playing');
  assert.equal(claimed.body.room.deadline, 62000);
  clock.now = 62000;
  const late = await post({ action: 'word', code: room.code, word: second }, room.guest.token);
  assert.equal(late.status, 200);
  assert.match(late.body.message, /60 秒/);
  assert.equal(late.body.room.endReason, 'commit_timeout');
  assert.equal(late.body.room.endedAt, 62000);
  assert.equal(late.body.room.words.length, 1);
  assert.equal(late.body.room.players[1].score, first.length);
  const finished = await get(room.code, room.host.token);
  assert.equal(finished.body.room.endReason, 'commit_timeout');
  assert.ok(finished.body.room.solutions.length > 0);
  await post({ action: 'rematch', code: room.code }, room.host.token);
  const restarted = await post({ action: 'start', code: room.code }, room.host.token);
  assert.equal(restarted.body.room.commitDeadline, null);
  assert.equal(db.room(room.code).commitDeadline, null);
  assert.ok(restarted.body.room.players.every(player => player.committedAt === null));
  assert.equal(restarted.body.room.deadline, 242000);
});

test('a Commit racing an opponent word preserves both the claim and the first countdown through CAS', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  const word = wordsFor(db, room.code)[0];
  clock.now = 2000;
  db.syncNextReads(2);
  const outcomes = await Promise.all([
    post({ action: 'commit', code: room.code, round: 1 }, room.host.token),
    post({ action: 'word', code: room.code, word, round: 1 }, room.guest.token),
  ]);
  assert.deepEqual(outcomes.map(result => result.status), [200, 200]);
  assert.ok(db.conflicts >= 1);
  const state = db.room(room.code);
  assert.equal(state.commitDeadline, 62000);
  assert.equal(state.players[0].committed, true);
  assert.equal(state.players[1].score, word.length);
  assert.equal(state.words.length, 1);
  assert.equal(state.status, 'playing');
});

test('legacy Commit migration is persisted once through concurrent polling and mutations still execute', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  const legacy = db.room(room.code);
  legacy.players[0].committed = true;
  legacy.players.forEach(player => { delete player.committedAt; });
  delete legacy.commitDeadline;
  db.replaceRoom(room.code, legacy);
  clock.now = 2000;
  db.syncNextReads(2);
  const reads = await Promise.all([get(room.code, room.host.token), get(room.code, room.guest.token)]);
  assert.deepEqual(reads.map(result => result.status), [200, 200]);
  assert.ok(db.conflicts >= 1);
  assert.ok(reads.every(result => result.body.room.status === 'playing' && result.body.room.commitDeadline === 62000));
  assert.equal(db.room(room.code).commitDeadline, 62000);
  assert.ok(reads.every(result => result.body.room.players.every(player => !('committedAt' in player))), 'Polling old rooms cannot fabricate historical Commit times.');
  const legacyMutation = db.room(room.code);
  delete legacyMutation.commitDeadline;
  db.replaceRoom(room.code, legacyMutation);
  clock.now = 3000;
  const word = wordsFor(db, room.code)[0];
  const claimed = await post({ action: 'word', code: room.code, word }, room.guest.token);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.room.status, 'playing');
  assert.equal(claimed.body.room.commitDeadline, 63000);
  assert.equal(claimed.body.room.words[0].word, word);
  clock.now = 3500;
  const repeated = await post({ action: 'commit', code: room.code }, room.host.token);
  assert.equal('committedAt' in repeated.body.room.players[0], false);
  clock.now = 4000;
  const finished = await post({ action: 'commit', code: room.code }, room.guest.token);
  assert.equal(finished.body.room.status, 'finished');
  assert.equal('committedAt' in finished.body.room.players[0], false);
  assert.equal(finished.body.room.players[1].committedAt, 4000);
  await post({ action: 'rematch', code: room.code }, room.host.token);
  const restarted = await post({ action: 'start', code: room.code }, room.host.token);
  assert.ok(restarted.body.room.players.every(player => player.committedAt === null));
});

test('round guards reject stale queued mutations after rematch while omitted rounds remain compatible', async (t) => {
  const { db } = setup(t);
  const room = await active();
  await post({ action: 'commit', code: room.code, round: 1 }, room.host.token);
  await post({ action: 'commit', code: room.code, round: 1 }, room.guest.token);
  await post({ action: 'rematch', code: room.code, round: 1 }, room.host.token);
  const restarted = await post({ action: 'start', code: room.code, round: 2 }, room.host.token);
  assert.equal(restarted.body.room.round, 2);
  const baseline = db.rows.get(room.code).state;
  const word = wordsFor(db, room.code)[0];
  for (const action of ['word', 'commit', 'rematch', 'start', 'team']) {
    for (const round of [1, 3, null, '2', 2.5]) {
      const stale = await post({ action, code: room.code, word, round, ...(action === 'team' ? { role: 'player', teamId: 0 } : {}) }, room.host.token);
      assert.equal(stale.status, 409);
      assert.match(stale.body.error, /本局已切换/);
      assert.equal(db.rows.get(room.code).state, baseline);
    }
  }
  const compatible = await post({ action: 'word', code: room.code, word }, room.host.token);
  assert.equal(compatible.status, 200);
  assert.equal(compatible.body.room.round, 2);
  assert.equal(compatible.body.room.words.length, 1);
});

test('API exposes shared main-word length counts and unlocks initial counts at exactly 40% for both players', async (t) => {
  const { db } = setup(t);
  const room = await active('small');
  const puzzle = game.puzzleForGame(db.room(room.code));
  const unlockAt = Math.ceil(puzzle.words.length * 0.4);
  assert.equal(room.guest.room.wordStats.hintsUnlocked, false);
  assert.equal('byInitial' in room.guest.room.wordStats, false);
  for (const word of puzzle.bonus.slice(0, 2)) {
    const bonus = await post({ action: 'word', code: room.code, word }, room.host.token);
    assert.equal(bonus.body.room.wordStats.found, 0);
    assert.equal('byInitial' in bonus.body.room.wordStats, false);
  }
  for (let i = 0; i < unlockAt; i++) {
    const token = i % 2 ? room.host.token : room.guest.token;
    const claim = await post({ action: 'word', code: room.code, word: puzzle.words[i] }, token);
    assert.equal(claim.status, 200);
    assert.equal(claim.body.room.wordStats.found, i + 1);
    assert.equal(claim.body.room.wordStats.unlockAt, unlockAt);
    assert.equal(claim.body.room.wordStats.hintsUnlocked, i + 1 === unlockAt);
    assert.equal('byInitial' in claim.body.room.wordStats, i + 1 === unlockAt);
  }
  const host = (await get(room.code, room.host.token)).body.room;
  const guest = (await get(room.code, room.guest.token)).body.room;
  assert.deepEqual(host.wordStats, guest.wordStats);
  assert.equal(host.wordStats.byLength.reduce((sum, item) => sum + item.total, 0), host.totalWords);
  assert.equal(host.wordStats.byLength.reduce((sum, item) => sum + item.found, 0), host.foundWords);
  assert.equal(host.wordStats.byInitial.reduce((sum, item) => sum + item.remaining, 0), host.remainingWords);
  assert.equal('wordStats' in db.room(room.code), false);
});

test('API updates canonical tile hints on each claim while accepting grey alternative and bonus routes', async (t) => {
  const { db, clock } = setup(t);
  const room = await active();
  const stored = db.room(room.code);
  const board = ['A', 'B', 'A', 'X', 'X', 'C', 'D', 'X', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M'];
  stored.board = [...board]; stored.puzzleId = -1;
  stored.generatedPuzzle = { board: [...board], words: ['ABCD', 'ACDB', 'EFGH'], bonus: ['JKLM'], generatorVersion: 'route-fixture' };
  db.replaceRoom(room.code, stored);
  const initial = await get(room.code, room.host.token);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.room.tileHints.unlocked, false);
  assert.equal('starts' in initial.body.room.tileHints, false);
  assert.deepEqual(initial.body.room.tileHints.usable, board.map((_, tile) => [0, 1, 5, 6, 8, 9, 10, 11].includes(tile)));

  clock.now = 2000;
  const bonus = await post({ action: 'word', code: room.code, word: 'JKLM', path: [12, 13, 14, 15] }, room.host.token);
  assert.equal(bonus.status, 200);
  assert.equal(bonus.body.room.players[0].score, 1);
  assert.equal(bonus.body.room.foundWords, 0);
  assert.deepEqual(bonus.body.room.tileHints, initial.body.room.tileHints, 'Bonus-only grey squares remain playable without changing main hints.');

  clock.now = 2001;
  const first = await post({ action: 'word', code: room.code, word: 'EFGH', path: [8, 9, 10, 11] }, room.guest.token);
  assert.equal(first.status, 200);
  assert.equal('starts' in first.body.room.tileHints, false);
  assert.deepEqual(first.body.room.tileHints.usable, board.map((_, tile) => [0, 1, 5, 6].includes(tile)));

  clock.now = 2002;
  const unlock = await post({ action: 'word', code: room.code, word: 'ACDB', path: [0, 5, 6, 1] }, room.host.token);
  assert.equal(unlock.status, 200);
  assert.equal(unlock.body.room.tileHints.unlocked, true);
  assert.deepEqual(unlock.body.room.tileHints.starts, [1, ...Array(15).fill(0)], 'A word with two starting As is counted once at its canonical start.');
  const [host, guest] = await Promise.all([get(room.code, room.host.token), get(room.code, room.guest.token)]);
  assert.deepEqual(host.body.room.tileHints, guest.body.room.tileHints);
  assert.deepEqual(host.body.room.tileHints, unlock.body.room.tileHints);

  clock.now = 2003;
  const alternative = await post({ action: 'word', code: room.code, word: 'ABCD', path: [2, 1, 5, 6] }, room.guest.token);
  assert.equal(alternative.status, 200, 'A grey starting A can still form a valid alternative route.');
  assert.equal(alternative.body.room.endReason, 'all_words');
  assert.deepEqual(alternative.body.room.tileHints.starts, Array(16).fill(0));
  assert.deepEqual(alternative.body.room.tileHints.usable, Array(16).fill(false));
  assert.deepEqual(alternative.body.room.solutions.find(item => item.word === 'ABCD').path, [0, 1, 5, 6]);
  assert.equal('tileHints' in db.room(room.code), false, 'Derived hints must not be stored as stale room state.');
});

test('creation validates optional recent-board arrays and accepts up to 32 valid signatures', async (t) => {
  const { db } = setup(t);
  const board = puzzles[0].board.join('');
  const invalidValues = [null, board, 42, {}, false, [null], [42], [''], [board.toLowerCase()],
    ['A'.repeat(15)], ['A'.repeat(17)], ['A'.repeat(15) + '1'], [' ' + board], Array(33).fill(board)];
  for (const recentBoards of invalidValues) {
    const result = await post({ action: 'create', name: 'Alice', recentBoards });
    assert.equal(result.status, 400, `Reject ${JSON.stringify(recentBoards)}`);
  }
  assert.equal(db.rows.size, 0, 'Invalid preferences must not persist a room.');
  for (const recentBoards of [[], [board], Array(32).fill(board)]) {
    const result = await post({ action: 'create', name: 'Alice', recentBoards });
    assert.equal(result.status, 201);
    assertPublic(assert, result.body.room);
    assert.ok(Array.isArray(db.room(result.body.room.code).boardHistory));
    assert.equal(db.room(result.body.room.code).puzzleId, -1);
    assert.ok(db.room(result.body.room.code).generatedPuzzle);
  }
  const omitted = await post({ action: 'create', name: 'Alice' });
  assert.equal(omitted.status, 201, 'Older clients do not need to send recentBoards.');
  assertPublic(assert, omitted.body.room);
});

test('creation avoids a recent reflected board and keeps its cross-room history private through polling and rematch', async (t) => {
  const { db } = setup(t);
  const previous = puzzles.find(puzzle => puzzle.words.length >= 30 && puzzle.words.length <= 40);
  const reflected = Array.from({ length: 16 }, (_, i) => previous.board[Math.floor(i / 4) * 4 + 3 - i % 4]).join('');
  const host = await post({ action: 'create', name: 'Alice', wordCount: 'small', recentBoards: [reflected] });
  assert.equal(host.status, 201);
  const code = host.body.room.code;
  assert.deepEqual(host.body.room.board, [], 'The host cannot see an unstarted board.');
  assertPublic(assert, host.body.room);
  const guest = await post({ action: 'join', code, name: 'Bob' });
  assert.equal(guest.status, 200);
  assertPublic(assert, guest.body.room);
  const opening = await post({ action: 'start', code }, host.body.token);
  assert.equal(opening.status, 200);
  const stored = db.room(code);
  assert.equal(stored.puzzleId, -1);
  assert.ok(stored.generatedPuzzle);
  assert.ok(stored.boardHistory.includes(game.canonicalBoardSignature(previous.board)));
  assert.ok(stored.boardHistory.includes(game.canonicalBoardSignature(stored.board)));
  assertPublic(assert, (await get(code, host.body.token)).body.room);
  await post({ action: 'commit', code }, host.body.token);
  const ended = await post({ action: 'commit', code }, guest.body.token);
  assertPublic(assert, ended.body.room);
  await post({ action: 'rematch', code }, host.body.token);
  const restarted = await post({ action: 'start', code }, host.body.token);
  assert.equal(restarted.body.room.status, 'playing');
  assertPublic(assert, restarted.body.room);
  assert.notEqual(game.canonicalBoardSignature(restarted.body.room.board), game.canonicalBoardSignature(previous.board));
  assert.notEqual(game.canonicalBoardSignature(db.room(code).board), game.canonicalBoardSignature(stored.board));
});

test('a genuinely generated room supports path claims, settlement, complete solutions and a fresh generated rematch', async (t) => {
  const { db, clock } = setup(t);
  const room = await active('medium');
  const original = db.room(room.code);
  assert.equal(original.puzzleId, -1);
  assert.ok(original.generatedPuzzle);
  assert.equal(room.guest.room.boardSource, 'random');
  assert.deepEqual(original.board, original.generatedPuzzle.board);
  assert.equal(room.guest.room.totalWords, original.generatedPuzzle.words.length);
  assertPublic(assert, room.host.room);
  assertPublic(assert, room.guest.room);
  assert.equal('solutions' in room.guest.room, false);
  const word = original.generatedPuzzle.words[0];
  const path = game.findPath(original.board, word);
  clock.now = 2000;
  const claim = await post({ action: 'word', code: room.code, round: 1, word, path }, room.host.token);
  assert.equal(claim.status, 200);
  assert.equal(claim.body.room.players[0].score, word.length);
  assert.equal('solutions' in claim.body.room, false);
  assertPublic(assert, claim.body.room);
  await post({ action: 'commit', code: room.code, round: 1 }, room.host.token);
  const finished = await post({ action: 'commit', code: room.code, round: 1 }, room.guest.token);
  assert.equal(finished.body.room.endReason, 'committed');
  assert.deepEqual(finished.body.room.solutions.map(item => item.word).sort(), [...original.generatedPuzzle.words, ...original.generatedPuzzle.bonus].sort());
  assert.ok(finished.body.room.solutions.every(item => game.validPath(original.board, item.word, item.path)));
  assertPublic(assert, finished.body.room);
  assert.equal('solutions' in db.room(room.code), false);
  await post({ action: 'rematch', code: room.code, round: 1 }, room.host.token);
  clock.now = 3000;
  const restarted = await post({ action: 'start', code: room.code, round: 2 }, room.host.token);
  assert.equal(restarted.body.room.round, 2);
  assert.equal(restarted.body.room.wordCount, 'medium');
  assert.equal('solutions' in restarted.body.room, false);
  assertPublic(assert, restarted.body.room);
  const next = db.room(room.code);
  assert.equal(next.puzzleId, -1);
  assert.ok(next.generatedPuzzle);
  assert.notEqual(game.canonicalBoardSignature(next.board), game.canonicalBoardSignature(original.board));
  assert.deepEqual(next.words, []);
  assert.ok(next.players.every(player => player.score === 0 && !player.committed));
  assert.ok(next.boardHistory.includes(game.canonicalBoardSignature(original.board)));
});

test('an existing legacy API room keeps saved answers throughout play and migrates only after the host prepares a rematch', async (t) => {
  const { db } = setup(t);
  const room = await active();
  const legacy = useLegacyPuzzle(db, room.code);
  const expected = puzzles[legacy.puzzleId];
  const polled = await get(room.code, room.host.token);
  assert.equal(polled.body.room.totalWords, expected.words.length);
  assert.equal(polled.body.room.boardSource, 'legacy');
  assert.deepEqual(polled.body.room.board, expected.board);
  assertPublic(assert, polled.body.room);
  assert.equal(db.room(room.code).generatedPuzzle, undefined);
  const word = expected.words[0];
  const claim = await post({ action: 'word', code: room.code, word }, room.host.token);
  assert.equal(claim.status, 200);
  assert.equal(claim.body.room.players[0].score, word.length);
  await post({ action: 'commit', code: room.code }, room.host.token);
  const finished = await post({ action: 'commit', code: room.code }, room.guest.token);
  assert.deepEqual(finished.body.room.solutions.map(item => item.word).sort(), [...expected.words, ...expected.bonus].sort());
  assert.equal(db.room(room.code).generatedPuzzle, undefined, 'Settlement must retain the old answers until the host prepares a new round.');
  const waiting = await post({ action: 'rematch', code: room.code }, room.host.token);
  assert.equal(waiting.body.room.status, 'waiting');
  assert.deepEqual(waiting.body.room.board, []);
  const restarted = await post({ action: 'start', code: room.code }, room.host.token);
  assert.equal(restarted.body.room.status, 'playing');
  assert.equal(restarted.body.room.boardSource, 'random');
  assert.equal(db.room(room.code).puzzleId, -1);
  assert.ok(db.room(room.code).generatedPuzzle);
  assert.notEqual(game.canonicalBoardSignature(restarted.body.room.board), game.canonicalBoardSignature(expected.board));
  assertPublic(assert, restarted.body.room);
});
