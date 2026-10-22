import { puzzles } from './puzzles';
import { generateBoard, type GeneratedPuzzle } from './board-generator';
import { canonicalWordPath, wordRoutes } from './word-routes';
import { makeRatingRound, type RatingRound, type RatingResult } from './rating';

export const INACTIVITY_MS = 180_000;
export const COMMIT_MS = 60_000;
export type WordCount = 'any' | 'small' | 'medium' | 'large';
export type TeamId = 0 | 1;
export type MemberRole = 'player' | 'spectator';
export type Player = { id: string; name: string; score: number; committed: boolean; committedAt?: number | null; secret: string; teamId?: TeamId; accountId?: string; rating?: number; ratedGames?: number };
export type FoundWord = { word: string; playerId: string; teamId?: TeamId; points: number; bonus: boolean; at: number };
export type WordSolution = { word: string; points: number; bonus: boolean; path: number[] };
export type WordStats = {
  byLength: { length: number; total: number; found: number; remaining: number }[];
  byInitial?: { letter: string; total: number; found: number; remaining: number }[];
  hintsUnlocked: boolean; unlockAt: number; found: number; total: number;
};
export type Game = {
  code: string; round: number; status: 'waiting' | 'playing' | 'finished'; board: string[];
  players: Player[]; words: FoundWord[]; lastWordAt: number | null; startedAt: number | null;
  endedAt: number | null; endReason: 'committed' | 'commit_timeout' | 'timeout' | 'all_words' | null;
  puzzleId: number; createdAt: number; rematchVotes: string[]; wordCount?: WordCount; commitDeadline?: number | null;
  puzzleHistory?: number[];
  generatedPuzzle?: GeneratedPuzzle; boardHistory?: string[];
  hostId?: string; spectators?: Player[];
  ratingRound?: RatingRound; ratingResult?: RatingResult;
};
export class GameError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function normalizeTeams(game: Game): void {
  game.players.forEach((player, index) => { player.teamId ??= (index % 2) as TeamId; });
  game.spectators ??= [];
  game.hostId ??= game.players[0]?.id ?? game.spectators[0]?.id;
  for (const found of game.words) found.teamId ??= game.players.find(player => player.id === found.playerId)?.teamId;
}
export function teamIdForPlayer(game: Game, playerId: string): TeamId | undefined {
  normalizeTeams(game);
  return game.players.find(player => player.id === playerId)?.teamId;
}
export function teamSummaries(game: Game) {
  normalizeTeams(game);
  return ([0, 1] as const).map(id => {
    const members = game.players.filter(player => player.teamId === id);
    const committed = members.length > 0 && members.every(player => player.committed);
    const timestamps = members.map(player => player.committedAt).filter((at): at is number => typeof at === 'number');
    return { id, name: id === 0 ? '橙队' : '蓝队', score: members.reduce((sum, player) => sum + player.score, 0),
      playerIds: members.map(player => player.id), committed, committedCount: members.filter(player => player.committed).length,
      totalPlayers: members.length, committedAt: committed && timestamps.length === members.length ? Math.max(...timestamps) : null };
  });
}
function requireMember(game: Game, playerId: string) {
  normalizeTeams(game);
  const member = [...game.players, ...game.spectators!].find(player => player.id === playerId);
  if (!member) throw new GameError('无效的房间成员。', 401);
  return member;
}
function requireHost(game: Game, playerId: string) {
  requireMember(game, playerId);
  if (game.hostId !== playerId) throw new GameError('只有房主可以执行这个操作。', 403);
}
function requirePlayer(game: Game, playerId: string) {
  const member = requireMember(game, playerId);
  if (!game.players.some(player => player.id === playerId)) throw new GameError('旁观者不能提交单词或 Commit。', 403);
  return member;
}
export function parseWordCount(value: unknown): WordCount {
  if (value === undefined) return 'any';
  if (value === 'any' || value === 'small' || value === 'medium' || value === 'large') return value;
  throw new GameError('请选择有效的词量档位。');
}
function matchingPuzzles(wordCount: WordCount) {
  return puzzles.map((puzzle, index) => ({ count: puzzle.words.length, index })).filter(({ count }) =>
    wordCount === 'any' || (wordCount === 'small' && count >= 30 && count <= 40) || (wordCount === 'medium' && count > 40 && count <= 55) || (wordCount === 'large' && count > 55 && count <= 70)
  ).map(({ index }) => index);
}
export function canonicalBoardSignature(board: unknown): string | null {
  if (typeof board !== 'string' && !Array.isArray(board)) return null;
  let letters: string[] = typeof board === 'string' ? board.trim().toUpperCase().split('') : [...board];
  if (letters.length !== 16 || letters.some(letter => typeof letter !== 'string' || !/^[A-Z]$/i.test(letter))) return null;
  letters = letters.map(letter => letter.toUpperCase());
  const signatures: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    signatures.push(letters.join(''));
    signatures.push(letters.map((_, index) => letters[Math.floor(index / 4) * 4 + 3 - index % 4]).join(''));
    letters = Array.from({ length: 16 }, (_, index) => letters[(3 - index % 4) * 4 + Math.floor(index / 4)]);
  }
  return signatures.sort()[0];
}
export function pickPuzzle(previous = -1, wordCount: WordCount = 'any', history: readonly number[] = []) {
  const matching = matchingPuzzles(wordCount);
  const alternatives = matching.filter(index => index !== previous);
  const seen = Array.isArray(history) ? history : [];
  const unseen = alternatives.filter(index => !seen.includes(index));
  const choices = unseen.length ? unseen : alternatives.length ? alternatives : matching;
  if (!choices.length) throw new GameError('这个词量档位暂时没有可用棋盘。', 503);
  return choices[Math.floor(Math.random() * choices.length)];
}
export function createGame(code: string, player: Player, now: number, wordCount: WordCount = 'any', recentBoards: readonly string[] = []): Game {
  const selectedWordCount = parseWordCount(wordCount);
  const generatedPuzzle = newGeneratedPuzzle(selectedWordCount, recentBoards);
  return { code, round: 1, status: 'waiting', board: [...generatedPuzzle.board], players: [{ ...player, teamId: 0 }], spectators: [], hostId: player.id, words: [],
    lastWordAt: null, startedAt: null, endedAt: null, endReason: null, puzzleId: -1, createdAt: now, rematchVotes: [], wordCount: selectedWordCount, commitDeadline: null,
    generatedPuzzle, boardHistory: rememberBoards(recentBoards, generatedPuzzle.board) };
}
function rememberBoards(previous: unknown, board: readonly string[]) {
  const history = (Array.isArray(previous) ? previous : []).map(canonicalBoardSignature).filter((signature): signature is string => signature !== null);
  const signature = canonicalBoardSignature([...board])!;
  return [signature, ...new Set(history.filter(item => item !== signature))].slice(0, 64);
}
function newGeneratedPuzzle(wordCount: WordCount, recentBoards: readonly string[]) {
  try { return generateBoard(wordCount, recentBoards); }
  catch { throw new GameError('暂时未能生成符合词量的新棋盘，请重试。', 503); }
}
export function puzzleForGame(game: Game): { board: string[]; words: string[]; bonus: string[] } {
  // Existing rooms retain their original dictionary until the round is over.
  const puzzle = game.generatedPuzzle ?? puzzles[game.puzzleId];
  if (!puzzle) throw new GameError('本局棋盘数据暂时不可用，请稍后重试。', 503);
  return puzzle;
}
function countFoundWords(game: Game) {
  const found = new Set(game.words.filter(item => !item.bonus).map(item => item.word));
  return puzzleForGame(game).words.filter(word => found.has(word)).length;
}
function wordStatistics(game: Game): WordStats {
  const words = puzzleForGame(game).words;
  const foundSet = new Set(game.words.filter(item => !item.bonus).map(item => item.word));
  const found = words.filter(word => foundSet.has(word)).length;
  const unlockAt = Math.ceil(words.length * 0.4);
  const hintsUnlocked = game.status === 'finished' || found >= unlockAt;
  const counts = (group: string[]) => {
    const claimed = group.filter(word => foundSet.has(word)).length;
    return { total: group.length, found: claimed, remaining: group.length - claimed };
  };
  const byLength = [...new Set(words.map(word => word.length))].sort((a, b) => a - b)
    .map(length => ({ length, ...counts(words.filter(word => word.length === length)) }));
  const byInitial = hintsUnlocked ? [...new Set(words.map(word => word[0]))].sort()
    .map(letter => ({ letter, ...counts(words.filter(word => word.startsWith(letter))) })) : undefined;
  return { byLength, ...(byInitial ? { byInitial } : {}), hintsUnlocked, unlockAt, found, total: words.length };
}
function finishIfComplete(game: Game, now: number) {
  if (game.status !== 'playing' || countFoundWords(game) < puzzleForGame(game).words.length) return false;
  game.status = 'finished'; game.endReason = 'all_words'; game.endedAt = now;
  return true;
}
export function expire(game: Game, now: number) {
  normalizeTeams(game);
  if (finishIfComplete(game, game.lastWordAt ?? now)) return true;
  if (game.status !== 'playing') return false;
  // Old rooms did not store a commit timestamp. Give them a single 60-second
  // countdown on first contact, then persist it through the same CAS as claims.
  const migrated = game.commitDeadline == null && teamSummaries(game).some(team => team.committed);
  if (migrated) game.commitDeadline = now + COMMIT_MS;
  const inactivityDeadline = game.lastWordAt === null ? Infinity : game.lastWordAt + INACTIVITY_MS;
  const commitDeadline = game.commitDeadline ?? Infinity;
  const deadline = Math.min(inactivityDeadline, commitDeadline);
  if (now >= deadline) {
    game.status = 'finished'; game.endReason = commitDeadline <= inactivityDeadline ? 'commit_timeout' : 'timeout'; game.endedAt = deadline;
    return true;
  }
  return migrated;
}
function validateRole(role: unknown): asserts role is MemberRole {
  if (role !== 'player' && role !== 'spectator') throw new GameError('请选择有效的参赛或旁观身份。');
}
function validateTeamId(teamId: unknown): asserts teamId is TeamId | undefined {
  if (teamId !== undefined && teamId !== 0 && teamId !== 1) throw new GameError('请选择橙队或蓝队。');
}
function teamWithRoom(game: Game): TeamId {
  return game.players.filter(player => player.teamId === 0).length <= game.players.filter(player => player.teamId === 1).length ? 0 : 1;
}
export function joinGame(game: Game, player: Player, _now: number, options: { role?: MemberRole; teamId?: TeamId } = {}) {
  normalizeTeams(game);
  const role = options.role ?? 'player';
  validateRole(role); validateTeamId(options.teamId);
  if (game.players.length + game.spectators!.length >= 64) throw new GameError('房间人数已达上限。', 409);
  if ([...game.players, ...game.spectators!].some(member => member.id === player.id)) throw new GameError('你已加入这个房间。', 409);
  if (role === 'player' && game.status !== 'waiting') throw new GameError('本局已经开始，请选择旁观，或等待房主准备下一局。', 409);
  const member = { ...player, score: 0, committed: false, committedAt: null };
  if (role === 'spectator') { delete member.teamId; game.spectators!.push(member); }
  else game.players.push({ ...member, teamId: options.teamId ?? teamWithRoom(game) });
}
export function changeTeam(game: Game, playerId: string, role: MemberRole, teamId?: TeamId) {
  const member = requireMember(game, playerId);
  validateRole(role); validateTeamId(teamId);
  if (game.status !== 'waiting') throw new GameError('只有准备阶段可以更换队伍或参赛身份。', 409);
  game.players = game.players.filter(player => player.id !== playerId);
  game.spectators = game.spectators!.filter(player => player.id !== playerId);
  const changed = { ...member, score: 0, committed: false, committedAt: null };
  if (role === 'spectator') { delete changed.teamId; game.spectators.push(changed); }
  else game.players.push({ ...changed, teamId: teamId ?? teamWithRoom(game) });
}
export function startGame(game: Game, playerId: string, now: number) {
  requireHost(game, playerId);
  if (game.status !== 'waiting') throw new GameError('本局已经开始或已经结束。', 409);
  if (teamSummaries(game).some(team => team.totalPlayers === 0)) throw new GameError('两支队伍都至少需要一名参赛者。', 409);
  game.status = 'playing'; game.startedAt = now; game.lastWordAt = now;
}
export function isAdjacent(a: number, b: number) {
  return a !== b && Math.abs(Math.floor(a / 4) - Math.floor(b / 4)) <= 1 && Math.abs(a % 4 - b % 4) <= 1;
}
export function validPath(board: string[], word: string, path: unknown): boolean {
  if (!Array.isArray(path) || path.length !== word.length || new Set(path).size !== path.length) return false;
  return path.every((tile, i) => Number.isInteger(tile) && tile >= 0 && tile < 16 && board[tile] === word[i] && (!i || isAdjacent(path[i - 1], tile)));
}
export function findPath(board: string[], word: string): number[] | null {
  return canonicalWordPath(board, word);
}
export function submitWord(game: Game, playerId: string, rawWord: unknown, path: unknown, now: number) {
  requirePlaying(game, playerId, now);
  if (typeof rawWord !== 'string') throw new GameError('请输入英文单词。');
  const word = rawWord.trim().toUpperCase();
  if (!/^[A-Z]{4,16}$/.test(word)) throw new GameError('单词需要至少 4 个字母。');
  if (game.words.some(found => found.word === word)) throw new GameError('这个单词已被抢先找到。', 409);
  if (path !== undefined ? !validPath(game.board, word, path) : !findPath(game.board, word)) throw new GameError('请连接相邻字母，每个格子只能使用一次。');
  const puzzle = puzzleForGame(game);
  const bonus = puzzle.bonus.includes(word);
  if (!puzzle.words.includes(word) && !bonus) throw new GameError('这个单词不在本局词库中。');
  const points = bonus ? 1 : word.length;
  game.words.push({ word, playerId, teamId: teamIdForPlayer(game, playerId), points, bonus, at: now });
  game.players.find(player => player.id === playerId)!.score += points;
  game.lastWordAt = now;
  finishIfComplete(game, now);
  return { word, points, bonus };
}
export function commitGame(game: Game, playerId: string, now: number) {
  if (game.status !== 'playing') throw new GameError('本局已结束或尚未开始。', 409);
  const player = requirePlayer(game, playerId);
  expire(game, now);
  if (game.status !== 'playing') throw new GameError('本局已结束或尚未开始。', 409);
  if (!player.committed) player.committedAt = now;
  player.committed = true;
  const teams = teamSummaries(game);
  if (teams.some(team => team.committed)) game.commitDeadline ??= now + COMMIT_MS;
  if (teams.every(team => team.committed)) { game.status = 'finished'; game.endReason = 'committed'; game.endedAt = now; }
}
export function rematch(game: Game, playerId: string, now: number) {
  if (game.status !== 'finished') throw new GameError('请先完成当前对局。', 409);
  requireHost(game, playerId);
  game.wordCount ??= 'any';
  const history = rememberBoards(game.boardHistory, game.board);
  const generatedPuzzle = newGeneratedPuzzle(game.wordCount, history);
  game.generatedPuzzle = generatedPuzzle; game.puzzleId = -1; game.board = [...generatedPuzzle.board]; game.round++;
  game.boardHistory = rememberBoards(history, game.board); delete game.puzzleHistory;
  game.players = game.players.map(p => ({ ...p, score: 0, committed: false, committedAt: null }));
  game.status = 'waiting'; game.words = []; game.startedAt = null; game.lastWordAt = null; game.endedAt = null; game.endReason = null; game.rematchVotes = []; game.commitDeadline = null;
  delete game.ratingRound; delete game.ratingResult;
}
export function publicGame(game: Game) {
  normalizeTeams(game);
  const puzzle = puzzleForGame(game);
  const wordStats = wordStatistics(game);
  const foundWords = wordStats.found;
  let routes: ReturnType<typeof wordRoutes>;
  try { routes = wordRoutes(game.board, puzzle.words, puzzle.bonus); }
  catch { throw new GameError('暂时无法生成棋盘提示，请稍后刷新。', 503); }
  const claimed = new Set(game.words.map(item => item.word));
  const starts = Array<number>(16).fill(0);
  let usableMask = 0;
  for (const [word, route] of routes) if (!claimed.has(word)) {
    if (!route.bonus) {
      usableMask |= route.usableMask;
      starts[route.path[0]]++;
    }
  }
  const tileHints = { unlocked: wordStats.hintsUnlocked,
    ...(wordStats.hintsUnlocked ? { starts } : {}),
    usable: Array.from({ length: 16 }, (_, tile) => Boolean(usableMask & (1 << tile))) };
  const { puzzleId: _, createdAt: __, puzzleHistory: ___, generatedPuzzle: ____, boardHistory: _____, ratingRound: _ratingRound, ...rest } = game;
  const ratingRound = game.status === 'waiting' ? makeRatingRound(game.players.map(player => ({
    playerId: player.id, accountId: player.accountId ?? '', teamId: player.teamId!, ratingMilli: Math.round((player.rating ?? NaN) * 1000),
  }))) : game.ratingRound;
  // Answers and their routes are derived only after settlement, never sent in play.
  const solutionFor = (word: string, bonus: boolean): WordSolution => {
    const path = routes.get(word)?.path;
    if (!path) throw new GameError('暂时无法生成词表路线，请稍后刷新。', 503);
    return { word, points: bonus ? 1 : word.length, bonus, path };
  };
  const solutions = game.status === 'finished' ? [
    ...[...puzzle.words].sort().map(word => solutionFor(word, false)),
    ...[...puzzle.bonus].sort().map(word => solutionFor(word, true)),
  ] : undefined;
  return { ...rest, board: game.status === 'waiting' ? [] : game.board,
    ...(ratingRound ? { rating: { version: ratingRound.version, expectedShares: ratingRound.expectedShares } } : {}),
    players: game.players.map(({ secret: _, accountId: _accountId, ...p }) => p),
    spectators: game.spectators!.map(({ secret: _, accountId: _accountId, ...p }) => p), hostId: game.hostId!, teams: teamSummaries(game),
    boardSource: game.generatedPuzzle ? 'random' : 'legacy',
    wordCount: game.wordCount ?? 'any', foundWords, remainingWords: puzzle.words.length - foundWords,
    wordStats, ...(game.status !== 'waiting' ? { tileHints } : {}),
    ...(solutions ? { solutions } : {}),
    commitDeadline: game.commitDeadline ?? null,
    deadline: game.status === 'playing' && game.lastWordAt !== null ? Math.min(game.lastWordAt + INACTIVITY_MS, game.commitDeadline ?? Infinity) : null,
    totalWords: puzzle.words.length, totalPoints: puzzle.words.reduce((sum, word) => sum + word.length, 0) + puzzle.bonus.length };
}
function requirePlaying(game: Game, playerId: string, now: number) {
  if (game.status !== 'playing') throw new GameError('本局已结束或尚未开始。', 409);
  const player = requirePlayer(game, playerId);
  expire(game, now);
  if (game.status !== 'playing') throw new GameError('本局已结束或尚未开始。', 409);
  if (player.committed) throw new GameError('你已经 Commit，等待本局结算。', 409);
}
