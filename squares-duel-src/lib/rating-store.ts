import { GameError, teamSummaries, type Game } from './game';
import { ARCHIVE_ROOM_SQL, UPDATE_ROOM_SQL, recordForGame, type GameRecordDetail } from './game-records';
import { makeRatingRound, settleRating } from './rating';

type ProfileRow = { id: string; rating_milli: number; rated_games: number };

// The lobby is only a preview. Every start reads fresh account ratings and then
// stores the roster/expectations with the same CAS that starts the room.
export async function captureRatingRound(db: D1DatabaseSession, game: Game): Promise<void> {
  const accountIds = game.players.map(player => player.accountId);
  if (accountIds.some(id => !id) || new Set(accountIds).size !== accountIds.length) {
    throw new GameError('参赛账号数据已变化，请重新创建房间。', 409);
  }
  const rows = await db.prepare(`SELECT id, rating_milli, rated_games FROM accounts WHERE id IN (${accountIds.map(() => '?').join(', ')})`)
    .bind(...accountIds).all<ProfileRow>();
  const profiles = new Map(rows.results.map(row => [row.id, row]));
  const round = makeRatingRound(game.players.map(player => ({
    playerId: player.id, accountId: player.accountId!, teamId: player.teamId!, ratingMilli: profiles.get(player.accountId!)?.rating_milli ?? NaN,
  })));
  if (!round) throw new GameError('参赛账号数据已变化，请重新创建房间。', 409);
  game.ratingRound = round;
  delete game.ratingResult;
  for (const player of game.players) {
    const profile = profiles.get(player.accountId!)!;
    player.rating = profile.rating_milli / 1000;
    player.ratedGames = profile.rated_games;
  }
}

function prepareSettlement(game: Game): void {
  if (game.status !== 'finished' || game.ratingResult) return;
  const scores = teamSummaries(game).map(team => team.score) as [number, number];
  const result = settleRating(game.ratingRound, scores);
  if (result.rated && (game.ratingRound!.players.length !== game.players.length || game.ratingRound!.players.some(participant =>
    !game.players.some(player => player.id === participant.playerId && player.accountId === participant.accountId && player.teamId === participant.teamId)))) {
    game.ratingResult = { version: 'team-share-v1', rated: false, reason: 'invalid_roster', expectedShares: null, actualShares: null, changes: [] };
  } else game.ratingResult = result;
}

// A random receipt distinguishes the winning CAS from an identical losing CAS.
// All ledger/account statements require that receipt. Account updates add the
// delta to their current value, so concurrent results in other rooms compose.
export async function writeRatedRoom(
  db: D1DatabaseSession, game: Game, revision: number, now: number, previousFinished?: Game, archiveLocal = false,
): Promise<boolean> {
  const candidates = [previousFinished, game].filter((candidate): candidate is Game => Boolean(candidate));
  for (const candidate of candidates) prepareSettlement(candidate);
  const state = JSON.stringify(game);
  const statements = [db.prepare(UPDATE_ROOM_SQL).bind(state, now, game.code, revision)];
  const rated = new Map<string, Game>();
  const records = new Map<string, GameRecordDetail>();
  for (const candidate of candidates) {
    if (candidate.status !== 'finished') continue;
    const roundId = `${candidate.code}-${candidate.createdAt}-${candidate.round}`;
    if (candidate.ratingResult?.rated && candidate.ratingRound) rated.set(roundId, candidate);
    if (archiveLocal) {
      const record = recordForGame(candidate);
      if (record) records.set(record.id, record);
    }
  }
  for (const [roundId, candidate] of rated) {
    const receipt = crypto.randomUUID();
    statements.push(db.prepare(`INSERT OR IGNORE INTO rating_rounds (id, receipt, room_code, round, ended_at, result_json)
SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rooms WHERE code = ? AND revision = ? AND state = ?)`)
      .bind(roundId, receipt, candidate.code, candidate.round, candidate.endedAt!, JSON.stringify(candidate.ratingResult), game.code, revision + 1, state));
    const changes = candidate.ratingResult!.changes;
    // Keep each statement below D1's bound-parameter limit, and the entire
    // 64-member room below the per-invocation query budget.
    for (let offset = 0; offset < changes.length; offset += 20) {
      const chunk = changes.slice(offset, offset + 20);
      const values = chunk.flatMap(change => {
        const participant = candidate.ratingRound!.players.find(player => player.playerId === change.playerId)!;
        return [participant.accountId, change.playerId, change.teamId, Math.round(change.delta * 1000)];
      });
      statements.push(db.prepare(`WITH deltas (account_id, player_id, team_id, delta_milli) AS (VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')})
INSERT OR IGNORE INTO rating_changes (round_id, account_id, player_id, team_id, before_milli, delta_milli, after_milli)
SELECT ?, a.id, d.player_id, d.team_id, a.rating_milli, d.delta_milli, a.rating_milli + d.delta_milli
FROM accounts a JOIN deltas d ON a.id = d.account_id
WHERE EXISTS (SELECT 1 FROM rating_rounds WHERE id = ? AND receipt = ?)`)
        .bind(...values, roundId, roundId, receipt));
    }
    statements.push(db.prepare(`UPDATE accounts SET rating_milli = rating_milli +
(SELECT delta_milli FROM rating_changes WHERE round_id = ? AND account_id = accounts.id), rated_games = rated_games + 1
WHERE EXISTS (SELECT 1 FROM rating_rounds WHERE id = ? AND receipt = ?)
AND id IN (SELECT account_id FROM rating_changes WHERE round_id = ?)`)
      .bind(roundId, roundId, receipt, roundId));
  }
  for (const record of records.values()) statements.push(db.prepare(ARCHIVE_ROOM_SQL).bind(
    record.id, record.code, record.round, record.endedAt, record.players.map(player => player.name).join('\n'), JSON.stringify(record),
    game.code, revision + 1, state,
  ));
  if (statements.length === 1) return (await statements[0].run()).meta.changes === 1;
  const results = await db.batch(statements);
  return results[0].meta.changes === 1;
}
