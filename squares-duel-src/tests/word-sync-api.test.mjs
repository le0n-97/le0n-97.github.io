import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryD1, runtimeURL } from './helpers.mjs';

const accountApi = await import(runtimeURL('account-route.mjs'));
const roomApi = await import(runtimeURL('word-sync-route.mjs'));
const origin = 'https://le0n-97.github.io';
const api = 'https://example.test/api';

function request(path, token, payload) {
  const headers = new Headers({ Origin: origin });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (payload === undefined) return new Request(`${api}/${path}`, { headers });
  headers.set('Content-Type', 'application/json');
  return new Request(`${api}/${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
}

class ConcurrentD1 extends MemoryD1 {
  syncWordSyncReads() {
    this.wordSyncGate = { ...Promise.withResolvers(), remaining: 2 };
  }

  prepare(sql) {
    const statement = super.prepare(sql);
    if (sql !== 'SELECT id, state, revision FROM word_sync_rooms WHERE code = ?') return statement;
    return { ...statement, bind: (...values) => {
      const bound = statement.bind(...values);
      return { ...bound, first: async () => {
        const row = await bound.first();
        const gate = this.wordSyncGate;
        if (gate) {
          gate.remaining--;
          if (!gate.remaining) {
            this.wordSyncGate = null;
            gate.resolve();
          }
          await gate.promise;
        }
        return row;
      } };
    } };
  }

  run(sql, values) {
    const result = super.run(sql, values);
    if (sql.startsWith('UPDATE word_sync_rooms SET state') && result.meta.changes === 0) this.conflicts++;
    return result;
  }
}

test('existing Squares account sessions control server rooms and simultaneous submissions', { timeout: 5000 }, async () => {
  const db = new ConcurrentD1();
  globalThis.__gameTestDB = db;
  try {
    const host = db.seedAccount('Host');
    const guest = db.seedAccount('Guest');
    const outsider = db.seedAccount('Outsider');

    const accountResponse = await accountApi.GET(request('account', host.token));
    assert.equal(accountResponse.status, 200);
    assert.equal((await accountResponse.json()).user.username, host.username);
    assert.equal((await roomApi.POST(request('word-sync', null, { action: 'create' }))).status, 401);
    const create = await roomApi.POST(request('word-sync', host.token, { action: 'create' }));
    assert.equal(create.status, 201);
    assert.equal(create.headers.get('Access-Control-Allow-Origin'), origin);
    assert.match(create.headers.get('Cache-Control'), /no-store/);
    const { room: lobby } = await create.json();
    assert.equal(lobby.players[0].name, host.username);
    assert.equal(lobby.hostId, lobby.meId);
    const { code } = lobby;

    const post = (token, action, fields) => roomApi.POST(request('word-sync', token, { action, code, ...fields }));
    const get = (token) => roomApi.GET(request(`word-sync?code=${code}`, token));
    assert.equal((await get(outsider.token)).status, 403);
    assert.equal((await post(guest.token, 'join', { code: code.toLowerCase() })).status, 200);
    assert.equal((await post(guest.token, 'start')).status, 403);
    assert.equal((await post(host.token, 'start')).status, 200);
    assert.equal((await post(host.token, 'submit', { round: 1, word: '苹果' })).status, 200);
    const pending = await (await get(guest.token)).json();
    assert.deepEqual(pending.room.players.map(player => player.submitted), [true, false]);
    assert.deepEqual(pending.room.history, []);
    const publicJson = JSON.stringify(pending);
    for (const privateValue of [host.id, guest.id, host.token, guest.token, '苹果']) {
      assert.equal(publicJson.includes(privateValue), false);
    }

    const revealed = await (await post(guest.token, 'submit', { round: 1, word: '梨' })).json();
    assert.equal(revealed.room.phase, 'revealed');
    assert.deepEqual(revealed.room.history[0].results.map(result => result.word), ['苹果', '梨']);
    assert.equal((await post(host.token, 'next', { round: 1 })).status, 200);
    assert.equal((await post(guest.token, 'submit', { round: 1, word: '迟到的答案' })).status, 409);

    db.syncWordSyncReads();
    const submits = await Promise.all([host, guest].map(account => post(account.token, 'submit', { round: 2, word: '晴天' })));
    assert.deepEqual(submits.map(response => response.status), [200, 200]);
    assert.equal(db.conflicts, 1);
    const finished = await (await get(host.token)).json();
    assert.equal(finished.room.phase, 'won');
    assert.equal(finished.revision, 7);
    assert.equal(finished.room.history.length, 2);
    assert.deepEqual(finished.room.history[1].results.map(result => result.word), ['晴天', '晴天']);

    assert.equal((await post(host.token, 'leave')).status, 200);
    const afterTransfer = await (await get(guest.token)).json();
    assert.equal(afterTransfer.room.hostId, afterTransfer.room.meId);
    assert.equal((await post(guest.token, 'leave')).status, 200);
    assert.equal((await get(guest.token)).status, 404);
  } finally {
    delete globalThis.__gameTestDB;
    db.close();
  }
});
