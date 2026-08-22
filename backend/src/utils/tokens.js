import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

/**
 * Short-lived access token (carried in an httpOnly cookie). Contains only the
 * minimum claims needed for authorization — never PHI.
 */
export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.uuid,
      role: user.role,
      mrp: !!user.must_reset_password, // must-reset-password flag
    },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtl, issuer: 'grelin-pms', audience: 'grelin-web' },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.accessSecret, {
    issuer: 'grelin-pms',
    audience: 'grelin-web',
  });
}

/** Opaque refresh token identity, signed so we can detect tampering early. */
export function signRefreshToken(jti, userUuid) {
  return jwt.sign({ sub: userUuid, jti }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshTtl,
    issuer: 'grelin-pms',
    audience: 'grelin-web',
  });
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret, {
    issuer: 'grelin-pms',
    audience: 'grelin-web',
  });
}
