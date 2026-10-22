import assert from 'node:assert/strict';
import { smokeAccount } from './smoke-account.mjs';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5173');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('This smoke check only supports a local HTTP development server.');
}
async function api(pathname, payload, token) {
  const response = await fetch(new URL(pathname, base), {
    ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }),
    headers: {
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', Origin: base.origin }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}
const hostAccount = await smokeAccount(base, 'chatA');
const guestAccount = await smokeAccount(base, 'chatB');
const otherAccount = await smokeAccount(base, 'chatOut');
assert.equal((await api('/api/game', { action: 'create', wordCount: 'small' })).status, 401);
const created = await api('/api/game', { action: 'create', wordCount: 'small' }, hostAccount.token);
assert.equal(created.status, 201);
const code = created.body.room.code;
const host = created.body;
const payload = { code, text: '你好，准备开始 👋', clientId: crypto.randomUUID() };
const sent = await api('/api/chat', payload, host.token);
assert.equal(sent.status, 200);
const retry = await api('/api/chat', payload, host.token);
assert.equal(retry.status, 200);
assert.deepEqual(retry.body.message, sent.body.message);
assert.equal((await api('/api/chat', { ...payload, text: 'different' }, host.token)).status, 409);
const joined = await api('/api/game', { action: 'join', code }, guestAccount.token);
assert.equal(joined.status, 200);
const guest = joined.body;
const polled = await api(`/api/chat?code=${code}`, undefined, guest.token);
assert.equal(polled.status, 200);
assert.match(polled.headers.get('Cache-Control'), /no-store/);
assert.deepEqual(polled.body.messages, [sent.body.message]);
assert.equal((await api(`/api/chat?code=${code}`)).status, 401);
const guestSent = await api('/api/chat', { code, text: '准备好了', clientId: crypto.randomUUID() }, guest.token);
assert.equal(guestSent.status, 200);
const delta = await api(`/api/chat?code=${code}&after=${sent.body.message.id}`, undefined, host.token);
assert.deepEqual(delta.body.messages, [guestSent.body.message]);
assert.equal(delta.body.hasMore, false);
const other = await api('/api/game', { action: 'create', wordCount: 'small' }, otherAccount.token);
assert.equal(other.status, 201);
assert.equal((await api(`/api/chat?code=${code}`, undefined, other.body.token)).status, 401);
assert.deepEqual((await api(`/api/chat?code=${other.body.room.code}`, undefined, other.body.token)).body.messages, []);
assert.equal((await api('/api/game', { action: 'start', code, round: 1 }, host.token)).body.room.status, 'playing');
assert.equal((await api('/api/chat', { code, text: '游戏中关闭', clientId: crypto.randomUUID() }, guest.token)).status, 409);
assert.equal((await api(`/api/chat?code=${code}`, undefined, guest.token)).status, 409);
assert.equal((await api('/api/game', { action: 'commit', code, round: 1 }, host.token)).status, 200);
const ended = await api('/api/game', { action: 'commit', code, round: 1 }, guest.token);
assert.equal(ended.body.room.status, 'finished');
await new Promise(resolve => setTimeout(resolve, 1050));
const afterFinish = await api('/api/chat', { code, text: '再来一局？', clientId: crypto.randomUUID() }, host.token);
assert.equal(afterFinish.status, 409);
const unchanged = await api(`/api/game?code=${code}`, undefined, guest.token);
assert.deepEqual(unchanged.body.room.players.map(player => player.score), [0, 0]);
assert.equal(unchanged.body.room.endedAt, ended.body.room.endedAt);
assert.deepEqual(unchanged.body.room.words, []);
const rematched = await api('/api/game', { action: 'rematch', code, round: 1 }, host.token);
assert.equal(rematched.body.room.status, 'waiting');
assert.deepEqual((await api(`/api/chat?code=${code}`, undefined, host.token)).body.messages.map(message => message.text),
  ['你好，准备开始 👋', '准备好了']);
console.log(JSON.stringify({
  localChat: true, twoParticipants: true, privateRooms: true, incrementalPolling: true,
  retryIdempotence: true, lobbyOnlyChat: true, gameplayUnchanged: true,
}));
