import * as authService from '../services/authService.js';
import { changeOwnPassword, issueFullSession } from '../services/authService.js';
import { toPublicUser } from '../services/userService.js';
import * as mfa from '../services/mfaService.js';
import { recordAudit } from '../services/auditService.js';
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
      mfaStage: result.mfaStage, // 'ok' | 'setup' (must scan QR) | 'pending' (must enter code)
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
  res.json({
    user: req.user,
    mustResetPassword: req.mustResetPassword,
    mfa: { enabled: !!req.mfaEnabled, enrolled: !!req.mfaConfirmed, satisfied: req.mfaClaim === 'ok' },
  });
}

// --- MFA (in-house TOTP) — all strictly scoped to the authenticated user (req.authUserRow) -------
function guardMfa(req, res, { stage }) {
  if (req.mustResetPassword) { res.status(403).json({ error: 'Password reset required first.', code: 'PASSWORD_RESET_REQUIRED' }); return false; }
  if (!req.mfaEnabled) { res.status(400).json({ error: 'MFA is not enabled for this account.', code: 'MFA_NOT_ENABLED' }); return false; }
  if (stage === 'setup' && req.mfaConfirmed && req.mfaClaim === 'ok') { res.status(409).json({ error: 'MFA is already set up.', code: 'MFA_ALREADY_SET' }); return false; }
  if (stage === 'verify' && !req.mfaConfirmed) { res.status(400).json({ error: 'MFA is not set up yet.', code: 'MFA_SETUP_REQUIRED' }); return false; }
  return true;
}

// Begin enrollment — returns the QR (data URI), manual Base32 key, and otpauth URI.
export async function mfaSetup(req, res, next) {
  try {
    if (!guardMfa(req, res, { stage: 'setup' })) return;
    res.json(await mfa.beginSetup(req.authUserRow));
  } catch (err) { next(err); }
}

// Confirm enrollment with the first code → activate MFA, return one-time recovery codes, full session.
export async function mfaEnroll(req, res, next) {
  try {
    if (!guardMfa(req, res, { stage: 'setup' })) return;
    const result = await mfa.confirmEnrollment(req.authUserRow, req.body?.code);
    if (result.error) return res.status(400).json({ error: 'That authentication code is not valid. Please try again.', code: 'MFA_INVALID' });
    const csrfToken = establishSession(res, await issueFullSession(req.authUserRow, ctxOf(req)));
    await recordAudit({ actorUserId: req.authUserId, action: 'auth.mfa.enrolled', ...ctxOf(req) });
    res.json({ ok: true, recoveryCodes: result.recoveryCodes, csrfToken });
  } catch (err) { next(err); }
}

// Verify a login code → full session.
export async function mfaVerify(req, res, next) {
  try {
    if (!guardMfa(req, res, { stage: 'verify' })) return;
    const result = await mfa.verifyCode(req.authUserRow, req.body?.code);
    if (result.error === 'locked') return res.status(423).json({ error: `Too many attempts. Try again in ${result.minutesLeft} minute(s).`, code: 'MFA_LOCKED' });
    if (result.error) return res.status(400).json({ error: 'That authentication code is not valid.', code: 'MFA_INVALID' });
    const csrfToken = establishSession(res, await issueFullSession(req.authUserRow, ctxOf(req)));
    await recordAudit({ actorUserId: req.authUserId, action: 'auth.mfa.verified', ...ctxOf(req) });
    res.json({ ok: true, csrfToken });
  } catch (err) { next(err); }
}

// Verify a one-time recovery code → full session (consumes the code).
export async function mfaRecovery(req, res, next) {
  try {
    if (!guardMfa(req, res, { stage: 'verify' })) return;
    const result = await mfa.verifyRecovery(req.authUserRow, req.body?.code);
    if (result.error === 'locked') return res.status(423).json({ error: `Too many attempts. Try again in ${result.minutesLeft} minute(s).`, code: 'MFA_LOCKED' });
    if (result.error) return res.status(400).json({ error: 'That recovery code is not valid or already used.', code: 'MFA_INVALID' });
    const csrfToken = establishSession(res, await issueFullSession(req.authUserRow, ctxOf(req)));
    await recordAudit({ actorUserId: req.authUserId, action: 'auth.mfa.recovery_used', ...ctxOf(req) });
    res.json({ ok: true, remaining: result.remaining, csrfToken });
  } catch (err) { next(err); }
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
