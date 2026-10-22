import test from 'node:test';
import assert from 'node:assert/strict';
import { game, puzzles, player, legacyRoom, started, candidate, assertPublic } from './helpers.mjs';

function matchesTier(puzzle, tier) {
  const count = puzzle.words.length;
  return tier === 'any' || (tier === 'small' && count >= 30 && count <= 40)
    || (tier === 'medium' && count > 40 && count <= 55) || (tier === 'large' && count > 55 && count <= 70);
}
function boardViews(board) {
  const letters = typeof board === 'string' ? board.split('') : [...board];
  const rotate = value => Array.from({ length: 16 }, (_, i) => value[(3 - i % 4) * 4 + Math.floor(i / 4)]);
  const mirror = value => Array.from({ length: 16 }, (_, i) => value[Math.floor(i / 4) * 4 + 3 - i % 4]);
  const views = [];
  for (const reflected of [false, true]) {
    let current = reflected ? mirror(letters) : letters;
    for (let i = 0; i < 4; i++) { views.push(current.join('')); current = rotate(current); }
  }
  return views;
}
function nextRound(room, now) {
  game.commitGame(room, 'one', now);
  game.commitGame(room, 'two', now);
  game.rematch(room, 'one', now + 1);
  game.startGame(room, 'one', now + 1);
}

test('all packaged puzzles have valid boards and reachable, distinct word lists', () => {
  assert.ok(puzzles.length >= 2, 'Saved legacy rooms need their original catalogue entries.');
  for (const puzzle of puzzles) {
    assert.equal(puzzle.board.length, 16);
    assert.ok(puzzle.board.every(letter => /^[A-Z]$/.test(letter)));
    const words = [...puzzle.words, ...puzzle.bonus];
    assert.equal(new Set(words).size, words.length);
    assert.ok(puzzle.words.length > 0);
    for (const word of words) {
      assert.match(word, /^[A-Z]{4,16}$/);
      const path = game.findPath(puzzle.board, word);
      assert.ok(path, `${word} must be reachable.`);
      assert.ok(game.validPath(puzzle.board, word, path));
    }
  }
});

test('original puzzle indexes remain stable for rooms saved before the expanded catalogue', () => {
  assert.deepEqual(puzzles.slice(0, 10).map(puzzle => puzzle.board.join('')), [
    'NIOEWMSVLGETESIN', 'NUMXNAAOOISHMUMC', 'LYFFMREOHRRTOEPY', 'YUPESIBRKOLCRSUI', 'POHENDCHREKGCNIN',
    'OBTOGNDHNUIEUCRX', 'FTEOTURICLNVYFSG', 'NTCEIGIRPACIFAMN', 'OJAMSYGIONINBITA', 'LINOIIBDTGESKYLA',
  ]);
});

test('joining a room keeps its timer stopped until its host manually starts', () => {
  const room = game.createGame('ABC234', player('one'), 20);
  assert.equal(room.status, 'waiting');
  assert.equal(room.lastWordAt, null);
  assert.equal(game.expire(room, 9999999), false);
  game.joinGame(room, player('two'), 1000);
  assert.equal(room.status, 'waiting');
  game.joinGame(room, player('three'), 1001);
  assert.equal(room.players.length, 3);
  game.startGame(room, 'one', 1002);
  assert.equal(room.status, 'playing');
  assert.equal(room.startedAt, 1002);
  assert.equal(room.lastWordAt, 1002);
  assert.throws(() => game.joinGame(room, player('four'), 1003), { status: 409 });
});

test('paths allow diagonal neighbors and reject row wrapping, reused cells and invalid indexes', () => {
  const board = 'ABCDEFGHIJKLMNOP'.split('');
  assert.ok(game.validPath(board, 'AFKP', [0, 5, 10, 15]));
  assert.deepEqual(game.findPath(board, 'AFKP'), [0, 5, 10, 15]);
  assert.equal(game.validPath(board, 'DEFG', [3, 4, 5, 6]), false);
  assert.equal(game.isAdjacent(3, 4), false);
  assert.equal(game.findPath(board, 'DEFG'), null);
  assert.equal(game.validPath(board, 'ABAB', [0, 1, 0, 1]), false);
  assert.equal(game.findPath(board, 'ABAB'), null);
  for (const path of [null, {}, [0, 5, 10], [0, 5, 10, 16], [0, 5, 10, -1], [0, 5, 10, 15.1], [0, 5, 10, '15']]) {
    assert.equal(game.validPath(board, 'AFKP', path), false);
  }
});

