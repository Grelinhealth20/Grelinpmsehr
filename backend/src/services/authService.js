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
  setPassword,
  getPasswordHistory,
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
async function issueSession(user, ctx) {
  const accessToken = signAccessToken(user);
  const jti = uuidv4();
  const refreshToken = signRefreshToken(jti, user.uuid);
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
  return { accessToken, refreshToken };
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

  if (user.status === USER_STATUS.DISABLED) {
    await logAttempt(email, ctx.ip, false);
    throw new AuthError('This account has been disabled.', 403, 'ACCOUNT_DISABLED');
  }

  // The master admin — by role OR the configured master email — is never locked
  // out (the top account must always remain reachable).
  const isMaster = user.role === ROLES.MASTER_ADMIN || user.email_bidx === blindIndex(config.masterAdmin.email);
  const lockable = !isMaster;

  // Any non-null lock marker means the account is locked until a password reset.
  if (user.locked_until && lockable) {
    await logAttempt(email, ctx.ip, false);
    throw new AuthError(
      'Account locked after too many failed attempts. Ask an administrator to reset your password.',
      423,
      'ACCOUNT_LOCKED',
    );
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
    // If this failure reached the threshold, the account is now locked (non-master only).
    if (lockable && user.failed_login_attempts + 1 >= config.policy.maxFailedLogins) {
      await recordAudit({
        actorUserId: user.id,
        action: 'auth.account.locked',
        outcome: 'failure',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new AuthError(
        'Account locked after too many failed attempts. Ask an administrator to reset your password.',
        423,
        'ACCOUNT_LOCKED',
      );
    }
    throw genericFail;
  }

  if (user.status === USER_STATUS.RESTRICTED) {
    await logAttempt(email, ctx.ip, false);
    throw new AuthError('Access to this account is currently restricted.', 403, 'ACCOUNT_RESTRICTED');
  }

  await recordSuccessfulLogin(user.id);
  await logAttempt(email, ctx.ip, true);
  const session = await issueSession(user, ctx);
  await recordAudit({
    actorUserId: user.id,
    action: 'auth.login.success',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return {
    user,
    ...session,
    mustResetPassword: !!user.must_reset_password,
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
  if (!record || record.revoked_at || new Date(record.expires_at) < new Date()) {
    throw new AuthError('Session expired. Please sign in again.', 401, 'REFRESH_EXPIRED');
  }

  const user = await findRawByUuid(payload.sub);
  if (!user || user.status === USER_STATUS.DISABLED) {
    throw new AuthError('Session no longer valid.', 401, 'USER_INVALID');
  }

  // Rotate: revoke the presented token, issue a fresh pair (refresh-token reuse detection ready).
  await execute(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = :id`, { id: record.id });
  const session = await issueSession(user, ctx);
  return { user, ...session };
}

export async function logout(refreshToken) {
  if (!refreshToken) return;
  await execute(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = :hash AND revoked_at IS NULL`,
    { hash: sha256Hex(refreshToken) },
  );
}

export async function revokeAllSessions(userId) {
  await execute(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = :id AND revoked_at IS NULL`,
    { id: userId },
  );
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
