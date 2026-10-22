import test from 'node:test';
import assert from 'node:assert/strict';
import { game, runtimeURL, started } from './helpers.mjs';

const { canonicalWordPath, wordRoutes } = await import(runtimeURL('word-routes.mjs'));
const board = ['A', 'B', 'A', 'X', 'X', 'C', 'D', 'X', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M'];
const words = ['ABCD', 'ACDB', 'EFGH'];
const bonus = ['JKLM'];

// Exhaustively enumerate this small repeated-letter fixture independently of
// production route helpers. Index order defines the lexicographically first
// valid route, while later routes remain legal player selections.
function everyPath(letters, word) {
  const paths = [];
  const used = new Set(), path = [];
  const visit = (tile, offset) => {
    if (used.has(tile) || letters[tile] !== word[offset]) return;
    used.add(tile); path.push(tile);
    if (path.length === word.length) paths.push([...path]);
    else for (let next = 0; next < letters.length; next++) {
      const dy = Math.abs(Math.floor(next / 4) - Math.floor(tile / 4));
      const dx = Math.abs(next % 4 - tile % 4);
      if (dy <= 1 && dx <= 1) visit(next, offset + 1);
    }
    path.pop(); used.delete(tile);
  };
  for (let tile = 0; tile < letters.length; tile++) visit(tile, 0);
  return paths;
}

function fixture() {
  const room = started();
  room.puzzleId = -1;
  room.board = [...board];
  room.generatedPuzzle = { board: [...board], words: [...words], bonus: [...bonus], generatorVersion: 'route-fixture' };
  return room;
}

test('canonical routes use the first index-ordered path and their masks exclude other legal routes', () => {
  const routes = wordRoutes(board, words, bonus);
  assert.deepEqual(everyPath(board, 'ABCD'), [[0, 1, 5, 6], [2, 1, 5, 6]]);
  for (const word of [...words, ...bonus]) {
    const expected = everyPath(board, word)[0];
    const route = routes.get(word);
    assert.deepEqual(canonicalWordPath(board, word), expected);
    assert.deepEqual(route.path, expected);
    assert.equal(route.usableMask, expected.reduce((mask, tile) => mask + 2 ** tile, 0));
    assert.equal(route.bonus, bonus.includes(word));
  }
  assert.equal(routes.get('ABCD').usableMask & (1 << 2), 0, 'The second A is legal but is absent from the canonical route.');
  assert.equal(canonicalWordPath('ABCDEFGHIJKLMNOP'.split(''), 'ABAB'), null, 'A tile cannot be reused.');
  assert.equal(canonicalWordPath(board, 'ABCDABCDABCDABCDE'), null);
});

test('tile hints hide numbers before 40%, count a word once, and grey only remaining ordinary canonical routes', () => {
  const room = fixture();
  const initial = game.publicGame(room);
  const initialUsable = [0, 1, 5, 6, 8, 9, 10, 11];
  assert.equal(initial.tileHints.unlocked, false);
  assert.equal('starts' in initial.tileHints, false);
  assert.deepEqual(initial.tileHints.usable, board.map((_, tile) => initialUsable.includes(tile)));
  assert.equal(initial.tileHints.usable[2], false, 'Alternative routes do not affect the canonical grey hint.');
  assert.ok([12, 13, 14, 15].every(tile => !initial.tileHints.usable[tile]), 'Bonus-only cells are grey.');
  assert.equal('tileHints' in room, false);

  const claimedBonus = game.submitWord(room, 'two', 'JKLM', [12, 13, 14, 15], 2000);
  assert.equal(claimedBonus.points, 1, 'Grey cells remain selectable for bonus words.');
  assert.deepEqual(game.publicGame(room).tileHints, initial.tileHints);
  game.submitWord(room, 'one', 'EFGH', [8, 9, 10, 11], 2001);
  const beforeUnlock = game.publicGame(room);
  assert.equal(beforeUnlock.tileHints.unlocked, false);
  assert.equal('starts' in beforeUnlock.tileHints, false);
  assert.deepEqual(beforeUnlock.tileHints.usable, board.map((_, tile) => [0, 1, 5, 6].includes(tile)), 'A claimed route disappears immediately, before numbers unlock.');

  game.submitWord(room, 'two', 'ACDB', [0, 5, 6, 1], 2002);
  const unlocked = game.publicGame(room);
  assert.equal(unlocked.tileHints.unlocked, true);
  assert.deepEqual(unlocked.tileHints.starts, [1, ...Array(15).fill(0)]);
  assert.equal(unlocked.tileHints.starts.reduce((sum, count) => sum + count, 0), unlocked.remainingWords);
  assert.equal(unlocked.tileHints.usable[2], false);
  assertPublicHintsUnchanged(room, unlocked);

  game.submitWord(room, 'one', 'ABCD', [2, 1, 5, 6], 2003);
  const finished = game.publicGame(room);
  assert.equal(finished.endReason, 'all_words');
  assert.deepEqual(finished.tileHints.starts, Array(16).fill(0));
  assert.deepEqual(finished.tileHints.usable, Array(16).fill(false));
  assert.deepEqual(finished.solutions.find(item => item.word === 'ABCD').path, [0, 1, 5, 6], 'Review uses the canonical route even when a player found another route.');
});

function assertPublicHintsUnchanged(room, expected) {
  const before = structuredClone(room);
  assert.deepEqual(game.publicGame(room).tileHints, expected.tileHints);
  assert.deepEqual(room, before, 'Computing hints must not mutate the stored round.');
}

test('settlement reveals canonical starting counts below 40% without making bonus-only cells usable', () => {
  const room = fixture();
  game.commitGame(room, 'one', 2000);
  game.commitGame(room, 'two', 2001);
  const ended = game.publicGame(room);
  assert.equal(ended.wordStats.found, 0);
  assert.equal(ended.tileHints.unlocked, true);
  assert.deepEqual(ended.tileHints.starts, [2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(ended.tileHints.starts.reduce((sum, count) => sum + count, 0), words.length);
  assert.ok([2, 3, 4, 7, 12, 13, 14, 15].every(tile => !ended.tileHints.usable[tile]));
  for (const solution of ended.solutions) assert.deepEqual(solution.path, everyPath(board, solution.word)[0]);
});
