import { env } from 'cloudflare:workers';
import { GameError } from '@/lib/game';
import { apiHeaders, apiOptions, isTrustedApiOrigin } from '@/lib/api-cors';
import { requireAccount } from '@/lib/accounts';
import { leaderboardPagination, readLeaderboard } from '@/lib/leaderboard';

export const dynamic = 'force-dynamic';
const json = (request: Request, data: unknown, status = 200) => Response.json(data, { status, headers: apiHeaders(request, true) });

export function OPTIONS(request: Request) { return apiOptions(request, true); }
export async function GET(request: Request) {
  try {
    if (!isTrustedApiOrigin(request)) throw new GameError('请求来源无效。', 403);
    if (!env.DB) throw new GameError('排行榜暂未就绪，请稍后重试。', 503);
    const db = env.DB.withSession('first-primary');
    const account = await requireAccount(request, db);
    return json(request, await readLeaderboard(db, account.id, leaderboardPagination(new URL(request.url))));
  } catch (error) {
    if (error instanceof GameError) return json(request, { error: error.message }, error.status);
    console.error('Leaderboard service error');
    return json(request, { error: '读取排行榜失败，请稍后重试。' }, 503);
  }
}
