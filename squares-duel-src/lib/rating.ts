/** Ratings use integer thousandths internally so a team transfer stays zero-sum. */
export const INITIAL_RATING = 1000;
export const RATING_K = 320;

export type RatingParticipant = {
  playerId: string;
  accountId: string;
  teamId: 0 | 1;
  ratingMilli: number;
};

export type RatingRound = {
  version: 'team-share-v1';
  players: RatingParticipant[];
  expectedShares: [number, number];
};

export type RatingChange = {
  playerId: string;
  teamId: 0 | 1;
  startRating: number;
  delta: number;
};

export type RatingResult = {
  version: 'team-share-v1';
  rated: boolean;
  reason?: 'no_words' | 'legacy' | 'invalid_roster';
  expectedShares: [number, number] | null;
  actualShares: [number, number] | null;
  changes: RatingChange[];
};

/** Sum each player's Elo strength, including the advantage of an extra teammate. */
export function makeRatingRound(players: RatingParticipant[]): RatingRound | null {
  if (!Array.isArray(players) || players.length < 2) return null;
  const playerIds = new Set<string>();
  const accountIds = new Set<string>();
  const counts = [0, 0];
  let maxRating = -Infinity;
  for (const player of players) {
    if (!player || typeof player.playerId !== 'string' || !player.playerId
      || typeof player.accountId !== 'string' || !player.accountId
      || (player.teamId !== 0 && player.teamId !== 1)
      || !Number.isSafeInteger(player.ratingMilli)
      || playerIds.has(player.playerId) || accountIds.has(player.accountId)) return null;
    playerIds.add(player.playerId);
    accountIds.add(player.accountId);
    counts[player.teamId]++;
    maxRating = Math.max(maxRating, player.ratingMilli);
  }
  if (!counts[0] || !counts[1]) return null;

  // Subtracting the strongest rating before exponentiation prevents overflow.
  const strengths = [0, 0];
  for (const player of players) {
    strengths[player.teamId] += 10 ** ((player.ratingMilli - maxRating) / 400_000);
  }
  const total = strengths[0] + strengths[1];
  const expectedShares: [number, number] = [strengths[0] / total, strengths[1] / total];
  return {
    version: 'team-share-v1',
    players: players.map(({ playerId, accountId, teamId, ratingMilli }) => ({
      playerId, accountId, teamId, ratingMilli,
    })),
    expectedShares,
  };
}

function unrated(reason: NonNullable<RatingResult['reason']>, expectedShares: [number, number] | null = null): RatingResult {
  return { version: 'team-share-v1', rated: false, reason, expectedShares, actualShares: null, changes: [] };
}

/** Split a signed integer transfer evenly, assigning residual thousandths by ID. */
function splitTransfer(players: RatingParticipant[], totalMilli: number, deltas: Map<string, number>) {
  const ordered = [...players].sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
  const base = Math.trunc(totalMilli / ordered.length);
  const remainder = Math.abs(totalMilli % ordered.length);
  const sign = Math.sign(totalMilli);
  ordered.forEach((player, index) => {
    const delta = base + (index < remainder ? sign : 0);
    deltas.set(player.playerId, delta === 0 ? 0 : delta);
  });
}

/** Compare the final score share with the strength share frozen at round start. */
export function settleRating(round: RatingRound | undefined, scores: [number, number]): RatingResult {
  if (!round) return unrated('legacy');
  const validated = makeRatingRound(round.players);
  if (round.version !== 'team-share-v1' || !validated
    || !Array.isArray(round.expectedShares) || round.expectedShares.length !== 2
    || round.expectedShares.some((share, team) => !Number.isFinite(share)
      || Math.abs(share - validated.expectedShares[team]) > 1e-12)
    || !Array.isArray(scores) || scores.length !== 2
    || scores.some(score => !Number.isSafeInteger(score) || score < 0)) return unrated('invalid_roster');

  const expectedShares = validated.expectedShares;
  if (scores[0] === 0 && scores[1] === 0) return unrated('no_words', expectedShares);
  const totalScore = scores[0] + scores[1];
  const actualShares: [number, number] = [scores[0] / totalScore, scores[1] / totalScore];
  const rawTransferMilli = RATING_K * 1000 * (actualShares[0] - expectedShares[0]);
  // Round ties away from zero, so swapping team colors mirrors the transfer.
  const transferMilli = Math.sign(rawTransferMilli) * Math.round(Math.abs(rawTransferMilli));
  const deltas = new Map<string, number>();
  splitTransfer(validated.players.filter(player => player.teamId === 0), transferMilli, deltas);
  splitTransfer(validated.players.filter(player => player.teamId === 1), -transferMilli, deltas);
  return {
    version: 'team-share-v1', rated: true, expectedShares, actualShares,
    changes: validated.players.map(player => ({
      playerId: player.playerId,
      teamId: player.teamId,
      startRating: player.ratingMilli / 1000,
      delta: deltas.get(player.playerId)! / 1000,
    })),
  };
}
