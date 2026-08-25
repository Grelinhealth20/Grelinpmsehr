import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import {
  activeAccessSecret, accessSecrets, activeRefreshSecret, refreshSecrets,
} from '../services/keyRotationService.js';

const OPTS = { issuer: 'grelin-pms', audience: 'grelin-web' };

/** Try each secret in the rotation ring until one verifies; else throw the last error. */
function verifyWithRing(token, secrets) {
  let lastErr = new Error('no signing secret available');
  for (const secret of secrets) {
    try { return jwt.verify(token, secret, OPTS); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

/**
 * Short-lived access token (carried in an httpOnly cookie). Contains only the
 * minimum claims needed for authorization — never PHI. Signed with the newest
 * rotating secret; verified against the whole ring so rotation never logs anyone out.
 */
export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.uuid,
      role: user.role,
      mrp: !!user.must_reset_password, // must-reset-password flag
    },
    activeAccessSecret(),
    { expiresIn: config.jwt.accessTtl, ...OPTS },
  );
}

export function verifyAccessToken(token) {
  return verifyWithRing(token, accessSecrets());
}

/** Opaque refresh token identity, signed so we can detect tampering early. */
export function signRefreshToken(jti, userUuid) {
  return jwt.sign({ sub: userUuid, jti }, activeRefreshSecret(), { expiresIn: config.jwt.refreshTtl, ...OPTS });
}

export function verifyRefreshToken(token) {
  return verifyWithRing(token, refreshSecrets());
}
