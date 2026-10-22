import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { INITIAL_RATING, RATING_K, makeRatingRound, settleRating } = await import(pathToFileURL(
  path.join(process.env.SQUARES_TEST_RUNTIME, 'rating.mjs'),
));
const player = (playerId, teamId, rating = INITIAL_RATING) => ({ playerId, accountId: `account-${playerId}`, teamId, ratingMilli: rating * 1000 });
const round = (...players) => makeRatingRound(players);
const delta = (result, id) => result.changes.find(change => change.playerId === id).delta;
const totalMilli = result => result.changes.reduce((total, change) => total + Math.round(change.delta * 1000), 0);
const approximate = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

test('equal solo players use the Elo baseline and a full score win transfers 16', () => {
  assert.equal(INITIAL_RATING, 1000);
  assert.equal(RATING_K, 32);
  const snapshot = round(player('a', 0), player('b', 1));
  assert.deepEqual(snapshot.expectedShares, [0.5, 0.5]);
  const result = settleRating(snapshot, [100, 0]);
  assert.equal(result.rated, true);
  assert.equal(delta(result, 'a'), 16);
  assert.equal(delta(result, 'b'), -16);
  assert.equal(totalMilli(result), 0);
  assert.equal(result.changes[0].startRating, 1000);
  assert.equal(JSON.stringify(result).includes('account-'), false);
});

test('extra teammates contribute strength, and each team splits its transfer', () => {
  const snapshot = round(player('a', 0), player('c', 1), player('b', 1));
  approximate(snapshot.expectedShares[0], 1 / 3);
  approximate(snapshot.expectedShares[1], 2 / 3);
  const result = settleRating(snapshot, [40, 60]);
  assert.equal(delta(result, 'a'), 2.133);
  assert.equal(delta(result, 'b'), -1.067);
  assert.equal(delta(result, 'c'), -1.066);
  assert.equal(totalMilli(result), 0);
  const reordered = settleRating(round(...[...snapshot.players].reverse()), [40, 60]);
  for (const id of ['a', 'b', 'c']) assert.equal(delta(result, id), delta(reordered, id));
});

test('equal size teams gain equally per player and tied expected performance is still rated', () => {
  const snapshot = round(player('a', 0), player('b', 0), player('c', 1), player('d', 1));
  const win = settleRating(snapshot, [100, 0]);
  assert.deepEqual(win.changes.map(change => change.delta), [8, 8, -8, -8]);
  const tie = settleRating(snapshot, [7, 7]);
  assert.equal(tie.rated, true);
  assert.deepEqual(tie.changes.map(change => change.delta), [0, 0, 0, 0]);
  assert.equal(tie.reason, undefined);
});

test('a 400 rating gap multiplies player strength by ten', () => {
  const snapshot = round(player('a', 0, 1400), player('b', 1, 1000));
  approximate(snapshot.expectedShares[0], 10 / 11);
  approximate(snapshot.expectedShares[1], 1 / 11);
  assert.ok(delta(settleRating(snapshot, [51, 49]), 'a') < 0);
  assert.ok(delta(settleRating(snapshot, [49, 51]), 'b') > 0);
});

test('better score shares monotonically improve a player rating; score scale has no effect', () => {
  const snapshot = round(player('a', 0), player('b', 1));
  let previous = -Infinity;
  for (let score = 0; score <= 100; score++) {
    const result = settleRating(snapshot, [score, 100 - score]);
    assert.ok(delta(result, 'a') >= previous);
    assert.equal(totalMilli(result), 0);
    previous = delta(result, 'a');
  }
  assert.deepEqual(settleRating(snapshot, [4, 6]), settleRating(snapshot, [400, 600]));
});

test('swapping the teams swaps expectations and negates the team transfer within one thousandth', () => {
  const players = [player('a', 0, 1200), player('b', 1, 950), player('c', 1, 1050)];
  const first = round(...players);
  const swapped = round(...players.map(player => ({ ...player, teamId: 1 - player.teamId })));
  approximate(first.expectedShares[0], swapped.expectedShares[1]);
  const result = settleRating(first, [41, 59]);
  const inverse = settleRating(swapped, [59, 41]);
  for (const { playerId } of players) approximate(delta(result, playerId), delta(inverse, playerId), 0.0011);
});

test('exact half-thousandth transfers round symmetrically when team colors swap', () => {
  const snapshot = round(player('a', 0), player('b', 1));
  // 257 / 512 is exactly representable and produces a raw +62.5 thousandths.
  const positive = settleRating(snapshot, [257, 255]);
  const negative = settleRating(snapshot, [255, 257]);
  assert.equal(delta(positive, 'a'), 0.063);
  assert.equal(delta(negative, 'a'), -0.063);
  assert.equal(delta(positive, 'b'), delta(negative, 'a'));
  assert.equal(totalMilli(positive), 0);
  assert.equal(totalMilli(negative), 0);
});

