import { verifyAccessToken } from '../utils/tokens.js';
import { COOKIE } from '../utils/cookies.js';
import { findRawByUuidCached, toPublicUser } from '../services/userService.js';
import { USER_STATUS } from '../config/env.js';

/**
 * Authenticate via the httpOnly access-token cookie. Attaches `req.user`
 * (safe DTO) and `req.authUserId` (internal id) on success.
 */
export async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE.ACCESS];
    if (!token) return res.status(401).json({ error: 'Authentication required.', code: 'NO_TOKEN' });

    let claims;
    try {
      claims = verifyAccessToken(token);
    } catch {
      return res.status(401).json({ error: 'Session expired.', code: 'TOKEN_INVALID' });
    }

    const row = await findRawByUuidCached(claims.sub);
    if (!row || row.status === USER_STATUS.DISABLED) {
      return res.status(401).json({ error: 'Session no longer valid.', code: 'USER_INVALID' });
    }

    // Credential-cut check: any access token issued BEFORE the user's tokens_valid_after is dead.
    // This is what makes a password change / admin force-logout / role or status change actually
    // invalidate live, stateless access tokens (not just refresh tokens) — closing the window where a
    // stolen access token keeps working after a revoke. `iat` is in seconds; compare at that resolution.
    if (row.tokens_valid_after) {
      const cutSec = Math.floor(new Date(row.tokens_valid_after).getTime() / 1000);
      if (typeof claims.iat === 'number' && claims.iat < cutSec) {
        return res.status(401).json({ error: 'Session no longer valid.', code: 'TOKEN_REVOKED' });
      }
    }

    req.authUserId = row.id;
    req.authUserRow = row;
    req.user = toPublicUser(row);
    req.mustResetPassword = !!row.must_reset_password;
    // MFA state: enrollment flags come from the fresh DB row; the per-session verification status
    // ('ok' | 'setup' | 'pending') comes from the signed token claim (can't be forged).
    req.mfaEnabled = !!row.mfa_enabled;
    req.mfaConfirmed = !!row.mfa_confirmed_at;
    req.mfaClaim = claims.mfa || 'ok';
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Block access to protected resources while the user still owes a password
 * reset — only the change-password + logout endpoints are reachable.
 */
export function requirePasswordSettled(req, res, next) {
  if (req.mustResetPassword) {
    return res.status(403).json({
      error: 'Password reset required before continuing.',
      code: 'PASSWORD_RESET_REQUIRED',
    });
  }
  // MFA gate (per-session). Password reset is resolved first (above); then, if MFA is required for
  // this user, no protected resource is reachable until they enroll (setup) and/or verify (pending).
  if (req.mfaEnabled) {
    if (!req.mfaConfirmed) {
      return res.status(403).json({ error: 'Multi-factor authentication setup required.', code: 'MFA_SETUP_REQUIRED' });
    }
    if (req.mfaClaim !== 'ok') {
      return res.status(403).json({ error: 'Multi-factor authentication required.', code: 'MFA_REQUIRED' });
    }
  }
  next();
}
