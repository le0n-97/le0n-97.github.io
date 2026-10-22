"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, Flag, LoaderCircle, RefreshCw, Search, ShieldCheck, Trophy, X } from "lucide-react";
import "./admin.css";

type RecordPlayer = { id: string; name: string; score: number; committed: boolean; committedAt?: number | null; teamId?: 0 | 1 };
type RecordTeam = { id: 0 | 1; name: string; score: number; playerIds: string[] };
type EndReason = "committed" | "commit_timeout" | "timeout" | "all_words" | null;
type RecordSummary = {
  id: string; code: string; round: number; startedAt: number | null; endedAt: number; endReason: EndReason;
  wordCount: "any" | "small" | "medium" | "large"; boardSource: "random" | "legacy"; players: RecordPlayer[];
  winnerId: string | null; durationMs: number; totalWords: number; foundWords: number; bonusFound: number;
  teams?: RecordTeam[]; winnerTeamId?: 0 | 1 | null;
};
type RecordWord = { word: string; playerId: string; points: number; bonus: boolean; at: number };
type RecordSolution = { word: string; points: number; bonus: boolean; path: number[] };
type RecordDetail = RecordSummary & { board: string[]; words: RecordWord[]; solutions: RecordSolution[] };
type RecordList = { records: RecordSummary[]; total: number; page: number; pageSize: number; backfillPending?: boolean };
type TimelineEvent = { id: string; kind: "word" | "commit"; playerId: string; at: number | null; word?: RecordWord };

const END_REASONS: Record<Exclude<EndReason, null>, string> = {
  committed: "两队全员 Commit", commit_timeout: "整队 Commit 后 60 秒", timeout: "三分钟未找到新词", all_words: "普通词全部找到",
};
const COUNT_LABELS = { any: "不限", small: "较少", medium: "适中", large: "较多" };
function dateLabel(at: number | null) {
  return at === null ? "未记录" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}
