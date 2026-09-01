import { config } from '../config/env.js';

/**
 * Cookie names. Tokens live in httpOnly cookies (unreadable by JS → XSS-resistant).
 * The CSRF token is a readable cookie used for the double-submit pattern.
 */
export const COOKIE = {
  ACCESS: 'gh_at',
  REFRESH: 'gh_rt',
  CSRF: 'gh_csrf',
};

const baseCookie = {
  httpOnly: true,
  secure: config.isProd, // requires HTTPS in production
  sameSite: 'strict',
  path: '/',
};

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(COOKIE.ACCESS, accessToken, { ...baseCookie, maxAge: config.jwt.accessTtl * 1000 });
  // During an MFA-pending/setup stage no refresh token is issued (a half-authenticated session
  // must NOT be persistable) — only set the refresh cookie when one is present.
  if (refreshToken) {
    res.cookie(COOKIE.REFRESH, refreshToken, {
      ...baseCookie,
      maxAge: config.jwt.refreshTtl * 1000,
      path: '/', // scoped by the gateway; kept simple and consistent here
    });
  }
}

export function setCsrfCookie(res, token) {
  res.cookie(COOKIE.CSRF, token, {
    httpOnly: false, // must be readable by the SPA to echo back in a header
    secure: config.isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: config.jwt.accessTtl * 1000,
  });
}

export function clearAuthCookies(res) {
  const opts = { ...baseCookie };
  res.clearCookie(COOKIE.ACCESS, opts);
  res.clearCookie(COOKIE.REFRESH, opts);
  res.clearCookie(COOKIE.CSRF, { ...opts, httpOnly: false });
}
