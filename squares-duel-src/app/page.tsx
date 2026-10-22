"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, Clock3, Copy, CornerDownLeft, Eye, Flag, HelpCircle, Link2, LoaderCircle, Play, RotateCcw, RotateCw, Sparkles, Trophy, Users, X } from "lucide-react";
import { DRAG_HIT_RADIUS, traceDragSegment, type DragPoint, type DragTarget } from "@/lib/drag-selection";
import { displayedBoardIndices, rotateIndex } from "@/lib/board-rotation";
import { createActionQueue } from "@/lib/action-queue";
import { WordStatistics, type WordStats } from "@/components/word-statistics";
import { RoomChat } from "@/components/room-chat";
import { AccountMenu } from "@/components/account-menu";
import { Leaderboard } from "@/components/leaderboard";
import { useAccount } from "@/lib/account-client";
import { apiUrl, publicAsset } from "@/lib/api-client";

type TeamId = 0 | 1;
type Player = { id: string; name: string; score: number; committed: boolean; committedAt?: number | null; teamId?: TeamId; rating?: number; ratedGames?: number };
type Team = { id: TeamId; name: string; score: number; playerIds: string[]; committed: boolean; committedCount: number; totalPlayers: number; committedAt: number | null };
type FoundWord = { word: string; playerId: string; teamId?: TeamId; points: number; bonus: boolean; at: number };
type Solution = { word: string; points: number; bonus: boolean; path: number[] };
type WordCount = "any" | "small" | "medium" | "large";
type TileHints = { unlocked: boolean; starts?: number[]; usable: boolean[] };
type RatingShares = [number, number];
type RatingChange = { playerId: string; teamId: TeamId; startRating: number; delta: number };
type RatingResult = { version: "team-share-v1"; rated: boolean; reason?: "no_words" | "legacy" | "invalid_roster"; expectedShares: RatingShares | null; actualShares: RatingShares | null; changes: RatingChange[] };
type Room = {
  code: string; round: number; status: "waiting" | "playing" | "finished"; board: string[];
  players: Player[]; spectators?: Player[]; hostId?: string; teams?: Team[]; words: FoundWord[]; lastWordAt: number | null; startedAt: number | null;
  endedAt: number | null; endReason: "committed" | "commit_timeout" | "timeout" | "all_words" | null; deadline: number | null; commitDeadline?: number | null;
  totalWords: number; totalPoints: number; wordCount?: WordCount; foundWords?: number; remainingWords?: number; rematchVotes?: string[]; solutions?: Solution[]; wordStats?: WordStats; tileHints?: TileHints; boardSource?: "random" | "legacy";
  rating?: { version: "team-share-v1"; expectedShares: RatingShares }; ratingResult?: RatingResult;
};
type Snapshot = { room: Room; playerId: string; token?: string; serverNow?: number; message?: string; error?: string };
type Session = { token: string; playerId: string };
type Notice = { text: string; tone: "success" | "error" | "info" };
type GameFlash = { name: string; mine: boolean; id: string; at: number; teamId: TeamId } & ({ kind: "word"; word: string; points: number; bonus: boolean } | { kind: "commit"; committedCount: number; totalPlayers: number } | { kind: "team-commit" });
const DEMO_BOARD = ["W", "O", "R", "D", "P", "L", "A", "Y", "L", "I", "N", "E", "C", "A", "S", "T"];
const DEMO_PATH = [0, 1, 2, 3];
const WORD_COUNT_LABELS: Record<WordCount, string> = { any: "不限 · 随机棋盘", small: "较少 · 约 30–40 个", medium: "适中 · 约 41–55 个", large: "较多 · 约 56–70 个" };
const RECENT_BOARDS_KEY = "squares-duel-recent-boards";
function playerTeam(player: Player, index: number): TeamId { return player.teamId ?? (index % 2 as TeamId); }
function roomTeams(room: Room): Team[] {
  return ([0, 1] as const).map((id) => {
    const saved = room.teams?.find((team) => team.id === id);
    if (saved) return saved;
    const members = room.players.filter((player, index) => playerTeam(player, index) === id);
    const committedCount = members.filter((player) => player.committed).length;
    return { id, name: id === 0 ? "橙队" : "蓝队", score: members.reduce((sum, player) => sum + player.score, 0), playerIds: members.map((player) => player.id), committed: members.length > 0 && committedCount === members.length, committedCount, totalPlayers: members.length, committedAt: null };
  });
}
function wordTeam(found: FoundWord, players: Player[]): TeamId {
  const index = players.findIndex((player) => player.id === found.playerId);
  return found.teamId ?? (index >= 0 ? playerTeam(players[index], index) : 0);
}
const formatShare = (share: number) => `${(share * 100).toFixed(1).replace(/\.0$/, "")}%`;
const formatDelta = (delta: number) => delta > 0 ? `+${delta}` : String(delta);
function RatingExpectation({ room, teams }: { room: Room; teams: Team[] }) {
  if (!room.rating) return room.status === "waiting" ? <p className="rating-waiting-note">每队至少 1 人后显示预期得分占比；开局时锁定本局 Rating。</p> : null;
  return <section className={`rating-expectation ${room.status === "waiting" ? "rating-preview" : ""}`} aria-label="Rating 预期得分占比"><div className="rating-expectation-heading"><span>预期得分占比</span><small>{room.status === "waiting" ? "随组队更新 · 开局锁定" : "按开局人数与 Rating 锁定"}</small></div><div className="rating-share-bar" aria-hidden="true"><span style={{ width: `${room.rating.expectedShares[0] * 100}%` }} /><span style={{ width: `${room.rating.expectedShares[1] * 100}%` }} /></div><div className="rating-share-labels">{teams.map((team) => <span className={`rating-team-${team.id}`} key={team.id}>{team.name} · {team.totalPlayers} 人<strong>{formatShare(room.rating!.expectedShares[team.id])}</strong></span>)}</div><p>这是得分占比预期，非胜率。人数越多，预期通常越高；本局胜负仍按原积分判断。</p></section>;
}
function RatingSettlement({ room, playerId, isSpectator }: { room: Room; playerId?: string; isSpectator: boolean }) {
  const result = room.ratingResult;
  const mine = result?.changes.find((change) => change.playerId === playerId);
  const noRatingMessage = result?.reason === "no_words" ? "本局双方均为 0 分，不调整 Rating，也不计入已计分对局。" : result?.reason === "invalid_roster" ? "本局参赛信息不完整，不调整 Rating。" : "本局开局时尚未记录 Rating，不补算历史对局。";
  return <section className="rating-settlement" aria-labelledby="rating-result-title"><div className="rating-result-heading"><div><span className="eyebrow">TEAM RATING</span><h2 id="rating-result-title">{result?.rated ? "本局 Rating 结算" : "本局未计 Rating"}</h2></div>{result?.rated && mine && <div className={`rating-my-change ${mine.delta > 0 ? "rating-gain" : mine.delta < 0 ? "rating-loss" : "rating-neutral"}`}><span>你的变化</span><strong>{formatDelta(mine.delta)}</strong></div>}</div>{result?.rated ? <>{result.expectedShares && result.actualShares && <div className="rating-result-shares">{([0, 1] as const).map((teamId) => <div key={teamId} className={`rating-team-${teamId}`}><strong>{teamId === 0 ? "橙队" : "蓝队"}</strong><span>预期 <b>{formatShare(result.expectedShares![teamId])}</b><ArrowRight size={13} />实际 <b>{formatShare(result.actualShares![teamId])}</b></span></div>)}</div>}<div className="rating-changes" role="table" aria-label="每位玩家本局 Rating 变化"><div className="rating-change-row rating-change-head" role="row"><span role="columnheader">参赛玩家</span><span role="columnheader">开局 Rating</span><span role="columnheader">本局变化</span></div>{result.changes.map((change) => <div key={change.playerId} className={`rating-change-row ${change.playerId === playerId ? "rating-change-mine" : ""}`} role="row"><span className={`rating-team-${change.teamId}`} role="cell"><i aria-hidden="true" />{room.players.find((player) => player.id === change.playerId)?.name ?? "玩家"}{change.playerId === playerId && <small>你</small>}</span><span role="cell">{change.startRating}</span><strong role="cell" className={change.delta > 0 ? "rating-gain" : change.delta < 0 ? "rating-loss" : "rating-neutral"}>{formatDelta(change.delta)}</strong></div>)}</div><p className="rating-result-note">按实际得分占比与预期的差值调分，同队均分变化。少人队小负也可能加分。{isSpectator ? "旁观不影响你的 Rating。" : "当前 Rating 可在右上角账号中查看。"}</p></> : <p className="rating-result-note">{noRatingMessage}{isSpectator ? "旁观不影响你的 Rating。" : ""}</p>}</section>;
}
function readRecentBoards(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_BOARDS_KEY) ?? "[]");
    return Array.isArray(saved) ? [...new Set(saved.filter((board): board is string => typeof board === "string" && /^[A-Z]{16}$/.test(board)))].slice(-32) : [];
  } catch { return []; }
}
function rememberBoard(board: string[]) {
  const signature = board.join("");
  if (!/^[A-Z]{16}$/.test(signature)) return;
  try { localStorage.setItem(RECENT_BOARDS_KEY, JSON.stringify([...readRecentBoards().filter((item) => item !== signature), signature].slice(-32))); } catch { /* Private browsing may disable storage; room history still works. */ }
}

