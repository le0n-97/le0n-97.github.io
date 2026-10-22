import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { game, puzzles, runtimeURL } from './helpers.mjs';

const { solveBoard, generateBoard } = await import(runtimeURL('board-generator.mjs'));
const { DICTIONARY_VERSION, MAIN_WORDS_COMPACT, BONUS_WORDS_COMPACT } = await import(runtimeURL('dictionary-data.mjs'));
const mainWords = MAIN_WORDS_COMPACT.split(/\s+/).filter(Boolean);
const bonusWords = BONUS_WORDS_COMPACT.split(/\s+/).filter(Boolean);
const manifest = JSON.parse(await readFile(new URL('../data/dictionary-sources.json', import.meta.url), 'utf8'));

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

// Deliberately checks each dictionary entry with coordinate-based DFS rather
// than sharing the production trie, bit mask, adjacency helper or findPath.
function independentSolve(board) {
  const starts = new Map();
  const counts = new Map();
  board.forEach((letter, index) => {
    if (!starts.has(letter)) starts.set(letter, []);
    starts.get(letter).push(index);
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  });
  const reachable = word => {
    const needed = new Map();
    for (const letter of word) {
      const count = (needed.get(letter) ?? 0) + 1;
      if (count > (counts.get(letter) ?? 0)) return false;
      needed.set(letter, count);
    }
    const used = Array(16).fill(false);
    const visit = (tile, offset) => {
      if (used[tile] || board[tile] !== word[offset]) return false;
      if (offset === word.length - 1) return true;
      used[tile] = true;
      const row = Math.floor(tile / 4), column = tile % 4;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const y = row + dy, x = column + dx;
        if (y >= 0 && y < 4 && x >= 0 && x < 4 && visit(y * 4 + x, offset + 1)) { used[tile] = false; return true; }
      }
      used[tile] = false;
      return false;
    };
    return (starts.get(word[0]) ?? []).some(tile => visit(tile, 0));
  };
  return { words: mainWords.filter(reachable).sort(), bonus: bonusWords.filter(reachable).sort() };
}

test('the generated-game dictionary contains distinct main and bonus English entries with an explicit version', () => {
  assert.equal(typeof DICTIONARY_VERSION, 'string');
  assert.ok(DICTIONARY_VERSION.length > 0);
  assert.ok(mainWords.length > 50_000, 'Generation needs a general dictionary rather than a list of fixed-board answers.');
  assert.ok(bonusWords.length > 1000);
  const main = new Set(mainWords);
  assert.equal(main.size, mainWords.length);
  assert.equal(new Set(bonusWords).size, bonusWords.length);
  for (const word of [...mainWords, ...bonusWords]) assert.match(word, /^[A-Z]{4,16}$/);
  assert.ok(bonusWords.every(word => !main.has(word)), 'Main and bonus classifications must be exclusive.');
});

test('dictionary data matches its source manifest counts, length distribution and content hashes', () => {
  assert.equal(DICTIONARY_VERSION, manifest.id);
  assert.equal(mainWords.length, manifest.output.mainWords);
  assert.equal(bonusWords.length, manifest.output.bonusWords);
  const byLength = words => words.reduce((counts, word) => { counts[word.length] = (counts[word.length] ?? 0) + 1; return counts; }, {});
  assert.deepEqual(byLength(mainWords), manifest.output.mainByLength);
  assert.deepEqual(byLength(bonusWords), manifest.output.bonusByLength);
  assert.equal(createHash('sha256').update(MAIN_WORDS_COMPACT).digest('hex'), manifest.output.mainSha256);
  assert.equal(createHash('sha256').update(BONUS_WORDS_COMPACT).digest('hex'), manifest.output.bonusSha256);
});

