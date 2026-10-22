import { env } from 'cloudflare:workers';
import { GameError } from '@/lib/game';
import { authenticateRoom, parseChatText, parseClientId, parseCursor, readMessages, roomCode, sendMessage } from '@/lib/chat';
import { apiHeaders, apiOptions, isTrustedApiOrigin } from '@/lib/api-cors';

export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 4_096;
const json = (request: Request, data: unknown, status = 200) => Response.json(data, { status, headers: apiHeaders(request, true) });
function database() {
  if (!env.DB) throw new GameError('聊天服务暂未就绪，请稍后重试。', 503);
  return env.DB.withSession('first-primary');
}
function handleError(request: Request, error: unknown) {
  if (error instanceof GameError) return json(request, { error: error.message }, error.status);
  console.error('Chat service error', error instanceof Error ? error.message : 'Unknown error');
  return json(request, { error: '连接聊天服务失败，请稍后重试。' }, 503);
}
async function payloadOf(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (declaredLength > MAX_BODY_BYTES) throw new GameError('请求内容过长。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new GameError('请求格式不正确。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new GameError('请求内容过长。', 413);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new GameError('请求格式不正确。'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GameError('请求格式不正确。');
  return payload as Record<string, unknown>;
}
export function OPTIONS(request: Request) { return apiOptions(request, true); }
export async function GET(request: Request) {
  try {
    if (!isTrustedApiOrigin(request)) throw new GameError('请求来源无效。', 403);
    const url = new URL(request.url);
    const code = roomCode(url.searchParams.get('code'));
    const after = parseCursor(url.searchParams.get('after'));
    const db = database();
    const { game } = await authenticateRoom(request, db, code);
    if (game.status !== 'waiting') throw new GameError('聊天仅在游戏开始前开放。', 409);
    return json(request, await readMessages(db, game, after));
  } catch (error) { return handleError(request, error); }
}
export async function POST(request: Request) {
  try {
    if (!isTrustedApiOrigin(request)) throw new GameError('请求来源无效。', 403);
    const payload = await payloadOf(request);
    const code = roomCode(payload.code);
    const clientId = parseClientId(payload.clientId);
    const text = parseChatText(payload.text);
    const db = database();
    const { game, player } = await authenticateRoom(request, db, code);
    if (game.status !== 'waiting') throw new GameError('聊天仅在游戏开始前开放。', 409);
    return json(request, { message: await sendMessage(db, game, player.id, clientId, text, Date.now()) });
  } catch (error) { return handleError(request, error); }
}