function Modal({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="modal" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-content"><button className="icon-button modal-close" aria-label="关闭" onClick={onClose}><X size={20} /></button><h2>{title}</h2>{children}</div>
  </dialog>;
}

function extendPath(current: number[], index: number) {
  const last = current[current.length - 1];
  if (last === index) return current;
  if (current.length > 1 && current[current.length - 2] === index) return current.slice(0, -1);
  if (current.includes(index) || (last !== undefined && (Math.abs(Math.floor(last / 4) - Math.floor(index / 4)) > 1 || Math.abs(last % 4 - index % 4) > 1))) return current;
  return [...current, index];
}

function LetterBoard({ board, path, disabled, preview = false, rotation = 0, rotating = false, tileHints, onSelect, onReset, onRelease, onRotationEnd }: { board: string[]; path: number[]; disabled: boolean; preview?: boolean; rotation?: number; rotating?: boolean; tileHints?: TileHints; onSelect?: (index: number) => void; onReset?: () => void; onRelease?: (path: number[]) => void; onRotationEnd?: () => void }) {
  const gesture = useRef<{ pointerId: number; path: number[]; previous: DragPoint; targets: DragTarget[] } | null>(null);
  const cancelGesture = useCallback(() => { if (!gesture.current) return; gesture.current = null; onReset?.(); }, [onReset]);
  useEffect(() => { if (disabled || rotating) cancelGesture(); }, [disabled, rotating, cancelGesture]);
  useEffect(() => { window.addEventListener("blur", cancelGesture); window.addEventListener("resize", cancelGesture); return () => { window.removeEventListener("blur", cancelGesture); window.removeEventListener("resize", cancelGesture); }; }, [cancelGesture]);
  const points = path.map((index) => rotateIndex(index, rotation)).map((index) => `${(index % 4) * 100 + 50},${Math.floor(index / 4) * 100 + 50}`).join(" ");
  const getIndex = (target: EventTarget | null) => { const tile = target instanceof Element ? target.closest<HTMLElement>("[data-tile]") : null; return tile ? Number(tile.dataset.tile) : null; };
  const moveGesture = (root: HTMLDivElement, clientX: number, clientY: number) => {
    const active = gesture.current;
    if (!active) return;
    const bounds = root.getBoundingClientRect();
    const point = { x: clientX - bounds.left, y: clientY - bounds.top };
    for (const index of traceDragSegment(active.previous, point, active.targets)) {
      const next = extendPath(active.path, index);
      if (next !== active.path) { active.path = next; onSelect?.(index); }
    }
    active.previous = point;
  };
  return <div className={`letter-board ${preview ? "preview-board" : ""} ${disabled && !preview ? "board-disabled" : ""} ${rotating ? "board-turning" : ""}`} aria-label={preview ? "规则演示棋盘" : "4 行 4 列字母棋盘"} aria-busy={rotating || undefined}
    onAnimationEnd={(event) => { if (event.target === event.currentTarget && event.animationName === "board-quarter-turn") onRotationEnd?.(); }}
    onPointerDown={(event) => {
      if (disabled || rotating || event.button !== 0 || gesture.current) return;
      const index = getIndex(event.target); if (index === null) return;
      event.preventDefault();
      const root = event.currentTarget;
      const bounds = root.getBoundingClientRect();
      const targets = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tile]")).map(tile => ({
        index: Number(tile.dataset.tile), x: tile.offsetLeft + tile.offsetWidth / 2, y: tile.offsetTop + tile.offsetHeight / 2,
        radius: Math.min(tile.offsetWidth, tile.offsetHeight) * DRAG_HIT_RADIUS,
      }));
      gesture.current = { pointerId: event.pointerId, path: [index], previous: { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, targets };
      root.setPointerCapture(event.pointerId); onReset?.(); onSelect?.(index);
    }}
    onPointerMove={(event) => { if (gesture.current?.pointerId === event.pointerId && !disabled) moveGesture(event.currentTarget, event.clientX, event.clientY); }}
    onPointerUp={(event) => { const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return; if (!disabled) moveGesture(event.currentTarget, event.clientX, event.clientY); gesture.current = null; onReset?.(); if (!disabled) onRelease?.(active.path); }}
    onPointerCancel={(event) => { if (gesture.current?.pointerId === event.pointerId) cancelGesture(); }}
    onLostPointerCapture={(event) => { if (gesture.current?.pointerId === event.pointerId) cancelGesture(); }}>
    <svg className="board-path" viewBox="0 0 400 400" aria-hidden="true"><polyline points={points} fill="none" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" /></svg>
    {displayedBoardIndices(rotation).map((index, position) => { const letter = board[index]; const unused = tileHints?.usable[index] === false; const starts = tileHints?.unlocked ? tileHints.starts?.[index] : undefined; return <button key={index} type="button" data-tile={index} data-unused={unused || undefined} className={`letter-tile ${unused ? "tile-unused" : ""} ${path.includes(index) ? "selected" : ""} ${path[path.length - 1] === index ? "last-tile" : ""}`} disabled={disabled || rotating} aria-label={`${letter}，第 ${Math.floor(position / 4) + 1} 行第 ${position % 4 + 1} 列${starts !== undefined ? `，${starts} 个剩余计分词的标准连法从此格开始` : ""}${unused ? "，剩余普通词的标准连法不再使用此格，仍可划选" : ""}`} aria-pressed={path.includes(index)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(index); } }}>
      {path.includes(index) && <span className="tile-order" aria-hidden="true">{path.indexOf(index) + 1}</span>}<span>{letter}</span>{starts !== undefined && <span className={`tile-start-count ${starts === 0 ? "tile-start-zero" : ""}`} aria-hidden="true" title={`${starts} 个剩余计分词的标准连法从此格开始`}>{starts}</span>}{letter === "QU" && <span className="tile-value">2</span>}
    </button>; })}
  </div>;
}

