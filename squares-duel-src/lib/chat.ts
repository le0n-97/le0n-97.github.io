import { GameError, normalizeTeams, type Game, type Player } from './game';
import { authenticatedMember } from './accounts';

export type ChatMessage = { id: number; clientId: string; playerId: string; text: string; at: number };
type ChatRow = { seq: number; client_id: string; player_id: string; text: string; created_at: number };
type ChatRoom = { code: string; createdAt: number };
const PAGE_SIZE = 100;
const RETAINED_MESSAGES = 200;
const SEND_INTERVAL_MS = 1_000;
const MESSAGE_COLUMNS = 'seq, client_id, player_id, text, created_at';

export function roomCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new GameError('请输入正确的 6 位房间码。');
  return code;
}
export function parseClientId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new GameError('消息标识无效，请重试。');
  }
  return value.toLowerCase();
}
export function parseChatText(value: unknown): string {
  if (typeof value !== 'string') throw new GameError('请输入聊天内容。');
  const text = value.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trim();
  if (!text) throw new GameError('请输入聊天内容。');
  if ([...text].length > 300) throw new GameError('每条消息最多 300 个字符。');
  return text;
}
export function parseCursor(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new GameError('聊天记录位置无效，请刷新后重试。');
  return Number(value);
}
export async function authenticateRoom(request: Request, db: D1DatabaseSession, code: string): Promise<{ game: Game; player: Player }> {
  const row = await db.prepare('SELECT state, revision FROM rooms WHERE code = ?').bind(code).first<{ state: string; revision: number }>();
  if (!row) throw new GameError('没有找到这个房间，请核对房间码。', 404);
  const game = JSON.parse(row.state) as Game;
  normalizeTeams(game);
  const player = await authenticatedMember(request, db, game);
  return { game, player };
}
function messageOf(row: ChatRow): ChatMessage {
  return { id: row.seq, clientId: row.client_id, playerId: row.player_id, text: row.text, at: row.created_at };
}
export async function readMessages(db: D1DatabaseSession, room: ChatRoom, after?: number) {
  const phase = `EXISTS (SELECT 1 FROM rooms WHERE code = ? AND json_extract(state, '$.createdAt') = ? AND json_extract(state, '$.status') = 'waiting')`;
  const result = after === undefined
    ? await db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM room_chat WHERE room_code = ? AND room_created_at = ? AND ${phase} ORDER BY seq DESC LIMIT ?`)
      .bind(room.code, room.createdAt, room.code, room.createdAt, PAGE_SIZE).all<ChatRow>()
    : await db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM room_chat WHERE room_code = ? AND room_created_at = ? AND seq > ? AND ${phase} ORDER BY seq ASC LIMIT ?`)
      .bind(room.code, room.createdAt, after, room.code, room.createdAt, PAGE_SIZE + 1).all<ChatRow>();
  const rows = result.results;
  const hasMore = after !== undefined && rows.length > PAGE_SIZE;
  const messages = (after === undefined ? rows.reverse() : rows.slice(0, PAGE_SIZE)).map(messageOf);
  return { messages, cursor: messages.at(-1)?.id ?? after ?? 0, hasMore };
}
async function findMessage(db: D1DatabaseSession, room: ChatRoom, playerId: string, clientId: string) {
  return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM room_chat WHERE room_code = ? AND room_created_at = ? AND player_id = ? AND client_id = ?`)
    .bind(room.code, room.createdAt, playerId, clientId).first<ChatRow>();
}
function sameMessage(row: ChatRow, text: string): ChatMessage {
  if (row.text !== text) throw new GameError('这条消息已经发送，请使用新的消息标识。', 409);
  return messageOf(row);
}
export async function sendMessage(db: D1DatabaseSession, room: ChatRoom, playerId: string, clientId: string, text: string, now: number): Promise<ChatMessage> {
  const previous = await findMessage(db, room, playerId, clientId);
  if (previous) return sameMessage(previous, text);
  // The insertion and independent rate marker share one D1 transaction. Keeping
  // the marker outside the bounded history prevents pruning from lifting limits.
  const insert = db.prepare(`INSERT OR IGNORE INTO room_chat (room_code, room_created_at, player_id, client_id, text, created_at)
SELECT ?, ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM rooms WHERE code = ? AND json_extract(state, '$.createdAt') = ? AND json_extract(state, '$.status') = 'waiting')
AND NOT EXISTS (SELECT 1 FROM room_chat_rates WHERE room_code = ? AND room_created_at = ? AND player_id = ? AND last_sent_at > ?)`)
    .bind(room.code, room.createdAt, playerId, clientId, text, now, room.code, room.createdAt, room.code, room.createdAt, playerId, now - SEND_INTERVAL_MS);
  const rate = db.prepare(`INSERT INTO room_chat_rates (room_code, room_created_at, player_id, last_sent_at)
SELECT room_code, room_created_at, player_id, created_at FROM room_chat
WHERE room_code = ? AND room_created_at = ? AND player_id = ? AND client_id = ?
ON CONFLICT (room_code, room_created_at, player_id) DO UPDATE SET last_sent_at = MAX(room_chat_rates.last_sent_at, excluded.last_sent_at)`)
    .bind(room.code, room.createdAt, playerId, clientId);
  const prune = db.prepare(`DELETE FROM room_chat WHERE room_code = ? AND room_created_at = ? AND seq NOT IN
(SELECT seq FROM room_chat WHERE room_code = ? AND room_created_at = ? ORDER BY seq DESC LIMIT ?)`)
    .bind(room.code, room.createdAt, room.code, room.createdAt, RETAINED_MESSAGES);
  await db.batch([insert, rate, prune]);
  const saved = await findMessage(db, room, playerId, clientId);
  if (!saved) {
    const current = await db.prepare('SELECT state, revision FROM rooms WHERE code = ?').bind(room.code).first<{ state: string; revision: number }>();
    const currentGame = current ? JSON.parse(current.state) as Game : null;
    if (!currentGame || currentGame.createdAt !== room.createdAt || currentGame.status !== 'waiting') throw new GameError('聊天仅在游戏开始前开放。', 409);
    throw new GameError('发送太快了，请稍等一秒。', 429);
  }
  return sameMessage(saved, text);
}
