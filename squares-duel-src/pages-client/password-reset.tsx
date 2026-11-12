import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, LoaderCircle } from "lucide-react";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../lib/account-policy";
import { apiUrl, publicAsset } from "../lib/api-client";
import "./password-reset.css";

export function PasswordReset({ code }: { code: string }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState(() => !/^[0-9a-f]{64}$/.test(code));
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || done || invalid) return;
    setError("");
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      setError(`请输入 ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 个字符。`);
      return;
    }
    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }

    setBusy(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(apiUrl("/api/account/reset"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, newPassword: password }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (response.status === 410) {
        setInvalid(true);
        setPassword("");
        setConfirmation("");
      } else if (response.ok) {
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new Error("Password reset response was not confirmed.");
        setDone(true);
        setPassword("");
        setConfirmation("");
      } else if (response.status === 400) {
        setError("无法使用这个新密码，请检查后重试。");
      } else {
        throw new Error("Password reset response was not confirmed.");
      }
    } catch {
      setError("暂时无法确认是否重置成功。可以先试用新密码登录，或稍后重试。");
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  return <main className="password-reset-shell">
    <section className="modal-content account-modal-content password-reset-card" aria-labelledby="password-reset-title">
      <div className="account-modal-icon" aria-hidden="true"><KeyRound size={23} /></div>
      <h1 id="password-reset-title">重置游戏密码</h1>
      {done ? <p className="account-success" role="status">密码已重置。请返回游戏，用新密码重新登录。</p> : invalid ? <p className="account-error" role="alert">重置链接无效、已过期或已用过。如果你刚提交过新密码，请尝试用它登录。</p> : <>
        <p className="account-description">为你的 Squares Duel 账号设置新密码。重置后，之前的登录会失效。</p>
        <form method="post" className="account-form" onSubmit={submit} aria-busy={busy}>
          <label htmlFor="reset-password">新密码
            <input id="reset-password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} required aria-describedby="reset-password-help" />
            <small id="reset-password-help">{MIN_PASSWORD_LENGTH}–{MAX_PASSWORD_LENGTH} 个字符</small>
          </label>
          <label htmlFor="reset-confirmation">确认新密码
            <input id="reset-confirmation" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} required />
          </label>
          <button type="submit" className="primary-button account-submit" disabled={busy}>{busy ? <><LoaderCircle size={17} className="spin" aria-hidden="true" />正在重置…</> : <>重置密码<ArrowRight size={17} aria-hidden="true" /></>}</button>
        </form>
        {error && <p className="account-error" role="alert">{error}</p>}
      </>}
      <a className="account-text-button password-reset-return" href={publicAsset("")}>返回游戏</a>
    </section>
  </main>;
}
