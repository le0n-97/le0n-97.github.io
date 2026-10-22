"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AccountRequestError, readAccount, requestAccount, type AccountUser } from "@/lib/account-request";

export type { AccountUser } from "@/lib/account-request";
export type AccountSession = { user: AccountUser; token: string; expiresAt: number };
const ACCOUNT_KEY = "squares-duel-account";
export const isAccountToken = (value: unknown): value is string => typeof value === "string" && value.startsWith("sq_account_");

function savedAccount(): AccountSession | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const session = value as AccountSession;
    return isAccountToken(session.token) && typeof session.user?.username === "string" && typeof session.expiresAt === "number" ? session : null;
  } catch { return null; }
}

function clearLegacyRoomSessions() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (/^squares-duel-[A-Z0-9]{6,8}$/.test(key)) sessionStorage.removeItem(key);
    }
  } catch { /* Account validation does not depend on browser storage. */ }
}

export function useAccount() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const generation = useRef(0);
  const sessionRef = useRef<AccountSession | null>(null);
  const save = useCallback((next: AccountSession | null) => {
    sessionRef.current = next;
    setSession(next);
    setRestoreError(null);
    clearLegacyRoomSessions();
    try { localStorage.removeItem("squares-duel-name"); if (next) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(next)); else localStorage.removeItem(ACCOUNT_KEY); } catch { /* The current tab can still use its in-memory session. */ }
  }, []);

  const restore = useCallback(async () => {
    const requestGeneration = ++generation.current;
    const saved = savedAccount();
    setLoading(true); setRestoreError(null);
    if (!saved) { save(null); setLoading(false); return; }
    try {
      const data = await readAccount(saved.token);
      if (requestGeneration !== generation.current) return;
      if (!data.user) { save(null); return; }
      save({ ...saved, user: data.user });
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      if (error instanceof AccountRequestError && error.status === 401) { save(null); return; }
      sessionRef.current = null; setSession(null);
      setRestoreError(error instanceof Error && error.name !== "TimeoutError" ? error.message : "账号连接超时，请重试。");
    } finally { if (requestGeneration === generation.current) setLoading(false); }
  }, [save]);

  useEffect(() => {
    void restore();
    const storageChanged = (event: StorageEvent) => { if (event.key === ACCOUNT_KEY || event.key === null) void restore(); };
    window.addEventListener("storage", storageChanged);
    return () => { generation.current++; window.removeEventListener("storage", storageChanged); };
  }, [restore]);

  const request = useCallback(async (action: "login" | "register" | "password" | "logout", fields: Record<string, string> = {}) => {
    const requestGeneration = ++generation.current;
    const current = sessionRef.current;
    setWorking(true);
    try {
      const data = await requestAccount(action, fields, current?.token);
      if (requestGeneration !== generation.current) throw new Error("账号状态已更新，请重试。");
      if (action === "logout") save(null);
      else {
        if (!data.user || !isAccountToken(data.token) || typeof data.expiresAt !== "number") throw new Error("账号响应不完整，请重试。");
        save({ user: data.user, token: data.token, expiresAt: data.expiresAt });
      }
      setLoading(false);
    } finally { setWorking(false); }
  }, [save]);

  const clearCredential = useCallback(() => { generation.current++; save(null); setLoading(false); }, [save]);
  // Updating rating must not trigger account restoration or discard the current room.
  const refreshProfile = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const requestGeneration = generation.current;
    try {
      const data = await readAccount(current.token);
      if (!data.user || requestGeneration !== generation.current || sessionRef.current?.token !== current.token) return;
      const next = { ...current, user: data.user };
      sessionRef.current = next;
      setSession(next);
      // Do not rewrite stored credentials: that would restart authentication in other tabs.
    } catch { /* The next profile opening can retry without interrupting a game. */ }
  }, []);
  return { session, loading, working, restoreError, restore, request, clearCredential, refreshProfile };
}

export type AccountController = ReturnType<typeof useAccount>;
