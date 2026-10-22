const GITHUB_PAGES_ORIGIN = 'https://le0n-97.github.io';

export function isTrustedApiOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin || origin === GITHUB_PAGES_ORIGIN;
}

export function apiHeaders(request: Request, varyAuthorization = false): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store, max-age=0',
    Vary: varyAuthorization ? 'Origin, Authorization' : 'Origin',
  });
  const origin = request.headers.get('Origin');
  if (origin && isTrustedApiOrigin(request)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

export function apiOptions(request: Request, varyAuthorization = false): Response {
  const headers = apiHeaders(request, varyAuthorization);
  if (!isTrustedApiOrigin(request)) {
    return Response.json({ error: '请求来源无效。' }, { status: 403, headers });
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '600');
  return new Response(null, { status: 204, headers });
}
