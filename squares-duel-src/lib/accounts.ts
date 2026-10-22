import { scrypt, timingSafeEqual } from 'node:crypto';
import { GameError, type Game, type Player } from './game';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './account-policy';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const RATE_WINDOW_MS = 15 * 60 * 1_000;
const HASH_PREFIX = 'scrypt$v1$16384$8$5$';
const TOKEN_PREFIX = 'sq_account_';
type AccountRow = { id: string; username: string; password_hash: string; password_version: number; rating_milli: number; rated_games: number };
export type Account = { id: string; username: string; passwordVersion: number; tokenHash: string; expiresAt: number; rating: number; ratedGames: number };
const ACCOUNT_COLUMNS = 'id, username, password_hash, password_version, rating_milli, rated_games';

function bytesHex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
export async function tokenHash(value: string): Promise<string> {
  return bytesHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
function randomHex(size: number): string { return bytesHex(crypto.getRandomValues(new Uint8Array(size))); }
export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return null;
  if (!authorization.startsWith('Bearer ') || authorization.length > 200 || authorization.length <= 7) throw new GameError('登录凭证无效，请重新登录。', 401);
  return authorization.slice(7);
}
export function isAccountToken(token: string): boolean { return token.startsWith(TOKEN_PREFIX); }
export function accountUsername(value: unknown): { username: string; key: string } {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(value)) throw new GameError('用户名须为 3–20 位英文字母、数字或下划线。');
  return { username: value, key: value.toLowerCase() };
}
export function accountPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) throw new GameError('密码须为 5–128 个字符，空格也会保留。');
  return value;
}
// Keep scrypt's working memory bounded when multiple requests reach one isolate.
let hashRunning = false;
const hashQueue: Array<() => void> = [];
async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (hashRunning) {
    if (hashQueue.length >= 4) throw new GameError('登录请求较多，请稍后重试。', 429);
    await new Promise<void>(resolve => hashQueue.push(resolve));
  }
  hashRunning = true;
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      scrypt(password, salt, 64, { N: 16_384, r: 8, p: 5, maxmem: 32 * 1_024 * 1_024 }, (error, result) => error ? reject(error) : resolve(result));
    });
  } finally {
    const next = hashQueue.shift();
    if (next) next(); else hashRunning = false;
  }
}
async function passwordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return HASH_PREFIX + bytesHex(salt) + '$' + bytesHex(await derive(password, salt));
}
async function passwordMatches(password: string, encoded: string | undefined): Promise<boolean> {
  const pieces = encoded?.startsWith(HASH_PREFIX) ? encoded.slice(HASH_PREFIX.length).split('$') : [];
  const valid = pieces.length === 2 && /^[0-9a-f]{32}$/.test(pieces[0]) && /^[0-9a-f]{128}$/.test(pieces[1]);
  const salt = valid ? Uint8Array.from(pieces[0].match(/../g)!, part => parseInt(part, 16)) : new Uint8Array(16);
  const expected = valid ? Uint8Array.from(pieces[1].match(/../g)!, part => parseInt(part, 16)) : new Uint8Array(64);
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && valid;
}
export async function optionalAccount(request: Request, db: D1DatabaseSession): Promise<Account | null> {
  const token = bearerToken(request);
  if (!token || !isAccountToken(token)) return null;
  if (!/^sq_account_[0-9a-f]{64}$/.test(token)) throw new GameError('登录已失效，请重新登录。', 401);
  const digest = await tokenHash(token);
  const row = await db.prepare(`SELECT a.id, a.username, a.password_version, a.rating_milli, a.rated_games, s.expires_at FROM account_sessions s JOIN accounts a ON a.id = s.account_id
WHERE s.token_hash = ? AND s.expires_at > ? AND s.password_version = a.password_version`).bind(digest, Date.now())
    .first<{ id: string; username: string; password_version: number; expires_at: number; rating_milli: number; rated_games: number }>();
  if (!row) throw new GameError('登录已失效，请重新登录。', 401);
  return { id: row.id, username: row.username, passwordVersion: row.password_version, tokenHash: digest, expiresAt: row.expires_at,
    rating: row.rating_milli / 1000, ratedGames: row.rated_games };
}
export async function requireAccount(request: Request, db: D1DatabaseSession): Promise<Account> {
  const account = await optionalAccount(request, db);
  if (!account) throw new GameError('请先登录账号。', 401);
  return account;
}
export async function authenticatedMember(request: Request, db: D1DatabaseSession, game: Game): Promise<Player> {
  const account = await requireAccount(request, db);
  const members = [...game.players, ...(game.spectators ?? [])];
  const player = members.find(member => member.accountId === account.id);
  if (!player) throw new GameError('房间凭证无效，请重新加入。', 401);
  return player;
}
export function publicAccount(account: Pick<Account, 'username' | 'rating' | 'ratedGames'>) {
  return { username: account.username, rating: account.rating, ratedGames: account.ratedGames };
}

