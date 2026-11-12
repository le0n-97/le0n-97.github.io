import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoom, publicRoom, transition } from '../lib/word-sync.ts';

const host = { id: 'host-account', username: '小明' };
const guest = { id: 42, username: '小红' };
const third = { id: 'third-account', username: '小张' };
const outsider = { id: 'outsider', username: '路人' };
const makeRoom = () => createRoom('ABC123', host, 0);

function act(room, user, action, fields = {}) {
  return transition(room, user, { action, ...fields }, room.updatedAt + 1);
}

test('room authority, answer privacy, revealed history and matching', () => {
  const room = makeRoom();
  assert.throws(() => act(room, host, 'start'), { status: 409 });
  assert.throws(() => publicRoom(room, outsider), { status: 403 });
  assert.equal(act(room, guest, 'join'), true);
  assert.equal(act(room, { ...guest, id: '42' }, 'join'), false);
  assert.throws(() => act(room, guest, 'start'), { status: 403 });
  assert.equal(act(room, host, 'start'), true);
  assert.throws(() => act(room, outsider, 'join'), { status: 409 });

  act(room, host, 'submit', { round: 1, word: ' 苹果 ' });
  const beforeReveal = publicRoom(room, guest);
  assert.equal(beforeReveal.phase, 'playing');
  assert.deepEqual(beforeReveal.players.map(player => player.submitted), [true, false]);
  assert.equal(beforeReveal.history.length, 0);
  assert.doesNotMatch(JSON.stringify(beforeReveal), /苹果|host-account|accountId/);
  assert.throws(() => act(room, host, 'submit', { round: 1, word: '梨' }), { status: 409 });
  assert.throws(() => act(room, guest, 'submit', { round: 1, word: '   ' }), { status: 400 });

  act(room, guest, 'submit', { round: 1, word: '香蕉' });
  assert.equal(publicRoom(room, host).phase, 'revealed');
  assert.deepEqual(publicRoom(room, guest).history[0], {
    round: 1,
    results: [{ name: host.username, word: '苹果' }, { name: guest.username, word: '香蕉' }],
    win: false,
  });
  assert.throws(() => act(room, guest, 'next', { round: 1 }), { status: 403 });
  assert.throws(() => act(room, host, 'next', { round: 0 }), { status: 409 });
  act(room, host, 'next', { round: 1 });
  assert.equal(publicRoom(room, guest).history.length, 1);
  assert.throws(() => act(room, guest, 'submit', { round: 1, word: '旧答案' }), { status: 409 });

  act(room, host, 'submit', { round: 2, word: '晴天' });
  act(room, guest, 'submit', { round: 2, word: '晴天' });
  const won = publicRoom(room, guest);
  assert.equal(won.phase, 'won');
  assert.equal(won.history.length, 2);
  assert.equal(won.history[1].win, true);
  assert.throws(() => act(room, host, 'next', { round: 2 }), { status: 409 });
});

test('explicit departures transfer ownership and resolve the remaining players', () => {
  const room = makeRoom();
  act(room, guest, 'join');
  act(room, third, 'join');
  act(room, host, 'start');
  act(room, guest, 'submit', { round: 1, word: '晴天' });
  act(room, third, 'submit', { round: 1, word: '晴天' });

  act(room, host, 'leave');
  const result = publicRoom(room, guest);
  assert.equal(result.hostId, result.meId);
  assert.equal(result.phase, 'won');
  assert.deepEqual(result.history[0].results.map(player => player.name), [guest.username, third.username]);
  assert.throws(() => publicRoom(room, host), { status: 403 });
});

test('an interrupted round with only one player reopens the room', () => {
  const room = makeRoom();
  act(room, guest, 'join');
  act(room, host, 'start');
  act(room, host, 'submit', { round: 1, word: '上轮答案' });
  act(room, guest, 'leave');

  assert.equal(publicRoom(room, host).phase, 'lobby');
  assert.equal(publicRoom(room, host).history.length, 0);
  assert.equal(publicRoom(room, host).players[0].submitted, false);
  act(room, third, 'join');
  act(room, host, 'start');
  assert.equal(publicRoom(room, third).round, 2);
  assert.throws(() => act(room, host, 'submit', { round: 1, word: '迟到答案' }), { status: 409 });
  assert.deepEqual(room.answers, {});
});