test('rounds freeze participant values and reject ambiguous or invalid rosters', () => {
  const source = [player('a', 0), player('b', 1)];
  const snapshot = makeRatingRound(source);
  source[0].ratingMilli = 2_000_000;
  assert.equal(snapshot.players[0].ratingMilli, 1_000_000);
  const invalid = [
    [], [player('a', 0)], [player('a', 0), player('b', 0)],
    [player('a', 0), player('a', 1)],
    [player('a', 0), { ...player('b', 1), accountId: 'account-a' }],
    [player('a', 0), { ...player('b', 1), playerId: '' }],
    [player('a', 0), { ...player('b', 1), accountId: '' }],
    [player('a', 0), { ...player('b', 1), teamId: 2 }],
    [player('a', 0), { ...player('b', 1), ratingMilli: 0.1 }],
    [player('a', 0), { ...player('b', 1), ratingMilli: Infinity }],
    [player('a', 0), { ...player('b', 1), ratingMilli: Number.MAX_SAFE_INTEGER + 1 }],
    [player('a', 0), null], null,
  ];
  for (const players of invalid) assert.equal(makeRatingRound(players), null);
});

test('extreme positive and negative ratings remain finite without arbitrary rating floors', () => {
  const snapshot = round(
    { ...player('a', 0), ratingMilli: Number.MAX_SAFE_INTEGER },
    { ...player('b', 1), ratingMilli: -Number.MAX_SAFE_INTEGER },
  );
  assert.deepEqual(snapshot.expectedShares, [1, 0]);
  const upset = settleRating(snapshot, [0, 1]);
  assert.equal(delta(upset, 'a'), -32);
  assert.equal(delta(upset, 'b'), 32);
  assert.equal(totalMilli(upset), 0);
  const belowZero = settleRating(round(player('a', 0, 0), player('b', 1, 0)), [0, 1]);
  assert.equal(delta(belowZero, 'a'), -16);
});

test('missing snapshots and zero point games never change ratings', () => {
  assert.deepEqual(settleRating(undefined, [1, 2]), {
    version: 'team-share-v1', rated: false, reason: 'legacy', expectedShares: null, actualShares: null, changes: [],
  });
  const empty = settleRating(round(player('a', 0), player('b', 1)), [0, 0]);
  assert.equal(empty.reason, 'no_words');
  assert.equal(empty.rated, false);
  assert.deepEqual(empty.expectedShares, [0.5, 0.5]);
  assert.deepEqual(empty.changes, []);
  assert.equal(empty.actualShares, null);
});

test('invalid scores and tampered snapshots are not rated', () => {
  const snapshot = round(player('a', 0), player('b', 1));
  for (const scores of [[-1, 2], [0.5, 1], [NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER + 1, 1], [1], null]) {
    assert.equal(settleRating(snapshot, scores).reason, 'invalid_roster');
  }
  for (const broken of [
    { ...snapshot, version: 'future-version' },
    { ...snapshot, expectedShares: [0.6, 0.4] },
    { ...snapshot, expectedShares: [NaN, 0.5] },
    { ...snapshot, expectedShares: [] },
    { ...snapshot, players: [] },
  ]) assert.equal(settleRating(broken, [1, 2]).reason, 'invalid_roster');
  assert.equal(settleRating(snapshot, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]).rated, true);
});

test('integer thousandths stay conserved for many unequal rosters and scores', () => {
  for (let sizeA = 1; sizeA <= 7; sizeA++) {
    for (let sizeB = 1; sizeB <= 7; sizeB++) {
      const players = [
        ...Array.from({ length: sizeA }, (_, i) => player(`a${i}`, 0, 900 + 37 * i)),
        ...Array.from({ length: sizeB }, (_, i) => player(`b${i}`, 1, 1100 - 31 * i)),
      ];
      const snapshot = makeRatingRound(players);
      for (const scores of [[0, 1], [1, 0], [9, 13], [1, 1], [117, 89]]) {
        const result = settleRating(snapshot, scores);
        assert.equal(totalMilli(result), 0);
        for (const team of [0, 1]) {
          const deltas = result.changes.filter(change => change.teamId === team).map(change => Math.round(change.delta * 1000));
          assert.ok(Math.max(...deltas) - Math.min(...deltas) <= 1);
        }
      }
    }
  }
});