async function limitAttempts(db: D1DatabaseSession, request: Request, operation: 'register' | 'login' | 'password', usernameKey: string) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const keys = await Promise.all([tokenHash(`ip:${operation}:${ip}`), tokenHash(`user:${operation}:${usernameKey}`)]);
  const limits = operation === 'register' ? [10, 5] : [30, 10];
  const statements = keys.map((key, index) => db.prepare(`INSERT INTO account_rates (key, window_start, hits) VALUES (?, ?, 1)
ON CONFLICT (key) DO UPDATE SET window_start = CASE WHEN account_rates.window_start <= ? THEN excluded.window_start ELSE account_rates.window_start END,
hits = CASE WHEN account_rates.window_start <= ? THEN 1 ELSE account_rates.hits + 1 END
WHERE account_rates.window_start <= ? OR account_rates.hits < ?`).bind(key, now, now - RATE_WINDOW_MS, now - RATE_WINDOW_MS, now - RATE_WINDOW_MS, limits[index]));
  statements.push(db.prepare('DELETE FROM account_rates WHERE key IN (SELECT key FROM account_rates WHERE window_start < ? LIMIT 100)').bind(now - RATE_WINDOW_MS * 2));
  statements.push(db.prepare('DELETE FROM account_sessions WHERE token_hash IN (SELECT token_hash FROM account_sessions WHERE expires_at <= ? LIMIT 100)').bind(now));
  const results = await db.batch(statements);
  if (results.slice(0, 2).some(result => result.meta.changes !== 1)) throw new GameError('尝试次数过多，请 15 分钟后再试。', 429);
}
function newSession() {
  const token = TOKEN_PREFIX + randomHex(32);
  const now = Date.now();
  return { token, now, expiresAt: now + SESSION_LIFETIME_MS };
}
export async function registerAccount(db: D1DatabaseSession, request: Request, usernameValue: unknown, passwordValue: unknown) {
  const { username, key } = accountUsername(usernameValue);
  const password = accountPassword(passwordValue);
  await limitAttempts(db, request, 'register', key);
  const id = crypto.randomUUID();
  const hash = await passwordHash(password);
  const session = newSession();
  const digest = await tokenHash(session.token);
  const results = await db.batch([
    db.prepare('INSERT OR IGNORE INTO accounts (id, username, username_key, password_hash, password_version, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(id, username, key, hash, session.now),
    db.prepare('INSERT INTO account_sessions (token_hash, account_id, password_version, created_at, expires_at) SELECT ?, id, password_version, ?, ? FROM accounts WHERE id = ?').bind(digest, session.now, session.expiresAt, id),
  ]);
  if (results[0].meta.changes !== 1) throw new GameError('这个用户名已被注册。', 409);
  return { user: { username, rating: 1000, ratedGames: 0 }, token: session.token, expiresAt: session.expiresAt };
}
export async function loginAccount(db: D1DatabaseSession, request: Request, usernameValue: unknown, passwordValue: unknown) {
  const { key } = accountUsername(usernameValue);
  const password = accountPassword(passwordValue);
  await limitAttempts(db, request, 'login', key);
  const row = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE username_key = ?`).bind(key).first<AccountRow>();
  if (!await passwordMatches(password, row?.password_hash) || !row) throw new GameError('用户名或密码不正确。', 401);
  const session = newSession();
  const inserted = await db.prepare(`INSERT INTO account_sessions (token_hash, account_id, password_version, created_at, expires_at)
SELECT ?, id, password_version, ?, ? FROM accounts WHERE id = ? AND password_hash = ? AND password_version = ?`)
    .bind(await tokenHash(session.token), session.now, session.expiresAt, row.id, row.password_hash, row.password_version).run();
  if (inserted.meta.changes !== 1) throw new GameError('密码已更新，请使用新密码登录。', 401);
  return { user: { username: row.username, rating: row.rating_milli / 1000, ratedGames: row.rated_games }, token: session.token, expiresAt: session.expiresAt };
}
export async function logoutAccount(db: D1DatabaseSession, request: Request) {
  const token = bearerToken(request);
  if (token && isAccountToken(token)) await db.prepare('DELETE FROM account_sessions WHERE token_hash = ?').bind(await tokenHash(token)).run();
  return { user: null };
}
export async function changePassword(db: D1DatabaseSession, request: Request, currentValue: unknown, nextValue: unknown) {
  const account = await requireAccount(request, db);
  const password = accountPassword(currentValue);
  const next = accountPassword(nextValue);
  await limitAttempts(db, request, 'password', account.id);
  const row = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).bind(account.id).first<AccountRow>();
  if (!row || !await passwordMatches(password, row.password_hash)) throw new GameError('当前密码不正确。', 401);
  const hash = await passwordHash(next);
  const session = newSession();
  const version = row.password_version + 1;
  const results = await db.batch([
    db.prepare('UPDATE accounts SET password_hash = ?, password_version = ? WHERE id = ? AND password_hash = ? AND password_version = ?').bind(hash, version, row.id, row.password_hash, row.password_version),
    db.prepare('DELETE FROM account_sessions WHERE account_id = ? AND password_version < ?').bind(row.id, version),
    db.prepare(`INSERT INTO account_sessions (token_hash, account_id, password_version, created_at, expires_at)
SELECT ?, id, password_version, ?, ? FROM accounts WHERE id = ? AND password_hash = ? AND password_version = ?`)
      .bind(await tokenHash(session.token), session.now, session.expiresAt, row.id, hash, version),
  ]);
  if (results[0].meta.changes !== 1) throw new GameError('密码已更新，请重新登录。', 409);
  const current = await db.prepare('SELECT rating_milli, rated_games FROM accounts WHERE id = ?').bind(row.id).first<{ rating_milli: number; rated_games: number }>();
  return { user: { username: row.username, rating: (current?.rating_milli ?? row.rating_milli) / 1000, ratedGames: current?.rated_games ?? row.rated_games }, token: session.token, expiresAt: session.expiresAt };
}
