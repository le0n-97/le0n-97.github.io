import test from 'node:test';
import assert from 'node:assert/strict';
import { game, started, candidate, runtimeURL, MemoryD1 } from './helpers.mjs';

const records = await import(runtimeURL('game-records.mjs'));
const admin = await import(runtimeURL('records-admin.mjs'));
const { GET: adminGET } = await import(runtimeURL('records-route.mjs'));
const { GET: gameGET, POST: gamePOST } = await import(runtimeURL('route.mjs'));

function setup(t, now = 10000) {
  const db = new MemoryD1();
  const clock = { now };
  globalThis.__gameTestDB = db;
  globalThis.__adminRecordsDev = true;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => { db.close(); delete globalThis.__adminRecordsDev; delete globalThis.__gameTestDB; });
  return { db, clock };
}
function settled() {
  const room = started(1000);
  const main = candidate(room);
  const bonus = candidate(room, 'bonus');
  assert.ok(main && bonus);
  game.submitWord(room, 'one', main, undefined, 2000);
  game.submitWord(room, 'two', bonus, undefined, 3000);
  game.commitGame(room, 'one', 4000);
  game.commitGame(room, 'two', 5000);
  return room;
}
async function adminRequest(query = '', origin = 'http://localhost:5173', headers = {}) {
  const response = await adminGET(new Request(`${origin}/api/admin/records${query ? `?${query}` : ''}`, { headers }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function authenticatedRoom(db) {
  const room = started(1000);
  const tokens = [];
  for (let index = 0; index < 2; index++) {
    const account = db.seedAccount(room.players[index].name);
    tokens.push(account.token);
    room.players[index].secret = '';
    room.players[index].accountId = account.id;
  }
  db.seedRoom(room);
  return { room, tokens };
}
async function post(room, token, action, extra = {}) {
  const response = await gamePOST(new Request('http://localhost:5173/api/game', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, code: room.code, round: room.round, ...extra }),
  }));
  return { status: response.status, body: await response.json() };
}
function codeFor(number) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'AA' + Array.from({ length: 4 }, (_, index) => alphabet[Math.floor(number / alphabet.length ** index) % alphabet.length]).join('');
}

test('records sanitize completed games with full answers, ownership and no room credentials', () => {
  const room = settled();
  room.privateFutureField = 'private-room-marker';
  room.players[0].privateFutureField = 'private-player-marker';
  room.words[0].privateFutureField = 'private-word-marker';
  const record = records.recordForGame(room);
  assert.equal(record.id, 'ABC234-1000-1');
  assert.equal(record.winnerId, 'one');
  assert.equal(record.durationMs, 4000);
  assert.equal(record.foundWords, 1);
  assert.equal(record.bonusFound, 1);
  assert.deepEqual(record.words.map(word => [word.playerId, word.points, word.at]), [['one', room.words[0].word.length, 2000], ['two', 1, 3000]]);
  assert.deepEqual(record.solutions.map(solution => solution.word).sort(), [...game.puzzleForGame(room).words, ...game.puzzleForGame(room).bonus].sort());
  assert.ok(record.solutions.every(solution => game.validPath(record.board, solution.word, solution.path)));
  const serialized = JSON.stringify(record);
  for (const forbidden of ['secret', 'private-room-marker', 'private-player-marker', 'private-word-marker', 'puzzleHistory', 'generatedPuzzle', 'boardHistory', 'rematchVotes']) {
    assert.equal(serialized.includes(forbidden), false, `Do not archive ${forbidden}.`);
  }
  record.board[0] = '!'; record.players[0].name = 'changed'; record.words[0].points = -1; record.solutions[0].path[0] = 99;
  assert.notEqual(room.board[0], '!');
  assert.equal(room.players[0].name, 'one');
  assert.ok(room.words[0].points > 0);
  assert.ok(game.findPath(room.board, record.solutions[0].word).every(tile => tile < 16));
});

test('unfinished or undated games cannot become records, and summaries omit replay payloads', () => {
  const room = settled();
  assert.equal(records.recordForGame({ ...room, status: 'playing' }), null);
  assert.equal(records.recordForGame({ ...room, status: 'waiting' }), null);
  assert.equal(records.recordForGame({ ...room, endedAt: null }), null);
  const undated = { ...room }; delete undated.endedAt;
  assert.equal(records.recordForGame(undated), null);
  room.players[1].score = room.players[0].score;
  const record = records.recordForGame(room);
  assert.equal(record.winnerId, null);
  const summary = records.summaryOf(record);
  assert.equal(summary.id, record.id);
  assert.equal(summary.foundWords, 1);
  for (const field of ['board', 'words', 'solutions']) assert.equal(field in summary, false);
  summary.players[0].name = 'mutated';
  assert.equal(record.players[0].name, 'one');
});

