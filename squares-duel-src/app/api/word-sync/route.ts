import { env } from 'cloudflare:workers';
import { requireAccount } from '@/lib/accounts';
import { apiHeaders, apiOptions, isTrustedApiOrigin } from '@/lib/api-cors';
import { GameError } from '@/lib/game';
import { createRoom, publicRoom, transition, WordSyncError, type WordSyncAction, type WordSyncRoom } from '@/lib/word-sync';

export const dynamic = 'force-dynamic';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_BODY_BYTES = 2048;
const MAX_ATTEMPTS = 12;
type RoomRow = { id: string; state: string; revision: number };

const json = (request: Request, data: unknown, status = 200) =>
  Response.json(data, { status, headers: apiHeaders(request, true) });

function database() {
  if (!env.DB) throw new WordSyncError(503, '房间服务暂未就绪，请稍后重试。');
  return env.DB.withSession('first-primary');
}

function checkOrigin(request: Request) {
  if (!isTrustedApiOrigin(request)) throw new WordSyncError(403, '请求来源无效。');
}

function codeOf(value: unknown) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new WordSyncError(400, '请输入正确的 6 位房间码。');
  return code;
}

function randomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), value => ALPHABET[value % ALPHABET.length]).join('');
}

function handleError(request: Request, error: unknown) {
  if (error instanceof WordSyncError || error instanceof GameError) {
    return json(request, { error: error.message }, error.status);
  }
  console.error('Word Sync room service error');
  return json(request, { error: '连接房间服务失败，请稍后重试。' }, 503);
}

async function readPayload(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) throw new WordSyncError(413, '请求内容过长。');
  const reader = request.body?.getReader();
  if (!reader) throw new WordSyncError(400, '请求格式不正确。');
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new WordSyncError(413, '请求内容过长。');
    }
    body += decoder.decode(next.value, { stream: true });
  }
  let payload: unknown;
  try { payload = JSON.parse(body + decoder.decode()); }
  catch { throw new WordSyncError(400, '请求格式不正确。'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new WordSyncError(400, '请求格式不正确。');
  return payload as Record<string, unknown>;
}

function readRoom(db: D1DatabaseSession, code: string) {
  return db.prepare('SELECT id, state, revision FROM word_sync_rooms WHERE code = ?').bind(code).first<RoomRow>();
}

export function OPTIONS(request: Request) { return apiOptions(request, true); }

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const db = database();
    const account = await requireAccount(request, db);
    const row = await readRoom(db, codeOf(new URL(request.url).searchParams.get('code')));
    if (!row) throw new WordSyncError(404, '没有找到这个房间，请核对房间码。');
    return json(request, { room: publicRoom(JSON.parse(row.state) as WordSyncRoom, account), revision: row.revision });
  } catch (error) { return handleError(request, error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const db = database();
    const account = await requireAccount(request, db);
    const { action, code, round, word } = await readPayload(request);

    if (action === 'create') {
      for (let attempt = 0; attempt < 6; attempt++) {
        const room = createRoom(randomCode(), account, Date.now());
        const result = await db.prepare('INSERT OR IGNORE INTO word_sync_rooms (id, code, state) VALUES (?, ?, ?)')
          .bind(crypto.randomUUID(), room.code, JSON.stringify(room)).run();
        if (result.meta.changes === 1) return json(request, { room: publicRoom(room, account), revision: 0 }, 201);
      }
      throw new WordSyncError(503, '暂时无法分配房间码，请重试。');
    }

    if (action !== 'join' && action !== 'start' && action !== 'submit' && action !== 'next' && action !== 'leave') {
      throw new WordSyncError(400, '不支持的房间操作。');
    }
    const roomCode = codeOf(code);
    const payload: WordSyncAction = { action, round, word };
    let roomId: string | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const row = await readRoom(db, roomCode);
      if (!row || (roomId && row.id !== roomId)) {
        if (action === 'leave') return json(request, { room: null });
        throw new WordSyncError(404, '没有找到这个房间，请核对房间码。');
      }
      roomId = row.id;
      const room = JSON.parse(row.state) as WordSyncRoom;
      const changed = transition(room, account, payload, Date.now());
      if (changed) {
        // Store each transition only if nobody else has changed this room since our read.
        const write = room.players.length
          ? db.prepare('UPDATE word_sync_rooms SET state = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
              .bind(JSON.stringify(room), row.id, row.revision)
          : db.prepare('DELETE FROM word_sync_rooms WHERE id = ? AND revision = ?').bind(row.id, row.revision);
        if ((await write.run()).meta.changes !== 1) continue;
      }
      if (action === 'leave') return json(request, { room: null });
      return json(request, { room: publicRoom(room, account), revision: row.revision + Number(changed) });
    }
    throw new WordSyncError(409, '房间正在同步，请重试。');
  } catch (error) { return handleError(request, error); }
}
