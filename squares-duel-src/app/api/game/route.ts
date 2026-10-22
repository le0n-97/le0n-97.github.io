import { env } from 'cloudflare:workers';
import { createGame, joinGame, startGame, changeTeam, submitWord, commitGame, rematch, expire, publicGame, parseWordCount, normalizeTeams, GameError, type Game, type Player, type MemberRole, type TeamId } from '@/lib/game';
import { captureRatingRound, writeRatedRoom } from '@/lib/rating-store';
import { apiHeaders, apiOptions, isTrustedApiOrigin } from '@/lib/api-cors';
import { authenticatedMember, bearerToken, requireAccount, type Account } from '@/lib/accounts';

export const dynamic = 'force-dynamic';
type RoomRow = { state: string; revision: number };
const json = (request: Request, data: unknown, status = 200) => Response.json(data, { status, headers: apiHeaders(request) });
function database() {
  if (!env.DB) throw new GameError('游戏服务暂未就绪，请稍后重试。', 503);
  // Read from the primary for each operation; CAS makes claims/commits atomic.
  return env.DB.withSession('first-primary');
}
function codeOf(value: unknown) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new GameError('请输入正确的 6 位房间码。');
  return code;
}
function recentBoardsOf(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some(board => typeof board !== 'string' || !/^[A-Z]{16}$/.test(board))) {
    throw new GameError('最近棋盘记录无效，请刷新后重试。');
  }
  return [...new Set(value)];
}
function roleOf(value: unknown, optional = false): MemberRole {
  if (value === undefined && optional) return 'player';
  if (value === 'player' || value === 'spectator') return value;
  throw new GameError('请选择有效的参赛或旁观身份。');
}
function teamIdOf(value: unknown): TeamId | undefined {
  if (value === undefined || value === 0 || value === 1) return value;
  throw new GameError('请选择橙队或蓝队。');
}
function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), value => alphabet[value % alphabet.length]).join('');
}
function newPlayer(account: Account, request: Request) {
  const token = bearerToken(request)!;
  const player: Player = { id: crypto.randomUUID(), name: account.username, score: 0, committed: false, committedAt: null, secret: '', accountId: account.id,
    rating: account.rating, ratedGames: account.ratedGames };
  return { token, player };
}
async function authenticatedPlayer(request: Request, db: ReturnType<typeof database>, game: Game) {
  normalizeTeams(game);
  return authenticatedMember(request, db, game);
}
async function readRoom(db: ReturnType<typeof database>, code: string) {
  const row = await db.prepare('SELECT state, revision FROM rooms WHERE code = ?').bind(code).first<RoomRow>();
  if (!row) throw new GameError('没有找到这个房间，请核对房间码。', 404);
  const game = JSON.parse(row.state) as Game;
  normalizeTeams(game);
  return { game, revision: row.revision };
}
async function writeRoom(db: ReturnType<typeof database>, game: Game, revision: number, now: number, previousFinished?: Game) {
  return writeRatedRoom(db, game, revision, now, previousFinished, import.meta.env.DEV);
}
function handleError(request: Request, error: unknown) {
  if (error instanceof GameError) return json(request, { error: error.message }, error.status);
  console.error('Game service error', error instanceof Error ? error.message : 'Unknown error');
  return json(request, { error: '连接游戏服务失败，请稍后重试。' }, 503);
}
export function OPTIONS(request: Request) { return apiOptions(request); }
export async function GET(request: Request) {
  try {
    if (!isTrustedApiOrigin(request)) throw new GameError('请求来源无效。', 403);
    const code = codeOf(new URL(request.url).searchParams.get('code'));
    const db = database();
    for (let attempt = 0; attempt < 12; attempt++) {
      const { game, revision } = await readRoom(db, code);
      const player = await authenticatedPlayer(request, db, game);
      const now = Date.now();
      const changed = expire(game, now);
      if ((changed || game.status === 'finished' && !game.ratingResult) && !await writeRoom(db, game, revision, now)) continue;
      return json(request, { room: publicGame(game), playerId: player.id, serverNow: now });
    }
    throw new GameError('房间正在同步，请重试。', 409);
  } catch (error) { return handleError(request, error); }
}
export async function POST(request: Request) {
  try {
    if (!isTrustedApiOrigin(request)) throw new GameError('请求来源无效。', 403);
    const raw = await request.text();
    if (raw.length > 2048) throw new GameError('请求内容过长。', 413);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(raw); } catch { throw new GameError('请求格式不正确。'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GameError('请求格式不正确。');
    const { action } = payload;
    const db = database();
    if (action === 'create') {
      const wordCount = parseWordCount(payload.wordCount);
      const recentBoards = recentBoardsOf(payload.recentBoards);
      const account = await requireAccount(request, db);
      const { token, player } = newPlayer(account, request);
      for (let i = 0; i < 6; i++) {
        const now = Date.now(); const game = createGame(randomCode(), player, now, wordCount, recentBoards);
        const result = await db.prepare('INSERT OR IGNORE INTO rooms (code, state, revision, updated_at) VALUES (?, ?, 0, ?)')
          .bind(game.code, JSON.stringify(game), now).run();
        if (result.meta.changes === 1) return json(request, { room: publicGame(game), token, playerId: player.id, serverNow: now }, 201);
      }
      throw new GameError('暂时无法创建房间，请重试。', 503);
    }
    if (!['join', 'start', 'team', 'word', 'commit', 'rematch'].includes(String(action))) throw new GameError('未知的游戏操作。');
    const code = codeOf(payload.code);
    const role = action === 'join' || action === 'team' ? roleOf(payload.role, action === 'join') : undefined;
    const teamId = action === 'join' || action === 'team' ? teamIdOf(payload.teamId) : undefined;
    const account = action === 'join' ? await requireAccount(request, db) : null;
    const joining = account ? newPlayer(account, request) : null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const { game, revision } = await readRoom(db, code);
      const existingMember = account ? [...game.players, ...(game.spectators ?? [])].find(member => member.accountId === account.id) : undefined;
      const player = existingMember ?? joining?.player ?? await authenticatedPlayer(request, db, game);
      if (!joining && payload.round !== undefined && (!Number.isInteger(payload.round) || payload.round !== game.round)) {
        throw new GameError('本局已切换，请在当前棋盘重新选词。', 409);
      }
      const now = Date.now();
      if (expire(game, now)) {
        if (!await writeRoom(db, game, revision, now)) continue;
        if (game.status === 'finished' && action !== 'rematch' && action !== 'join') {
          const message = game.endReason === 'all_words' ? '所有计分词已找完，本局已结算。'
            : game.endReason === 'commit_timeout' ? '首支队伍全员 Commit 后已满 60 秒，本局已结算。'
            : '三分钟内没有新词，本局已结算。';
          return json(request, { room: publicGame(game), playerId: player.id, serverNow: now, message });
        }
        continue;
      }
      // Account reconnection preserves its current roster slot even after play
      // starts. A CAS retry also arrives here if a concurrent join won first.
      if (action === 'join' && joining && existingMember) {
        return json(request, { room: publicGame(game), playerId: existingMember.id, serverNow: now, token: joining.token });
      }
      let message: string | undefined;
      const previousFinished = action === 'rematch' && game.status === 'finished' ? structuredClone(game) : undefined;
      if (action === 'join' && joining) joinGame(game, joining.player, now, { role, teamId });
      if (action === 'start') { startGame(game, player.id, now); await captureRatingRound(db, game); }
      if (action === 'team') changeTeam(game, player.id, role!, teamId);
      if (action === 'word') {
        const found = submitWord(game, player.id, payload.word, payload.path, now);
        message = found.bonus ? `${found.word} · 附加词 +${found.points}` : `${found.word} · +${found.points}`;
      }
      if (action === 'commit') commitGame(game, player.id, now);
      if (action === 'rematch') rematch(game, player.id, now);
      if (!await writeRoom(db, game, revision, now, previousFinished)) continue;
      return json(request, { room: publicGame(game), playerId: player.id, serverNow: now, ...(message ? { message } : {}), ...(joining ? { token: joining.token } : {}) });
    }
    throw new GameError('房间正在同步，请重试。', 409);
  } catch (error) { return handleError(request, error); }
}