test('a successful settlement archives once while later finished-state writes preserve the original result', async (t) => {
  const { db } = setup(t);
  const before = started(); db.seedRoom(before);
  const ended = settled();
  assert.equal(await records.writeRoomWithRecord(db, ended, 0, 5000), true);
  assert.equal(db.rows.get(ended.code).revision, 1);
  assert.deepEqual(db.records.get('ABC234-1000-1'), records.recordForGame(ended));
  ended.rematchVotes.push('one');
  assert.equal(await records.writeRoomWithRecord(db, ended, 1, 6000), true);
  assert.equal(db.records.size, 1);
  assert.equal(db.records.get('ABC234-1000-1').endedAt, 5000);
  assert.equal('rematchVotes' in db.records.get('ABC234-1000-1'), false);
});

test('a lost settlement CAS cannot create a record for a game that did not finish', async (t) => {
  const { db } = setup(t);
  const before = started(); db.seedRoom(before);
  const winner = structuredClone(before);
  game.submitWord(winner, 'two', candidate(winner), undefined, 2500);
  assert.equal(await records.writeRoomWithRecord(db, winner, 0, 2500), true);
  assert.equal(await records.writeRoomWithRecord(db, settled(), 0, 5000), false);
  assert.equal(db.records.size, 0);
  assert.equal(db.room(before.code).status, 'playing');
  assert.equal(db.room(before.code).players[1].score, winner.players[1].score);
  assert.equal(db.conflicts, 1);
});

test('archive failure rolls back the room CAS in the same transaction', async (t) => {
  const { db } = setup(t);
  const before = started(); db.seedRoom(before);
  db.sqlite.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON game_records BEGIN SELECT RAISE(ABORT, 'archive test failure'); END");
  await assert.rejects(records.writeRoomWithRecord(db, settled(), 0, 5000), /archive test failure/);
  assert.deepEqual(db.room(before.code), before);
  assert.equal(db.rows.get(before.code).revision, 0);
  assert.equal(db.records.size, 0);
});

test('rematch persistence archives the old board before reset and keeps later rounds as separate records', async (t) => {
  const { db } = setup(t);
  const ended = settled(); db.seedRoom(ended);
  const previous = structuredClone(ended);
  const next = structuredClone(ended);
  game.rematch(next, 'one', 6000);
  assert.equal(await records.writeRoomWithRecord(db, next, 0, 6000, previous), true);
  assert.equal(db.room(next.code).round, 2);
  assert.deepEqual(db.room(next.code).words, []);
  assert.equal(db.records.size, 1);
  assert.deepEqual(db.records.get('ABC234-1000-1').board, previous.board);
  assert.deepEqual(db.records.get('ABC234-1000-1').words, previous.words);
  game.startGame(next, 'one', 6500);
  game.commitGame(next, 'one', 7000); game.commitGame(next, 'two', 7000);
  assert.equal(await records.writeRoomWithRecord(db, next, 1, 7000), true);
  assert.equal(db.records.size, 2);
  assert.deepEqual(db.records.get('ABC234-1000-2').words, []);
  assert.ok(db.records.get('ABC234-1000-2').players.every(player => player.score === 0));
});

test('concurrent game API commits archive exactly the final scores and rematches retain the first round', async (t) => {
  const { db, clock } = setup(t, 2000);
  const { room, tokens } = await authenticatedRoom(db);
  const word = candidate(room);
  assert.equal((await post(room, tokens[0], 'word', { word })).status, 200);
  clock.now = 3000;
  db.syncNextReads(2);
  const outcomes = await Promise.all(tokens.map(token => post(room, token, 'commit')));
  assert.deepEqual(outcomes.map(outcome => outcome.status), [200, 200]);
  assert.ok(db.conflicts > 0);
  const record = db.records.get('ABC234-1000-1');
  assert.equal(db.records.size, 1);
  assert.equal(record.endReason, 'committed');
  assert.equal(record.players[0].score, word.length);
  assert.deepEqual(record.words.map(item => item.word), [word]);
  assert.equal((await post(room, tokens[1], 'rematch')).status, 403);
  clock.now = 4000;
  const waiting = await post(room, tokens[0], 'rematch');
  assert.equal(waiting.body.room.round, 2);
  assert.equal(waiting.body.room.status, 'waiting');
  assert.equal(db.records.size, 1);
  assert.deepEqual(db.records.get(record.id), record);
  assert.deepEqual(db.room(room.code).words, []);
});

