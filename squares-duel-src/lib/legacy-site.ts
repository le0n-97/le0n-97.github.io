const NEW_GAME_URL = 'https://le0n-97.github.io/squares-duel/';

// GitHub Pages still calls this Worker's API. Only the former web UI is closed.
export function closedLegacyPage(request: Request): Response | null {
  if (new URL(request.url).pathname.startsWith('/api/')) return null;
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>旧网址已关闭</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f7f3;color:#252722;font:16px system-ui}main{padding:32px;max-width:440px}h1{font-size:26px}a{display:inline-block;margin-top:12px;color:#356547}p{line-height:1.8;color:#63665f}</style><main><h1>旧网址已关闭</h1><p>Squares 团队对决已迁移到新网址。</p><a href="${NEW_GAME_URL}">打开新网址 →</a></main></html>`, {
    status: 410,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" },
  });
}
