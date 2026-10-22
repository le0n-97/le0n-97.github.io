import { publicGame, teamIdForPlayer, teamSummaries, type Game, type FoundWord, type TeamId, type WordCount, type WordSolution } from './game';

export type RecordedPlayer = {
  id: string; name: string; score: number; committed: boolean; committedAt: number | null; teamId?: TeamId;
};
export type RecordedTeam = ReturnType<typeof teamSummaries>[number];
export type GameRecordSummary = {
  id: string; code: string; round: number; startedAt: number | null; endedAt: number;
  endReason: Game['endReason']; wordCount: WordCount; boardSource: 'random' | 'legacy';
  players: RecordedPlayer[]; winnerId: string | null; durationMs: number;
  teams?: RecordedTeam[]; winnerTeamId?: TeamId | null;
  totalWords: number; foundWords: number; bonusFound: number;
};
export type GameRecordDetail = GameRecordSummary & {
  board: string[]; words: FoundWord[]; solutions: WordSolution[];
};

// Keep the stored record on an explicit allowlist: room credentials, generated
// puzzle internals and future private game fields must never enter the archive.
export function recordForGame(game: Game): GameRecordDetail | null {
  if (game.status !== 'finished' || typeof game.endedAt !== 'number' || !Number.isFinite(game.endedAt)) return null;
  const view = publicGame(game);
  const players = game.players.map(player => ({
    id: player.id, name: player.name, score: player.score, committed: player.committed,
    committedAt: player.committedAt ?? null,
    teamId: teamIdForPlayer(game, player.id),
  }));
  const teams = teamSummaries(game).map(team => ({ ...team, playerIds: [...team.playerIds] }));
  const leaders = teams.filter(team => team.score === Math.max(...teams.map(item => item.score)));
  const winner = leaders.length === 1 ? leaders[0] : null;
  return {
    id: `${game.code}-${game.createdAt}-${game.round}`,
    code: game.code, round: game.round, startedAt: game.startedAt, endedAt: game.endedAt,
    endReason: game.endReason, wordCount: game.wordCount ?? 'any',
    boardSource: game.generatedPuzzle ? 'random' : 'legacy', players,
    teams, winnerTeamId: winner?.id ?? null,
    winnerId: winner?.playerIds.length === 1 ? winner.playerIds[0] : null,
    durationMs: game.startedAt === null ? 0 : Math.max(0, game.endedAt - game.startedAt),
    totalWords: view.totalWords, foundWords: view.foundWords,
    bonusFound: game.words.filter(word => word.bonus).length,
    board: [...game.board],
    words: game.words.map(word => ({
      word: word.word, playerId: word.playerId, points: word.points, bonus: word.bonus, at: word.at,
      teamId: word.teamId ?? teamIdForPlayer(game, word.playerId),
    })),
    solutions: (view.solutions ?? []).map(solution => ({
      word: solution.word, points: solution.points, bonus: solution.bonus, path: [...solution.path],
    })),
  };
}

export function summaryOf(record: GameRecordDetail): GameRecordSummary {
  return {
    id: record.id, code: record.code, round: record.round,
    startedAt: record.startedAt, endedAt: record.endedAt, endReason: record.endReason,
    wordCount: record.wordCount, boardSource: record.boardSource,
    players: record.players.map(player => ({
      id: player.id, name: player.name, score: player.score,
      committed: player.committed, committedAt: player.committedAt,
      ...(player.teamId !== undefined ? { teamId: player.teamId } : {}),
    })),
    winnerId: record.winnerId, durationMs: record.durationMs,
    ...(record.teams ? { teams: record.teams.map(team => ({ ...team, playerIds: [...team.playerIds] })), winnerTeamId: record.winnerTeamId ?? null } : {}),
    totalWords: record.totalWords, foundWords: record.foundWords, bonusFound: record.bonusFound,
  };
}

export const UPDATE_ROOM_SQL = 'UPDATE rooms SET state = ?, revision = revision + 1, updated_at = ? WHERE code = ? AND revision = ?';
export const ARCHIVE_ROOM_SQL = `INSERT OR IGNORE INTO game_records (id, room_code, round, ended_at, player_names, record_json)
SELECT ?, ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM rooms WHERE code = ? AND revision = ? AND state = ?)`;

// D1 batches execute atomically. The archive insert is also tied to the exact
// state written by this CAS, so a losing concurrent request cannot archive its
// proposed result. Previous finished state is captured before a rematch resets it.
export async function writeRoomWithRecord(
  db: D1DatabaseSession, game: Game, revision: number, now: number, previousFinished?: Game,
): Promise<boolean> {
  const state = JSON.stringify(game);
  const update = db.prepare(UPDATE_ROOM_SQL).bind(state, now, game.code, revision);
  const records = new Map<string, GameRecordDetail>();
  for (const candidate of [previousFinished, game]) {
    if (!candidate) continue;
    const record = recordForGame(candidate);
    if (record) records.set(record.id, record);
  }
  if (!records.size) return (await update.run()).meta.changes === 1;
  const statements = [update, ...[...records.values()].map(record => db.prepare(ARCHIVE_ROOM_SQL).bind(
    record.id, record.code, record.round, record.endedAt,
    record.players.map(player => player.name).join('\n'), JSON.stringify(record),
    game.code, revision + 1, state,
  ))];
  const results = await db.batch(statements);
  return results[0].meta.changes === 1;
}