function TeamPanel({ team, players, hostId, playerId, words, roomStatus, onCommit, busy, commitQueued = false }: { team: Team; players: Player[]; hostId?: string; playerId?: string; words: FoundWord[]; roomStatus: Room["status"]; onCommit?: () => void; busy: boolean; commitQueued?: boolean }) {
  const members = players.filter((player, index) => playerTeam(player, index) === team.id);
  const me = members.find((player) => player.id === playerId);
  return <section className={`team-panel player-${team.id} ${me ? "your-team" : ""} ${roomStatus === "waiting" ? "team-panel-waiting" : ""}`} aria-label={`${team.name}，${members.length} 人，${team.score} 分`}>
    <div className="team-heading"><div><span className="team-color-dot" /><h2>{team.name}</h2>{me && <span className="you-badge">你的队伍</span>}</div><span>{members.length} 人</span></div>
    {roomStatus !== "waiting" && <div className="team-score"><strong key={team.score}>{team.score}</strong><span>团队总分</span><span className={`team-commit-state ${team.committed ? "team-all-committed" : ""}`}>{team.committed ? <CheckCheck size={14} /> : <Flag size={13} />}{team.committedCount}/{team.totalPlayers} Commit</span></div>}
    <ul className="team-members">{members.length ? members.map((player) => <li key={player.id} className={player.id === playerId ? "member-is-you" : ""}><div className="team-member-name"><span className="avatar">{player.name.slice(0, 1).toUpperCase()}</span><span>{player.name}{player.id === playerId && <small>你</small>}{player.id === hostId && <small className="host-badge">房主</small>}{typeof player.rating === "number" && <span className="member-rating" title={`${player.ratedGames ?? 0} 局已计分对局`}>{roomStatus === "waiting" ? "Rating" : "开局"} {player.rating}</span>}</span></div><div className="team-member-score"><strong>{player.score}<small> 分</small></strong>{roomStatus !== "waiting" && <span>{roomStatus === "finished" ? "已结束" : player.committed ? "已 Commit" : "寻找中"}</span>}</div></li>) : <li className="team-empty"><Users size={19} /><span>等待朋友加入</span></li>}</ul>
    {me && roomStatus === "playing" && <div className="commit-area"><button className={`commit-button ${me.committed ? "is-committed" : ""}`} onClick={onCommit} disabled={busy || me.committed}>{me.committed ? <CheckCheck size={16} /> : <Flag size={15} />}{me.committed ? "你已 Commit" : commitQueued ? busy ? "正在 Commit…" : "重试 Commit" : "Commit · 不可撤回"}</button><p>{me.committed ? team.committed ? "全队已交卷，留意结算倒计时" : "你已停止选词，队友仍可继续" : commitQueued ? "已停止选词，等待确认" : "个人交卷后停止选词；全队交卷才开始 60 秒结算"}</p></div>}
    {roomStatus !== "waiting" && <><div className="word-list-heading"><span>全队找到的单词</span><span>{words.length.toString().padStart(2, "0")}</span></div><div className="team-word-list" aria-live="polite" aria-relevant="additions">{words.length ? [...words].reverse().map((item) => <div className={`found-word ${item.bonus ? "bonus-word" : ""}`} key={`${item.word}-${item.at}`}><span><strong>{item.word.toUpperCase()}{item.bonus && <Sparkles size={12} aria-label="附加词" />}</strong><small>{players.find((player) => player.id === item.playerId)?.name ?? "玩家"}</small></span><b>{item.bonus ? `+${item.points} BONUS` : `+${item.points}`}</b></div>) : <p className="team-no-words">第一个好词，还在路上。</p>}</div></>}
  </section>;
}

function SolutionGroup({ title, solutions, claimedWords, players, selectedWord, onSelect }: { title: string; solutions: Solution[]; claimedWords: Map<string, FoundWord>; players: Player[]; selectedWord: string | null; onSelect: (word: string) => void }) {
  const foundCount = solutions.filter((solution) => claimedWords.has(solution.word.toLowerCase())).length;
  return <section className="solution-group" aria-label={title}>
    <div className="solution-group-heading"><h3>{title}<span>{solutions.length} 个</span></h3><span>已找到 {foundCount} · 漏找 {solutions.length - foundCount}</span></div>
    {solutions.length ? <div className="solution-grid">{solutions.map((solution) => {
      const claim = claimedWords.get(solution.word.toLowerCase());
      const found = !!claim;
      const owner = claim ? players.find((player) => player.id === claim.playerId) : undefined;
      const ownerIndex = claim ? wordTeam(claim, players) : -1;
      const ownerName = owner?.name ?? "玩家";
      const selected = selectedWord === solution.word;
      return <button key={solution.word} type="button" className={`solution-word ${found ? `solution-found solution-player-${ownerIndex}` : "solution-missed"} ${selected ? "solution-selected" : ""}`} aria-pressed={selected} aria-label={`${solution.word.toUpperCase()}，${solution.bonus ? `附加词，${solution.points} 分` : `${solution.points} 分`}，${found ? `${ownerName} 找到` : "漏找"}，查看标准连法`} onClick={() => onSelect(solution.word)}><span className="solution-word-main"><strong>{solution.word.toUpperCase()}</strong><span>{solution.points} 分</span></span><span className="solution-word-status">{found && <Check size={11} />}{found ? `${ownerName} 找到` : "漏找"}</span></button>;
    })}</div> : <p className="solution-empty">本局没有附加词。</p>}
  </section>;
}

