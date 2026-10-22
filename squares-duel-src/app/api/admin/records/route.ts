import { env } from 'cloudflare:workers';
import { backfillRecords, listRecords, readRecord, recordsQuery } from '@/lib/records-admin';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  let localHost = true;
  if (host !== null) {
    try {
      const address = new URL(`http://${host}`);
      localHost = loopback(address.hostname) && address.pathname === '/' && !address.username && !address.password && !address.search && !address.hash;
    } catch { localHost = false; }
  }
  // Fail closed in production, even when its request Host is a loopback name.
  if (!import.meta.env.DEV || !loopback(url.hostname) || !localHost) {
    return json({ error: '对局记录后台仅在本机开发环境开放。' }, 404);
  }
  let query: ReturnType<typeof recordsQuery>;
  try { query = recordsQuery(url); }
  catch { return json({ error: '查询条件不正确。' }, 400); }
  try {
    if (!env.DB) return json({ error: '本地游戏数据库暂未就绪。' }, 503);
    const db = env.DB.withSession('first-primary');
    const backfillPending = await backfillRecords(db, Date.now());
    if (query.id !== null) {
      const record = await readRecord(db, query.id);
      return record ? json({ record }) : json({ error: '没有找到这局记录。' }, 404);
    }
    return json({ ...await listRecords(db, query.q, query.page), backfillPending });
  } catch (error) {
    console.error('Local records error', error instanceof Error ? error.message : 'Unknown error');
    return json({ error: '读取对局记录失败，请确认已应用本地记录表迁移。' }, 503);
  }
}