test('regular words score exactly their length; normalized words can be claimed only once', () => {
  const room = started();
  const word = candidate(room);
  const result = game.submitWord(room, 'one', ` ${word.toLowerCase()} `, undefined, 2000);
  assert.deepEqual(result, { word, points: word.length, bonus: false });
  assert.equal(room.players[0].score, word.length);
  assert.equal(room.players[1].score, 0);
  assert.equal(room.lastWordAt, 2000);
  assert.throws(() => game.submitWord(room, 'two', word, undefined, 3000), { status: 409 });
  assert.throws(() => game.submitWord(room, 'one', word, undefined, 3000), { status: 409 });
  assert.equal(room.lastWordAt, 2000);
  assert.equal(room.words.length, 1);
});

test('bonus words of every available length score one, are exclusive, and reset inactivity', () => {
  const room = started();
  const puzzleId = puzzles.findIndex(puzzle => puzzle.bonus.length);
  assert.ok(puzzleId >= 0, 'A bonus-word fixture is required.');
  room.puzzleId = puzzleId;
  room.board = [...puzzles[puzzleId].board];
  const bonus = puzzles[puzzleId].bonus;
  const words = [...new Map(bonus.map(word => [word.length, word])).values()];
  for (const word of words) {
    const before = room.players[0].score;
    const result = game.submitWord(room, 'one', word, undefined, 150000);
    assert.deepEqual(result, { word, points: 1, bonus: true });
    assert.equal(room.players[0].score, before + 1);
    assert.throws(() => game.submitWord(room, 'two', word, undefined, 150001), { status: 409 });
  }
  assert.equal(room.lastWordAt, 150000);
});

test('short words, dictionary misses and invalid paths cannot score or reset the clock', () => {
  const room = started();
  const before = structuredClone(room);
  const word = candidate(room);
  for (const [raw, path] of [[null, undefined], ['CAT', undefined], ['ABCD', undefined], [word, []], [word, null]]) {
    assert.throws(() => game.submitWord(room, 'one', raw, path, 2000), game.GameError);
    assert.deepEqual(room, before);
  }
  room.board = 'ABCDEFGHIJKLMNOP'.split('');
  assert.throws(() => game.submitWord(room, 'one', 'ABCD', [0, 1, 2, 3], 2000), /词库/);
  assert.equal(room.lastWordAt, 1000);
  assert.equal(room.words.length, 0);
});

test('committed players are locked; the other player can continue until both commit', () => {
  const room = started();
  const word = candidate(room);
  assert.throws(() => game.commitGame(room, 'unknown', 1500), { status: 401 });
  game.commitGame(room, 'one', 2000);
  assert.equal(room.players[0].committedAt, 2000);
  assert.equal(room.status, 'playing');
  assert.equal(room.lastWordAt, 1000);
  assert.throws(() => game.submitWord(room, 'one', word, undefined, 2001), { status: 409 });
  game.submitWord(room, 'two', word, undefined, 2002);
  game.commitGame(room, 'two', 3000);
  assert.deepEqual(room.players.map(player => player.committedAt), [2000, 3000]);
  assert.equal(room.status, 'finished');
  assert.equal(room.endReason, 'committed');
  assert.equal(room.endedAt, 3000);
  assert.equal(room.players[1].score, word.length);
  assert.throws(() => game.submitWord(room, 'two', word, undefined, 3001), { status: 409 });
});

test('timeout is inclusive at three minutes, resets after a word, and preserves an equal score', () => {
  const room = started();
  assert.equal(game.expire(room, 1000 + game.INACTIVITY_MS - 1), false);
  assert.equal(game.expire(room, 1000 + game.INACTIVITY_MS), true);
  assert.equal(room.endedAt, 181000);
  assert.equal(room.endReason, 'timeout');
  assert.equal(room.players[0].score, room.players[1].score);
  assert.equal(game.expire(room, 181001), false);
  const active = started();
  game.submitWord(active, 'one', candidate(active), undefined, 180999);
  assert.equal(game.expire(active, 181000), false);
  assert.equal(game.expire(active, 360998), false);
  assert.equal(game.expire(active, 360999), true);
});

