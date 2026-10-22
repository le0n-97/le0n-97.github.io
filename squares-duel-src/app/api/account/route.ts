import { env } from 'cloudflare:workers';
import { GameError } from '@/lib/game';
import { apiHeaders, apiOptions, isTrustedApiOrigin } from '@/lib/api-cors';
import { bearerToken, changePassword, loginAccount, logoutAccount, publicAccount, registerAccount, requireAccount } from '@/lib/accounts';

export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 4_096;
const json = (request: Request, data: unknown, status = 200) => Response.json(data, { status, headers: apiHeaders(request, true) });
function database() {
  if (!env.DB) throw new GameError('账号服务暂未就绪，请稍后重试。', 503);
  return env.DB.withSession('first-primary');
}
function handleError(request: Request, error: unknown) {
  if (error instanceof GameError) return json(request, { error: error.message }, error.status);
  // Account errors can contain database values; never include them in logs.
  console.error('Account service error');
  return json(request, { error: '连接账号服务失败，请稍后重试。' }, 503);
}
async function payloadOf(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) throw new GameError('请求内容过长。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new GameError('请求格式不正确。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new GameError('请求内容过长。', 413); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new GameError('请求格式不正确。'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GameError('请求格式不正确。');
  return payload as Record<string, unknown>;
}
export function OPTIONS(request: Request) { return apiOptions(request, true); }
export async function GET(request: Request) {
  try {
    if (!isTrustedApiOrigin(request)) throw new GameError('请求来源无效。', 403);
    if (!bearerToken(request)) return json(request, { user: null });
    const account = await requireAccount(request, database());
    return json(request, { user: publicAccount(account), expiresAt: account.expiresAt });
  } catch (error) { return handleError(request, error); }
}
export async function POST(request: Request) {
  try {
    if (!isTrustedApiOrigin(request)) throw new GameError('请求来源无效。', 403);
    const payload = await payloadOf(request);
    if (!['register', 'login', 'logout', 'password'].includes(String(payload.action))) throw new GameError('未知的账号操作。');
    const db = database();
    if (payload.action === 'register') return json(request, await registerAccount(db, request, payload.username, payload.password), 201);
    if (payload.action === 'login') return json(request, await loginAccount(db, request, payload.username, payload.password));
    if (payload.action === 'logout') return json(request, await logoutAccount(db, request));
    return json(request, await changePassword(db, request, payload.password ?? payload.oldPassword, payload.newPassword));
  } catch (error) { return handleError(request, error); }
}
