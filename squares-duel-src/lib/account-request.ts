import { apiUrl } from './api-client';

export type AccountUser = { username: string; rating: number; ratedGames: number };
export type AccountResponse = { user?: AccountUser | null; token?: string; expiresAt?: number; error?: string };
export type AccountAction = 'login' | 'register' | 'password' | 'logout';
type Transport = { fetch?: typeof fetch; retryDelayMs?: number; timeoutMs?: number };

export class AccountRequestError extends Error {
  constructor(message: string, readonly status = 0, readonly retryable = false) { super(message); }
}

async function send(action: AccountAction | null, fields: Record<string, string>, token: string | undefined, options: Transport): Promise<AccountResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? (action ? 15_000 : 12_000));
  // Login and registration use a CORS-safelisted body, with no session header.
  // The server still validates Origin before accepting the JSON payload.
  const publicAction = action === 'login' || action === 'register';
  try {
    const response = await (options.fetch ?? fetch)(apiUrl('/api/account'), {
      method: action ? 'POST' : 'GET',
      headers: {
        ...(action ? { 'Content-Type': publicAction ? 'text/plain;charset=UTF-8' : 'application/json' } : {}),
        ...(token && !publicAction ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(action ? { body: JSON.stringify({ action, ...fields }) } : {}),
      mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal,
    });
    let data: AccountResponse;
    try { data = await response.json() as AccountResponse; }
    catch { throw new AccountRequestError('账号连接中断，请重试。', response.status, response.ok || response.status >= 500); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AccountRequestError('账号响应不完整，请重试。', response.status, true);
    if (!response.ok) throw new AccountRequestError(typeof data.error === 'string' ? data.error : '账号操作失败，请稍后重试。', response.status, response.status >= 500);
    if (action && action !== 'logout' && (!data.user || typeof data.user.username !== 'string' || typeof data.token !== 'string' || !/^sq_account_[0-9a-f]{64}$/.test(data.token) || typeof data.expiresAt !== 'number')) {
      throw new AccountRequestError('账号响应不完整，请重试。', response.status, true);
    }
    return data;
  } catch (error) {
    if (timedOut) throw new AccountRequestError('账号连接超时，请检查网络后重试。', 0, true);
    if (error instanceof AccountRequestError) throw error;
    throw new AccountRequestError('连接账号服务失败，请检查网络后重试。', 0, true);
  } finally { clearTimeout(timeout); }
}

const waitToRetry = (options: Transport) => new Promise<void>(resolve => setTimeout(resolve, options.retryDelayMs ?? 400));

export async function requestAccount(action: AccountAction, fields: Record<string, string> = {}, token?: string, options: Transport = {}): Promise<AccountResponse> {
  try { return await send(action, fields, token, options); }
  catch (error) {
    if (!(error instanceof AccountRequestError) || !error.retryable || (action !== 'login' && action !== 'register')) throw error;
    await waitToRetry(options);
    if (action === 'register') {
      // The account may already exist if the registration response was lost.
      // Prove ownership with the same credentials before retrying creation.
      try { return await send('login', fields, undefined, options); }
      catch (recovery) {
        if (!(recovery instanceof AccountRequestError) || recovery.status !== 401) throw recovery;
      }
    }
    return send(action, fields, token, options);
  }
}

export async function readAccount(token: string, options: Transport = {}): Promise<AccountResponse> {
  try { return await send(null, {}, token, options); }
  catch (error) {
    if (!(error instanceof AccountRequestError) || !error.retryable) throw error;
    await waitToRetry(options);
    return send(null, {}, token, options);
  }
}
