import { v4 as uuidv4 } from 'uuid';
import { pool, execute } from '../db/pool.js';
import { config, USER_STATUS, ROLES } from '../config/env.js';
import { verifyPassword, hashPassword, validatePasswordPolicy } from '../utils/password.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/tokens.js';
import { sha256Hex, blindIndex } from '../utils/crypto.js';
import {
  findRawByEmail,
  findRawByUuid,
  recordFailedLogin,
  recordSuccessfulLogin,
  clearLockWindow,
  getLockState,
  setPassword,
  getPasswordHistory,
  invalidateUserCache,
} from './userService.js';
import { recordAudit } from './auditService.js';

export class AuthError extends Error {
  constructor(message, status = 401, code = 'AUTH_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function logAttempt(email, ip, successful) {
  try {
    await execute(
      `INSERT INTO login_attempts (email_bidx, ip, successful) VALUES (:bidx, :ip, :ok)`,
      { bidx: email ? blindIndex(email) : null, ip: ip || null, ok: successful ? 1 : 0 },
    );
  } catch {
    /* non-fatal */
  }
}

/** Issue an access token and a persisted, rotatable refresh token. */
async function issueSession(user, ctx, { mfa = 'ok', withRefresh = true } = {}) {
  const accessToken = signAccessToken(user, { mfa });
  // A half-authenticated (MFA-pending/setup) session is access-only and short-lived — no refresh
  // token is minted, so it can never be persisted or refreshed into a full session.
  let refreshToken = null;
  if (withRefresh) {
    const jti = uuidv4();
    refreshToken = signRefreshToken(jti, user.uuid);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTtl * 1000);
    await execute(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
       VALUES (:uid, :hash, :exp, :ip, :ua)`,
      {
        uid: user.id,
        hash: sha256Hex(refreshToken),
        exp: expiresAt,
        ip: ctx?.ip || null,
        ua: ctx?.userAgent ? ctx.userAgent.slice(0, 255) : null,
      },
    );
  }
  return { accessToken, refreshToken };
}

/** MFA stage for a freshly-authenticated user: 'ok' (not required/satisfied), 'setup' (enrolled
 *  policy but no confirmed authenticator yet), or 'pending' (enrolled — must enter a code). */
export function mfaStageFor(user) {
  if (!user.mfa_enabled) return 'ok';
  return user.mfa_confirmed_at ? 'pending' : 'setup';
}

/** Re-issue a FULL session (with refresh) for a user who has just satisfied MFA. Used by the MFA
 *  verify/enroll endpoints. Strictly for the passed user — never cross-user. */
export async function issueFullSession(user, ctx) {
  return issueSession(user, ctx, { mfa: 'ok', withRefresh: true });
}

export async function login(email, password, ctx = {}) {
  const user = await findRawByEmail(email);
  // Uniform failure to avoid user enumeration; still spend time verifying.
  const genericFail = new AuthError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');

  if (!user) {
    await logAttempt(email, ctx.ip, false);
    // Constant-ish work to blunt timing oracle.
    await hashPassword('timing-equalizer-placeholder').catch(() => {});
    throw genericFail;
  }

  // NOTE: account state (disabled / restricted) is checked only AFTER the password is verified (below),
  // so an unauthenticated caller cannot use the response to confirm an account exists or learn its state
  // (anti-enumeration). Lockout still runs pre-password because it must fire on repeated wrong guesses.

  // Brute-force lockout applies to EVERY account, including the master admin. Exempting the most
  // privileged account gave it no per-account lockout — a distributed/botnet attacker rotating source
  // IPs could bypass the IP limiter and guess the master password unthrottled. The lock is time-based
  // and auto-unlocks after the window, so the master remains recoverable (break-glass = wait out the
  // window, or an operator clears users.locked_until) — protection is chosen over convenience.
  const lockable = true;

  // Time-based lockout, evaluated DB-side (timezone-safe). Locked only while the
  // window is still in the future; once it lapses the account auto-unlocks.
  const lockState = user.locked_until ? await getLockState(user.id) : { locked: false, minutesLeft: 0 };
  if (lockState.locked && lockable) {
    await logAttempt(email, ctx.ip, false);
    const mins = Math.max(1, lockState.minutesLeft);
    throw new AuthError(
      `Account temporarily locked after too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      423,
      'ACCOUNT_LOCKED',
    );
  }
  // A lapsed lock (or leftover counter) starts a fresh attempt window (auto-unlock).
  if (lockable && user.locked_until && !lockState.locked) {
    await clearLockWindow(user.id);
    user.failed_login_attempts = 0;
  }

  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    await recordFailedLogin(user.id, { lock: lockable });
    await logAttempt(email, ctx.ip, false);
    await recordAudit({
      actorUserId: user.id,
      action: 'auth.login.failure',
      outcome: 'failure',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    // If this failure reached the threshold, the account is now locked for the window.
    if (lockable && user.failed_login_attempts + 1 >= config.policy.maxFailedLogins) {
      await recordAudit({
        actorUserId: user.id,
        action: 'auth.account.locked',
        outcome: 'failure',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new AuthError(
        `Account temporarily locked after too many failed attempts. Try again in ${config.policy.accountLockMinutes} minutes.`,
        423,
        'ACCOUNT_LOCKED',
      );
    }
    throw genericFail;
  }

  // Account-state gates — only reached once the password is proven correct, so they never leak
  // existence/state to an unauthenticated guesser.
  if (user.status === USER_STATUS.DISABLED) {
    await logAttempt(email, ctx.ip, false);
    throw new AuthError('This account has been disabled.', 403, 'ACCOUNT_DISABLED');
  }
  if (user.status === USER_STATUS.RESTRICTED) {
    await logAttempt(email, ctx.ip, false);
    throw new AuthError('Access to this account is currently restricted.', 403, 'ACCOUNT_RESTRICTED');
  }

  await recordSuccessfulLogin(user.id);
  await logAttempt(email, ctx.ip, true);
  // MFA: if required, issue an access-only (no refresh) session in the setup/pending stage. Full
  // access is gated by requirePasswordSettled until the user completes MFA (which re-issues a full
  // session). Never affects a different user — everything keys off THIS authenticated user.
  const mfaStage = mfaStageFor(user);
  const session = await issueSession(user, ctx, { mfa: mfaStage, withRefresh: mfaStage === 'ok' });
  await recordAudit({
    actorUserId: user.id,
    action: 'auth.login.success',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: mfaStage === 'ok' ? undefined : { mfaStage },
  });

  return {
    user,
    ...session,
    mustResetPassword: !!user.must_reset_password,
    mfaStage,
  };
}

export async function refresh(refreshToken, ctx = {}) {
  if (!refreshToken) throw new AuthError('Missing refresh token.', 401, 'NO_REFRESH');
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new AuthError('Invalid session.', 401, 'INVALID_REFRESH');
  }

  const hash = sha256Hex(refreshToken);
  const [rows] = await execute(
    `SELECT rt.id, rt.user_id, rt.revoked_at, rt.expires_at
       FROM refresh_tokens rt WHERE rt.token_hash = :hash LIMIT 1`,
    { hash },
  );
  const record = rows[0];
  if (!record) {
    throw new AuthError('Session expired. Please sign in again.', 401, 'REFRESH_EXPIRED');
  }
  // Reuse detection: a token that EXISTS but is already revoked was rotated out — presenting it again
  // is a theft signal (the legitimate client would use the current token). Nuke the whole session
  // family and audit, so a stolen-then-rotated token can't quietly ride alongside the real one.
  if (record.revoked_at) {
    await revokeAllSessions(record.user_id);
    await recordAudit({
      actorUserId: record.user_id,
      action: 'auth.refresh.reuse',
      outcome: 'failure',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw new AuthError('Session expired. Please sign in again.', 401, 'REFRESH_REUSE');
  }
  if (new Date(record.expires_at) < new Date()) {
    throw new AuthError('Session expired. Please sign in again.', 401, 'REFRESH_EXPIRED');
  }

  const user = await findRawByUuid(payload.sub);
  if (!user || user.status === USER_STATUS.DISABLED) {
    throw new AuthError('Session no longer valid.', 401, 'USER_INVALID');
  }

  // Rotate: revoke the presented token, issue a fresh pair.
  await execute(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = :id`, { id: record.id });
  const session = await issueSession(user, ctx);
  return { user, ...session };
}

export async function logout(refreshToken, ctx = {}) {
  if (!refreshToken) return;
  const hash = sha256Hex(refreshToken);
  // Resolve who is signing out (for the audit trail) before revoking the token.
  const [rows] = await execute(`SELECT user_id FROM refresh_tokens WHERE token_hash = :hash LIMIT 1`, { hash });
  await execute(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = :hash AND revoked_at IS NULL`,
    { hash },
  );
  const userId = rows[0]?.user_id;
  if (userId) {
    await recordAudit({ actorUserId: userId, action: 'auth.logout', ip: ctx.ip, userAgent: ctx.userAgent });
  }
}

export async function revokeAllSessions(userId) {
  // Revoke refresh tokens AND stamp tokens_valid_after=now so every already-issued (stateless) access
  // token for this user is rejected by `authenticate` immediately — a full credential cut, not just
  // refresh revocation. Used on password change, admin force-logout, and role/status changes.
  await execute(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = :id AND revoked_at IS NULL`,
    { id: userId },
  );
  const [urows] = await execute(`UPDATE users SET tokens_valid_after = NOW() WHERE id = :id`, { id: userId });
  // Drop the 20s identity cache so the new cutoff takes effect on the very next request (not up to 20s later).
  invalidateUserCache();
  return urows;
}

/**
 * Change the current user's password. Requires the current password (even in
 * the forced-reset flow), enforces policy and no-reuse of recent passwords.
 */
export async function changeOwnPassword(userUuid, currentPassword, newPassword, ctx = {}) {
  const user = await findRawByUuid(userUuid);
  if (!user) throw new AuthError('User not found.', 404, 'NOT_FOUND');

  const currentOk = await verifyPassword(user.password_hash, currentPassword);
  if (!currentOk) throw new AuthError('Current password is incorrect.', 400, 'BAD_CURRENT');

  const policyErrors = validatePasswordPolicy(newPassword);
  if (policyErrors.length) {
    const e = new AuthError('Password does not meet the security policy.', 400, 'WEAK_PASSWORD');
    e.details = policyErrors;
    throw e;
  }

  if (await verifyPassword(user.password_hash, newPassword)) {
    throw new AuthError('New password must differ from the current password.', 400, 'REUSED_PASSWORD');
  }
  const history = await getPasswordHistory(user.id);
  for (const oldHash of history) {
    if (await verifyPassword(oldHash, newPassword)) {
      throw new AuthError(
        `New password must not match your last ${config.policy.passwordHistorySize} passwords.`,
        400,
        'REUSED_PASSWORD',
      );
    }
  }

  const newHash = await hashPassword(newPassword);
  await setPassword(user.id, newHash, { clearMustReset: true });
  await revokeAllSessions(user.id); // force re-auth everywhere after a credential change
  await recordAudit({
    actorUserId: user.id,
    action: 'auth.password.change',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}