test('only the host can prepare a rematch, which clears the round and waits for manual start', () => {
  const room = started();
  const originalPuzzle = room.puzzleId;
  const originalPlayers = structuredClone(room.players);
  game.submitWord(room, 'one', candidate(room), undefined, 2000);
  assert.throws(() => game.rematch(room, 'one', 2100), { status: 409 });
  game.commitGame(room, 'one', 3000);
  game.commitGame(room, 'two', 3001);
  assert.throws(() => game.rematch(room, 'unknown', 4000), { status: 401 });
  assert.throws(() => game.rematch(room, 'two', 4000), { status: 403 });
  game.rematch(room, 'one', 4000);
  assert.equal(room.status, 'waiting');
  assert.throws(() => game.rematch(room, 'one', 4001), { status: 409 });
  assert.equal(room.round, 2);
  assert.notEqual(room.puzzleId, originalPuzzle);
  assert.deepEqual(room.players, originalPlayers.map(player => ({ ...player, committedAt: null })));
  assert.deepEqual(room.words, []);
  assert.deepEqual(room.rematchVotes, []);
  assert.equal(room.startedAt, null);
  assert.equal(room.lastWordAt, null);
  assert.equal(room.endedAt, null);
  assert.equal(room.endReason, null);
  assert.equal(room.commitDeadline, null);
  game.startGame(room, 'one', 5000);
  assert.equal(room.status, 'playing');
  assert.equal(room.startedAt, 5000);
  assert.equal(room.lastWordAt, 5000);
});

test('public state hides credentials and answers and includes one point per bonus in total points', () => {
  const room = started();
  const result = game.publicGame(room);
  assertPublic(assert, result);
  assert.equal('bonus' in result, false);
  assert.equal(result.deadline, 181000);
  assert.equal(result.totalWords, puzzles[room.puzzleId].words.length);
  assert.equal(result.totalPoints, puzzles[room.puzzleId].words.reduce((sum, word) => sum + word.length, 0) + puzzles[room.puzzleId].bonus.length);
  game.commitGame(room, 'one', 2000);
  game.commitGame(room, 'two', 2000);
  assert.equal(game.publicGame(room).deadline, null);
});

test('the legacy catalogue picker respects complete tier ranges and does not immediately repeat an index', (t) => {
  let random = 0;
  t.mock.method(Math, 'random', () => random);
  const matches = {
    any: () => true,
    small: count => count >= 30 && count <= 40,
    medium: count => count > 40 && count <= 55,
    large: count => count > 55 && count <= 70,
  };
  for (const [tier, matchesCount] of Object.entries(matches)) {
    const available = puzzles.map((puzzle, index) => ({ puzzle, index }))
      .filter(({ puzzle }) => matchesCount(puzzle.words.length));
    assert.ok(available.length >= 2, `${tier} needs rematch alternatives.`);
    for (let i = 0; i < available.length; i++) {
      random = (i + 0.5) / available.length;
      assert.equal(game.pickPuzzle(-1, tier), available[i].index);
      assert.notEqual(game.pickPuzzle(available[i].index, tier), available[i].index);
    }
  }
});

