const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = new vm.Script(fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8'));
const apiOrigin = 'https://squares-duel-oct15.not-n0el.chatgpt.site';
const accountKey = 'squares-duel-account';
const session = {
  user: { username: 'test_user', rating: 1000, ratedGames: 0 },
  token: 'sq_account_' + 'a'.repeat(64),
  expiresAt: 2000000000000
};

function client(initialUrl, api, storage = new Map()) {
  const elements = new Map();
  const timers = new Map();
  let storageListener;
  let timerId = 0;
  class Element {
    constructor(classes = '') {
      const values = new Set(classes.split(' '));
      this.classList = {
        add: value => values.add(value),
        remove: value => values.delete(value),
        contains: value => values.has(value),
        toggle: (value, force) => force ? values.add(value) : values.delete(value)
      };
      this.value = '';
    }
    focus() {}
    set innerHTML(content) {
      this.html = content;
      if (this !== elements.get('stage')) return;
      for (const id of ['start', 'next', 'answer', 'answerForm', 'submitWord']) {
        elements.delete(id);
        if (content.includes('id="' + id + '"')) elements.set(id, new Element());
      }
    }
    get innerHTML() { return this.html; }
  }
  for (const tag of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements.set(tag[1], new Element(tag[0].match(/\bclass="([^"]*)"/)?.[1]));
  }
  let location = new URL(initialUrl);
  script.runInNewContext({
    window: {
      get location() { return location; },
      history: { replaceState: (_state, _title, url) => { location = url; } },
      addEventListener: (name, listener) => {
        if (name === 'storage') storageListener = listener;
      }
    },
    document: { getElementById: id => elements.get(id) },
    localStorage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    setTimeout: (fn, delay) => {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    URL,
    URLSearchParams,
    AbortSignal,
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, apiOrigin);
      const { status = 200, data } = await api(new URL(url), options);
      return { ok: status < 400, status, json: async () => data };
    }
  });

  return {
    $: id => elements.get(id),
    storage,
    accountStorageChanged: () => storageListener({ key: accountKey }),
    location: () => location,
    poll: async () => {
      const [id, timer] = [...timers].find(([_id, value]) => value.delay === 1250);
      timers.delete(id);
      await timer.fn();
    }
  };
}

const turn = () => new Promise(resolve => setImmediate(resolve));
const submit = { preventDefault() {} };
const room = {
  code: 'AB23CD',
  hostId: 'host',
  meId: 'guest',
  phase: 'lobby',
  round: 1,
  players: [
    { id: 'host', name: 'host_user', submitted: false },
    { id: 'guest', name: session.user.username, submitted: false }
  ],
  history: []
};

test('reuses the Squares account, joins only from an invite, and keeps a draft as other players submit', async () => {
  const storage = new Map([[accountKey, JSON.stringify(session)]]);
  let member = false;
  let revision = 1;
  let snapshot = room;
  const actions = [];
  const api = (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + session.token);
    if (url.pathname === '/api/account') {
      assert.equal(options.method, 'GET');
      return { data: { user: session.user } };
    }
    assert.equal(url.pathname, '/api/word-sync');
    if (options.method === 'GET') {
      assert.equal(url.searchParams.get('code'), room.code);
      return member ? { data: { room: snapshot, revision } } : { status: 404, data: { error: '未加入' } };
    }
    const body = JSON.parse(options.body);
    actions.push(body);
    if (body.action === 'join') member = true;
    if (body.action === 'submit') {
      revision++;
      snapshot = {
        ...snapshot,
        phase: 'revealed',
        history: [{ round: 1, results: [{ name: 'host_user', word: '苹果' }, { name: session.user.username, word: body.word }], win: false }]
      };
    }
    if (body.action === 'leave') {
      member = false;
      return { data: { room: null } };
    }
    return { data: { room: snapshot, revision } };
  };
  const ui = client('https://le0n-97.github.io/word-sync/?room=ab23cd', api, storage);

  await turn();
  assert.equal(ui.$('create').classList.contains('hidden'), true);
  assert.equal(ui.$('joinDivider').classList.contains('hidden'), true);
  assert.equal(ui.$('accountName').textContent, session.user.username);
  assert.equal(ui.$('roomCode').value, room.code);
  ui.$('create').onclick();
  ui.$('joinForm').onsubmit(submit);
  await turn();
  assert.deepEqual(actions, [{ action: 'join', code: room.code }]);
  assert.equal(ui.$('room').classList.contains('hidden'), false);
  assert.equal(ui.$('playerCount').textContent, 2);
  const refreshed = client(ui.location().href, api, storage);
  await turn();
  assert.equal(refreshed.$('room').classList.contains('hidden'), false);
  assert.equal(refreshed.$('codeLabel').textContent, room.code);
  assert.deepEqual(actions, [{ action: 'join', code: room.code }]);

  snapshot = { ...room, phase: 'playing' };
  revision++;
  await ui.poll();
  const input = ui.$('answer');
  input.value = '香蕉';
  snapshot = { ...snapshot, players: [{ ...room.players[0], submitted: true }, room.players[1]] };
  revision++;
  await ui.poll();
  assert.equal(ui.$('answer'), input);
  assert.equal(input.value, '香蕉');
  ui.$('answerForm').onsubmit(submit);
  await turn();
  assert.deepEqual(actions.at(-1), { action: 'submit', code: room.code, round: 1, word: '香蕉' });
  assert.match(ui.$('history').innerHTML, /苹果.*香蕉/);

  ui.$('leave').onclick();
  await turn();
  assert.deepEqual(actions.at(-1), { action: 'leave', code: room.code });
  assert.equal(ui.$('home').classList.contains('hidden'), false);
  assert.equal(ui.$('create').classList.contains('hidden'), true);
});