test('production game settlement keeps records local-only while preserving the final game result', async (t) => {
  const { db, clock } = setup(t, 2000);
  globalThis.__adminRecordsDev = false;
  const { room, tokens } = await authenticatedRoom(db);
  const word = candidate(room);
  assert.equal((await post(room, tokens[0], 'word', { word })).status, 200);
  clock.now = 3000;
  for (const token of tokens) assert.equal((await post(room, token, 'commit')).status, 200);
  assert.equal(db.room(room.code).status, 'finished');
  assert.equal(db.room(room.code).players[0].score, word.length);
  assert.equal(db.records.size, 0);
});

test('authenticated game polling archives timeout at the actual deadline rather than polling time', async (t) => {
  const { db } = setup(t, 500000);
  const { room, tokens } = await authenticatedRoom(db);
  const response = await gameGET(new Request(`http://localhost:5173/api/game?code=${room.code}`, { headers: { Authorization: `Bearer ${tokens[0]}` } }));
  assert.equal(response.status, 200);
  const record = db.records.get('ABC234-1000-1');
  assert.equal(record.endReason, 'timeout');
  assert.equal(record.endedAt, 181000);
  assert.equal(record.durationMs, 180000);
});

test('claiming the last ordinary word archives all-words completion with bonus claims included', async (t) => {
  const { db } = setup(t, 4000);
  const { room, tokens } = await authenticatedRoom(db);
  const puzzle = game.puzzleForGame(room);
  const last = puzzle.words.at(-1);
  room.words = puzzle.words.slice(0, -1).map(word => ({ word, playerId: 'one', points: word.length, bonus: false, at: 2000 }));
  room.players[0].score = room.words.reduce((sum, word) => sum + word.points, 0);
  const bonus = candidate(room, 'bonus');
  room.words.push({ word: bonus, playerId: 'two', points: 1, bonus: true, at: 3000 });
  room.players[1].score = 1; room.lastWordAt = 3000;
  db.replaceRoom(room.code, room);
  const outcome = await post(room, tokens[1], 'word', { word: last });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.room.endReason, 'all_words');
  const record = db.records.get('ABC234-1000-1');
  assert.equal(record.endReason, 'all_words');
  assert.equal(record.foundWords, record.totalWords);
  assert.equal(record.bonusFound, 1);
  assert.equal(record.players[1].score, last.length + 1);
});

test('records API is disabled in production and on non-loopback hosts without exposing details', async (t) => {
  const { db } = setup(t);
  db.seedRoom(settled());
  globalThis.__adminRecordsDev = false;
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
    const result = await adminRequest('', origin);
    assert.equal(result.status, 404);
    assert.equal('records' in result.body, false);
    assert.match(result.headers.get('Cache-Control'), /no-store/);
  }
  globalThis.__adminRecordsDev = true;
  for (const origin of ['https://squares.example', 'http://localhost.example:5173', 'http://192.168.1.2:5173']) {
    assert.equal((await adminRequest('', origin, { 'X-Forwarded-Host': 'localhost:5173' })).status, 404);
  }
  for (const host of ['records.invalid', '127.0.0.1.evil', 'localhost@evil', 'localhost/path', 'localhost?query=1', 'localhost#fragment']) {
    const result = await adminRequest('', 'http://localhost:5173', { Host: host });
    assert.equal(result.status, 404, `Reject raw Host ${host} even if the framework normalizes request.url to localhost.`);
    assert.equal('records' in result.body, false);
  }
  assert.equal(db.records.size, 0, 'Rejected callers cannot trigger backfill.');
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
    const result = await adminRequest('', origin);
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 1);
    assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  }
  for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173']) {
    const result = await adminRequest('', 'http://localhost:5173', { Host: host });
    assert.equal(result.status, 200, `Allow a loopback Host ${host}.`);
    assert.equal(result.body.total, 1);
  }
});