function fullDate(at: number | null) {
  return at === null ? "未记录" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(at);
}
function durationLabel(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
function resultLabel(record: RecordSummary) {
  if (record.teams) {
    const winner = record.teams.find(team => team.id === record.winnerTeamId);
    return winner ? `${winner.name} 获胜` : "平局";
  }
  const winner = record.players.find((player) => player.id === record.winnerId);
  return winner ? `${winner.name} 获胜` : "平局";
}
function isDraw(record: RecordSummary) { return record.teams ? record.winnerTeamId == null : record.winnerId === null; }
function scoreRows(record: RecordSummary) {
  return record.teams ? record.teams.map(team => ({ id: `team-${team.id}`, name: team.name, score: team.score,
    color: team.id, winner: record.winnerTeamId === team.id, team: true,
    members: record.players.filter(player => team.playerIds.includes(player.id)).map(player => player.name).join("、") }))
    : record.players.map((player, index) => ({ id: player.id, name: player.name, score: player.score,
      color: index, winner: record.winnerId === player.id, team: false, members: "" }));
}
function reasonLabel(reason: EndReason) { return reason ? END_REASONS[reason] : "对局结束"; }

function ReviewBoard({ record, solution }: { record: RecordDetail; solution: RecordSolution | undefined }) {
  const path = solution?.path ?? [];
  const points = path.map((index) => `${(index % 4) * 100 + 50},${Math.floor(index / 4) * 100 + 50}`).join(" ");
  return <div className="admin-board-section">
    <div className="admin-section-heading"><h3>本局棋盘</h3><span>{record.boardSource === "random" ? "随机生成" : "旧版棋盘"}</span></div>
    <div className="admin-board" role="img" aria-label={`本局 4 行 4 列棋盘${solution ? `，${solution.word.toUpperCase()} 的标准连法为 ${path.map((index) => `${Math.floor(index / 4) + 1} 行 ${index % 4 + 1} 列`).join("、")}` : "，点击下方词表查看连法"}`}>
      <svg viewBox="0 0 400 400" aria-hidden="true"><polyline points={points} fill="none" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {record.board.map((letter, index) => <div key={index} className={`admin-tile ${path.includes(index) ? "admin-tile-selected" : ""}`} aria-hidden="true"><span>{letter}</span>{path.includes(index) && <small>{path.indexOf(index) + 1}</small>}</div>)}
    </div>
    <div className={`admin-route-caption ${solution ? "admin-route-active" : ""}`} aria-live="polite">
      {solution ? <><strong>{solution.word.toUpperCase()}</strong><span>{solution.bonus ? "附加词" : "普通词"} · {solution.points} 分 · 标准连法</span><p>{path.map((index) => record.board[index]).join(" → ")}</p></> : <p>点击词表或时间线中的单词，查看它的标准连法。</p>}
    </div>
  </div>;
}

function RecordReview({ record }: { record: RecordDetail }) {
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const claims = useMemo(() => new Map(record.words.map((word) => [word.word.toLowerCase(), word])), [record.words]);
  const selected = record.solutions.find((solution) => solution.word.toLowerCase() === selectedWord);
  const events = useMemo(() => {
    const items: TimelineEvent[] = record.words.map((word, index) => ({ id: `word-${index}`, kind: "word", playerId: word.playerId, at: word.at, word }));
    for (const player of record.players) if (player.committed) items.push({ id: `commit-${player.id}`, kind: "commit", playerId: player.id, at: player.committedAt ?? null });
    return items.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "word" ? -1 : 1));
  }, [record.words, record.players]);
  const playerIndex = (id: string) => {
    const index = record.players.findIndex(player => player.id === id);
    return record.players[index]?.teamId ?? index;
  };
  const playerName = (id: string) => record.players.find((player) => player.id === id)?.name ?? "未知玩家";
  const selectWord = (word: string) => {
    setSelectedWord(word.toLowerCase());
    boardRef.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  return <article className="admin-review" aria-labelledby="admin-review-title">
    <header className="admin-review-heading"><div><span className="admin-kicker">MATCH REVIEW</span><h2 id="admin-review-title">{record.code} <span>第 {record.round} 局</span></h2></div><span className="admin-result"><Trophy size={15} />{resultLabel(record)}</span></header>
    <div className="admin-scorecards">{scoreRows(record).map(row => <div key={row.id} className={`admin-scorecard admin-owner-${row.color}`}><div><span>{row.team ? "TEAM" : "PLAYER"} {String(row.color + 1).padStart(2, "0")}</span><h3>{row.name}</h3>{row.members && <small>{row.members}</small>}<small>{row.winner ? "本局获胜" : isDraw(record) ? "平局" : "本局落败"}</small></div><strong>{row.score}<small>分</small></strong></div>)}</div>
    <dl className="admin-match-meta"><div><dt>开始时间</dt><dd>{fullDate(record.startedAt)}</dd></div><div><dt>结束时间</dt><dd>{fullDate(record.endedAt)}</dd></div><div><dt>对局时长</dt><dd>{durationLabel(record.durationMs)}</dd></div><div><dt>结束原因</dt><dd>{reasonLabel(record.endReason)}</dd></div><div><dt>找到普通词</dt><dd>{record.foundWords} / {record.totalWords}</dd></div><div><dt>附加词 · 词量设置</dt><dd>{record.bonusFound} 个 · {COUNT_LABELS[record.wordCount]}</dd></div></dl>
    <div className="admin-review-middle"><div ref={boardRef}><ReviewBoard record={record} solution={selected} /></div><section className="admin-timeline-section" aria-label="本局时间线"><div className="admin-section-heading"><h3>对局时间线</h3><span>按发生时间</span></div><ol className="admin-timeline"><li className="admin-timeline-boundary"><Clock3 size={14} /><time dateTime={record.startedAt === null ? undefined : new Date(record.startedAt).toISOString()}>开局 · {record.startedAt === null ? "时间未记录" : "0:00"}</time></li>{events.map((event) => <li key={event.id} className={`admin-timeline-event admin-owner-${playerIndex(event.playerId)}`}><span className="admin-timeline-dot" /><time title={fullDate(event.at)}>{event.at === null ? "时间未记录" : record.startedAt === null ? dateLabel(event.at) : `+${durationLabel(event.at - record.startedAt)}`}</time><div><span className="admin-event-player">{playerName(event.playerId)}</span>{event.kind === "commit" ? <strong className="admin-commit-event"><Flag size={13} />Commit</strong> : <button type="button" className="admin-timeline-word" aria-pressed={selectedWord === event.word!.word.toLowerCase()} onClick={() => selectWord(event.word!.word)}><strong>{event.word!.word.toUpperCase()}</strong><span>{event.word!.bonus ? "BONUS " : ""}+{event.word!.points}</span></button>}</div></li>)}<li className="admin-timeline-boundary"><Flag size={14} /><span>结算 · {durationLabel(record.durationMs)}</span></li></ol></section></div>
    <section className="admin-vocabulary" aria-labelledby="admin-vocabulary-title"><div className="admin-vocabulary-heading"><div><h3 id="admin-vocabulary-title">完整词表</h3><p>点击单词查看标准连法；颜色表示找到它的队伍。</p></div><div className="admin-player-legend">{scoreRows(record).map(row => <span key={row.id} className={`admin-owner-${row.color}`}><i />{row.name}</span>)}<span><i />未找到</span></div></div>
      {[false, true].map((bonus) => {
        const solutions = record.solutions.filter((solution) => solution.bonus === bonus);
        return <div className="admin-word-group" key={String(bonus)}><div className="admin-section-heading"><h4>{bonus ? "附加词" : "普通词"}</h4><span>{solutions.length} 个</span></div>{solutions.length ? <div className="admin-word-grid">{solutions.map((solution) => { const claim = claims.get(solution.word.toLowerCase()); const owner = claim ? playerIndex(claim.playerId) : -1; const active = selectedWord === solution.word.toLowerCase(); return <button key={solution.word} type="button" className={`admin-solution admin-owner-${owner} ${active ? "admin-solution-selected" : ""}`} aria-pressed={active} aria-label={`${solution.word.toUpperCase()}，${solution.points} 分，${claim ? `${playerName(claim.playerId)} 找到` : "未找到"}，查看标准连法`} onClick={() => selectWord(solution.word)}><span><strong>{solution.word.toUpperCase()}</strong><b>{solution.points} 分</b></span><small>{claim && <Check size={11} />}{claim ? playerName(claim.playerId) : "未找到"}</small></button>; })}</div> : <p className="admin-muted">本局没有附加词。</p>}</div>;
      })}
    </section>
  </article>;
}