test('the last regular word awards its points and ends the game without requiring bonus words', () => {
  const room = started();
  const puzzleId = puzzles.findIndex(puzzle => puzzle.bonus.length > 1);
  assert.ok(puzzleId >= 0, 'This test needs both claimed and unclaimed bonus words.');
  room.puzzleId = puzzleId;
  room.board = [...puzzles[puzzleId].board];
  const { words, bonus } = puzzles[puzzleId];
  const expectedScores = [0, 0];
  words.slice(0, -1).forEach((word, index) => {
    const seat = index % 2;
    game.submitWord(room, room.players[seat].id, word, undefined, 2000 + index);
    expectedScores[seat] += word.length;
  });
  game.submitWord(room, 'one', bonus[0], undefined, 3000);
  expectedScores[0] += 1;
  assert.equal(room.words.length, words.length, 'A bonus must not count toward completing the board.');
  assert.equal(room.status, 'playing');
  const pending = game.publicGame(room);
  assert.equal(pending.foundWords, words.length - 1);
  assert.equal(pending.remainingWords, 1);
  assert.equal(pending.totalWords, words.length);
  const finalWord = words.at(-1);
  assert.deepEqual(game.submitWord(room, 'two', finalWord, undefined, 4000), { word: finalWord, points: finalWord.length, bonus: false });
  expectedScores[1] += finalWord.length;
  assert.equal(room.status, 'finished');
  assert.equal(room.endReason, 'all_words');
  assert.equal(room.endedAt, 4000);
  assert.equal(room.lastWordAt, 4000);
  assert.deepEqual(room.players.map(item => item.score), expectedScores);
  assert.equal(expectedScores.reduce((sum, score) => sum + score, 0), pending.totalPoints - bonus.length + 1);
  const finished = game.publicGame(room);
  assert.equal(finished.foundWords, words.length);
  assert.equal(finished.remainingWords, 0);
  assert.equal(finished.deadline, null);
  const snapshot = structuredClone(room);
  for (const id of ['one', 'two']) {
    assert.throws(() => game.submitWord(room, id, bonus[1], undefined, 5000), { status: 409 });
    assert.throws(() => game.commitGame(room, id, 5000), { status: 409 });
  }
  assert.equal(game.expire(room, 999999), false);
  assert.deepEqual(room, snapshot);
  assert.throws(() => game.rematch(room, 'two', 5000), { status: 403 });
  game.rematch(room, 'one', 6000);
  assert.equal(room.status, 'waiting');
  assert.equal(room.round, 2);
  assert.equal(room.endReason, null);
  assert.equal(game.publicGame(room).foundWords, 0);
  assert.equal(game.publicGame(room).remainingWords, game.puzzleForGame(room).words.length);
  assert.ok(room.players.every(item => item.score === 0 && !item.committed));
});

test('regular-word completion does not require any bonus-word submissions', () => {
  const room = started();
  const puzzleId = puzzles.findIndex(puzzle => puzzle.bonus.length > 0);
  assert.ok(puzzleId >= 0);
  room.puzzleId = puzzleId;
  room.board = [...puzzles[puzzleId].board];
  for (const word of puzzles[puzzleId].words) game.submitWord(room, 'one', word, undefined, 2000);
  assert.equal(room.endReason, 'all_words');
  assert.equal(room.words.length, puzzles[puzzleId].words.length);
  assert.ok(room.words.every(item => !item.bonus));
  assert.equal(game.publicGame(room).remainingWords, 0);
});

test('polling reconciles an exhausted legacy round at its final claim time before timeout', () => {
  const room = started();
  delete room.wordCount;
  room.words = puzzles[room.puzzleId].words.map(word => ({ word, playerId: 'one', points: word.length, bonus: false, at: 2000 }));
  room.players[0].score = room.words.reduce((sum, item) => sum + item.points, 0);
  room.lastWordAt = 2000;
  const score = room.players[0].score;
  assert.equal(game.expire(room, 2000 + game.INACTIVITY_MS + 100), true);
  assert.equal(room.endReason, 'all_words');
  assert.equal(room.endedAt, 2000);
  assert.equal(room.players[0].score, score);
  assert.equal(game.expire(room, 999999), false);
  assert.equal(game.publicGame(room).wordCount, 'any');
  game.rematch(room, 'one', 400000);
  game.startGame(room, 'one', 400001);
  assert.equal(room.wordCount, 'any');
  assert.equal(room.status, 'playing');
});

test('host rematches preserve the chosen word-count tier across manually started rounds', () => {
  for (const tier of ['small', 'medium', 'large']) {
    const room = game.createGame('ABC234', player('one'), 1000, tier);
    game.joinGame(room, player('two'), 1000);
    game.startGame(room, 'one', 1000);
    for (let round = 1; round <= 3; round++) {
      const previous = game.canonicalBoardSignature(room.board);
      game.commitGame(room, 'one', 2000 * round);
      game.commitGame(room, 'two', 2000 * round);
      game.rematch(room, 'one', 2000 * round + 1);
      assert.equal(room.wordCount, tier);
      assert.equal(room.status, 'waiting');
      game.startGame(room, 'one', 2000 * round + 2);
      assert.notEqual(game.canonicalBoardSignature(room.board), previous);
      assert.equal(room.wordCount, tier);
      const count = game.publicGame(room).totalWords;
      assert.ok(tier === 'small' ? count >= 30 && count <= 40 : tier === 'medium' ? count > 40 && count <= 55 : count > 55 && count <= 70);
      assert.equal(room.puzzleId, -1);
      assert.deepEqual(room.board, game.puzzleForGame(room).board);
      assert.equal(room.round, round + 1);
    }
  }
});

