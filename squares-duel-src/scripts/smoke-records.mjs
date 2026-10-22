import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import ts from 'typescript';
import { smokeAccount } from './smoke-account.mjs';

// This check creates two local rounds. Refuse public hosts before any request.
const configured = new URL(process.env.HTTP_BASE ?? 'http://127.0.0.1:5173');
assert.ok(configured.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname)
  && !configured.username && !configured.password && configured.pathname === '/'
  && !configured.search && !configured.hash,
'Record smoke is local only: HTTP_BASE must be an HTTP loopback origin.');
const base = configured.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(root, '.sites-runtime', 'records-smoke');
await mkdir(runtime, { recursive: true });
// Compile only the local solver modules; no previous test run is required.
for (const name of ['puzzles', 'dictionary-data', 'board-generator', 'word-routes']) {
  const input = await readFile(path.join(root, 'lib', `${name}.ts`), 'utf8');
  const output = ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/(['"])\.\/([a-z][\w-]*)\1/g, "'./$2.mjs'");
  await writeFile(path.join(runtime, `${name}.mjs`), output);
}
const { solveBoard } = await import(pathToFileURL(path.join(runtime, 'board-generator.mjs')));
const { canonicalWordPath } = await import(pathToFileURL(path.join(runtime, 'word-routes.mjs')));

function assertPrivateFieldsAbsent(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!['secret', 'token', 'accountId', 'generatedPuzzle', 'puzzleId', 'puzzleHistory', 'boardHistory'].includes(key),
      `Private field appeared in public response: ${key}`);
    assertPrivateFieldsAbsent(item);
  }
}
async function jsonRequest(endpoint, { payload, token, expected = 200, headers = {} } = {}) {
  const response = await fetch(`${base}${endpoint}`, {
    method: payload ? 'POST' : 'GET',
    headers: {
      ...(payload ? { 'Content-Type': 'application/json', Origin: base } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  assert.match(response.headers.get('Content-Type') ?? '', /application\/json/,
    `${endpoint}: expected JSON, received HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(response.status, expected, `${payload?.action ?? endpoint}: ${body.error ?? 'Unexpected response'}`);
  return body;
}
const post = (payload, token, expected) => jsonRequest('/api/game', { payload, token, expected });
const records = params => jsonRequest(`/api/admin/records?${new URLSearchParams(params)}`);
const hostAccount = await smokeAccount(base, 'recordH');
const guestAccount = await smokeAccount(base, 'recordB');
const hostName = hostAccount.user.username;
const guestName = guestAccount.user.username;
const host = await post({ action: 'create', wordCount: 'small' }, hostAccount.token, 201);
const code = host.room.code;
const guest = await post({ action: 'join', code }, guestAccount.token);
assert.equal(guest.room.status, 'waiting');
assert.deepEqual(guest.room.board, []);
guest.room = (await post({ action: 'start', code }, host.token)).room;
assert.equal(guest.room.boardSource, 'random');
assert.equal(guest.room.status, 'playing');
assert.equal(guest.room.round, 1);
assertPrivateFieldsAbsent(guest.room);
const puzzle = solveBoard(guest.room.board);
assert.ok(puzzle.words.length >= 30 && puzzle.words.length <= 40);
assert.ok(puzzle.bonus.length > 0, 'This local board needs a bonus word for the scoring check.');
const mainWord = puzzle.words[0];
const bonusWord = puzzle.bonus[0];
await post({ action: 'word', code, round: 1, word: mainWord,
  path: canonicalWordPath(guest.room.board, mainWord) }, host.token);
await post({ action: 'word', code, round: 1, word: bonusWord,
  path: canonicalWordPath(guest.room.board, bonusWord) }, guest.token);
const beforeEnd = await records({ q: code });
assert.equal(beforeEnd.total, 0, 'A live round must not be archived.');
await post({ action: 'commit', code, round: 1 }, host.token);
const settled = await post({ action: 'commit', code, round: 1 }, guest.token);
assert.equal(settled.room.status, 'finished');
assert.equal(settled.room.players.find(player => player.id === host.playerId).score, mainWord.length);
assert.equal(settled.room.players.find(player => player.id === guest.playerId).score, 1);
const firstList = await records({ q: code });
assert.equal(firstList.total, 1);
assert.equal(firstList.pageSize, 20);
assert.equal(firstList.records.length, 1);
assert.ok(!('board' in firstList.records[0]) && !('words' in firstList.records[0]) && !('solutions' in firstList.records[0]));
assertPrivateFieldsAbsent(firstList);
const first = (await records({ id: firstList.records[0].id })).record;
assertPrivateFieldsAbsent(first);
assert.equal(first.round, 1);
assert.equal(first.winnerId, host.playerId);
assert.equal(first.winnerTeamId, 0);
assert.equal(first.endReason, 'committed');
assert.equal(first.totalWords, puzzle.words.length);
assert.equal(first.foundWords, 1);
assert.equal(first.bonusFound, 1);
assert.equal(first.durationMs, first.endedAt - first.startedAt);
assert.deepEqual(first.board, guest.room.board);
assert.deepEqual(first.words, settled.room.words);
assert.equal(first.solutions.length, puzzle.words.length + puzzle.bonus.length);
for (const solution of first.solutions) {
  assert.deepEqual(solution.path, canonicalWordPath(first.board, solution.word));
  assert.equal(solution.points, solution.bonus ? 1 : solution.word.length);
}
assert.equal((await records({ q: hostName })).total, 1);
assert.equal((await records({ q: guestName })).total, 1);
assert.equal((await records({ q: `${hostName}%` })).total, 0, 'Search must treat wildcard input literally.');
await jsonRequest('/api/admin/records?page=0', { expected: 400 });
await jsonRequest('/api/admin/records?id=', { expected: 400 });
await jsonRequest(`/api/admin/records?id=${code}-1-999`, { expected: 404 });

await post({ action: 'rematch', code, round: 1 }, host.token);
const rematched = await post({ action: 'start', code, round: 2 }, host.token);
assert.equal(rematched.room.status, 'playing');
assert.equal(rematched.room.round, 2);
assert.notDeepEqual(rematched.room.board, first.board);
assert.deepEqual((await records({ id: first.id })).record, first, 'Rematch must preserve the first round unchanged.');
assert.equal((await records({ q: code })).total, 1);
await post({ action: 'commit', code, round: 2 }, host.token);
await post({ action: 'commit', code, round: 2 }, guest.token);
const both = await records({ q: code });
assert.equal(both.total, 2);
assert.deepEqual(both.records.map(record => record.round), [2, 1]);
assert.notEqual(both.records[0].id, both.records[1].id);
const second = (await records({ id: both.records[0].id })).record;
assert.equal(second.winnerId, null);
assert.deepEqual(second.words, []);
assert.ok(second.players.every(player => player.score === 0));
assert.deepEqual(second.board, rematched.room.board);
assert.deepEqual((await records({ id: first.id })).record, first);
const pageTwo = await records({ q: code, page: '2' });
assert.equal(pageTwo.total, 2);
assert.deepEqual(pageTwo.records, []);
assert.equal((await records({ q: hostName })).total, 2);
assert.equal((await records({ q: guestName })).total, 2);

// Vite may reject a foreign Host before the route's loopback guard sees it.
const rejectedHostStatus = await new Promise((resolve, reject) => {
  // Use the HTTP client directly: Fetch may normalize the Host header to its URL.
  const request = httpRequest(new URL('/api/admin/records', base), {
    headers: { Host: 'records-smoke.invalid' },
  }, response => {
    response.resume();
    resolve(response.statusCode);
  });
  request.on('error', reject);
  request.setTimeout(30_000, () => request.destroy(new Error('Local Host guard request timed out.')));
  request.end();
});
assert.ok([403, 404].includes(rejectedHostStatus), `A non-local request Host must be rejected (received HTTP ${rejectedHostStatus}).`);
console.log('Local records HTTP smoke passed: two independent rounds, exact main/bonus scoring, canonical review paths, credential privacy, retained rematch history, player/code search, literal wildcards, pagination, invalid queries and non-local Host rejection.');
