import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const runtime = process.env.SQUARES_TEST_RUNTIME;
if (!runtime) throw new Error('Run these tests with node scripts/test-game.mjs.');
export const game = await import(pathToFileURL(path.join(runtime, 'game.mjs')).href);
export const { puzzles } = await import(pathToFileURL(path.join(runtime, 'puzzles.mjs')).href);
export const player = (id) => ({ id, name: id, score: 0, committed: false, secret: `secret-${id}` });
export function legacyRoom(puzzleId = 0, now = 1000) {
  return { code: 'ABC234', round: 1, status: 'waiting', board: [...puzzles[puzzleId].board], players: [player('one')], words: [],
    lastWordAt: null, startedAt: null, endedAt: null, endReason: null, puzzleId, createdAt: now,
    rematchVotes: [], wordCount: 'any', commitDeadline: null, puzzleHistory: [puzzleId] };
}
export function started(now = 1000) {
  const room = legacyRoom(0, now);
  game.joinGame(room, player('two'), now);
  game.startGame(room, 'one', now);
  return room;
}
export function candidate(room, kind = 'words') {
  return game.puzzleForGame(room)[kind].find(word => game.findPath(room.board, word));
}
export function assertPublic(assert, room) {
  assert.equal('puzzleId' in room, false);
  assert.equal('puzzleHistory' in room, false);
  assert.equal('generatedPuzzle' in room, false);
  assert.equal('boardHistory' in room, false);
  assert.equal('createdAt' in room, false);
  assert.ok(room.players.every(item => !('secret' in item)));
  assert.ok((room.spectators ?? []).every(item => !('secret' in item)));
  assert.ok([...room.players, ...(room.spectators ?? [])].every(item => !('accountId' in item)));
}
export function runtimeURL(name) { return pathToFileURL(path.join(runtime, name)).href; }

// Game/chat fixtures seed real account rows and hashed sessions, so route tests
// exercise the production account lookup without spending time on password KDFs.
// Pass null or an explicit token to fixtureGameToken to test unauthenticated and
// invalid credentials; only otherwise omitted create/join credentials are seeded.
export function fixtureGameToken(payload, token) {
  return token === undefined && ['create', 'join'].includes(payload?.action)
    ? globalThis.__gameTestDB.seedAccount(payload.name).token
    : token;
}

export class MemoryD1 {
  sqlite = new DatabaseSync(':memory:');
  conflicts = 0;
  constructor() {
    for (const migration of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => /^\d+_.*\.sql$/.test(name)).sort()) {
      this.sqlite.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
    }
  }
  get rows() {
    return new Map(this.sqlite.prepare('SELECT code, state, revision, updated_at FROM rooms').all()
      .map(row => [row.code, { state: row.state, revision: row.revision, updatedAt: row.updated_at }]));
  }
  get records() {
    return new Map(this.sqlite.prepare('SELECT id, record_json FROM game_records').all()
      .map(row => [row.id, JSON.parse(row.record_json)]));
  }
  close() { this.sqlite.close(); }
  seedAccount(username = 'Player', { expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000 } = {}) {
    const base = String(username).replace(/\u0000/g, '').trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16) || 'Player';
    let name = base.length < 3 ? `${base}_user` : base;
    for (let suffix = 2; this.sqlite.prepare('SELECT id FROM accounts WHERE username_key = ?').get(name.toLowerCase()); suffix++) {
      name = `${base}_${suffix}`;
    }
    const id = randomUUID();
    const token = 'sq_account_' + randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    this.sqlite.prepare('INSERT INTO accounts (id, username, username_key, password_hash, password_version, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, name, name.toLowerCase(), 'fixture-password-not-used', Date.now());
    this.sqlite.prepare('INSERT INTO account_sessions (token_hash, account_id, password_version, created_at, expires_at) VALUES (?, ?, 0, ?, ?)')
      .run(hash, id, Date.now(), expiresAt);
    return { id, username: name, token, expiresAt };
  }
  syncNextReads(count) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    this.readGate = { remaining: count, promise, release };
  }
  withSession(mode) {
    if (mode !== 'first-primary') throw new Error('Reads must use the primary.');
    return this;
  }
  prepare(sql) {
    const bound = (values) => ({
      sql, values,
      first: async () => {
        const row = this.sqlite.prepare(sql).get(...values);
        const snapshot = row ? { ...row } : null;
        const gate = /^SELECT state, revision FROM rooms WHERE code = \?$/i.test(sql) && this.readGate;
        if (gate) {
          gate.remaining--;
          if (!gate.remaining) { this.readGate = null; gate.release(); }
          await gate.promise;
        }
        return snapshot;
      },
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values).map(row => ({ ...row })), success: true }),
      run: async () => this.run(sql, values),
    });
    return { ...bound([]), bind: (...values) => bound(values) };
  }
  run(sql, values) {
    const result = this.sqlite.prepare(sql).run(...values);
    if (sql.startsWith('UPDATE rooms SET state') && result.changes === 0) this.conflicts++;
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => this.run(statement.sql, statement.values));
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  room(code) { return JSON.parse(this.rows.get(code).state); }
  replaceRoom(code, room) {
    this.sqlite.prepare('UPDATE rooms SET state = ? WHERE code = ?').run(JSON.stringify(room), code);
  }
  seedRoom(room, revision = 0, updatedAt = room.createdAt) {
    this.sqlite.prepare('INSERT INTO rooms (code, state, revision, updated_at) VALUES (?, ?, ?, ?)')
      .run(room.code, JSON.stringify(room), revision, updatedAt);
  }
}