export default function AdminRecordsPage() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<RecordList | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);

  useEffect(() => {
    const request = ++listRequest.current;
    const controller = new AbortController();
    setListLoading(true); setListError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/records?${new URLSearchParams({ q: query.q, page: String(query.page) })}`, { cache: "no-store", signal: controller.signal });
        if (request !== listRequest.current || controller.signal.aborted) return;
        if (response.status === 404) { setUnavailable(true); setList(null); setSelectedId(null); return; }
        const data = await response.json() as RecordList & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "暂时无法读取记录，请稍后刷新。");
        if (request !== listRequest.current || controller.signal.aborted) return;
        setUnavailable(false); setList(data);
      } catch (error) {
        if (!controller.signal.aborted && request === listRequest.current) setListError(error instanceof Error ? error.message : "读取失败，请重新刷新。");
      } finally { if (!controller.signal.aborted && request === listRequest.current) setListLoading(false); }
    })();
    return () => controller.abort();
  }, [query, revision]);

  useEffect(() => {
    const request = ++detailRequest.current;
    const controller = new AbortController();
    setDetail(null); setDetailError(null);
    if (!selectedId) { setDetailLoading(false); return () => controller.abort(); }
    setDetailLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/records?${new URLSearchParams({ id: selectedId })}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json() as { record?: RecordDetail; error?: string };
        if (!response.ok || !data.record) throw new Error(data.error ?? "无法读取这局记录，请刷新列表后重试。");
        if (request !== detailRequest.current || controller.signal.aborted) return;
        setDetail(data.record);
      } catch (error) {
        if (!controller.signal.aborted && request === detailRequest.current) setDetailError(error instanceof Error ? error.message : "读取详情失败，请重试。");
      } finally { if (!controller.signal.aborted && request === detailRequest.current) setDetailLoading(false); }
    })();
    return () => controller.abort();
  }, [selectedId, revision]);

  function submitSearch(event: FormEvent) { event.preventDefault(); setSelectedId(null); setList(null); setQuery({ q: search.trim(), page: 1 }); }
  function changePage(page: number) { setSelectedId(null); setList(null); setQuery((current) => ({ ...current, page })); }
  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const currentPage = list?.page ?? query.page;
  return <main className="admin-shell">
    <header className="admin-header"><a className="admin-brand" href="/" aria-label="返回 Squares Duel"><span className="admin-brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span>squares<span>.</span></span><b>DUEL</b></a><span className="admin-local-badge"><ShieldCheck size={14} />本机后台</span></header>
    <div className="admin-page-heading"><div><span className="admin-kicker">MATCH HISTORY</span><h1>对局记录</h1><p>保留功能启用后的每一局；旧数据仅补录仍保留的对局。</p></div><button type="button" className="admin-refresh" onClick={() => setRevision((current) => current + 1)} disabled={listLoading}><RefreshCw size={15} className={listLoading ? "admin-spin" : ""} />{listLoading ? "读取中" : "刷新记录"}</button></div>
    {unavailable ? <section className="admin-unavailable" role="status"><ShieldCheck size={34} /><h2>对局记录仅在本地可用</h2><p>请在本机启动本地版本，并通过 localhost 或 127.0.0.1 打开此页。</p><a href="/">返回游戏 <ArrowRight size={14} /></a></section> : <>
      <form className="admin-search" onSubmit={submitSearch}><label htmlFor="admin-search-input"><Search size={17} /><input id="admin-search-input" type="search" placeholder="搜索房间号或玩家昵称" aria-label="搜索房间号或玩家昵称" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label><button type="submit">搜索</button>{query.q && <button type="button" className="admin-clear-search" onClick={() => { setSearch(""); setSelectedId(null); setQuery({ q: "", page: 1 }); }}><X size={14} />清除</button>}</form>
      {list?.backfillPending && <p className="admin-backfill" role="status">还有旧记录待整理，刷新可继续。</p>}
      <div className={`admin-workspace ${selectedId ? "admin-has-selection" : ""}`}>
        <section className="admin-records-panel" aria-labelledby="admin-list-title" aria-busy={listLoading}><div className="admin-list-heading"><h2 id="admin-list-title">{query.q ? "搜索结果" : "已结束的对局"}</h2><span>{list ? `${list.total} 局` : "—"}</span></div>
          {listError && <div className="admin-error" role="alert"><p>{listError}</p><button type="button" onClick={() => setRevision((current) => current + 1)}>重试</button></div>}
          {!list && listLoading ? <div className="admin-placeholder" role="status"><LoaderCircle size={24} className="admin-spin" /><p>正在读取对局记录…</p></div> : list && list.records.length ? <div className="admin-record-list">{list.records.map((record) => <button type="button" key={record.id} className={`admin-record-item ${selectedId === record.id ? "admin-record-selected" : ""}`} aria-pressed={selectedId === record.id} onClick={() => setSelectedId(record.id)}><div className="admin-record-top"><strong>{record.code}<small>第 {record.round} 局</small></strong><time dateTime={new Date(record.endedAt).toISOString()}>{dateLabel(record.endedAt)}</time></div><div className="admin-record-players">{scoreRows(record).map(row => <span key={row.id} className={`admin-owner-${row.color}`}><span>{row.name}</span><b>{row.score}</b>{row.winner && <Trophy size={12} aria-label="获胜" />}</span>)}</div><div className="admin-record-bottom"><span>{isDraw(record) ? "平局" : "已结算"} · {durationLabel(record.durationMs)} · {record.foundWords}/{record.totalWords} 普通词</span><ArrowRight size={14} /></div></button>)}</div> : !listError && !listLoading ? <div className="admin-placeholder"><Clock3 size={29} /><h3>{query.q ? "没有匹配的对局" : "还没有结束的对局"}</h3><p>{query.q ? "试试完整房间号或另一个玩家昵称。" : "在本地完成一局游戏后，记录会出现在这里。"}</p><a href="/">打开游戏 <ArrowRight size={13} /></a></div> : null}
          {list && list.total > 0 && <nav className="admin-pagination" aria-label="对局记录分页"><button type="button" aria-label="上一页" disabled={listLoading || currentPage <= 1} onClick={() => changePage(currentPage - 1)}><ArrowLeft size={15} /></button><span>第 {currentPage} / {pages} 页</span><button type="button" aria-label="下一页" disabled={listLoading || currentPage >= pages} onClick={() => changePage(currentPage + 1)}><ArrowRight size={15} /></button></nav>}
        </section>
        <section className="admin-detail-panel" aria-label="选中对局详情" aria-busy={detailLoading}>{selectedId && <button type="button" className="admin-close-detail" onClick={() => setSelectedId(null)}><X size={15} />关闭详情</button>}{detailLoading ? <div className="admin-placeholder" role="status"><LoaderCircle className="admin-spin" size={24} /><p>正在读取这局的棋盘和词表…</p></div> : detailError ? <div className="admin-error" role="alert"><p>{detailError}</p><button type="button" onClick={() => setRevision((current) => current + 1)}>重试</button></div> : detail ? <RecordReview key={detail.id} record={detail} /> : <div className="admin-placeholder admin-select-placeholder"><span className="admin-empty-board" aria-hidden="true">{Array.from({ length: 16 }, (_, index) => <i key={index} />)}</span><h2>选择一局，查看完整复盘</h2><p>双方得分、找词时间线和完整词表都会保留在这里。</p></div>}</section>
      </div>
    </>}
    <footer className="admin-footer"><span>Squares Duel · 对局记录</span><span>时间按当前设备的时区显示</span></footer>
  </main>;
}
