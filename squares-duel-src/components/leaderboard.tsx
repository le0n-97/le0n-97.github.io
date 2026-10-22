"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, LocateFixed, LoaderCircle, RefreshCw, Trophy, X } from "lucide-react";
import { apiUrl } from "@/lib/api-client";
import type { LeaderboardResponse } from "@/lib/leaderboard-types";

const PAGE_SIZE = 20;
const formatRating = (rating: number) => rating.toLocaleString("zh-CN", { useGrouping: false, maximumFractionDigits: 3 });
const formatCount = (count: number) => count.toLocaleString("zh-CN");

export function Leaderboard({ token, disabled, onLogin }: { token: string | null; disabled: boolean; onLogin: () => void }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<{ token: string; data: LeaderboardResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const myRowRef = useRef<HTMLTableRowElement>(null);
  const locatePending = useRef(false);
  const openRef = useRef(false);
  const tokenRef = useRef(token);
  const previousToken = useRef(token);
  const requestNumber = useRef(0);
  tokenRef.current = token;

  const close = () => { openRef.current = false; locatePending.current = false; setOpen(false); };
  const show = () => {
    if (!token) { onLogin(); return; }
    openRef.current = true;
    setOffset(0); setSnapshot(null); setError(null); setNeedsLogin(false); setOpen(true);
  };
  const login = () => { close(); onLogin(); };

  useEffect(() => {
    if (previousToken.current !== token) {
      openRef.current = false; setOpen(false); setSnapshot(null); setError(null); setNeedsLogin(false);
      previousToken.current = token;
    }
  }, [token]);
  useEffect(() => { if (open) dialogRef.current?.showModal(); }, [open]);
  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    let timedOut = false;
    const requestId = ++requestNumber.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
    const isCurrent = () => !cancelled && openRef.current && tokenRef.current === token && requestNumber.current === requestId;
    setLoading(true); setError(null); setNeedsLogin(false);
    void (async () => {
      try {
        const response = await fetch(apiUrl(`/api/leaderboard?offset=${offset}&limit=${PAGE_SIZE}`), {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
        });
        if (!isCurrent()) return;
        if (response.status === 401) { setNeedsLogin(true); throw new Error("登录已失效，请重新登录后查看排行榜。"); }
        let data: LeaderboardResponse & { error?: string };
        try { data = await response.json() as LeaderboardResponse & { error?: string }; }
        catch { throw new Error("排行榜连接暂时异常，请稍后重试。"); }
        if (!isCurrent()) return;
        if (!response.ok) throw new Error(data.error ?? "暂时无法加载排行榜，请稍后重试。");
        if (!Array.isArray(data.entries) || !data.me || !Number.isInteger(data.total)) throw new Error("排行榜响应不完整，请重试。");
        if (data.total > 0 && offset >= data.total) {
          setOffset(Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE);
          return;
        }
        setSnapshot({ token, data });
      } catch (reason) {
        if (isCurrent()) setError(timedOut ? "排行榜加载超时，请重试。" : reason instanceof Error && reason.name !== "TypeError" ? reason.message : "暂时无法连接排行榜，请重试。");
      } finally {
        window.clearTimeout(timeout);
        if (isCurrent()) setLoading(false);
      }
    })();
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
  }, [open, token, offset, refresh]);

  const latest = snapshot?.token === token ? snapshot.data : null;
  const page = latest?.offset === offset ? latest : null;
  const me = latest?.me;
  const myOffset = me?.position ? Math.floor((me.position - 1) / PAGE_SIZE) * PAGE_SIZE : null;
  const reload = () => setRefresh((value) => value + 1);
  useEffect(() => {
    if (!page || !locatePending.current || loading) return;
    locatePending.current = false;
    myRowRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  }, [page, loading]);

  return <>
    <button type="button" className="leaderboard-button" disabled={disabled} onClick={show} aria-label={token ? "查看 Rating 排行榜" : "登录后查看 Rating 排行榜"}><Trophy size={16} /><span>排行榜</span></button>
    {open && <dialog ref={dialogRef} className="modal leaderboard-modal" aria-labelledby="leaderboard-title" aria-describedby="leaderboard-description" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal-content leaderboard-content">
        <button type="button" className="icon-button modal-close" aria-label="关闭排行榜" onClick={close} autoFocus><X size={20} /></button>
        <div className="leaderboard-heading"><span className="leaderboard-emblem" aria-hidden="true"><Trophy size={22} /></span><div><span className="eyebrow">RATING RANKING</span><h2 id="leaderboard-title">Rating 排行榜</h2></div></div>
        <p id="leaderboard-description" className="leaderboard-description">完成至少 1 局计分对局即可上榜。按当前 Rating 排名，相同 Rating 并列。</p>

        {me && <section className="leaderboard-mine" aria-label="我的排名"><div className="leaderboard-mine-name"><span>我的排名</span><strong>{me.username}</strong></div><div className="leaderboard-mine-rank"><span>{me.rank === null ? "尚未上榜" : `第 ${formatCount(me.rank)} 名`}</span><small>{me.rank === null ? "完成一局计分对局后上榜" : `${formatCount(me.ratedGames)} 局已计分`}</small></div><div className="leaderboard-mine-rating"><span>当前 Rating</span><strong>{formatRating(me.rating)}</strong></div>{myOffset !== null && <button type="button" className="leaderboard-locate" disabled={loading} onClick={() => { locatePending.current = true; if (myOffset === offset) reload(); else setOffset(myOffset); }}><LocateFixed size={14} />查看我的位置</button>}</section>}

        <div className="leaderboard-toolbar"><span>{latest ? `${formatCount(latest.total)} 位玩家上榜` : "全球玩家排名"}</span><button type="button" onClick={reload} disabled={loading || needsLogin} aria-label="刷新排行榜">{loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}刷新</button></div>
        {error && <div className="leaderboard-error" role="alert"><p>{error}</p><button type="button" onClick={needsLogin ? login : reload} disabled={loading}>{needsLogin ? "前往账号" : "重新加载"}<ArrowRight size={14} /></button></div>}
        <div className="leaderboard-results" aria-busy={loading}>
          {page && page.entries.length > 0 ? <table className="leaderboard-table"><caption>玩家排名、账号、当前 Rating 和已计分局数</caption><colgroup><col className="leaderboard-rank-column" /><col /><col className="leaderboard-rating-column" /><col className="leaderboard-games-column" /></colgroup><thead><tr><th scope="col">排名</th><th scope="col">玩家</th><th scope="col">Rating</th><th scope="col">计分局数</th></tr></thead><tbody>{page.entries.map((entry) => <tr key={entry.username} ref={entry.isMe ? myRowRef : undefined} className={entry.isMe ? "leaderboard-row-mine" : ""} aria-current={entry.isMe ? "true" : undefined}><td><span className={`leaderboard-rank ${entry.rank <= 3 ? `leaderboard-top-${entry.rank}` : ""}`}>{entry.rank <= 3 && <Trophy size={12} aria-hidden="true" />}{formatCount(entry.rank)}</span></td><th scope="row"><span>{entry.username}</span>{entry.isMe && <small>你</small>}</th><td className="leaderboard-rating-cell">{formatRating(entry.rating)}</td><td>{formatCount(entry.ratedGames)}</td></tr>)}</tbody></table> : loading ? <div className="leaderboard-state" role="status"><LoaderCircle size={25} className="spin" /><strong>正在加载排行榜…</strong></div> : page?.total === 0 ? <div className="leaderboard-state"><Trophy size={30} /><strong>第一位上榜玩家，会是你吗？</strong><p>完成至少一局计分对局，开始积累 Rating。</p></div> : !error ? <div className="leaderboard-state"><p>正在准备排行榜…</p></div> : null}
        </div>
        {page && page.total > 0 && <nav className="leaderboard-pagination" aria-label="排行榜分页"><button type="button" disabled={loading || page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))} aria-label="排行榜上一页"><ArrowLeft size={15} /><span>上一页</span></button><span aria-live="polite">{formatCount(page.offset + 1)}–{formatCount(page.offset + page.entries.length)} / {formatCount(page.total)}</span><button type="button" disabled={loading || page.offset + page.entries.length >= page.total} onClick={() => setOffset(page.offset + PAGE_SIZE)} aria-label="排行榜下一页"><span>下一页</span><ArrowRight size={15} /></button></nav>}
        <p className="leaderboard-footnote">Rating 精确到小数点后三位；并列后顺延名次。0:0 与旁观不计分。{latest && <span>更新于 {new Date(latest.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>}</p>
      </div>
    </dialog>}
  </>;
}