test('every finished puzzle reveals its complete regular and bonus solutions with valid paths without changing the game', () => {
  const reasons = new Set();
  for (const [puzzleId, puzzle] of puzzles.entries()) {
    const room = legacyRoom(puzzleId);
    assert.equal('solutions' in game.publicGame(room), false, 'Waiting rooms must not expose answers.');
    game.joinGame(room, player('two'), 1000);
    game.startGame(room, 'one', 1000);
    assert.equal('solutions' in game.publicGame(room), false, 'Playing rooms must not expose answers.');
    if (puzzleId % 3 === 0) {
      game.submitWord(room, 'one', puzzle.words[0], undefined, 2000);
      assert.equal('solutions' in game.publicGame(room), false, 'A found word must not unlock hidden answers.');
      game.commitGame(room, 'one', 3000);
      game.commitGame(room, 'two', 3000);
    } else if (puzzleId % 3 === 1) {
      game.expire(room, 1000 + game.INACTIVITY_MS);
    } else {
      for (const word of puzzle.words) game.submitWord(room, 'two', word, undefined, 2000);
    }
    assert.equal(room.status, 'finished');
    reasons.add(room.endReason);
    const before = structuredClone(room);
    const result = game.publicGame(room);
    assertPublic(assert, result);
    assert.equal('solutions' in room, false, 'Answer derivation must not add a persisted field.');
    assert.ok(Array.isArray(result.solutions));
    assert.equal(result.solutions.length, puzzle.words.length + puzzle.bonus.length);
    assert.equal(new Set(result.solutions.map(item => item.word)).size, result.solutions.length);
    assert.deepEqual(result.solutions.map(item => item.word).sort(), [...puzzle.words, ...puzzle.bonus].sort());
    assert.equal(result.solutions.filter(item => !item.bonus).length, result.totalWords);
    assert.equal(result.solutions.reduce((sum, item) => sum + item.points, 0), result.totalPoints);
    for (const solution of result.solutions) {
      assert.deepEqual(Object.keys(solution).sort(), ['bonus', 'path', 'points', 'word']);
      assert.match(solution.word, /^[A-Z]{4,16}$/);
      assert.equal(solution.bonus, puzzle.bonus.includes(solution.word));
      assert.equal(solution.points, solution.bonus ? 1 : solution.word.length);
      assert.ok(game.validPath(room.board, solution.word, solution.path), `Puzzle ${puzzleId}: ${solution.word} needs a valid board path.`);
    }
    assert.deepEqual(game.publicGame(room), result, 'Repeated reads must give the same answers and score.');
    assert.deepEqual(room, before, 'Revealing answers must not alter scores, claimed words, clocks or stored state.');
  }
  assert.deepEqual([...reasons].sort(), ['all_words', 'committed', 'timeout']);
});

test('a host rematch hides finished answers and the board until the next manual start', () => {
  const room = started();
  game.commitGame(room, 'one', 2000);
  game.commitGame(room, 'two', 2000);
  const finished = game.publicGame(room);
  assert.ok(finished.solutions.length > 0);
  assert.throws(() => game.rematch(room, 'two', 3000), { status: 403 });
  assert.equal(room.status, 'finished');
  assert.deepEqual(game.publicGame(room).solutions, finished.solutions);
  game.rematch(room, 'one', 4000);
  const restarted = game.publicGame(room);
  assert.equal(restarted.status, 'waiting');
  assert.deepEqual(restarted.board, []);
  assert.equal(restarted.round, 2);
  assert.equal('solutions' in restarted, false);
  assert.equal('solutions' in room, false);
  assert.deepEqual(restarted.words, []);
  assertPublic(assert, restarted);
});

test('first Commit fixes a 60-second deadline which repeated commits and new words cannot extend', () => {
  const room = started();
  game.commitGame(room, 'one', 2000);
  assert.equal(room.players[0].committedAt, 2000);
  assert.equal(game.publicGame(room).players[0].committedAt, 2000);
  assert.equal(room.commitDeadline, 62000);
  assert.equal(game.publicGame(room).deadline, 62000);
  game.commitGame(room, 'one', 3000);
  assert.equal(room.players[0].committedAt, 2000, 'A repeated Commit must retain the original player timestamp.');
  assert.equal(room.commitDeadline, 62000);
  assert.equal(room.players[0].committed, true);
  game.submitWord(room, 'two', candidate(room), undefined, 61999);
  assert.equal(room.lastWordAt, 61999);
  assert.equal(game.publicGame(room).deadline, 62000);
  assert.equal(game.expire(room, 61999), false);
  assert.equal(game.expire(room, 62000), true);
  assert.equal(room.status, 'finished');
  assert.equal(room.endReason, 'commit_timeout');
  assert.equal(room.endedAt, 62000);
  assert.equal(game.publicGame(room).deadline, null);
  assert.ok(game.publicGame(room).solutions.length > 0);
  assert.equal(game.expire(room, 999999), false);
});

