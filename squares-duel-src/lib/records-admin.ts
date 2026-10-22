import { expire, INACTIVITY_MS, type Game } from './game';
import { summaryOf, writeRoomWithRecord, type GameRecordDetail } from './game-records';

export const RECORDS_PAGE_SIZE = 20;
export const BACKFILL_SQL = `SELECT state, revision FROM rooms
  WHERE json_extract(state, '$.status') IN ('playing', 'finished')
    AND NOT EXISTS (SELECT 1 FROM game_records WHERE id = rooms.code || '-' || json_extract(state, '$.createdAt') || '-' || json_extract(state, '$.round'))
    AND ((json_extract(state, '$.status') = 'finished' AND json_type(state, '$.endedAt') IN ('integer', 'real'))
      OR json_extract(state, '$.lastWordAt') <= ?
      OR json_extract(state, '$.commitDeadline') <= ?)
  ORDER BY updated_at DESC LIMIT 100`;
const SEARCH_FILTER = `(room_code LIKE ? ESCAPE '\\' OR player_names LIKE ? ESCAPE '\\')`;
export const COUNT_RECORDS_SQL = `SELECT COUNT(*) AS total FROM game_records WHERE ${SEARCH_FILTER}`;
export const LIST_RECORDS_SQL = `SELECT record_json FROM game_records WHERE ${SEARCH_FILTER} ORDER BY ended_at DESC, id DESC LIMIT ? OFFSET ?`;
export const DETAIL_RECORD_SQL = 'SELECT record_json FROM game_records WHERE id = ?';

export function recordsQuery(url: URL) {
  const q = (url.searchParams.get('q') ?? '').trim();
  const rawPage = url.searchParams.get('page') ?? '1';
  const id = url.searchParams.get('id');
  if (q.length > 100 || !/^[1-9]\d{0,4}$/.test(rawPage) || Number(rawPage) > 10000
    || (id !== null && !/^[A-HJ-NP-Z2-9]{6}-\d{1,16}-[1-9]\d{0,8}$/.test(id))) {
    throw new Error('查询条件不正确。');
  }
  return { q, page: Number(rawPage), id };
}

export async function backfillRecords(db: D1DatabaseSession, now: number) {
  const result = await db.prepare(BACKFILL_SQL).bind(now - INACTIVITY_MS, now)
    .all<{ state: string; revision: number }>();
  for (const row of result.results) {
    const game = JSON.parse(row.state) as Game;
    expire(game, now);
    if (game.status === 'finished') await writeRoomWithRecord(db, game, row.revision, now);
  }
  return result.results.length === 100;
}

export async function listRecords(db: D1DatabaseSession, q: string, page: number) {
  const pattern = `%${q.replace(/[\\%_]/g, character => `\\${character}`)}%`;
  const total = await db.prepare(COUNT_RECORDS_SQL).bind(pattern, pattern).first<{ total: number }>();
  const result = await db.prepare(LIST_RECORDS_SQL).bind(pattern, pattern, RECORDS_PAGE_SIZE, (page - 1) * RECORDS_PAGE_SIZE)
    .all<{ record_json: string }>();
  return { records: result.results.map(row => summaryOf(JSON.parse(row.record_json) as GameRecordDetail)),
    total: total?.total ?? 0, page, pageSize: RECORDS_PAGE_SIZE };
}

export async function readRecord(db: D1DatabaseSession, id: string) {
  const row = await db.prepare(DETAIL_RECORD_SQL).bind(id).first<{ record_json: string }>();
  return row ? JSON.parse(row.record_json) as GameRecordDetail : null;
}