test('records API backfills old finished rooms and expired games while active and waiting rooms stay untouched', async (t) => {
  const { db } = setup(t, 500000);
  const finished = settled(); db.seedRoom(finished);
  const idle = started(); idle.code = 'ABC235'; db.seedRoom(idle);
  const committed = started(400000); committed.code = 'ABC236';
  game.commitGame(committed, 'one', 410000); db.seedRoom(committed);
  const active = started(499000); active.code = 'ABC237'; db.seedRoom(active);
  const waiting = started(); waiting.code = 'ABC238'; waiting.status = 'waiting'; db.seedRoom(waiting);
  const result = await adminRequest();
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 3);
  assert.equal(db.records.get('ABC235-1000-1').endedAt, 181000);
  assert.equal(db.records.get('ABC235-1000-1').endReason, 'timeout');
  assert.equal(db.records.get('ABC236-400000-1').endedAt, 470000);
  assert.equal(db.records.get('ABC236-400000-1').endReason, 'commit_timeout');
  assert.equal(db.room(active.code).status, 'playing');
  assert.equal(db.room(waiting.code).status, 'waiting');
  assert.equal((await adminRequest()).body.total, 3);
  assert.equal(db.records.size, 3, 'Subsequent scans remain idempotent.');
});

test('bounded backfill advances beyond 100 rooms on subsequent reads', async (t) => {
  const { db } = setup(t, 500000);
  const template = settled();
  for (let index = 0; index < 105; index++) {
    const room = structuredClone(template); room.code = codeFor(index);
    db.seedRoom(room, 0, index);
  }
  const first = await adminRequest();
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 100);
  assert.equal(first.body.backfillPending, true);
  const second = await adminRequest();
  assert.equal(second.body.total, 105);
  assert.equal(second.body.backfillPending, false);
  assert.equal(db.records.size, 105);
});

test('record search, stable pagination and detail retain literal player names without leaking private state', async (t) => {
  const { db } = setup(t);
  const room = settled(); db.seedRoom(room);
  for (let index = 0; index < 25; index++) {
    room.round = index + 1; room.endedAt = 5000 + index;
    room.players[0].name = index === 8 ? 'A_100%\\X' : index === 10 ? '中文玩家' : 'Alice';
    assert.equal(await records.writeRoomWithRecord(db, room, index, room.endedAt), true);
  }
  const first = await adminRequest();
  const second = await adminRequest('page=2');
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 25); assert.equal(first.body.pageSize, 20);
  assert.equal(first.body.records.length, 20); assert.equal(second.body.records.length, 5);
  assert.equal(first.body.records[0].round, 25); assert.equal(second.body.records[0].round, 5);
  assert.equal(new Set([...first.body.records, ...second.body.records].map(record => record.id)).size, 25);
  assert.ok(first.body.records.every(record => !('board' in record) && !('words' in record) && !('solutions' in record)));
  assert.equal((await adminRequest('q=abc234')).body.total, 25);
  for (const literal of ['%', '_', '\\', '中文玩家']) {
    const result = await adminRequest(`q=${encodeURIComponent(literal)}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 1, `Search ${literal} literally.`);
  }
  assert.equal((await adminRequest('q=does-not-exist')).body.total, 0);
  const detail = await adminRequest('id=ABC234-1000-9');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.record.players[0].name, 'A_100%\\X');
  assert.equal(detail.body.record.board.length, 16);
  assert.ok(detail.body.record.solutions.length > 0);
  assert.equal(JSON.stringify(detail.body).includes('secret'), false);
  assert.equal((await adminRequest('id=ABC234-1000-999')).status, 404);
});

test('records API validates pagination and identifiers before accessing the database', async (t) => {
  setup(t);
  globalThis.__gameTestDB = null;
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=01', 'page=10001', 'page=NaN', 'id=invalid', 'id=ABC234-1000-0', `q=${'x'.repeat(101)}`]) {
    const result = await adminRequest(query);
    assert.equal(result.status, 400, query);
    assert.match(result.headers.get('Cache-Control'), /no-store/);
  }
  assert.equal((await adminRequest()).status, 503);
  assert.deepEqual(admin.recordsQuery(new URL('http://localhost/api/admin/records?q=%20Alice%20&page=2')), { q: 'Alice', page: 2, id: null });
});
