const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

function load(search) {
  const elements = {};
  for (const id of ['home', 'room', 'name', 'create', 'join', 'joinDivider', 'roomCode', 'toast', 'codeLabel', 'copy', 'leave']) {
    const classes = new Set();
    elements[id] = { value: '', classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } };
  }
  const context = { window: {}, document: { getElementById: id => elements[id] }, location: { search }, URLSearchParams, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync('game.js', 'utf8'), context);
  return elements;
}

const normal = load('');
assert.equal(normal.create.classList.contains('hidden'), false);
assert.equal(normal.joinDivider.classList.contains('hidden'), false);
const invite = load('?room=ab23cd');
assert.equal(invite.create.classList.contains('hidden'), true);
assert.equal(invite.joinDivider.classList.contains('hidden'), true);
assert.equal(invite.roomCode.value, 'AB23CD');
invite.leave.onclick();
assert.equal(invite.create.classList.contains('hidden'), true);
const invalid = load('?room=abcdefghi');
assert.equal(invalid.create.classList.contains('hidden'), true);
assert.equal(invalid.roomCode.value, 'ABCDEFGHI');
assert.equal(load('?room=').create.classList.contains('hidden'), true);
console.log('Invite entry tests passed');