test('logs in through Squares and restores a server room after refresh', async () => {
  const hosted = { ...room, meId: room.hostId, players: [room.players[0]] };
  const calls = [];
  const api = (url, options) => {
    calls.push([url.pathname, options.method]);
    if (url.pathname === '/api/account') {
      if (options.method === 'POST') {
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers['Content-Type'], 'text/plain;charset=UTF-8');
        assert.deepEqual(JSON.parse(options.body), { action: 'login', username: session.user.username, password: 'test-password' });
        return { data: session };
      }
      return { data: { user: session.user, expiresAt: session.expiresAt } };
    }
    assert.equal(url.pathname, '/api/word-sync');
    assert.equal(options.headers.Authorization, 'Bearer ' + session.token);
    if (options.method === 'POST') assert.deepEqual(JSON.parse(options.body), { action: 'create' });
    else assert.equal(url.searchParams.get('code'), hosted.code);
    return { data: { room: hosted, revision: 0 } };
  };
  const ui = client('https://le0n-97.github.io/word-sync/', api);
  await turn();
  assert.equal(ui.$('authForm').classList.contains('hidden'), false);
  ui.$('username').value = session.user.username;
  ui.$('password').value = 'test-password';
  await ui.$('authForm').onsubmit(submit);
  assert.deepEqual(JSON.parse(ui.storage.get(accountKey)), session);
  assert.equal(ui.$('password').value, '');
  assert.equal(ui.$('create').classList.contains('hidden'), false);
  ui.$('create').onclick();
  await turn();
  assert.equal(ui.location().searchParams.get('room'), hosted.code);
  assert.equal(ui.$('start').disabled, true);

  const refreshed = client(ui.location().href, api, ui.storage);
  await turn();
  assert.equal(refreshed.$('room').classList.contains('hidden'), false);
  assert.deepEqual(calls, [
    ['/api/account', 'POST'], ['/api/word-sync', 'POST'],
    ['/api/account', 'GET'], ['/api/word-sync', 'GET']
  ]);
});

test('signing out in another tab clears the room even if an old poll returns afterward', async () => {
  const storage = new Map([[accountKey, JSON.stringify(session)]]);
  let getRoomCount = 0;
  let finishPoll;
  const ui = client('https://le0n-97.github.io/word-sync/?room=AB23CD', (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + session.token);
    if (url.pathname === '/api/account') return { data: { user: session.user } };
    if (++getRoomCount === 1) return { data: { room, revision: 0 } };
    return new Promise(resolve => { finishPoll = resolve; });
  }, storage);

  await turn();
  assert.equal(ui.$('room').classList.contains('hidden'), false);
  const poll = ui.poll();
  storage.delete(accountKey);
  ui.accountStorageChanged();
  finishPoll({ data: { room, revision: 1 } });
  await poll;
  assert.equal(ui.$('authForm').classList.contains('hidden'), false);
  assert.equal(ui.$('room').classList.contains('hidden'), true);
  assert.equal(ui.location().searchParams.get('room'), room.code);
});