test('direct word and Commit functions enforce both inclusive time limits before making a claim', () => {
  for (const limit of ['commit', 'inactivity']) {
    for (const action of ['word', 'commit']) {
      const room = started();
      if (limit === 'commit') game.commitGame(room, 'one', 2000);
      const deadline = limit === 'commit' ? 62000 : 181000;
      const word = candidate(room);
      const mutate = action === 'word'
        ? () => game.submitWord(room, 'two', word, undefined, deadline)
        : () => game.commitGame(room, 'two', deadline);
      assert.throws(mutate, { status: 409 });
      assert.equal(room.status, 'finished');
      assert.equal(room.endReason, limit === 'commit' ? 'commit_timeout' : 'timeout');
      assert.equal(room.endedAt, deadline);
      assert.equal(room.words.length, 0);
      assert.ok(room.players.every(player => player.score === 0));
      assert.equal(room.players[1].committed, false);
    }
  }
});

test('inactivity can settle earlier than the Commit countdown and rematches clear that countdown', () => {
  const room = started();
  game.commitGame(room, 'one', 170000);
  assert.equal(room.commitDeadline, 230000);
  assert.equal(game.publicGame(room).deadline, 181000);
  game.expire(room, 181000);
  assert.equal(room.endReason, 'timeout');
  assert.equal(room.endedAt, 181000);
  game.rematch(room, 'one', 182000);
  game.startGame(room, 'one', 182000);
  assert.equal(room.commitDeadline, null);
  assert.ok(room.players.every(player => player.committedAt === null));
  assert.equal(game.publicGame(room).commitDeadline, null);
  assert.equal(game.publicGame(room).deadline, 362000);
  game.commitGame(room, 'two', 183000);
  assert.equal(room.commitDeadline, 243000);
  assert.equal(room.players[1].committedAt, 183000);
});

test('legacy committed rooms acquire only one new countdown without postponing an expired inactivity clock', () => {
  const room = started();
  room.players[0].committed = true;
  delete room.players[0].committedAt;
  delete room.commitDeadline;
  assert.equal(game.expire(room, 2000), true, 'A migration must be persisted even though the room remains active.');
  assert.equal(room.status, 'playing');
  assert.equal(room.commitDeadline, 62000);
  assert.equal(room.players[0].committedAt, undefined, 'A historical Commit time cannot be inferred from a later poll.');
  game.commitGame(room, 'one', 2500);
  assert.equal(room.players[0].committedAt, undefined, 'Repeating an old Commit must not invent its original timestamp.');
  assert.equal(game.expire(room, 3000), false);
  assert.equal(room.commitDeadline, 62000);
  const stale = started();
  stale.players[0].committed = true;
  delete stale.commitDeadline;
  assert.equal(game.expire(stale, 200000), true);
  assert.equal(stale.endReason, 'timeout');
  assert.equal(stale.endedAt, 181000);
});

