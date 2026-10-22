import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { smokeAccount } from './smoke-account.mjs';

const configured = new URL(process.argv[2] ?? process.env.HTTP_BASE ?? 'http://127.0.0.1:5173');
assert.ok(configured.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname)
  && !configured.username && !configured.password && configured.pathname === '/' && !configured.search && !configured.hash,
'Team smoke is local only: use an HTTP loopback origin.');
const base = configured.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(root, '.sites-runtime', 'teams-smoke');
await mkdir(runtime, { recursive: true });
for (const name of ['puzzles', 'dictionary-data', 'board-generator', 'word-routes']) {
  const input = await readFile(path.join(root, 'lib', `${name}.ts`), 'utf8');
  const output = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
    .outputText.replace(/(['"])\.\/([a-z][\w-]*)\1/g, "'./$2.mjs'");
  await writeFile(path.join(runtime, `${name}.mjs`), output);
}
const { solveBoard } = await import(pathToFileURL(path.join(runtime, 'board-generator.mjs')));
const { canonicalWordPath } = await import(pathToFileURL(path.join(runtime, 'word-routes.mjs')));
async function api(endpoint, payload, token, expected = 200) {
  const response = await fetch(`${base}${endpoint}`, {
    ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }),
    headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  assert.equal(response.status, expected, `${payload?.action ?? endpoint}: ${body.error ?? 'Unexpected response'}`);
  return body;
}
const post = (payload, token, expected) => api('/api/game', payload, token, expected);
await post({ action: 'create', wordCount: 'small' }, undefined, 401);
const hostAccount = await smokeAccount(base, 'teamH');
const host = await post({ action: 'create', wordCount: 'small' }, hostAccount.token, 201);
const code = host.room.code;
assert.deepEqual(host.room.board, []); assert.equal(host.room.status, 'waiting'); assert.equal(host.room.deadline, null);
await post({ action: 'start', code }, host.token, 409);
const blue = [];
for (const label of ['teamB1', 'teamB2']) {
  const account = await smokeAccount(base, label);
  blue.push(await post({ action: 'join', code, teamId: 1 }, account.token));
}
const watcherAccount = await smokeAccount(base, 'teamW');
const watcher = await post({ action: 'join', code, role: 'spectator' }, watcherAccount.token);
assert.equal(watcher.room.status, 'waiting'); assert.deepEqual(watcher.room.teams.map(team => team.totalPlayers), [1, 2]);
assert.deepEqual(watcher.room.board, []);
const text = '旁观者在开局前聊天';
await api('/api/chat', { code, text, clientId: crypto.randomUUID() }, watcher.token);
assert.equal((await api(`/api/chat?code=${code}`, undefined, host.token)).messages.at(-1).text, text);
await post({ action: 'start', code }, blue[0].token, 403);
const started = await post({ action: 'start', code }, host.token);
assert.equal(started.room.status, 'playing'); assert.equal(started.room.board.length, 16);
assert.ok(started.room.deadline > started.serverNow);
const board = started.room.board;
const puzzle = solveBoard(board);
const word = puzzle.words[0], nextWord = puzzle.words[1];
await api(`/api/chat?code=${code}`, undefined, host.token, 409);
await api('/api/chat', { code, text: 'During game', clientId: crypto.randomUUID() }, watcher.token, 409);
const lateAccount = await smokeAccount(base, 'teamL');
await post({ action: 'join', code, teamId: 0 }, lateAccount.token, 409);
const lateWatcher = await post({ action: 'join', code, role: 'spectator' }, lateAccount.token);
assert.deepEqual(lateWatcher.room.board, board); assert.equal(lateWatcher.room.spectators.length, 2);
await post({ action: 'word', code, word }, watcher.token, 403);
await post({ action: 'commit', code }, watcher.token, 403);
const first = await post({ action: 'word', code, word, path: canonicalWordPath(board, word) }, blue[0].token);
assert.equal(first.room.teams[1].score, word.length);
assert.equal(first.room.words[0].teamId, 1); assert.equal(first.room.words[0].playerId, blue[0].playerId);
await post({ action: 'word', code, word }, blue[1].token, 409);
await post({ action: 'word', code, word }, host.token, 409);
const partial = await post({ action: 'commit', code }, blue[0].token);
assert.equal(partial.room.commitDeadline, null); assert.equal(partial.room.teams[1].committed, false);
await post({ action: 'word', code, word: nextWord }, blue[0].token, 409);
const teammate = await post({ action: 'word', code, word: nextWord, path: canonicalWordPath(board, nextWord) }, blue[1].token);
assert.equal(teammate.room.teams[1].score, word.length + nextWord.length);
const full = await post({ action: 'commit', code }, blue[1].token);
assert.equal(full.room.teams[1].committed, true); assert.equal(full.room.commitDeadline, full.serverNow + 60000);
const repeat = await post({ action: 'commit', code }, blue[0].token);
assert.equal(repeat.room.commitDeadline, full.room.commitDeadline);
const ended = await post({ action: 'commit', code }, host.token);
assert.equal(ended.room.status, 'finished'); assert.equal(ended.room.endReason, 'committed');
assert.equal(ended.room.solutions.length, puzzle.words.length + puzzle.bonus.length);
await api(`/api/chat?code=${code}`, undefined, watcher.token, 409);
await post({ action: 'rematch', code }, blue[0].token, 403);
const waiting = await post({ action: 'rematch', code }, host.token);
assert.equal(waiting.room.status, 'waiting'); assert.equal(waiting.room.round, 2);
assert.equal(waiting.room.deadline, null); assert.deepEqual(waiting.room.board, []);
assert.deepEqual(waiting.room.teams.map(team => team.score), [0, 0]);
assert.deepEqual(waiting.room.teams.map(team => team.totalPlayers), [1, 2]);
assert.equal(waiting.room.spectators.length, 2);
assert.equal((await api(`/api/chat?code=${code}`, undefined, watcher.token)).messages.at(-1).text, text);
const next = await post({ action: 'start', code, round: 2 }, host.token);
assert.equal(next.room.status, 'playing'); assert.notDeepEqual(next.room.board, board);
for (const member of [host, ...blue]) await post({ action: 'commit', code, round: 2 }, member.token);
console.log(JSON.stringify({ localTeams: true, unequalTeams: true, hostManualStart: true, spectators: true,
  lobbyOnlyChat: true, sharedExclusiveWords: true, wholeTeamCommit: true, hostManualRematch: true }));