export default function Home() {
  const account = useAccount();
  const [room, setRoom] = useState<Room | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<"create" | "join">("create");
  const [wordCount, setWordCount] = useState<WordCount>("any");
  const [joinCode, setJoinCode] = useState(""); const [accountOpenRequest, setAccountOpenRequest] = useState(0);
  const [joinRole, setJoinRole] = useState<"orange" | "blue" | "spectator">("blue");
  const [busy, setBusy] = useState(false); const [restoring, setRestoring] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [commitQueued, setCommitQueued] = useState(false); const commitRequested = useRef(false);
  const [pendingWordCount, setPendingWordCount] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [rotating, setRotating] = useState(false);
  const [gameFlash, setGameFlash] = useState<GameFlash | null>(null);
  const [path, setPath] = useState<number[]>([]);
  const [selectedSolutionWord, setSelectedSolutionWord] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null); const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(true); const [now, setNow] = useState(0);
  const serverOffset = useRef(0); const requestNumber = useRef(0); const appliedRequest = useRef(0); const currentRound = useRef<number | null>(null); const currentRoomCode = useRef<string | null>(null);
  const mutationPending = useRef(false); const boardPanelRef = useRef<HTMLElement>(null);
  const snapshotRef = useRef<Room | null>(null); const actionQueue = useRef(createActionQueue());
  const pendingWords = useRef(new Set<string>()); const pendingActions = useRef(0);
  const identityGeneration = useRef(0); const previousAccountToken = useRef<string | null | undefined>(undefined);
  const resetRoom = useCallback((clearRoomLink = true) => {
    identityGeneration.current++; appliedRequest.current = ++requestNumber.current;
    currentRoomCode.current = null; currentRound.current = null; snapshotRef.current = null;
    commitRequested.current = false; pendingWords.current = new Set(); pendingActions.current = 0;
    mutationPending.current = false; actionQueue.current = createActionQueue();
    setCommitQueued(false); setPendingWordCount(0); setBusy(false); setRestoring(false);
    setRoom(null); setSession(null); setPath([]); setSelectedSolutionWord(null); setNotice(null); setGameFlash(null); setConnected(true);
    if (clearRoomLink) window.history.replaceState({}, "", window.location.pathname);
  }, []);
  const applySnapshot = useCallback((data: Snapshot, requestId: number, generation: number) => {
    if (generation !== identityGeneration.current || requestId < appliedRequest.current) return;
    appliedRequest.current = requestId;
    const previous = snapshotRef.current;
    const sameRound = previous?.round === data.room.round && previous?.code === data.room.code;
    if (!sameRound) {
      rememberBoard(data.room.board);
      currentRound.current = data.room.round; currentRoomCode.current = data.room.code;
      setPath([]); setSelectedSolutionWord(null); setRotation(0); setRotating(false); setGameFlash(null); setBusy(false);
      commitRequested.current = false; setCommitQueued(false);
    } else {
      if (previous.status === "waiting" && data.room.status !== "waiting") rememberBoard(data.room.board);
      const seen = new Set(previous.words.map((item) => item.word));
      const additions: GameFlash[] = data.room.words.filter((item) => !seen.has(item.word)).map((item) => ({ ...item, kind: "word", id: `${data.room.round}-word-${item.word}`, name: data.room.players.find((player) => player.id === item.playerId)?.name ?? "玩家", mine: item.playerId === data.playerId, teamId: wordTeam(item, data.room.players) }));
      const nextTeams = roomTeams(data.room);
      for (const [index, player] of data.room.players.entries()) {
        const teamId = playerTeam(player, index); const team = nextTeams[teamId];
        if (player.committed && !previous.players.find((old) => old.id === player.id)?.committed) additions.push({ kind: "commit", id: `${data.room.round}-commit-${player.id}`, at: player.committedAt ?? data.serverNow ?? Date.now(), name: player.name, mine: player.id === data.playerId, teamId, committedCount: team.committedCount, totalPlayers: team.totalPlayers });
      }
      for (const team of nextTeams) if (team.committed && !roomTeams(previous).find((old) => old.id === team.id)?.committed) additions.push({ kind: "team-commit", id: `${data.room.round}-team-commit-${team.id}`, at: team.committedAt ?? data.serverNow ?? Date.now(), name: team.name, mine: false, teamId: team.id });
      // A new event replaces the current notice immediately, including its timer.
      const latestEvent = additions.sort((a, b) => a.at - b.at || ({ word: 0, commit: 1, "team-commit": 2 }[a.kind] - { word: 0, commit: 1, "team-commit": 2 }[b.kind])).at(-1);
      if (latestEvent) setGameFlash(latestEvent);
      if (data.room.status !== "playing" || data.room.players.find((player) => player.id === data.playerId)?.committed) setPath([]);
    }
    snapshotRef.current = data.room; setRoom(data.room);
    if (data.serverNow) serverOffset.current = data.serverNow - Date.now();
    setNow(Date.now() + serverOffset.current); setConnected(true);
  }, []);

  const accountToken = account.session?.token ?? null;
  const accountReady = !account.loading && !account.working && !account.restoreError;
  const requireLogin = useCallback(() => {
    resetRoom(false); previousAccountToken.current = null; account.clearCredential();
    const code = new URLSearchParams(window.location.search).get("room")?.toUpperCase().trim();
    if (code) { setJoinCode(code); setMode("join"); }
    setNotice({ text: "登录已失效，请重新登录后继续。", tone: "error" });
  }, [account.clearCredential, resetRoom]);
  useEffect(() => {
    if (!account.loading && !account.session && currentRoomCode.current) resetRoom(false);
    if (!accountReady) return;
    if (previousAccountToken.current !== undefined && previousAccountToken.current !== accountToken) resetRoom(false);
    previousAccountToken.current = accountToken;
  }, [accountReady, accountToken, account.loading, account.session, resetRoom]);

  useEffect(() => {
    if (!accountReady) return;
    let cancelled = false;
    const hydrate = setTimeout(() => {
      const code = new URLSearchParams(window.location.search).get("room")?.toUpperCase().trim();
      if (!code) return; setJoinCode(code); setMode("join");
      const token = accountToken; if (!token) return;
      const generation = identityGeneration.current;
      setRestoring(true); const requestId = ++requestNumber.current;
      fetch(apiUrl(`/api/game?code=${encodeURIComponent(code)}`), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(12_000) }).then(async (response) => {
        const data = await response.json() as Snapshot;
        if (cancelled || generation !== identityGeneration.current) return;
        if (!response.ok) {
          // A valid account may be following an invitation for the first time.
          if (response.status === 401 || response.status === 403) {
            const validation = await fetch(apiUrl("/api/account"), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(12_000) });
            if (!cancelled && generation === identityGeneration.current && validation.status === 401) requireLogin();
            else if (!validation.ok) throw new Error("暂时无法验证账号，请稍后重试。");
            return;
          }
          throw new Error(data.error ?? "暂时无法连接房间，请重试。");
        }
        setSession({ token, playerId: data.playerId }); applySnapshot(data, requestId, generation);
      }).catch((error: Error) => { if (!cancelled && generation === identityGeneration.current) setNotice({ text: error.name === "TimeoutError" ? "房间连接超时，请重试。" : error.message, tone: "error" }); }).finally(() => { if (!cancelled && generation === identityGeneration.current) setRestoring(false); });
    }, 0);
    return () => { cancelled = true; clearTimeout(hydrate); };
  }, [accountReady, accountToken, applySnapshot, requireLogin]);

  const refreshedRatingRound = useRef<string | null>(null);
  const finishedRatingRound = room?.status === "finished" ? `${room.code}-${room.round}` : null;
  const refreshProfile = account.refreshProfile;
  useEffect(() => {
    if (!finishedRatingRound || !accountToken || refreshedRatingRound.current === `${accountToken}:${finishedRatingRound}`) return;
    refreshedRatingRound.current = `${accountToken}:${finishedRatingRound}`;
    void refreshProfile();
  }, [finishedRatingRound, accountToken, refreshProfile]);

  const roomCode = room?.code;
  const sessionToken = session?.token;
  useEffect(() => {
    if (!roomCode || !sessionToken) return;
    const generation = identityGeneration.current;
    let cancelled = false; let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => { if (!mutationPending.current) { const requestId = ++requestNumber.current; try { const response = await fetch(apiUrl(`/api/game?code=${encodeURIComponent(roomCode)}`), { headers: { Authorization: `Bearer ${sessionToken}` }, cache: "no-store", signal: AbortSignal.timeout(12_000) }); const data = await response.json() as Snapshot; if (!cancelled && generation === identityGeneration.current && response.status === 401) { requireLogin(); return; } if (!response.ok) throw new Error(data.error); if (!cancelled) applySnapshot(data, requestId, generation); } catch { if (!cancelled && generation === identityGeneration.current) setConnected(false); } } if (!cancelled && generation === identityGeneration.current) timeout = setTimeout(poll, 1000); };
    timeout = setTimeout(poll, 1000); return () => { cancelled = true; clearTimeout(timeout); };
  }, [roomCode, sessionToken, applySnapshot, requireLogin]);
  useEffect(() => { if (!roomCode) return; const interval = setInterval(() => setNow(Date.now() + serverOffset.current), 250); return () => clearInterval(interval); }, [roomCode]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(null), notice.tone === "error" ? 6000 : 3500); return () => clearTimeout(timeout); }, [notice]);
  const activeFlashId = gameFlash?.id;
  useEffect(() => { if (!activeFlashId) return; const timeout = setTimeout(() => setGameFlash((current) => current?.id === activeFlashId ? null : current), 2800); return () => clearTimeout(timeout); }, [activeFlashId]);
  useEffect(() => { if (!copied) return; const timeout = setTimeout(() => setCopied(false), 2500); return () => clearTimeout(timeout); }, [copied]);
  useEffect(() => {
    if (!rotating) return;
    // Also release the brief input guard if a background tab skips animationend.
    const timeout = setTimeout(() => setRotating(false), 450);
    return () => clearTimeout(timeout);
  }, [rotating]);

  const me = room?.players.find((player) => player.id === session?.playerId);
  const spectators = room?.spectators ?? [];
  const isSpectator = !me && spectators.some((player) => player.id === session?.playerId);
  const isHost = !!session && (room?.hostId ?? room?.players[0]?.id) === session.playerId;
  const teams = room ? roomTeams(room) : [];
  const myTeamId = me && room ? playerTeam(me, room.players.indexOf(me)) : undefined;
  const canPlay = room?.status === "playing" && !!me && !me.committed && !commitQueued && connected && accountReady && !!account.session;
  const word = room ? path.map((index) => room.board[index]).join("") : "";
  const secondsLeft = room?.deadline ? Math.max(0, Math.ceil((room.deadline - now) / 1000)) : 180;
  const timeLabel = `${Math.floor(secondsLeft / 60).toString().padStart(2, "0")}:${(secondsLeft % 60).toString().padStart(2, "0")}`;
  const inactivityDeadline = (room?.lastWordAt ?? room?.startedAt ?? now) + 180_000;
  const hasCommitDeadline = room?.commitDeadline != null;
  const commitTimer = room?.commitDeadline != null && room.commitDeadline <= inactivityDeadline;
  const timerProgress = Math.min(100, Math.max(0, secondsLeft / (commitTimer ? 60 : 180) * 100));
  const isDraw = room?.status === "finished" && teams[0]?.score === teams[1]?.score;
  const winner = room?.status === "finished" && !isDraw ? teams[teams[0].score > teams[1].score ? 0 : 1] : undefined;
  const won = myTeamId !== undefined && winner?.id === myTeamId;
  const foundWords = room ? Math.min(room.totalWords, room.foundWords ?? room.words.filter((found) => !found.bonus).length) : 0;
  const remainingWords = room ? Math.max(0, room.remainingWords ?? room.totalWords - foundWords) : 0;
  const wordProgress = room?.totalWords ? (foundWords / room.totalWords) * 100 : 0;
  const selectedSolution = room?.status === "finished" ? room.solutions?.find((solution) => solution.word === selectedSolutionWord) : undefined;
  const regularSolutions = room?.status === "finished" ? room.solutions?.filter((solution) => !solution.bonus) ?? [] : [];
  const bonusSolutions = room?.status === "finished" ? room.solutions?.filter((solution) => solution.bonus) ?? [] : [];
  const claimedWords = new Map(room?.words.map((found) => [found.word.toLowerCase(), found] as const) ?? []);

  const submitLobby = async (event: FormEvent) => {
    event.preventDefault(); if (!accountReady || busy || restoring) return;
    if (!account.session) { setAccountOpenRequest((value) => value + 1); return; }
    if (mode === "join" && !joinCode.trim()) { setNotice({ text: "请输入朋友分享的房间码。", tone: "error" }); return; }
    const generation = identityGeneration.current;
    setBusy(true); mutationPending.current = true; const requestId = ++requestNumber.current;
    try { const response = await fetch(apiUrl("/api/game"), { method: "POST", headers: { "Content-Type": "application/json", ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : {}) }, body: JSON.stringify({ action: mode, ...(mode === "join" ? { code: joinCode.trim().toUpperCase(), role: joinRole === "spectator" ? "spectator" : "player", ...(joinRole !== "spectator" ? { teamId: joinRole === "orange" ? 0 : 1 } : {}) } : { wordCount, recentBoards: readRecentBoards().reverse() }) }), signal: AbortSignal.timeout(20_000) }); const data = await response.json() as Snapshot; if (generation !== identityGeneration.current) return; if (response.status === 401) { requireLogin(); return; } if (!response.ok || !data.token) throw new Error(data.error ?? "房间创建失败，请稍后重试。"); const nextSession = { token: data.token, playerId: data.playerId }; setSession(nextSession); applySnapshot(data, requestId, generation); const url = new URL(window.location.href); url.searchParams.set("room", data.room.code); window.history.replaceState({}, "", url); setNotice(null); }
    catch (error) { if (generation === identityGeneration.current) setNotice({ text: error instanceof Error && error.name !== "TimeoutError" ? error.message : "连接超时，请稍后重试。", tone: "error" }); } finally { if (generation === identityGeneration.current) { setBusy(false); mutationPending.current = false; } }
  };
  const mutateRoom = async (action: "word" | "commit" | "rematch" | "start" | "team", extra: Record<string, unknown> = {}) => {
    if (!room || !session || busy || !accountReady || !account.session) return;
    if (action === "word" && (!canPlay || commitRequested.current)) return;
    if (action === "commit" && me?.committed) return;
    const { code, round } = room;
    const generation = identityGeneration.current;
    const wordKey = `${code}-${round}-${String(extra.word).trim().toUpperCase()}`;
    if (action === "word" && pendingWords.current.has(wordKey)) return;
    if (action === "word") {
      pendingWords.current.add(wordKey); setPendingWordCount(pendingWords.current.size);
      // Release immediately; an older response must never erase the next word.
      setPath([]);
    } else {
      setBusy(true);
      if (action === "commit") { commitRequested.current = true; setCommitQueued(true); setPath([]); }
    }
    pendingActions.current++; mutationPending.current = true;
    const stillHere = () => generation === identityGeneration.current && currentRoomCode.current === code && currentRound.current === round;
    try {
      await actionQueue.current.run(async () => {
        const latest = snapshotRef.current;
        if (!stillHere() || !latest || ((action === "word" || action === "commit") && latest.status !== "playing") || ((action === "start" || action === "team") && latest.status !== "waiting") || (action === "rematch" && latest.status !== "finished")) return;
        const requestId = ++requestNumber.current;
        const response = await fetch(apiUrl("/api/game"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ action, code, round, ...extra }), signal: AbortSignal.timeout(15_000) });
        const data = await response.json() as Snapshot;
        if (!stillHere()) return;
        if (response.status === 401) { requireLogin(); return; }
        if (!response.ok) throw new Error(data.error ?? "操作失败，请稍后重试。");
        applySnapshot(data, requestId, generation);
        if (data.message && action === "word" && !data.room.words.some((item) => item.word === String(extra.word).trim().toUpperCase() && item.playerId === session.playerId)) setNotice({ text: data.message, tone: "info" });
      });
    } catch (error) {
      if (stillHere()) setNotice({ text: error instanceof Error && error.name === "TimeoutError" ? "请求超时，正在重新同步。可在同步后重试；已选择的 Commit 不可取消。" : error instanceof Error ? error.message : "连接失败，请稍后重试。", tone: "error" });
    } finally {
      if (generation !== identityGeneration.current) return;
      pendingActions.current--; mutationPending.current = pendingActions.current > 0;
      if (action === "word") { pendingWords.current.delete(wordKey); setPendingWordCount(pendingWords.current.size); }
      else if (stillHere()) {
        setBusy(false);
        // Keep the local surrender intent even if its acknowledgement is lost.
        if (action === "commit" && snapshotRef.current?.players.find((player) => player.id === session.playerId)?.committed) setCommitQueued(false);
      }
    }
  };
  const clearSelection = useCallback(() => { setPath([]); }, []);
  const selectTile = useCallback((index: number) => { if (!canPlay || commitRequested.current) return; setPath((current) => extendPath(current, index)); }, [canPlay]);
  const releaseSelection = (selectedPath: number[]) => {
    clearSelection();
    if (!canPlay || commitRequested.current || !room || selectedPath.length < 4) return;
    const selectedWord = selectedPath.map((index) => room.board[index]).join("");
    void mutateRoom("word", { word: selectedWord, path: selectedPath });
  };
  const copyInvite = async () => { if (!room) return; const url = new URL(window.location.pathname, window.location.origin); url.searchParams.set("room", room.code); try { await navigator.clipboard.writeText(url.toString()); setCopied(true); } catch { setNotice({ text: `房间码 ${room.code} · 可从地址栏复制邀请链接`, tone: "info" }); } };
  const showSolution = (solutionWord: string) => { if (room?.status !== "finished" || !room.solutions?.some((solution) => solution.word === solutionWord)) return; setSelectedSolutionWord(solutionWord); requestAnimationFrame(() => boardPanelRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })); };
  const rotateBoard = () => { if (rotating) return; clearSelection(); setRotating(true); setRotation((value) => (value + 1) % 4); };
  const goToLobby = () => resetRoom();

  return <div className={`app-shell ${room ? "in-room" : "in-lobby"}`}>
    <header className="site-header"><button className="brand" aria-label="Squares Duel 首页" onClick={room ? goToLobby : undefined}><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span className="brand-word">squares<span className="brand-period">.</span></span><span className="duel-label">DUEL</span></button><nav className="header-actions"><span className="header-tagline">好词，值得一场较量。</span><AccountMenu account={account} inRoom={!!room} disabled={busy || restoring || !accountReady} onReturnToLobby={goToLobby} requestOpen={accountOpenRequest} /><Leaderboard token={accountToken} disabled={!accountReady} onLogin={() => setAccountOpenRequest((value) => value + 1)} /><button className="rules-button" onClick={() => setRulesOpen(true)}><HelpCircle size={17} /><span>怎么玩</span></button></nav></header>
    {!room || !account.session ? <main className="lobby-main"><section className="lobby-hero"><div className="hero-content"><div className="eyebrow"><span className="eyebrow-line" /> THE TEAM WORD GAME</div><h1>一个棋盘。<br />两队<span className="hero-accent">灵感<span className="accent-spark">✳</span></span>。</h1><p className="hero-description">和队友共享 16 个字母，抢先找到藏在其中的英文单词。<br className="desktop-break" />同一个词，只有先找到的人得分。</p>
      <form className="lobby-form" onSubmit={submitLobby}>{account.restoreError && <div className="account-restore-error" role="alert"><p>{account.restoreError}</p><div><button type="button" onClick={() => void account.restore()}>重新验证账号</button><button type="button" onClick={() => { account.clearCredential(); setAccountOpenRequest((value) => value + 1); }}>清除旧登录并重新登录</button></div></div>}<div className="form-tabs" role="tablist" aria-label="选择开始方式"><button type="button" role="tab" aria-selected={mode === "create"} className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>创建房间</button><button type="button" role="tab" aria-selected={mode === "join"} className={mode === "join" ? "active" : ""} onClick={() => setMode("join")}>加入朋友</button></div>{account.session ? <><label className="field-label" htmlFor="player-name">账号身份 <span>跨设备保留房间身份</span></label><div className="name-input-wrap"><span className="input-avatar"><Users size={17} /></span><input id="player-name" value={account.session.user.username} autoComplete="username" readOnly disabled={busy || restoring || !accountReady} /></div></> : <div className="lobby-login-required"><span><Users size={19} /></span><div><strong>登录后，开始这场较量</strong><p>创建房间、加入队伍和旁观都需要账号。</p></div></div>}{mode === "create" && <div className="word-count-field"><label className="field-label" htmlFor="word-count">计分词数量<span>大致控制每局词量</span></label><select id="word-count" value={wordCount} onChange={(event) => setWordCount(event.target.value as WordCount)} aria-describedby="word-count-hint" disabled={busy || restoring || !accountReady}>{Object.entries(WORD_COUNT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><p id="word-count-hint">每局随机生成字母并核对完整词表；附加词另计，每词 +1 分。</p></div>}{mode === "join" && <div className="join-code-field"><label className="field-label" htmlFor="room-code">房间码</label><input id="room-code" className="room-code-input" placeholder="输入朋友的房间码" value={joinCode} onChange={(event) => setJoinCode(event.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase())} maxLength={8} autoComplete="off" required={!!account.session} disabled={busy || restoring || !accountReady} /></div>}{mode === "join" && <fieldset className="join-role-field"><legend>以什么身份加入？</legend><div className="join-role-options">{([{ value: "orange", label: "橙队", icon: <Users size={15} /> }, { value: "blue", label: "蓝队", icon: <Users size={15} /> }, { value: "spectator", label: "旁观", icon: <Eye size={15} /> }] as const).map((option) => <label key={option.value} className={`join-role-option join-role-${option.value} ${joinRole === option.value ? "role-selected" : ""}`}><input type="radio" name="join-role" value={option.value} checked={joinRole === option.value} disabled={busy || restoring || !accountReady} onChange={() => setJoinRole(option.value)} />{option.icon}<span>{option.label}</span></label>)}</div><p>比赛开始后仅可旁观；开局前可在房间内换队。</p></fieldset>}<button type="submit" className="primary-button lobby-start" disabled={busy || restoring || !accountReady}>{busy || restoring || account.loading ? <><LoaderCircle size={19} className="spin" />{account.loading ? "正在验证账号…" : restoring ? "正在回到房间…" : "正在连接…"}</> : <>{!account.session ? "登录 / 注册，开始游戏" : mode === "create" ? "建个房间，一起组队" : "加入这场较量"}<ArrowUpRight size={20} /></>}</button><p className="form-footnote"><Link2 size={13} />{account.session ? "账号已登录 · 房主手动开始" : "登录后加入队伍 · 也可只做旁观"}</p></form></div>
      <div className="hero-game-preview"><div className="preview-topline"><span><i /> A FRIENDLY RIVALRY</span><span className="preview-label">规则演示</span></div><div className="preview-board-wrap"><LetterBoard board={DEMO_BOARD} path={DEMO_PATH} disabled preview /><div className="preview-word-card"><span className="word-success-icon"><Check size={16} strokeWidth={3} /></span><strong>WORD</strong><span className="preview-word-divider" /><b>+4 <small>分</small></b><span className="preview-card-caption">好词，先到先得。</span></div></div><div className="preview-bottomline"><span className="mini-grid-icon" aria-hidden="true">▦</span><span>横向、纵向、斜向，灵感自由连线。</span><span>4 × 4</span></div><div className="preview-note"><span className="note-arrow">↖</span> 你的下一个词，藏在这里。</div></div></section>
      <section className="quick-rules" aria-label="三步开始"><div className="quick-rule"><span className="quick-rule-number">01</span><div><h2>连起来，就是好词</h2><p>相邻字母自由连接，至少 4 个字母。</p></div></div><div className="quick-rule"><span className="quick-rule-number">02</span><div><h2>抢先找到，独享得分</h2><p>每个字母 1 分，已被找到的词不能再用。</p></div></div><div className="quick-rule"><span className="quick-rule-number">03</span><div><h2>计分词找完，即刻结算</h2><p>整队 Commit 后 60 秒、两队交卷或 3 分钟无新词结束。</p></div></div></section></main> : <main className="room-main">
      <div className="room-topline"><button className="back-button" onClick={goToLobby}><ArrowLeft size={15} />大厅</button><div className="room-code-pill"><span>房间</span><strong>{room.code}</strong><button aria-label="复制邀请链接" onClick={() => void copyInvite()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div><div className={`connection-status ${connected ? "" : "disconnected"}`}><i />{connected ? "实时同步" : "正在重新连接"}</div></div>
      <div className="room-title-row"><div><p className="eyebrow">ROUND {String(room.round).padStart(2, "0")} <span> / </span> SQUARES DUEL</p><h1>{room.status === "waiting" ? "好词，和队友一起找。" : room.status === "finished" ? isDraw ? "平分秋色，都是好词。" : `${winner?.name}，赢得这一场。` : "让好词，抢先一步。"}</h1></div><div className={`round-label ${room.status === "playing" ? "live-round" : ""}`}>{isSpectator && <span className="spectating-label"><Eye size={14} />旁观中</span>}{room.status === "playing" ? <><i />对局进行中</> : room.status === "finished" ? <><Flag size={14} />本局已结束</> : <><Users size={15} />准备室</>}</div></div>
      {room.status === "finished" && <div className={`result-banner ${won ? "result-won" : ""}`}><div className="result-icon"><Trophy size={23} /></div><div><strong>{isDraw ? "默契与实力，刚好打平。" : `${winner?.name}赢得本局${won ? "，恭喜你们！" : ""}`}</strong><p>{room.endReason === "all_words" ? "所有计分词已找完" : room.endReason === "committed" ? "两队全员都已 Commit" : room.endReason === "commit_timeout" ? "首支队伍全员 Commit 后已满 60 秒" : "连续 3 分钟没有发现新词"} · 橙队 {teams[0].score} : {teams[1].score} 蓝队</p></div><span className="result-total">共找到 <b>{room.words.length}</b> 个词</span></div>}
      {room.status === "finished" && <RatingSettlement room={room} playerId={session?.playerId} isSpectator={isSpectator} />}
      {room.status === "playing" && <RatingExpectation room={room} teams={teams} />}
      {room.status === "waiting" ? <section className="waiting-lobby" aria-label="对局准备室">
        <div className="waiting-lobby-heading"><div><h2>先组好队，再一起开局</h2><p>两队人数可以不同，每队至少 1 人。{isHost ? "准备好后，由你开始比赛。" : "准备好后，等待房主开始。"}</p></div><button className="invite-button" onClick={() => void copyInvite()}>{copied ? <Check size={15} /> : <Link2 size={15} />}{copied ? "已复制" : "邀请朋友"}</button></div>
        <RatingExpectation room={room} teams={teams} />
        <div className="waiting-teams">{teams.map((team) => <TeamPanel key={team.id} team={team} players={room.players} hostId={room.hostId} playerId={session?.playerId} words={[]} roomStatus={room.status} busy={busy} />)}</div>
        <div className="role-picker"><span>你的身份</span><div role="group" aria-label="选择队伍或旁观"><button className={`role-option role-orange ${myTeamId === 0 ? "role-selected" : ""}`} disabled={busy || !connected || myTeamId === 0} onClick={() => void mutateRoom("team", { role: "player", teamId: 0 })}>{myTeamId === 0 && <Check size={14} />}加入橙队</button><button className={`role-option role-blue ${myTeamId === 1 ? "role-selected" : ""}`} disabled={busy || !connected || myTeamId === 1} onClick={() => void mutateRoom("team", { role: "player", teamId: 1 })}>{myTeamId === 1 && <Check size={14} />}加入蓝队</button><button className={`role-option ${isSpectator ? "role-selected" : ""}`} disabled={busy || !connected || isSpectator} onClick={() => void mutateRoom("team", { role: "spectator" })}><Eye size={14} />{isSpectator ? "正在旁观" : "旁观"}</button></div></div>
        <div className="host-start-area">{isHost ? <><button className="primary-button" disabled={busy || !connected || teams.some((team) => team.totalPlayers === 0)} onClick={() => void mutateRoom("start")}>{busy ? <LoaderCircle size={18} className="spin" /> : <Play size={18} />}开始游戏</button><p>{teams.some((team) => team.totalPlayers === 0) ? "两队各有至少 1 位玩家后即可开始" : `${teams[0].totalPlayers} 对 ${teams[1].totalPlayers}，准备好就开始吧`}</p></> : <><div className="waiting-host"><Clock3 size={18} />等待房主开始游戏</div><p>房主：{[...room.players, ...spectators].find((player) => player.id === room.hostId)?.name ?? "房主"} · 开始前可自由换队或旁观</p></>}</div>
      </section> : <div className="game-layout team-game-layout">
        <TeamPanel team={teams[0]} players={room.players} hostId={room.hostId} playerId={session?.playerId} words={room.words.filter((found) => wordTeam(found, room.players) === 0)} roomStatus={room.status} onCommit={() => void mutateRoom("commit")} commitQueued={commitQueued && myTeamId === 0} busy={busy || !connected} />
        <section ref={boardPanelRef} className="board-panel" aria-label="共享棋盘"><div className="board-toolbar"><div className="board-view-controls"><span className="shared-board-label"><span className="small-grid" />共享棋盘</span><button type="button" className="rotate-board-button" disabled={rotating} onClick={rotateBoard} aria-label="顺时针旋转棋盘 90 度" title="旋转只改变你的视角"><RotateCw size={15} /><span>旋转</span></button></div><span className="board-view-note">{isSpectator ? "旁观 · 仅观看" : "各自视角独立"}</span></div>
          <div className={`match-timer ${room.status === "playing" && secondsLeft <= 30 ? "match-timer-urgent" : ""} ${hasCommitDeadline && room.status === "playing" ? "match-timer-commit" : ""} ${room.status === "finished" ? "match-timer-finished" : ""}`} role="timer" aria-label={room.status === "playing" ? `${commitTimer ? "整队 Commit" : "无新词"}结算倒计时 ${timeLabel}` : "本局已结算"}>
            <div className="match-timer-top"><span className="match-timer-icon">{hasCommitDeadline && room.status === "playing" ? <Flag size={22} /> : <Clock3 size={23} />}</span><div><span className="match-timer-label">{room.status === "finished" ? "本局结束" : commitTimer ? "整队 Commit 结算倒计时" : "无新词结算倒计时"}</span><strong>{room.status === "finished" ? "已结算" : timeLabel}</strong></div>{room.status === "playing" && <span className="match-timer-badge">{secondsLeft <= 30 ? "即将结算" : hasCommitDeadline ? "已有整队交卷" : "找到新词重置"}</span>}</div>
            {room.status === "playing" && <><div className="match-timer-track" aria-hidden="true"><span style={{ width: `${timerProgress}%` }} /></div><p>{hasCommitDeadline ? commitTimer ? "首队全员 Commit 后最多 60 秒，新词不延长期限" : "无新词期限更早，按此倒计时结算" : "连续 3 分钟没有新词时结算"}</p></>}
          </div>
          <div className="word-progress"><div className="word-progress-heading"><span>计分词 <strong>{foundWords} / {room.totalWords}</strong></span><span>剩余 <b>{remainingWords}</b> 个</span></div><div className="word-progress-track" role="progressbar" aria-label="两队已找到的计分词" aria-valuemin={0} aria-valuemax={room.totalWords} aria-valuenow={foundWords} aria-valuetext={`已找到 ${foundWords} 个，共 ${room.totalWords} 个，剩余 ${remainingWords} 个`}><span style={{ width: `${wordProgress}%` }} /></div><p>{WORD_COUNT_LABELS[room.wordCount ?? "any"]}<span>附加词另计</span></p></div>
          <div className="play-board-wrap"><LetterBoard key={`${room.code}-${room.round}-${rotation}`} rotation={rotation} rotating={rotating} onRotationEnd={() => setRotating(false)} board={room.board} tileHints={room.tileHints} path={room.status === "finished" ? selectedSolution?.path ?? [] : path} disabled={!canPlay} onSelect={selectTile} onReset={clearSelection} onRelease={releaseSelection} /></div>
          {room.status === "playing" && (isSpectator ? <div className="spectator-board-notice"><Eye size={17} /><div><strong>正在旁观</strong><span>可旋转棋盘，赛后查看完整词表和连法。</span></div></div> : <><div className={`selection-preview ${!canPlay ? "selection-disabled" : ""}`}><output className={word ? "has-letters" : ""} aria-label="当前选中的字母">{word || (me?.committed || commitQueued ? myTeamId !== undefined && teams[myTeamId]?.committed ? "全队已 Commit，等待结算" : "你已 Commit，队友仍可继续" : !connected ? "连接恢复后即可继续" : "在棋盘上拖动连字，松开提交")}</output>{word && <button type="button" className="clear-selection" aria-label="清除当前选择" onClick={clearSelection} disabled={!canPlay}><X size={16} /></button>}<button type="button" className="submit-selection" aria-label="提交棋盘所选单词" title="使用键盘逐格选择后，点击提交" onClick={() => releaseSelection([...path])} disabled={!canPlay || path.length < 4}><ArrowRight size={23} /></button></div><div className="board-entry-hint"><span>{word ? `${word.length} 个字母${word.length < 4 ? " · 至少 4 个" : ""}` : "按住拖动，松开提交；可连续选词"}</span><span>{pendingWordCount > 0 ? <><LoaderCircle size={12} className="spin" />{pendingWordCount} 词待确认</> : <><CornerDownLeft size={12} />键盘选格后可点箭头提交</>}</span></div></>)}
          <WordStatistics stats={room.wordStats} />
          {room.status === "finished" && <div className={`solution-route ${selectedSolution ? "has-solution" : ""}`} aria-live="polite">{selectedSolution ? <><div className="solution-route-heading"><div><span>标准连法</span><strong>{selectedSolution.word.toUpperCase()}</strong><b>{selectedSolution.bonus ? `附加词 · ${selectedSolution.points} 分` : `${selectedSolution.points} 分`}</b></div><button type="button" className="icon-button" aria-label="清除单词路径" onClick={() => setSelectedSolutionWord(null)}><X size={16} /></button></div><p className="solution-route-letters">{selectedSolution.path.map((index, step) => `${step + 1} ${room.board[index]}`).join(" → ")}</p><p>从 1 开始依次连线。这是本词固定的标准连法，其他合法连法也可得分。</p></> : <p>点选下方词表中的单词，查看棋盘上的标准连法。</p>}</div>}
          {room.status === "finished" && <div className="rematch-area">{isHost ? <><button className="primary-button" disabled={busy || !connected} onClick={() => void mutateRoom("rematch")}>{busy ? <LoaderCircle size={18} className="spin" /> : <RotateCcw size={18} />}再来一局</button><p>回到准备室重新组队，由房主再次开始</p></> : <p>等待房主开启下一局，即可回到准备室。</p>}</div>}
        </section>
        <TeamPanel team={teams[1]} players={room.players} hostId={room.hostId} playerId={session?.playerId} words={room.words.filter((found) => wordTeam(found, room.players) === 1)} roomStatus={room.status} onCommit={() => void mutateRoom("commit")} commitQueued={commitQueued && myTeamId === 1} busy={busy || !connected} />
      </div>}
      <div className="spectator-list"><span><Eye size={15} />旁观 {spectators.length} 人</span><div>{spectators.length ? spectators.map((player) => <span key={player.id}>{player.name}{player.id === session?.playerId && <small>你</small>}{player.id === room.hostId && <small>房主</small>}</span>) : <span className="no-spectators">朋友可用邀请链接加入旁观</span>}</div></div>
      {session && room.status === "waiting" && <RoomChat key={`${room.code}-${room.round}-${session.token}`} roomCode={room.code} token={session.token} playerId={session.playerId} players={[...room.players.map((player, index) => ({ ...player, teamId: playerTeam(player, index) })), ...spectators.map((player) => ({ ...player, spectator: true }))]} />}
      {room.status === "finished" && <section className="postgame-review" aria-labelledby="postgame-review-title"><div className="postgame-review-heading"><div><p className="eyebrow">ROUND REVIEW</p><h2 id="postgame-review-title">本局完整词表</h2></div><p>点选任意单词，在棋盘上查看标准连法。</p></div><div className="solution-legend" aria-label="已找到单词的队伍颜色">{teams.map((team) => <span key={team.id} className={`solution-legend-player solution-player-${team.id}`}><i aria-hidden="true" />{team.name}找到</span>)}<span className="solution-legend-missed"><i aria-hidden="true" />漏找</span></div>{room.solutions?.length ? <><SolutionGroup title="计分词" solutions={regularSolutions} claimedWords={claimedWords} players={room.players} selectedWord={selectedSolution?.word ?? null} onSelect={showSolution} /><SolutionGroup title="附加词" solutions={bonusSolutions} claimedWords={claimedWords} players={room.players} selectedWord={selectedSolution?.word ?? null} onSelect={showSolution} /></> : <p className="solution-loading" role="status"><LoaderCircle size={15} className="spin" />词表正在同步，稍后即可查看。</p>}</section>}
      <div className="match-footer"><span><Sparkles size={14} />{room.status === "waiting" ? "组队与聊天仅在准备室开放，比赛由房主手动开始" : "全队 Commit 后最多 60 秒结算；两队全员交卷立即结束"}</span><button onClick={() => setRulesOpen(true)}>查看完整规则<ChevronRight size={14} /></button></div>
    </main>}
    <footer className="site-footer"><p>16 个字母。一群队友。一场好较量。</p><span>Inspired by <a href="https://squares.org/" target="_blank" rel="noreferrer">Squares<ArrowUpRight size={11} /></a><i />MADE FOR TEAMS</span></footer>
    {gameFlash && <div key={gameFlash.id} className={`word-flash ${gameFlash.teamId === 1 ? "word-flash-opponent" : "word-flash-mine"} ${gameFlash.kind !== "word" ? "commit-flash" : ""}`} role="status" aria-live="polite" aria-atomic="true"><span className="word-flash-icon">{gameFlash.kind !== "word" ? <Flag size={23} /> : gameFlash.mine ? <Check size={24} /> : <Sparkles size={24} />}</span><div><span>{gameFlash.kind === "team-commit" ? `${gameFlash.name}全员已 Commit` : gameFlash.kind === "commit" ? `${gameFlash.mine ? "你" : gameFlash.name} 已交卷 · 不可撤回` : `${gameFlash.mine ? "你" : gameFlash.name} 找到一个词${gameFlash.bonus ? " · BONUS" : ""}`}</span><strong>{gameFlash.kind === "word" ? gameFlash.word : gameFlash.kind === "team-commit" ? "全队 COMMIT" : "COMMIT"}</strong>{gameFlash.kind !== "word" && <small>{room?.status === "finished" ? "本局已结算" : gameFlash.kind === "team-commit" ? "最多 60 秒后结算，请留意倒计时" : `${gameFlash.teamId === 0 ? "橙队" : "蓝队"} ${gameFlash.committedCount}/${gameFlash.totalPlayers} 已交卷，全队交卷才开始 60 秒计时`}</small>}</div>{gameFlash.kind === "word" && <b>+{gameFlash.points}<small> 分</small></b>}<button type="button" aria-label="关闭对局提示" onClick={() => setGameFlash(null)}><X size={16} /></button></div>}
    {notice && <div className={`toast toast-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" ? <Check size={17} /> : notice.tone === "error" ? <HelpCircle size={17} /> : <Link2 size={17} />}<span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    {rulesOpen && <Modal title="好词，怎么得分？" onClose={() => setRulesOpen(false)}><p className="modal-description">两支队伍，共享一个棋盘；组好队，由房主开始。</p><div className="rules-detail"><div><span>01</span><section><h3>在同一张棋盘里寻找英文单词</h3><p>连接横向、纵向或斜向相邻的字母。单词至少 4 个字母，同一个单词中，每个方格只能使用一次。按住鼠标或手指拖动连字，松开后自动提交并清空选择。也可用 Tab 移动到字母格，按 Enter 或空格逐格选择，再点击箭头提交。</p></section></div><div><span>02</span><section><h3>每个字母 1 分，先找到的人得分</h3><p>普通计分词按字母数量得分；附加词（Bonus）无论长度，每个词都得 1 分。同一个词只能由一人认领，大小写不影响判定。</p></section></div><div><span>03</span><section><h3>找到新词，倒计时重新开始</h3><p>比赛开始后，连续 3 分钟没有新的有效单词被找到，本局结束。找到额外单词也会重置倒计时。</p></section></div><div><span>04</span><section><h3>找完了，就 Commit</h3><p>点击 Commit 即个人交卷，不可取消，此后你不能再选词，队友仍可继续。一支队伍全员 Commit 后，最多 60 秒结算，新词不会延长这个期限；两队全员都 Commit 时立即结束。3 分钟无新词或普通计分词找完也会更早结算，以两队总分判断胜负。</p></section></div><div><span>05</span><section><h3>所有计分词找完，立即结算</h3><p>两队合计找完棋盘上的全部普通计分词，本局立即结束，附加词无需全部找到。创建房间时可选择大致词量：约 30–40、41–55 或 56–70 个计分词；每张棋盘的完整词表都会保留，再来一局沿用所选词量，并重新随机生成字母布局。随机棋盘使用 SCOWL 英语词库，普通词与较生僻附加词分开计分，收词范围与原站可能有差异。</p></section></div><div><span>06</span><section><h3>Rating：也考虑人数不平衡</h3><p>账号初始 Rating 为 1000。每个人的 Rating 先换算为个人实力，再将队内每个人的实力相加，计算双方的预期得分占比；同水平的 1 人对 2 人，预期分别约为 1/3 和 2/3。开局时锁定人数和 Rating，结算时对比实际得分占比与预期：表现高于预期加分，低于预期减分，因此少人队即使小负也可能加分。队伍的调分由全部队员均分，双方总调分相抵。胜负仍只按本局原积分判断；旁观和 0:0 不计 Rating。上线前已开始且没有 Rating 记录的对局不补算。</p></section></div></div><button className="primary-button modal-understood" onClick={() => setRulesOpen(false)}>明白了，开始找词<ArrowRight size={18} /></button><p className="rules-source">规则参考 <a href="https://squares.org/" target="_blank" rel="noreferrer">squares.org <ArrowUpRight size={11} /></a> · 词库 <a href={publicAsset("dictionary-license.txt")} target="_blank" rel="noreferrer">SCOWL <ArrowUpRight size={11} /></a></p></Modal>}

  </div>;
}
