import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeURL } from './helpers.mjs';

const { DRAG_HIT_RADIUS, traceDragSegment } = await import(runtimeURL('drag-selection.mjs'));
const point = (x, y) => ({ x, y });
const targets = Array.from({ length: 16 }, (_, index) => ({
  index,
  x: 50 + (index % 4) * 100,
  y: 50 + Math.floor(index / 4) * 100,
  radius: 90 * DRAG_HIT_RADIUS,
}));

// A continuing gesture may still be inside the last hit zone. Selecting that
// same tile again does not extend the path, so omit consecutive duplicate hits.
function traceSamples(samples, hitTargets = targets) {
  const hits = [];
  for (let index = 1; index < samples.length; index++) {
    for (const hit of traceDragSegment(samples[index - 1], samples[index], hitTargets)) {
      if (hits.at(-1) !== hit) hits.push(hit);
    }
  }
  return hits;
}

test('a diagonal crossing near tile corners does not select orthogonal neighbors', () => {
  assert.deepEqual(traceSamples([point(50, 50), point(102, 96), point(150, 150)]), [0, 5]);
  assert.deepEqual(traceSamples([point(150, 150), point(96, 102), point(50, 50)]), [5, 0]);
});

test('horizontal and vertical drags tolerate a detour near a diagonal tile corner', () => {
  assert.deepEqual(traceSamples([point(50, 50), point(96, 102), point(150, 50)]), [0, 1]);
  assert.deepEqual(traceSamples([point(50, 50), point(102, 96), point(50, 150)]), [0, 4]);
});

test('a fast horizontal or vertical drag visits intermediate tiles in travel order', () => {
  assert.deepEqual(traceDragSegment(point(50, 50), point(350, 50), [...targets].reverse()), [0, 1, 2, 3]);
  assert.deepEqual(traceDragSegment(point(350, 50), point(50, 50), targets), [3, 2, 1, 0]);
  assert.deepEqual(traceDragSegment(point(50, 50), point(50, 350), targets), [0, 4, 8, 12]);
});

test('a fast diagonal drag visits every intermediate diagonal tile', () => {
  assert.deepEqual(traceDragSegment(point(50, 50), point(350, 350), targets), [0, 5, 10, 15]);
  assert.deepEqual(traceDragSegment(point(350, 350), point(50, 50), targets), [15, 10, 5, 0]);
  assert.deepEqual(traceDragSegment(point(350, 50), point(50, 350), targets), [3, 6, 9, 12]);
});

test('deliberate right-angle movement and retracing still reach the intended tiles', () => {
  assert.deepEqual(traceSamples([point(50, 50), point(150, 50), point(150, 150)]), [0, 1, 5]);
  assert.deepEqual(traceSamples([point(50, 50), point(150, 50), point(50, 50)]), [0, 1, 0]);
});

test('the same paths work when board geometry scales to a smaller screen', () => {
  const scale = 0.48;
  const scaledTargets = targets.map(target => ({
    ...target, x: target.x * scale, y: target.y * scale, radius: target.radius * scale,
  }));
  const scaledPoints = [point(50, 50), point(102, 96), point(150, 150)].map(({ x, y }) => point(x * scale, y * scale));
  assert.deepEqual(traceSamples(scaledPoints, scaledTargets), [0, 5]);
  assert.deepEqual(traceDragSegment(point(24, 24), point(168, 24), scaledTargets), [0, 1, 2, 3]);
});

test('empty targets, gaps and stationary pointer samples do not invent tile hits', () => {
  assert.deepEqual(traceDragSegment(point(50, 50), point(150, 50), []), []);
  assert.deepEqual(traceDragSegment(point(100, 0), point(100, 400), targets), []);
  assert.deepEqual(traceDragSegment(point(-50, -50), point(-50, 450), targets), []);
  assert.deepEqual(traceDragSegment(point(100, 100), point(100, 100), targets), []);
  assert.deepEqual(traceDragSegment(point(150, 150), point(150, 150), targets), [5]);
});

test('a segment touching a circular hit-zone boundary counts as entering the zone', () => {
  assert.deepEqual(traceDragSegment(point(-20, 10), point(20, 10), [{ index: 7, x: 0, y: 0, radius: 10 }]), [7]);
  assert.deepEqual(traceDragSegment(point(-20, 10.1), point(20, 10.1), [{ index: 7, x: 0, y: 0, radius: 10 }]), []);
});
