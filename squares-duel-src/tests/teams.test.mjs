import test from 'node:test';
import assert from 'node:assert/strict';
import { game, player, legacyRoom, candidate, assertPublic, runtimeURL, MemoryD1, fixtureGameToken } from './helpers.mjs';

const { GET, POST } = await import(runtimeURL('route.mjs'));
const records = await import(runtimeURL('game-records.mjs'));
const origin = 'https://squares.example';
function roster() {
  const room = legacyRoom();
  game.joinGame(room, player('two'), 1100, { teamId: 1 });
  game.joinGame(room, player('three'), 1200, { teamId: 1 });
  game.joinGame(room, player('watcher'), 1300, { role: 'spectator' });
  return room;
}
function playing() { const room = roster(); game.startGame(room, 'one', 2000); return room; }
function setup(t) {
  const db = new MemoryD1(); const clock = { now: 1000 };
  globalThis.__gameTestDB = db;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => { db.close(); delete globalThis.__gameTestDB; });
  return { db, clock };
}
async function post(payload, token) {
  token = fixtureGameToken(payload, token);
  const response = await POST(new Request(`${origin}/api/game`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload),
  }));
  return { status: response.status, body: await response.json() };
}
async function get(code, token) {
  const response = await GET(new Request(`${origin}/api/game?code=${code}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
  return { status: response.status, body: await response.json() };
}
async function apiRoster() {
  const host = await post({ action: 'create', name: 'Host', wordCount: 'small' });
  assert.equal(host.status, 201);
  const code = host.body.room.code;
  const members = [];
  for (const [name, role, teamId] of [['Blue one', 'player', 1], ['Blue two', 'player', 1], ['Watcher', 'spectator', undefined]]) {
    const joined = await post({ action: 'join', code, name, role, ...(teamId === undefined ? {} : { teamId }) });
    assert.equal(joined.status, 200); members.push(joined.body);
  }
  return { code, host: host.body, blue: members.slice(0, 2), watcher: members[2] };
}

test('unequal teams and spectators wait without a timer or visible board until the host starts', () => {
  const room = roster();
  assert.equal(room.status, 'waiting');
  assert.equal(room.lastWordAt, null); assert.equal(room.startedAt, null);
  assert.equal(game.expire(room, 99999999), false);
  const view = game.publicGame(room);
  assert.equal(view.hostId, 'one'); assert.deepEqual(view.board, []);
  assert.equal('tileHints' in view, false); assert.equal('solutions' in view, false);
  assert.equal(view.deadline, null);
  assert.deepEqual(view.teams.map(team => team.totalPlayers), [1, 2]);
  assert.equal(view.spectators.length, 1); assert.equal(view.spectators[0].teamId, undefined);
  assertPublic(assert, view);
  game.startGame(room, 'one', 500000);
  assert.equal(room.status, 'playing'); assert.equal(room.startedAt, 500000);
  assert.equal(game.publicGame(room).board.length, 16);
  assert.equal(game.publicGame(room).deadline, 680000);
});

test('only the host starts and both teams require a participant, even if the host is spectating', () => {
  const room = legacyRoom();
  game.joinGame(room, player('two'), 1000, { teamId: 0 });
  assert.throws(() => game.startGame(room, 'two', 1000), { status: 403 });
  assert.throws(() => game.startGame(room, 'unknown', 1000), { status: 401 });
  assert.throws(() => game.startGame(room, 'one', 1000), { status: 409 });
  assert.equal(room.startedAt, null);
  game.changeTeam(room, 'one', 'spectator');
  assert.equal(room.hostId, 'one');
  assert.throws(() => game.startGame(room, 'one', 1000), { status: 409 });
  game.joinGame(room, player('three'), 1000, { teamId: 1 });
  game.startGame(room, 'one', 2000);
  assert.equal(room.status, 'playing');
  assert.deepEqual(room.players.map(member => member.id), ['two', 'three']);
  assert.throws(() => game.startGame(room, 'one', 2001), { status: 409 });
});

test('lobby role changes preserve credentials and host identity; rosters lock for play while late spectators can join', () => {
  const room = roster();
  game.changeTeam(room, 'three', 'player', 0);
  assert.equal(room.players.find(member => member.id === 'three').teamId, 0);
  game.changeTeam(room, 'three', 'spectator');
  assert.equal(room.players.some(member => member.id === 'three'), false);
  assert.equal(room.spectators.find(member => member.id === 'three').secret, 'secret-three');
  game.changeTeam(room, 'three', 'player', 1);
  assert.equal(room.spectators.some(member => member.id === 'three'), false);
  assert.throws(() => game.changeTeam(room, 'unknown', 'player', 0), { status: 401 });
  game.startGame(room, 'one', 2000);
  const before = structuredClone(room);
  for (const id of ['one', 'two', 'watcher']) assert.throws(() => game.changeTeam(room, id, 'spectator'), { status: 409 });
  assert.throws(() => game.joinGame(room, player('late'), 2001, { teamId: 0 }), { status: 409 });
  assert.deepEqual(room, before);
  game.joinGame(room, player('late-watcher'), 2001, { role: 'spectator' });
  assert.equal(room.spectators.length, 2);
  assert.deepEqual(game.publicGame(room).board, before.board);
  for (const action of [() => game.submitWord(room, 'watcher', candidate(room), undefined, 2002),
    () => game.commitGame(room, 'watcher', 2002)]) assert.throws(action, { status: 403 });
});

test('team scores combine teammates while each word remains exclusive to the whole room', () => {
  const room = playing(); const [first, second] = game.puzzleForGame(room).words;
  game.submitWord(room, 'two', first, undefined, 3000);
  for (const id of ['one', 'three']) assert.throws(() => game.submitWord(room, id, first, undefined, 3001), { status: 409 });
  game.submitWord(room, 'three', second, undefined, 3002);
  assert.deepEqual(room.words.map(word => [word.playerId, word.teamId]), [['two', 1], ['three', 1]]);
  const teams = game.publicGame(room).teams;
  assert.deepEqual(teams.map(team => team.score), [0, first.length + second.length]);
  assert.deepEqual(teams[1].playerIds, ['two', 'three']);
  assert.equal(room.players[1].score, first.length); assert.equal(room.players[2].score, second.length);
});

test('a partial team Commit locks only that player and starts no countdown until every teammate commits', () => {
  const room = playing(); const [first, second] = game.puzzleForGame(room).words;
  game.commitGame(room, 'two', 3000);
  assert.equal(room.commitDeadline, null);
  assert.deepEqual(game.publicGame(room).teams.map(team => [team.committedCount, team.committed]), [[0, false], [1, false]]);
  assert.equal(game.publicGame(room).deadline, 182000);
  assert.throws(() => game.submitWord(room, 'two', first, undefined, 3001), { status: 409 });
  game.submitWord(room, 'three', first, undefined, 3002);
  game.commitGame(room, 'three', 4000);
  assert.equal(room.commitDeadline, 64000);
  assert.equal(game.publicGame(room).teams[1].committedAt, 4000);
  game.commitGame(room, 'two', 5000);
  assert.equal(room.players[1].committedAt, 3000); assert.equal(room.commitDeadline, 64000);
  game.submitWord(room, 'one', second, undefined, 63999);
  assert.equal(room.commitDeadline, 64000);
  assert.equal(game.expire(room, 63999), false);
  assert.equal(game.expire(room, 64000), true);
  assert.equal(room.endReason, 'commit_timeout'); assert.equal(room.endedAt, 64000);
});

test('both fully committed teams settle immediately and partial teams retain the ordinary inactivity deadline', () => {
  const room = playing();
  game.commitGame(room, 'one', 3000);
  assert.equal(room.commitDeadline, 63000);
  game.commitGame(room, 'two', 4000);
  assert.equal(room.status, 'playing');
  game.commitGame(room, 'three', 5000);
  assert.equal(room.status, 'finished'); assert.equal(room.endReason, 'committed'); assert.equal(room.endedAt, 5000);
  const idle = playing();
  game.commitGame(idle, 'two', 3000);
  assert.equal(game.expire(idle, 182000), true);
  assert.equal(idle.endReason, 'timeout'); assert.equal(idle.endedAt, 182000);
});

test('legacy playing rooms gain two teams without restarting their timers, claims or credentials', () => {
  const room = legacyRoom();
  room.players.push(player('two')); room.status = 'playing'; room.startedAt = room.lastWordAt = 1000;
  room.words = [{ word: candidate(room), playerId: 'two', points: 4, bonus: false, at: 1200 }];
  const firstSecret = room.players[0].secret;
  game.normalizeTeams(room);
  assert.deepEqual(room.players.map(member => member.teamId), [0, 1]);
  assert.equal(room.words[0].teamId, 1); assert.equal(room.hostId, 'one'); assert.deepEqual(room.spectators, []);
  assert.equal(room.startedAt, 1000); assert.equal(room.lastWordAt, 1000);
  assert.equal(room.players[0].secret, firstSecret);
  assert.equal(game.publicGame(room).deadline, 181000);
});

test('host rematches preserve unequal rosters and spectators while clearing scores and requiring another manual start', () => {
  const room = playing(); game.submitWord(room, 'three', candidate(room), undefined, 3000);
  for (const id of ['one', 'two', 'three']) game.commitGame(room, id, 4000);
  const previousBoard = [...room.board]; const identities = [...room.players, ...room.spectators].map(member => [member.id, member.secret]);
  assert.throws(() => game.rematch(room, 'two', 5000), { status: 403 });
  assert.throws(() => game.rematch(room, 'watcher', 5000), { status: 403 });
  game.rematch(room, 'one', 5000);
  assert.equal(room.round, 2); assert.equal(room.status, 'waiting');
  assert.equal(room.lastWordAt, null); assert.equal(room.startedAt, null); assert.equal(room.commitDeadline, null);
  assert.notDeepEqual(room.board, previousBoard); assert.deepEqual(game.publicGame(room).board, []);
  assert.deepEqual([...room.players, ...room.spectators].map(member => [member.id, member.secret]), identities);
  assert.deepEqual(room.players.map(member => member.teamId), [0, 1, 1]);
  assert.ok(room.players.every(member => member.score === 0 && !member.committed && member.committedAt === null));
  assert.equal(game.expire(room, 99999999), false);
  game.startGame(room, 'one', 99999999);
  assert.equal(game.publicGame(room).deadline, 100179999);
});

test('API authenticates spectators for snapshots but rejects play, Commit, start and rematch privileges', async t => {
  const { db } = setup(t); const room = await apiRoster();
  const waiting = await get(room.code, room.watcher.token);
  assert.equal(waiting.status, 200); assert.deepEqual(waiting.body.room.board, []);
  assert.equal(waiting.body.playerId, room.watcher.playerId); assertPublic(assert, waiting.body.room);
  assert.equal((await post({ action: 'start', code: room.code }, room.watcher.token)).status, 403);
  assert.equal((await post({ action: 'start', code: room.code }, room.host.token)).status, 200);
  const word = game.puzzleForGame(db.room(room.code)).words[0];
  const before = db.rows.get(room.code).state;
  for (const action of ['word', 'commit', 'team']) {
    const result = await post({ action, code: room.code, word, role: 'player', teamId: 0 }, room.watcher.token);
    assert.equal(result.status, action === 'team' ? 409 : 403);
    assert.equal(db.rows.get(room.code).state, before);
  }
  const watched = await get(room.code, room.watcher.token);
  assert.equal(watched.status, 200); assert.equal(watched.body.room.board.length, 16);
  const late = await post({ action: 'join', code: room.code, name: 'Late watcher', role: 'spectator' });
  assert.equal(late.status, 200); assert.equal(late.body.room.spectators.length, 2);
  assertPublic(assert, late.body.room);
});

test('concurrent teammate Commits survive CAS and trigger the team countdown exactly once', async t => {
  const { db, clock } = setup(t); const room = await apiRoster();
  await post({ action: 'start', code: room.code }, room.host.token);
  clock.now = 2000; db.syncNextReads(2);
  const results = await Promise.all(room.blue.map(member => post({ action: 'commit', code: room.code }, member.token)));
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.ok(db.conflicts > 0);
  const active = db.room(room.code);
  assert.equal(active.status, 'playing'); assert.equal(active.commitDeadline, 62000);
  assert.deepEqual(active.players.map(member => member.committed), [false, true, true]);
  const view = (await get(room.code, room.watcher.token)).body.room;
  assert.equal(view.teams[1].committed, true); assert.equal(view.teams[1].committedAt, 2000);
  clock.now = 3000;
  const ended = await post({ action: 'commit', code: room.code }, room.host.token);
  assert.equal(ended.body.room.status, 'finished'); assert.equal(ended.body.room.endReason, 'committed');
  assert.equal((await post({ action: 'rematch', code: room.code }, room.watcher.token)).status, 403);
});

test('joining as a spectator while polling settles an overdue room still adds the watcher to the finished round', async t => {
  const { db, clock } = setup(t); const room = await apiRoster();
  await post({ action: 'start', code: room.code }, room.host.token);
  clock.now = 181000;
  const watcher = await post({ action: 'join', code: room.code, name: 'After timeout', role: 'spectator' });
  assert.equal(watcher.status, 200);
  assert.ok(watcher.body.token); assert.equal(watcher.body.room.status, 'finished');
  assert.equal(watcher.body.room.endReason, 'timeout'); assert.equal(watcher.body.room.endedAt, 181000);
  assert.equal(watcher.body.room.spectators.length, 2);
  assert.equal(watcher.body.room.spectators.at(-1).id, watcher.body.playerId);
  assert.ok(watcher.body.room.solutions.length > 0);
  const fetched = await get(room.code, watcher.body.token);
  assert.equal(fetched.status, 200); assertPublic(assert, fetched.body.room);
  assert.equal(db.room(room.code).words.length, 0);
});

test('a join racing the host start is linearized without a late participant altering a running roster', async t => {
  const { db } = setup(t); const room = await apiRoster();
  db.syncNextReads(2);
  const [starting, joining] = await Promise.all([
    post({ action: 'start', code: room.code }, room.host.token),
    post({ action: 'join', code: room.code, name: 'Race_participant', teamId: 0 }),
  ]);
  assert.equal(starting.status, 200);
  assert.ok([200, 409].includes(joining.status)); assert.ok(db.conflicts > 0);
  const active = db.room(room.code);
  assert.equal(active.status, 'playing');
  assert.equal(active.players.length, joining.status === 200 ? 4 : 3);
  assert.equal(active.players.filter(member => member.name === 'Race_participant').length, joining.status === 200 ? 1 : 0);
  if (joining.status === 200) assert.equal((await get(room.code, joining.body.token)).status, 200);
});

test('partial team Commit never fabricates a countdown on legacy migration and room capacity includes spectators', () => {
  const room = playing();
  room.players[1].committed = true; delete room.players[1].committedAt; delete room.commitDeadline;
  assert.equal(game.expire(room, 3000), false);
  assert.equal(game.publicGame(room).commitDeadline, null);
  assert.equal(game.publicGame(room).deadline, 182000);
  game.commitGame(room, 'three', 4000);
  assert.equal(room.commitDeadline, 64000);
  assert.equal(game.publicGame(room).teams[1].committedAt, null, 'Old incomplete timestamps cannot be invented.');
  const full = roster();
  for (let index = 4; index < 64; index++) game.joinGame(full, player(`watch-${index}`), 2000, { role: 'spectator' });
  assert.equal(full.players.length + full.spectators.length, 64);
  assert.throws(() => game.joinGame(full, player('overflow'), 2000, { role: 'spectator' }), { status: 409 });
  game.changeTeam(full, 'watcher', 'player', 0);
  assert.equal(full.players.length + full.spectators.length, 64, 'Changing roles does not allocate a second room slot.');
});

test('API rejects malformed roles and teams and lets a spectator host manage a full round', async t => {
  setup(t); const room = await apiRoster();
  for (const extra of [{ role: 'invalid' }, { role: null }, { teamId: -1 }, { teamId: 2 }, { teamId: '1' }, { teamId: null }]) {
    assert.equal((await post({ action: 'join', code: room.code, name: 'Invalid', ...extra })).status, 400);
  }
  const changed = await post({ action: 'team', code: room.code, role: 'spectator' }, room.host.token);
  assert.equal(changed.status, 200); assert.equal(changed.body.room.hostId, room.host.playerId);
  const orange = await post({ action: 'team', code: room.code, role: 'player', teamId: 0 }, room.watcher.token);
  assert.equal(orange.status, 200);
  assert.equal((await post({ action: 'start', code: room.code }, room.host.token)).status, 200);
  for (const member of [room.watcher, ...room.blue]) assert.equal((await post({ action: 'commit', code: room.code }, member.token)).status, 200);
  const next = await post({ action: 'rematch', code: room.code }, room.host.token);
  assert.equal(next.status, 200); assert.equal(next.body.room.status, 'waiting'); assert.equal(next.body.room.round, 2);
  assert.equal(next.body.room.hostId, room.host.playerId);
});

test('archives identify the winning team, its members and word owners while excluding spectator secrets', () => {
  const room = playing(); const [one, two] = game.puzzleForGame(room).words;
  game.submitWord(room, 'two', one, undefined, 3000); game.submitWord(room, 'three', two, undefined, 3001);
  for (const id of ['one', 'two', 'three']) game.commitGame(room, id, 4000);
  const record = records.recordForGame(room);
  assert.equal(record.winnerTeamId, 1); assert.equal(record.winnerId, null);
  assert.deepEqual(record.teams.map(team => team.score), [0, one.length + two.length]);
  assert.deepEqual(record.players.map(member => member.teamId), [0, 1, 1]);
  assert.deepEqual(record.words.map(word => [word.playerId, word.teamId]), [['two', 1], ['three', 1]]);
  assert.equal(record.players.some(member => member.id === 'watcher'), false);
  for (const member of [...room.players, ...room.spectators]) assert.equal(JSON.stringify(record).includes(member.secret), false);
  const summary = records.summaryOf(record); summary.teams[1].playerIds[0] = 'mutated';
  assert.deepEqual(record.teams[1].playerIds, ['two', 'three']);
});
