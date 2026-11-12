import { env } from 'cloudflare:workers';
import { apiHeaders, apiOptions, isTrustedApiOrigin } from '@/lib/api-cors';
import { GameError } from '@/lib/game';
import { redeemPasswordReset } from '@/lib/password-reset';

export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 4_096;
const json = (request: Request, value: object, status = 200) => Response.json(value, { status, headers: apiHeaders(request) });

async function readPayload(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) throw new GameError('请求内容过长。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new GameError('请求格式不正确。');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let input = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new GameError('请求内容过长。', 413); }
      input += decoder.decode(chunk.value, { stream: true });
    }
    const value = JSON.parse(input + decoder.decode());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (error) {
    if (error instanceof GameError) throw error;
  }
  throw new GameError('请求格式不正确。');
}

export function OPTIONS(request: Request) { return apiOptions(request); }

export async function POST(request: Request) {
  try {
    if (!isTrustedApiOrigin(request)) throw new GameError('请求来源无效。', 403);
    const payload = await readPayload(request);
    const config = (env as typeof env & { SQUARES_PASSWORD_RESET?: string }).SQUARES_PASSWORD_RESET;
    if (!env.DB) throw new GameError('账号服务暂未就绪，请稍后重试。', 503);
    return json(request, await redeemPasswordReset(env.DB.withSession('first-primary'), config, payload));
  } catch (error) {
    if (error instanceof GameError) return json(request, { error: error.message }, error.status);
    return json(request, { error: '重置服务暂不可用，请稍后重试。' }, 503);
  }
}
