"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, KeyRound, LoaderCircle, LogOut, ShieldCheck, UserRound, X } from "lucide-react";
import type { AccountController } from "@/lib/account-client";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/account-policy";

export function AccountMenu({ account, inRoom, disabled, onReturnToLobby, requestOpen = 0 }: { account: AccountController; inRoom: boolean; disabled: boolean; onReturnToLobby: () => void; requestOpen?: number }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"login" | "register" | "profile" | "password">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const currentToken = account.session?.token;
  const clearPasswords = () => { setPassword(""); setNewPassword(""); setConfirmation(""); };
  const close = () => { setOpen(false); clearPasswords(); setError(null); setMessage(null); };
  useEffect(() => { if (open) dialogRef.current?.showModal(); }, [open]);
  useEffect(() => { if (!currentToken && (mode === "profile" || mode === "password")) { setMode("login"); clearPasswords(); } }, [currentToken, mode]);
  useEffect(() => {
    if (!requestOpen) return;
    setMode("login"); clearPasswords(); setError(null); setMessage(null); setOpen(true);
  }, [requestOpen]);
  const switchMode = (next: typeof mode) => { setMode(next); clearPasswords(); setError(null); setMessage(null); };
  const show = () => { switchMode(account.session ? "profile" : "login"); setOpen(true); if (account.session) void account.refreshProfile(); };

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null); setMessage(null);
    if ((mode === "register" || mode === "password") && (mode === "register" ? password : newPassword) !== confirmation) { setError("两次输入的密码不一致。"); return; }
    setBusy(true);
    try {
      if (mode === "password") {
        await account.request("password", { password, newPassword });
        clearPasswords(); setMode("profile"); setMessage("密码已更新，其他设备需要重新登录。");
      } else {
        await account.request(mode === "register" ? "register" : "login", { username: username.trim(), password });
        clearPasswords(); setMode("profile"); setMessage(mode === "register" ? "注册成功，已登录。点击右上角 × 返回棋盘。" : "登录成功。点击右上角 × 返回棋盘。");
      }
    } catch (reason) { setError(reason instanceof Error && reason.name !== "TimeoutError" ? reason.message : "连接超时，请稍后重试。"); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true); setError(null); setMessage(null);
    try { await account.request("logout"); clearPasswords(); setMode("login"); setMessage("已退出登录。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "退出失败，请重试。"); }
    finally { setBusy(false); }
  };

  return <>
    <button type="button" className={`account-button ${account.session ? "account-signed-in" : ""}`} disabled={disabled || account.loading || !!account.restoreError} onClick={show} aria-label={account.session ? `账号 ${account.session.user.username}，Rating ${account.session.user.rating ?? 1000}` : "登录或注册账号"}>{account.loading ? <LoaderCircle size={16} className="spin" /> : <UserRound size={16} />}<span>{account.loading ? "验证账号…" : account.session?.user.username ?? "登录 / 注册"}</span>{account.session && <b className="account-rating" title="当前 Rating">{account.session.user.rating ?? 1000}</b>}</button>
    {open && <dialog ref={dialogRef} className="modal account-modal" aria-labelledby="account-title" onCancel={(event) => event.preventDefault()}>
      <div className="modal-content account-modal-content"><button type="button" className="icon-button modal-close" aria-label="关闭账号窗口" onClick={close}><X size={20} /></button>
        <div className="account-modal-icon">{account.session ? <ShieldCheck size={23} /> : <UserRound size={23} />}</div>
        <h2 id="account-title">{inRoom ? "正在这场较量中" : mode === "profile" ? "你的账号" : mode === "password" ? "修改密码" : mode === "register" ? "给好词一个名字" : "欢迎回到棋盘"}</h2>
        {inRoom ? <><p className="account-description">{account.session ? `当前账号：${account.session.user.username}。` : "请重新登录账号。"}回到大厅后可以登录、退出或修改密码。对局会继续保留。</p>{account.session && <div className="account-rating-summary"><div><span>当前 Rating</span><strong>{account.session.user.rating ?? 1000}</strong></div><div><span>已计分对局</span><strong>{account.session.user.ratedGames ?? 0}<small> 局</small></strong></div></div>}<button type="button" className="primary-button account-submit" onClick={() => { setMode(account.session ? "profile" : "login"); onReturnToLobby(); }}>回到大厅<ArrowRight size={17} /></button></> : mode === "profile" && account.session ? <>
          <p className="account-description">在不同设备登录同一账号，即可找回已加入的房间身份。</p><div className="account-profile-name"><span><UserRound size={20} /></span><div><small>当前登录</small><strong>{account.session.user.username}</strong></div><Check size={17} /></div>
          <div className="account-rating-summary"><div><span>当前 Rating</span><strong>{account.session.user.rating ?? 1000}</strong></div><div><span>已计分对局</span><strong>{account.session.user.ratedGames ?? 0}<small> 局</small></strong></div></div><p className="account-rating-note">初始 Rating 1000。根据队伍人数、双方实力和本局得分占比调整。</p>
          <div className="account-profile-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => switchMode("password")}><KeyRound size={16} />修改密码</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void logout()}>{busy ? <LoaderCircle size={16} className="spin" /> : <LogOut size={16} />}退出登录</button></div>
        </> : <>
          <p className="account-description">{mode === "password" ? "更新后，其他设备的登录会失效。" : "登录后，用同一账号在其他设备继续较量。"}</p>
          {mode !== "password" && <div className="account-tabs" role="tablist" aria-label="账号操作"><button type="button" role="tab" aria-selected={mode === "login"} disabled={busy} onClick={() => switchMode("login")}>登录</button><button type="button" role="tab" aria-selected={mode === "register"} disabled={busy} onClick={() => switchMode("register")}>注册账号</button></div>}
          <form className="account-form" onSubmit={submit}>
            {mode !== "password" && <label htmlFor="account-username">用户名<input id="account-username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="你的英文名字" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={20} pattern="[A-Za-z0-9_]{3,20}" aria-describedby="account-username-help" required disabled={busy} /><small id="account-username-help">3–20 位英文字母、数字或下划线，不区分大小写</small></label>}
            <label htmlFor="account-password">{mode === "password" ? "当前密码" : "密码"}<input id="account-password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder={mode === "register" ? "至少 5 个字符" : "输入密码"} minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} required disabled={busy} /></label>
            {mode === "password" && <label htmlFor="account-new-password">新密码<input id="account-new-password" name="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" placeholder="5–128 个字符" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} required disabled={busy} /></label>}
            {(mode === "register" || mode === "password") && <label htmlFor="account-confirmation">确认{mode === "password" ? "新" : ""}密码<input id="account-confirmation" name="password-confirmation" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" placeholder="再输入一次" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} required disabled={busy} /></label>}
            {mode !== "login" && <p className="account-password-note">请妥善保存密码；当前未提供邮箱找回。</p>}
            <button type="submit" className="primary-button account-submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : null}{busy ? "正在处理…" : mode === "password" ? "更新密码" : mode === "register" ? "注册并登录" : "登录"}{!busy && <ArrowRight size={17} />}</button>
          </form>
          {mode === "password" && <button type="button" className="account-text-button" disabled={busy} onClick={() => switchMode("profile")}>返回账号</button>}
        </>}
        {error && <p className="account-error" role="alert">{error}</p>}{message && <p className="account-success" role="status">{message}</p>}
      </div>
    </dialog>}
  </>;
}
