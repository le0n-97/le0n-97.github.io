export type WordSyncAccount = { id: string | number; username: string };

type Phase = 'lobby' | 'playing' | 'revealed' | 'won';
type Player = { id: string; accountId: string; name: string };
type RoundResult = { round: number; results: { name: string; word: string }[]; win: boolean };

export type WordSyncRoom = {
  code: string;
  hostId: string;
  players: Player[];
  nextPlayerId: number;
  phase: Phase;
  round: number;
  history: RoundResult[];
  answers: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

export type WordSyncAction = {
  action: 'join' | 'start' | 'submit' | 'next' | 'leave';
  code?: string;
  round?: unknown;
  word?: unknown;
};

export class WordSyncError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WordSyncError';
    this.status = status;
  }
}

export function createRoom(code: string, account: WordSyncAccount, now: number): WordSyncRoom {
  const host: Player = { id: 'p1', accountId: String(account.id), name: account.username };
  return {
    code,
    hostId: host.id,
    players: [host],
    nextPlayerId: 2,
    phase: 'lobby',
    round: 1,
    history: [],
    answers: {},
    createdAt: now,
    updatedAt: now,
  };
}

function findPlayer(room: WordSyncRoom, account: WordSyncAccount) {
  return room.players.find(player => player.accountId === String(account.id));
}

function requireHost(room: WordSyncRoom, player: Player) {
  if (player.id !== room.hostId) throw new WordSyncError(403, '只有房主可以开始回合');
}

export function resumeRevealedRound(room: WordSyncRoom, now: number): boolean {
  // Rooms saved by the previous version may still be waiting for the host.
  if (room.phase !== 'revealed') return false;
  room.round++;
  room.phase = room.players.length >= 2 ? 'playing' : 'lobby';
  room.answers = {};
  room.updatedAt = now;
  return true;
}

function revealIfReady(room: WordSyncRoom) {
  if (room.phase !== 'playing' || room.players.length < 2) return;
  if (!room.players.every(player => Object.hasOwn(room.answers, player.id))) return;

  const results = room.players.map(({ id, name }) => ({ name, word: room.answers[id] }));
  const win = results.every(result => result.word === results[0].word);
  room.history.push({ round: room.round, results, win });
  room.answers = {};
  if (win) room.phase = 'won';
  else room.round++;
}

function leaveRoom(room: WordSyncRoom, player: Player, now: number) {
  room.players = room.players.filter(member => member.id !== player.id);
  delete room.answers[player.id];
  if (room.hostId === player.id) room.hostId = room.players[0]?.id ?? '';

  if (resumeRevealedRound(room, now)) return;

  if (room.players.length < 2 && room.phase === 'playing') {
    // Retire this round number so an in-flight answer cannot land in the replacement round.
    room.round++;
    room.phase = 'lobby';
    room.answers = {};
  } else {
    revealIfReady(room);
  }
}

export function transition(room: WordSyncRoom, account: WordSyncAccount, payload: WordSyncAction, now: number): boolean {
  const player = findPlayer(room, account);
  const resumed = player && payload.action !== 'leave' ? resumeRevealedRound(room, now) : false;

  if (payload.action === 'join') {
    if (player) return resumed;
    if (room.phase !== 'lobby') throw new WordSyncError(409, '游戏已开始，暂时无法加入');
    if (room.players.length >= 12) throw new WordSyncError(409, '房间已满');
    room.players.push({ id: `p${room.nextPlayerId++}`, accountId: String(account.id), name: account.username });
    room.updatedAt = now;
    return true;
  }

  if (!player) {
    if (payload.action === 'leave') return false;
    throw new WordSyncError(403, '请先加入这个房间');
  }

  switch (payload.action) {
    case 'start':
      requireHost(room, player);
      if (room.phase !== 'lobby') throw new WordSyncError(409, '游戏已经开始');
      if (room.players.length < 2) throw new WordSyncError(409, '至少需要两位玩家');
      room.phase = 'playing';
      break;
    case 'submit': {
      if (room.phase !== 'playing' || payload.round !== room.round) throw new WordSyncError(409, '这个回合已结束，请查看最新房间状态');
      const word = typeof payload.word === 'string' ? payload.word.trim() : '';
      if (!word || word.length > 30) throw new WordSyncError(400, '请输入 1 至 30 字的答案');
      if (Object.hasOwn(room.answers, player.id)) {
        if (room.answers[player.id] === word) return false;
        throw new WordSyncError(409, '你已经提交了本回合的答案');
      }
      if (room.history.some(round => round.results.some(result => result.word === word))) {
        throw new WordSyncError(409, '这个词在之前的回合已经用过了，请换一个。');
      }
      room.answers[player.id] = word;
      revealIfReady(room);
      break;
    }
    case 'next':
      requireHost(room, player);
      // A cached client may still send the old confirmation. Return the new round without advancing again.
      if (room.phase === 'playing' && payload.round === room.round - 1 && room.history.at(-1)?.round === payload.round) return resumed;
      throw new WordSyncError(409, '回合已自动推进，请查看最新房间状态');
    case 'leave':
      leaveRoom(room, player, now);
      break;
    default:
      throw new WordSyncError(400, '不支持的房间操作');
  }

  room.updatedAt = now;
  return true;
}

export function publicRoom(room: WordSyncRoom, account: WordSyncAccount) {
  const player = findPlayer(room, account);
  if (!player) throw new WordSyncError(403, '请先加入这个房间');

  return {
    code: room.code,
    hostId: room.hostId,
    meId: player.id,
    phase: room.phase,
    round: room.round,
    players: room.players.map(({ id, name }) => ({ id, name, submitted: Object.hasOwn(room.answers, id) })),
    history: room.history.map(({ round, results, win }) => ({ round, results: results.map(result => ({ ...result })), win })),
  };
}
