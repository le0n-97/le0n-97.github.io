import { GameError } from './game';
import type { Leaderboard, LeaderboardEntry, LeaderboardProfile } from './leaderboard-types';

export function leaderboardPagination(url: URL): { offset: number; limit: number } {
  function integer(name: string, fallback: number, minimum: number, maximum: number) {
    const values = url.searchParams.getAll(name);
    if (!values.length) return fallback;
    if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0])) throw new GameError('排行榜分页参数无效。');
    const value = Number(values[0]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new GameError('排行榜分页参数无效。');
    return value;
  }
  return { offset: integer('offset', 0, 0, 1_000_000), limit: integer('limit', 20, 1, 50) };
}

type EntryRow = Omit<LeaderboardEntry, 'isMe'> & { isMe: number };
type ProfileRow = Omit<LeaderboardProfile, 'isMe'>;

export async function readLeaderboard(db: D1DatabaseSession, accountId: string, pagination: { offset: number; limit: number }): Promise<Leaderboard> {
  // One statement gives page rows, total and the current account the same snapshot.
  // Rank uses the exact stored thousandths; position breaks ties only for pagination.
  const row = await db.prepare(`WITH ranked AS (
  SELECT id, username, rating_milli, rated_games,
    RANK() OVER (ORDER BY rating_milli DESC) AS rank,
    ROW_NUMBER() OVER (ORDER BY rating_milli DESC, username_key ASC) AS position
  FROM accounts WHERE rated_games > 0
), current_account AS (
  SELECT id, username, rating_milli, rated_games FROM accounts WHERE id = ?
), page AS (
  SELECT * FROM ranked ORDER BY position LIMIT ? OFFSET ?
)
SELECT (SELECT COUNT(*) FROM ranked) AS total,
  (SELECT json_group_array(json_object(
    'rank', rank, 'position', position, 'username', username,
    'rating', rating_milli / 1000.0, 'ratedGames', rated_games,
    'isMe', id = (SELECT id FROM current_account)
  )) FROM page) AS entries_json,
  (SELECT json_object(
    'rank', ranked.rank, 'position', ranked.position, 'username', current_account.username,
    'rating', current_account.rating_milli / 1000.0, 'ratedGames', current_account.rated_games
  ) FROM current_account LEFT JOIN ranked ON ranked.id = current_account.id) AS me_json`)
    .bind(accountId, pagination.limit, pagination.offset)
    .first<{ total: number; entries_json: string; me_json: string | null }>();
  if (!row?.me_json) throw new GameError('登录已失效，请重新登录。', 401);
  const entries = (JSON.parse(row.entries_json) as EntryRow[]).map(entry => ({
    rank: entry.rank, position: entry.position, username: entry.username,
    rating: entry.rating, ratedGames: entry.ratedGames, isMe: entry.isMe === 1,
  }));
  const profile = JSON.parse(row.me_json) as ProfileRow;
  return {
    entries, total: row.total, offset: pagination.offset, limit: pagination.limit,
    me: { rank: profile.rank, position: profile.position, username: profile.username,
      rating: profile.rating, ratedGames: profile.ratedGames, isMe: true },
    generatedAt: Date.now(),
  };
}