test('length statistics count every main word accurately and hide initials until the shared 40% threshold', () => {
  for (const [puzzleId, puzzle] of puzzles.entries()) {
    const room = started();
    room.puzzleId = puzzleId;
    room.board = [...puzzle.board];
    const initial = game.publicGame(room).wordStats;
    assert.equal(initial.total, puzzle.words.length);
    assert.equal(initial.found, 0);
    assert.equal(initial.unlockAt, Math.ceil(puzzle.words.length * 0.4));
    assert.equal(initial.hintsUnlocked, false);
    assert.equal('byInitial' in initial, false);
    assert.deepEqual(initial.byLength, [...new Set(puzzle.words.map(word => word.length))].sort((a, b) => a - b).map(length => {
      const count = puzzle.words.filter(word => word.length === length).length;
      return { length, total: count, found: 0, remaining: count };
    }));
    for (const word of puzzle.bonus) game.submitWord(room, 'one', word, undefined, 2000);
    for (let i = 0; i < initial.unlockAt - 1; i++) {
      game.submitWord(room, i % 2 ? 'one' : 'two', puzzle.words[i], undefined, 2000);
    }
    const locked = game.publicGame(room).wordStats;
    assert.equal(locked.found, initial.unlockAt - 1);
    assert.equal(locked.hintsUnlocked, false, 'Bonus claims and their points must not unlock initials.');
    assert.equal('byInitial' in locked, false);
    assert.equal(locked.byLength.reduce((sum, item) => sum + item.found, 0), locked.found);
    assert.equal(locked.byLength.reduce((sum, item) => sum + item.remaining, 0), locked.total - locked.found);
    game.submitWord(room, 'two', puzzle.words[initial.unlockAt - 1], undefined, 2001);
    const unlocked = game.publicGame(room).wordStats;
    assert.equal(unlocked.found, initial.unlockAt);
    assert.equal(unlocked.hintsUnlocked, true);
    const claimed = new Set(puzzle.words.slice(0, initial.unlockAt));
    assert.deepEqual(unlocked.byInitial, [...new Set(puzzle.words.map(word => word[0]))].sort().map(letter => {
      const group = puzzle.words.filter(word => word.startsWith(letter));
      const found = group.filter(word => claimed.has(word)).length;
      return { letter, total: group.length, found, remaining: group.length - found };
    }));
    assert.equal(unlocked.byInitial.reduce((sum, item) => sum + item.total, 0), unlocked.total);
    assert.equal(unlocked.byInitial.reduce((sum, item) => sum + item.found, 0), unlocked.found);
    assert.equal('wordStats' in room, false, 'Statistics are derived without changing persistent room state.');
  }
});

test('settlement unlocks the initial counts even below 40% and rematches clear the previous hints', () => {
  const room = started();
  game.commitGame(room, 'one', 2000);
  game.commitGame(room, 'two', 2000);
  const ended = game.publicGame(room).wordStats;
  assert.equal(ended.found, 0);
  assert.equal(ended.hintsUnlocked, true);
  assert.ok(ended.byInitial.length > 0);
  assert.ok(ended.byInitial.every(item => item.remaining === item.total));
  assert.throws(() => game.rematch(room, 'two', 3000), { status: 403 });
  assert.deepEqual(game.publicGame(room).wordStats, ended);
  game.rematch(room, 'one', 3000);
  game.startGame(room, 'one', 3000);
  const restarted = game.publicGame(room).wordStats;
  assert.equal(restarted.found, 0);
  assert.equal(restarted.hintsUnlocked, false);
  assert.equal('byInitial' in restarted, false);
  for (const word of game.puzzleForGame(room).words) game.submitWord(room, 'one', word, undefined, 4000);
  const complete = game.publicGame(room).wordStats;
  assert.equal(complete.found, complete.total);
  assert.ok(complete.byLength.every(item => item.remaining === 0));
  assert.ok(complete.byInitial.every(item => item.remaining === 0));
});

test('canonical board signatures identify all rotations and reflections without conflating different boards', () => {
  const board = 'ABCDEFGHIJKLMNOP';
  const variants = boardViews(board);
  assert.equal(new Set(variants).size, 8, 'The fixture exercises all eight distinct orientations.');
  const expected = [...variants].sort()[0];
  for (const view of variants) {
    assert.equal(game.canonicalBoardSignature(view), expected);
    assert.equal(game.canonicalBoardSignature(view.split('')), expected);
  }
  assert.equal(game.canonicalBoardSignature(' abcdefghijklmnop '), expected);
  assert.notEqual(game.canonicalBoardSignature('ABCDEFGHIJKLMNOP'), game.canonicalBoardSignature('ABCDEFGHIJKLMNOQ'));
  for (const bad of [undefined, null, '', 'ABC', 'ABCDEFGHIJKLMNOPQ', 'ABCDEFGHIJKLMNO1', 42, {}, ['ABCDEFGHIJKLMNOP']]) {
    assert.equal(game.canonicalBoardSignature(bad), null);
  }
});

