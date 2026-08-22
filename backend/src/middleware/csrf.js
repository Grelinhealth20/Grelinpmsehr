import { COOKIE } from '../utils/cookies.js';
import { safeEqual } from '../utils/crypto.js';

/**
 * Stateless double-submit CSRF protection. The SPA reads the (non-httpOnly)
 * CSRF cookie and echoes it in the X-CSRF-Token header; we require the two to
 * match on every state-changing request. Safe (read-only) methods are exempt.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const cookieToken = req.cookies?.[COOKIE.CSRF];
  const headerToken = req.get('x-csrf-token');

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.', code: 'CSRF_FAILED' });
  }
  next();
}
