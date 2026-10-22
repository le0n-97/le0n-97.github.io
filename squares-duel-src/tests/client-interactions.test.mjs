import test from 'node:test';
import assert from 'node:assert/strict';
import { game, puzzles, started, runtimeURL } from './helpers.mjs';

const { createActionQueue } = await import(runtimeURL('action-queue.mjs'));
const { rotateIndex, displayedBoardIndices } = await import(runtimeURL('board-rotation.mjs'));
const { traceDragSegment, DRAG_HIT_RADIUS } = await import(runtimeURL('drag-selection.mjs'));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

test('a delayed claim can have subsequent claims queued without starting them early or losing results', async () => {
  const queue = createActionQueue();
  const delayedResponse = gate();
  const events = [];
  const first = queue.run(async () => {
    events.push('first request');
    await delayedResponse.promise;
    events.push('first response');
    return 'first accepted';
  });
  const second = queue.run(async () => { events.push('second request'); return 'second accepted'; });
  const third = queue.run(async () => { events.push('third request'); return 'third accepted'; });
  await nextTurn();
  assert.deepEqual(events, ['first request']);
  delayedResponse.release();
  assert.deepEqual(await Promise.all([first, second, third]), ['first accepted', 'second accepted', 'third accepted']);
  assert.deepEqual(events, ['first request', 'first response', 'second request', 'third request']);
});

test('a rejected claim reports its error while the following valid claim still executes', async () => {
  const queue = createActionQueue();
  const delayedResponse = gate();
  const events = [];
  const first = queue.run(async () => {
    await delayedResponse.promise;
    events.push('rejected');
    throw new Error('This word was already claimed');
  });
  const rejected = assert.rejects(first, /already claimed/);
  const second = queue.run(async () => { events.push('accepted'); return 5; });
  delayedResponse.release();
  await rejected;
  assert.equal(await second, 5);
  assert.deepEqual(events, ['rejected', 'accepted']);
});

test('Commit waits for earlier claims and cannot undo a successful claim or allow later words', async () => {
  const queue = createActionQueue();
  const room = started();
  const word = puzzles[room.puzzleId].words[0];
  const otherWord = puzzles[room.puzzleId].words[1];
  const delayedResponse = gate();
  const claim = queue.run(async () => {
    await delayedResponse.promise;
    return game.submitWord(room, 'one', word, undefined, 2000);
  });
  const commit = queue.run(async () => game.commitGame(room, 'one', 2100));
  await nextTurn();
  assert.equal(room.players[0].committed, false);
  assert.equal(room.words.length, 0);
  delayedResponse.release();
  await Promise.all([claim, commit]);
  assert.equal(room.players[0].score, word.length);
  assert.equal(room.players[0].committed, true);
  assert.equal(room.words[0].word, word);
  await assert.rejects(queue.run(async () => game.submitWord(room, 'one', otherWord, undefined, 2200)), { status: 409 });
  assert.equal(room.words.length, 1);
});

test('four rotations restore every tile, with inverse mapping for both rotation directions', () => {
  const original = Array.from({ length: 16 }, (_, index) => index);
  assert.deepEqual(displayedBoardIndices(0), original);
  assert.deepEqual(displayedBoardIndices(4), original);
  assert.deepEqual(displayedBoardIndices(-4), original);
  assert.deepEqual(displayedBoardIndices(1).slice(0, 4), [12, 8, 4, 0]);
  for (const turns of [-5, -1, 0, 1, 2, 3, 4, 5]) {
    const shown = displayedBoardIndices(turns);
    assert.equal(new Set(shown).size, 16);
    for (const index of original) {
      assert.equal(shown[rotateIndex(index, turns)], index);
      assert.equal(rotateIndex(rotateIndex(index, turns), -turns), index);
    }
  }
});

test('rotation preserves every packaged word, route letters, adjacency and unique tiles', () => {
  for (const puzzle of puzzles) {
    for (const word of [...puzzle.words, ...puzzle.bonus]) {
      const path = game.findPath(puzzle.board, word);
      assert.ok(path, `${word} must have a canonical route`);
      for (const turns of [0, 1, 2, 3]) {
        const shown = displayedBoardIndices(turns);
        const displayedBoard = shown.map(index => puzzle.board[index]);
        const displayedPath = path.map(index => rotateIndex(index, turns));
        assert.equal(displayedPath.map(index => displayedBoard[index]).join(''), word);
        assert.ok(game.validPath(displayedBoard, word, displayedPath), `${word} after ${turns} turns`);
        assert.deepEqual(displayedPath.map(index => shown[index]), path);
      }
    }
  }
});

test('drag hit detection preserves all eight directions after rotating the board view', () => {
  const neighbors = [0, 1, 2, 4, 6, 8, 9, 10];
  for (const turns of [0, 1, 2, 3]) {
    const targets = Array.from({ length: 16 }, (_, index) => {
      const displayIndex = rotateIndex(index, turns);
      return { index, x: displayIndex % 4 * 100 + 50, y: Math.floor(displayIndex / 4) * 100 + 50, radius: 100 * DRAG_HIT_RADIUS };
    });
    for (const neighbor of neighbors) {
      assert.ok(game.isAdjacent(5, neighbor));
      assert.deepEqual(traceDragSegment(targets[5], targets[neighbor], targets), [5, neighbor], `direction 5 → ${neighbor}, turns ${turns}`);
    }
  }
});
