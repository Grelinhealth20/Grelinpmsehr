import { verifyAccessToken } from '../utils/tokens.js';
import { COOKIE } from '../utils/cookies.js';
import { findRawByUuid, toPublicUser } from '../services/userService.js';
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

    const row = await findRawByUuid(claims.sub);
    if (!row || row.status === USER_STATUS.DISABLED) {
      return res.status(401).json({ error: 'Session no longer valid.', code: 'USER_INVALID' });
    }

    req.authUserId = row.id;
    req.authUserRow = row;
    req.user = toPublicUser(row);
    req.mustResetPassword = !!row.must_reset_password;
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
  next();
}