test('every generated tier includes its complete independent dictionary solution without truncating to the requested count', () => {
  const ranges = { any: [30, 70], small: [30, 40], medium: [41, 55], large: [56, 70] };
  const catalogue = new Set(puzzles.map(puzzle => game.canonicalBoardSignature(puzzle.board)));
  const signatures = new Set();
  for (const [index, [tier, [minimum, maximum]]] of Object.entries(ranges).entries()) {
    const seed = 123456789 + index;
    const puzzle = generateBoard(tier, [], { random: seeded(seed) });
    assert.equal(puzzle.board.length, 16);
    assert.ok(puzzle.board.every(letter => /^[A-Z]$/.test(letter)));
    assert.ok(puzzle.words.length >= minimum && puzzle.words.length <= maximum, `${tier}: ${puzzle.words.length} main words`);
    assert.ok(puzzle.words.some(word => word.length >= 8 && !word.endsWith('S')), `${tier} needs an ordinary long word beyond plural padding.`);
    assert.ok(puzzle.words.filter(word => word.length >= 7).length >= 2);
    assert.ok(puzzle.words.filter(word => word.length >= 6).length >= 3);
    assert.equal(typeof puzzle.generatorVersion, 'string');
    assert.ok(puzzle.generatorVersion.length > 0);
    const expected = independentSolve(puzzle.board);
    assert.deepEqual({ words: puzzle.words, bonus: puzzle.bonus }, expected);
    assert.deepEqual(solveBoard(puzzle.board), expected);
    for (const word of [...puzzle.words, ...puzzle.bonus]) {
      const path = game.findPath(puzzle.board, word);
      assert.ok(path && game.validPath(puzzle.board, word, path));
    }
    const signature = game.canonicalBoardSignature(puzzle.board);
    assert.equal(catalogue.has(signature), false, 'The generated board must not be a catalogue board in another orientation.');
    assert.equal(signatures.has(signature), false, 'Different tier samples must be different word puzzles.');
    signatures.add(signature);
    assert.deepEqual(generateBoard(tier, [], { random: seeded(seed) }), puzzle, 'An injected random seed must reproduce the full puzzle.');
  }
});

test('the solver preserves the complete answer sets when a board is rotated or reflected', () => {
  const puzzle = generateBoard('medium', [], { random: seeded(123456789) });
  const rotate = board => Array.from({ length: 16 }, (_, i) => board[(3 - i % 4) * 4 + Math.floor(i / 4)]);
  const mirror = board => Array.from({ length: 16 }, (_, i) => board[Math.floor(i / 4) * 4 + 3 - i % 4]);
  const expected = { words: puzzle.words, bonus: puzzle.bonus };
  for (const reflected of [false, true]) {
    let board = reflected ? mirror(puzzle.board) : [...puzzle.board];
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(solveBoard(board), expected);
      board = rotate(board);
    }
  }
});

test('bounded generation rejects a blocked deterministic board instead of silently selecting a static puzzle', () => {
  const candidate = generateBoard('any', [], { random: seeded(1), maxAttempts: 1 });
  assert.throws(() => generateBoard('any', [candidate.board.join('')], { random: seeded(1), maxAttempts: 1 }), /重试/);
  for (const maxAttempts of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => generateBoard('any', [], { maxAttempts }), Error);
  }
});

test('long-word quality is guaranteed by ordinary answers across varied layouts in every count tier', () => {
  for (const [tierIndex, tier] of ['any', 'small', 'medium', 'large'].entries()) {
    const signatures = new Set();
    for (let index = 0; index < 12; index++) {
      const puzzle = generateBoard(tier, [], { random: seeded(90210 + tierIndex * 100 + index) });
      assert.ok(puzzle.words.some(word => word.length >= 8 && !word.endsWith('S')), `${tier} sample ${index} lacks a non-plural ordinary long word.`);
      assert.ok(puzzle.words.filter(word => word.length >= 7).length >= 2, 'Bonus answers cannot satisfy the ordinary 7+ requirement.');
      assert.ok(puzzle.words.filter(word => word.length >= 6).length >= 3, 'Bonus answers cannot satisfy the ordinary 6+ requirement.');
      const signature = game.canonicalBoardSignature(puzzle.board);
      assert.equal(signatures.has(signature), false);
      signatures.add(signature);
    }
  }
});

test('generation honors a blocked board in the last position of a 64-board recent history', () => {
  const seed = 123456789;
  const original = generateBoard('small', [], { random: seeded(seed) });
  const preceding = puzzles.slice(0, 63).map(puzzle => puzzle.board.join(''));
  assert.equal(preceding.length, 63);
  assert.deepEqual(generateBoard('small', preceding, { random: seeded(seed) }), original,
    'Unrelated legacy signatures must not change the seeded candidate stream.');
  const history = [...preceding, original.board.join('')];
  const next = generateBoard('small', history, { random: seeded(seed) });
  assert.notEqual(game.canonicalBoardSignature(next.board), game.canonicalBoardSignature(original.board));
  assert.ok(next.words.length >= 30 && next.words.length <= 40);
  assert.deepEqual({ words: next.words, bonus: next.bonus }, solveBoard(next.board));
});
