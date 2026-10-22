"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, LoaderCircle, MessageCircle, Send } from "lucide-react";
import { apiUrl } from "@/lib/api-client";
import "@/app/room-chat.css";

type ChatMessage = { id: number; clientId: string; playerId: string; text: string; at: number };
type ChatSnapshot = { messages: ChatMessage[]; cursor: number; hasMore: boolean; error?: string };
type ChatPlayer = { id: string; name: string; teamId?: 0 | 1; spectator?: boolean };
const MAX_CHARACTERS = 300;

export function RoomChat({ roomCode, token, playerId, players }: { roomCode: string; token: string; playerId: string; players: ChatPlayer[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [connection, setConnection] = useState<"loading" | "connected" | "retrying">("loading");
  const [unseenCount, setUnseenCount] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const atBottom = useRef(true);
  const cursor = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const composing = useRef(false);
  const pendingDraft = useRef<{ text: string; clientId: string } | null>(null);
  const sendController = useRef<AbortController | null>(null);
  const active = useRef(true);
  const draftLength = Array.from(draft).length;
  const tooLong = draftLength > MAX_CHARACTERS;

  const mergeMessages = useCallback((incoming: ChatMessage[], initial = false) => {
    const byId = new Map(messagesRef.current.map((message) => [message.id, message]));
    let additions = 0;
    for (const message of incoming) {
      if (!byId.has(message.id)) additions++;
      byId.set(message.id, message);
    }
    if (!additions) return;
    const next = [...byId.values()].sort((a, b) => a.id - b.id).slice(-200);
    messagesRef.current = next;
    setMessages(next);
    if (!initial && !atBottom.current) setUnseenCount((count) => count + additions);
  }, []);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async () => {
      let more = false;
      try {
        const after = cursor.current;
        const response = await fetch(apiUrl(`/api/chat?code=${encodeURIComponent(roomCode)}${after === null ? "" : `&after=${after}`}`), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
        const data = await response.json() as ChatSnapshot;
        if (stopped) return;
        if (!response.ok) throw new Error(data.error ?? "聊天暂时无法连接");
        mergeMessages(data.messages, after === null);
        // Only GET advances this cursor: a POST acknowledgement may arrive
        // before an earlier message from the other player has been polled.
        cursor.current = Math.max(cursor.current ?? 0, data.cursor);
        more = data.hasMore;
        setConnection("connected");
      } catch {
        if (!stopped) setConnection("retrying");
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), more ? 0 : 1100);
      }
    };
    void poll();
    return () => {
      stopped = true;
      active.current = false;
      clearTimeout(timer);
      controller.abort();
      sendController.current?.abort();
    };
  }, [roomCode, token, mergeMessages]);

  useLayoutEffect(() => {
    if (atBottom.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const jumpToLatest = () => {
    atBottom.current = true;
    setUnseenCount(0);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (sendingRef.current || !text || tooLong || composing.current) return;
    const attempt = pendingDraft.current?.text === text ? pendingDraft.current : { text, clientId: crypto.randomUUID() };
    pendingDraft.current = attempt;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    const controller = new AbortController();
    sendController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(apiUrl("/api/chat"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ code: roomCode, ...attempt }), signal: controller.signal });
      const data = await response.json() as { message?: ChatMessage; error?: string };
      if (!active.current) return;
      if (!response.ok || !data.message) throw new Error(data.error ?? (response.status === 429 ? "发送太快了，请稍等一秒再试。" : "消息未确认，请重试。"));
      mergeMessages([data.message]);
      pendingDraft.current = null;
      setDraft("");
    } catch (error) {
      if (active.current) setSendError(error instanceof Error && error.name !== "AbortError" ? error.message : "消息暂未确认，草稿已保留，可以重试。");
    } finally {
      clearTimeout(timeout);
      sendingRef.current = false;
      if (active.current) setSending(false);
    }
  };

  return <section className="room-chat" aria-labelledby="room-chat-title">
    <div className="chat-heading"><div><span className="chat-heading-icon"><MessageCircle size={19} /></span><div><h2 id="room-chat-title">准备室聊天</h2><p>房间内所有人可见 · 开始游戏后收起</p></div></div><span className={`chat-connection ${connection === "retrying" ? "chat-retrying" : ""}`}><i />{connection === "loading" ? "连接中" : connection === "retrying" ? "正在重连" : "实时聊天"}</span></div>
    <div className="chat-message-area">
      <div ref={listRef} className="chat-messages" role="log" aria-label="准备室聊天消息" aria-live="polite" aria-relevant="additions" tabIndex={0} onScroll={() => { const list = listRef.current; if (!list) return; atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 45; if (atBottom.current) setUnseenCount(0); }}>
        {messages.length ? messages.map((message) => {
          const index = players.findIndex((player) => player.id === message.playerId);
          const player = players[index];
          const color = player?.spectator || player?.teamId === undefined ? "spectator" : player.teamId;
          const mine = message.playerId === playerId;
          return <article key={message.id} className={`chat-message chat-player-${color} ${mine ? "chat-message-mine" : ""}`}><div className="chat-message-meta"><strong>{player?.name ?? "房间成员"}{player?.spectator && <span>旁观</span>}{mine && <span>你</span>}</strong><time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time></div><p>{message.text}</p></article>;
        }) : <div className="chat-empty"><MessageCircle size={25} /><p>{connection === "loading" ? "正在加载聊天…" : "和朋友打个招呼，商量一下组队吧。"}</p><span>聊天仅在准备室开放，旁观者也能参与。</span></div>}
      </div>
      {unseenCount > 0 && <button type="button" className="chat-new-messages" onClick={jumpToLatest}><ArrowDown size={13} />{unseenCount} 条新消息</button>}
    </div>
    <form className="chat-compose" onSubmit={(event) => void sendMessage(event)}><label className="chat-input-label" htmlFor="room-chat-draft">发送给房间所有人</label><div className={`chat-input-wrap ${tooLong ? "chat-input-too-long" : ""}`}><textarea id="room-chat-draft" value={draft} rows={2} placeholder="说点什么…" readOnly={sending} aria-describedby="chat-compose-hint chat-compose-error" aria-invalid={tooLong || undefined} onChange={(event) => { setDraft(event.target.value); if (sendError) setSendError(null); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void sendMessage(); } }} /><button type="submit" className="chat-send-button" aria-label={sendError ? "重试发送消息" : "发送消息"} disabled={sending || !draft.trim() || tooLong}>{sending ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}<span>{sending ? "发送中" : sendError ? "重试" : "发送"}</span></button></div><div className="chat-compose-hint" id="chat-compose-hint"><span>Enter 发送 · Shift + Enter 换行</span><span className={tooLong ? "chat-character-error" : ""}>{draftLength} / {MAX_CHARACTERS}</span></div><p id="chat-compose-error" className="chat-send-error" role={sendError || tooLong ? "alert" : undefined}>{tooLong ? "消息最多 300 个字符，请缩短后再发送。" : sendError ?? (connection === "retrying" ? "聊天连接中断，正在自动重试。" : "")}</p></form>
  </section>;
}
