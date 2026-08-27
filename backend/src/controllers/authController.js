import * as authService from '../services/authService.js';
import { changeOwnPassword } from '../services/authService.js';
import { toPublicUser } from '../services/userService.js';
import { setAuthCookies, setCsrfCookie, clearAuthCookies, COOKIE } from '../utils/cookies.js';
import { randomToken } from '../utils/crypto.js';

function ctxOf(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

function establishSession(res, session) {
  setAuthCookies(res, session);
  const csrf = randomToken(24);
  setCsrfCookie(res, csrf);
  return csrf;
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await authService.login(email, password, ctxOf(req));
    const csrfToken = establishSession(res, result);
    res.json({
      user: toPublicUser(result.user),
      mustResetPassword: result.mustResetPassword,
      csrfToken,
    });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE.REFRESH];
    const result = await authService.refresh(token, ctxOf(req));
    const csrfToken = establishSession(res, result);
    res.json({ user: toPublicUser(result.user), csrfToken });
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    await authService.logout(req.cookies?.[COOKIE.REFRESH], { ip: req.ip, userAgent: req.get('user-agent') });
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function me(req, res) {
  res.json({ user: req.user, mustResetPassword: req.mustResetPassword });
}

export async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    await changeOwnPassword(req.user.uuid, currentPassword, newPassword, ctxOf(req));
    // Credentials changed → all sessions revoked. Clear cookies; client re-logs in.
    clearAuthCookies(res);
    res.json({ ok: true, message: 'Password updated. Please sign in again.' });
  } catch (err) {
    next(err);
  }
}
