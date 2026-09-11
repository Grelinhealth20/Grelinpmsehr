import * as authService from '../services/authService.js';
import { changeOwnPassword, issueFullSession } from '../services/authService.js';
import { toPublicUser } from '../services/userService.js';
import { referralsEnabledForProvider } from '../services/facilityFaxService.js';
import * as mfa from '../services/mfaService.js';
import { recordAudit } from '../services/auditService.js';
import { setAuthCookies, setCsrfCookie, clearAuthCookies, COOKIE } from '../utils/cookies.js';
import { randomToken } from '../utils/crypto.js';
import { viewerScope } from '../services/accessScope.js';
import { logger } from '../config/logger.js';

function ctxOf(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

function establishSession(res, session) {
  setAuthCookies(res, session);
  const csrf = randomToken(24);
  setCsrfCookie(res, csrf);
  // Fire-and-forget: pre-warm this user's access-scope caches (MD flag + service lines + facility ids) the
  // moment a session is granted, so the FIRST table they open (Patients / Encounters / Notes / Referrals /
  // Clinical Records — all use viewerScope) is already warm (~0.5s) instead of paying ~3 cold sequential
  // round-trips (~2.3s) to the remote DB. Non-blocking — never delays or fails the login response.
  const uid = session?.user?.id;
  if (uid) viewerScope(uid).catch((e) => logger.warn({ err: e.message, uid }, 'scope pre-warm failed (non-fatal)'));
  return csrf;
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await authService.login(email, password, ctxOf(req));
    const csrfToken = establishSession(res, result);
    let referrals = true;
    try { referrals = await referralsEnabledForProvider(result.user.id); } catch { referrals = true; }
    // Do NOT reveal the account's identity (name / role / NPI / license) until the SECOND factor is
    // satisfied: on an MFA-pending / enrollment-required login (password correct, code not yet entered) a
    // stolen-password holder must not see the victim's professional identity. Return only the minimal
    // handle the MFA screens need; the full profile is fetched from /me after MFA completes.
    const settled = result.mfaStage === 'ok';
    res.json({
      user: settled ? toPublicUser(result.user) : { uuid: result.user.uuid },
      mustResetPassword: result.mustResetPassword,
      mfaStage: result.mfaStage, // 'ok' | 'setup' (must scan QR) | 'pending' (must enter code)
      features: { referrals },
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
  // Per-facility feature availability for THIS user (drives which sections the EHR shell shows).
  let referrals = true;
  try { referrals = await referralsEnabledForProvider(req.authUserId); } catch { referrals = true; }
  res.json({
    user: req.user,
    mustResetPassword: req.mustResetPassword,
    mfa: { enabled: !!req.mfaEnabled, enrolled: !!req.mfaConfirmed, satisfied: req.mfaClaim === 'ok' },
    features: { referrals },
  });
}

// --- MFA (in-house TOTP) — all strictly scoped to the authenticated user (req.authUserRow) -------
function guardMfa(req, res, { stage }) {
  if (req.mustResetPassword) { res.status(403).json({ error: 'Password reset required first.', code: 'PASSWORD_RESET_REQUIRED' }); return false; }
  if (!req.mfaEnabled) { res.status(400).json({ error: 'MFA is not enabled for this account.', code: 'MFA_NOT_ENABLED' }); return false; }
  // Block the enroll/confirm path for ANY already-enrolled user (not only a fully-satisfied session):
  // an mfa-'pending' mid-login session is still mfaConfirmed, and letting it re-run confirmEnrollment was
  // a TOTP-replay bypass (confirm ignored mfa_last_step) that also silently rotated the victim's recovery
  // codes. Re-enrolling a new authenticator goes through an admin reset (which clears mfa_confirmed_at first).
  if (stage === 'setup' && req.mfaConfirmed) { res.status(409).json({ error: 'MFA is already set up.', code: 'MFA_ALREADY_SET' }); return false; }
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