test('new games and rematches generate independent tier-matching boards outside the complete legacy catalogue', () => {
  const catalogue = new Set(puzzles.map(puzzle => game.canonicalBoardSignature(puzzle.board)));
  const seen = new Set();
  for (const tier of ['any', 'small', 'medium', 'large']) {
    const room = game.createGame('ABC234', player('one'), 1000, tier);
    game.joinGame(room, player('two'), 1000);
    game.startGame(room, 'one', 1000);
    for (let i = 0; i < 4; i++) {
      if (i) nextRound(room, 2000 + i * 1000);
      assert.equal(room.puzzleId, -1);
      assert.ok(room.generatedPuzzle);
      assert.equal(game.publicGame(room).boardSource, 'random');
      assert.ok(matchesTier(game.puzzleForGame(room), tier));
      assert.deepEqual(room.board, room.generatedPuzzle.board);
      const signature = game.canonicalBoardSignature(room.board);
      assert.equal(catalogue.has(signature), false, `${tier} selected a legacy puzzle or one of its rotations/reflections.`);
      assert.equal(seen.has(signature), false, `${tier} repeated an earlier generated word puzzle.`);
      seen.add(signature);
      assertPublic(assert, game.publicGame(room));
    }
  }
  assert.equal(seen.size, 16);
});

test('legacy rooms retain their exact saved word list until settlement and switch to a new generated board on rematch', () => {
  const room = started();
  const original = game.canonicalBoardSignature(room.board);
  const originalPuzzle = puzzles[room.puzzleId];
  delete room.puzzleHistory;
  assert.equal(room.generatedPuzzle, undefined);
  assert.equal(game.publicGame(room).boardSource, 'legacy');
  assert.deepEqual(game.puzzleForGame(room).words, originalPuzzle.words);
  assert.deepEqual(game.puzzleForGame(room).bonus, originalPuzzle.bonus);
  const word = originalPuzzle.words[0];
  assert.equal(game.submitWord(room, 'one', word, undefined, 1500).points, word.length);
  nextRound(room, 2000);
  assert.equal(room.puzzleId, -1);
  assert.ok(room.generatedPuzzle);
  assert.equal(game.publicGame(room).boardSource, 'random');
  assert.notEqual(game.canonicalBoardSignature(room.board), original);
  assert.ok(room.boardHistory.includes(original));
  assert.ok(room.boardHistory.includes(game.canonicalBoardSignature(room.board)));
  assert.equal(room.words.length, 0);
  assertPublic(assert, game.publicGame(room));
});

test('malformed board histories cannot break rematches, leak answers or grow beyond 64 signatures', () => {
  const room = game.createGame('ABC234', player('one'), 1000, 'small');
  game.joinGame(room, player('two'), 1000);
  game.startGame(room, 'one', 1000);
  const histories = [null, 'bad history', {}, 42, [null, 42, {}, '', 'ABC', ...boardViews(room.board)],
    puzzles.slice(0, 90).map(puzzle => puzzle.board.join(''))];
  for (const [offset, history] of histories.entries()) {
    const before = game.canonicalBoardSignature(room.board);
    room.boardHistory = history;
    room.puzzleHistory = [null, -1, 999999, 'bad'];
    nextRound(room, 2000 + offset * 1000);
    assert.notEqual(game.canonicalBoardSignature(room.board), before);
    assert.ok(Array.isArray(room.boardHistory));
    assert.ok(room.boardHistory.length <= 64);
    assert.equal(new Set(room.boardHistory).size, room.boardHistory.length);
    assert.ok(room.boardHistory.every(signature => /^[A-Z]{16}$/.test(signature) && game.canonicalBoardSignature(signature) === signature));
    assert.ok(room.boardHistory.includes(before));
    assert.ok(room.boardHistory.includes(game.canonicalBoardSignature(room.board)));
    assertPublic(assert, game.publicGame(room));
  }
});

test('room creation avoids recent generated boards across rotations/reflections without falling back to a static pool', () => {
  const original = game.createGame('ABC234', player('one'), 1000, 'small');
  const signature = game.canonicalBoardSignature(original.board);
  for (const tier of ['any', 'small', 'medium', 'large']) {
    const room = game.createGame('ABC234', player('one'), 1000, tier, boardViews(original.board));
    assert.equal(room.puzzleId, -1);
    assert.ok(matchesTier(game.puzzleForGame(room), tier));
    assert.notEqual(game.canonicalBoardSignature(room.board), signature, `${tier} treated a transformed recent board as new.`);
    assert.ok(room.boardHistory.includes(signature));
    assert.ok(room.boardHistory.includes(game.canonicalBoardSignature(room.board)));
    assert.equal(new Set(room.boardHistory).size, room.boardHistory.length);
    assertPublic(assert, game.publicGame(room));
  }
});
