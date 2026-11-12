import { timingSafeEqual } from 'node:crypto';
import { accountPassword, accountUsername, passwordHash, tokenHash } from './accounts';
import { GameError } from './game';

const HEX_CODE = /^[0-9a-f]{64}$/;
const unavailable = () => new GameError('这个重置链接无效、已使用或已过期。', 410);

async function configuredReset(config: unknown, code: unknown) {
  if (typeof config !== 'string' || typeof code !== 'string' || !HEX_CODE.test(code)) throw unavailable();
  let entry: Record<string, unknown>;
  let usernameKey: string;
  try {
    entry = JSON.parse(config);
    usernameKey = accountUsername(entry.username).key;
  } catch { throw unavailable(); }
  const { tokenHash: expected, expiresAt } = entry;
  if (typeof expected !== 'string' || !HEX_CODE.test(expected)
    || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt) throw unavailable();
  const digest = await tokenHash(code);
  if (!timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex'))) throw unavailable();
  return { usernameKey, digest, expiresAt };
}

export async function redeemPasswordReset(db: D1DatabaseSession, config: unknown, payload: Record<string, unknown>) {
  const { usernameKey, digest, expiresAt } = await configuredReset(config, payload.code);
  const account = await db.prepare(`SELECT id, password_version FROM accounts WHERE username_key = ?
AND NOT EXISTS (SELECT 1 FROM account_password_resets WHERE token_hash = ?)`)
    .bind(usernameKey, digest).first<{ id: string; password_version: number }>();
  if (!account || Date.now() >= expiresAt) throw unavailable();
  if (payload.checkOnly === true) return { ok: true };

  const hash = await passwordHash(accountPassword(payload.newPassword));
  const now = Date.now();
  if (now >= expiresAt) throw unavailable();
  const receipt = crypto.randomUUID();
  // A concurrent request can change the account only if it inserted the receipt itself.
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO account_password_resets (token_hash, receipt, used_at)
SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND password_version = ?)`)
      .bind(digest, receipt, now, account.id, account.password_version),
    db.prepare(`UPDATE accounts SET password_hash = ?, password_version = password_version + 1
WHERE id = ? AND password_version = ? AND EXISTS (SELECT 1 FROM account_password_resets WHERE token_hash = ? AND receipt = ?)`)
      .bind(hash, account.id, account.password_version, digest, receipt),
    db.prepare(`DELETE FROM account_sessions WHERE account_id = ?
AND EXISTS (SELECT 1 FROM account_password_resets WHERE token_hash = ? AND receipt = ?)`)
      .bind(account.id, digest, receipt),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw unavailable();
  return { ok: true };
}
