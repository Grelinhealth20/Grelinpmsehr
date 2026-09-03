import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi, toApiError } from '../lib/api.js';
import OtpInput from '../components/OtpInput.jsx';

/**
 * Login MFA challenge — shown after a correct password when the account has MFA enrolled. The user
 * enters the current 6-digit authenticator code, or falls back to a one-time recovery code.
 */
export default function MfaChallenge() {
  const { user, logout, completeMfa } = useAuth();
  const [code, setCode] = useState('');
  const [mode, setMode] = useState('totp'); // 'totp' | 'recovery'
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false); // guard against auto-submit + click double-fire

  const submit = useCallback(async (raw) => {
    if (submitting.current) return;
    submitting.current = true;
    setErr(null); setBusy(true);
    try {
      const clean = mode === 'totp' ? String(raw).replace(/\D/g, '') : String(raw).trim().toUpperCase();
      const { data } = mode === 'totp' ? await authApi.mfaVerify(clean) : await authApi.mfaRecovery(clean);
      completeMfa(data.csrfToken);
    } catch (e2) {
      setErr(toApiError(e2).message); setBusy(false); submitting.current = false;
      if (mode === 'totp') setCode(''); // clear the boxes so the next attempt starts fresh
    }
  }, [mode, completeMfa]);

  function onSubmit(e) { e.preventDefault(); submit(code); }

  const ready = mode === 'totp' ? code.length === 6 : code.replace(/[\s-]/g, '').length >= 10;

  return (
    <div className="login-stage">
      <div className="login-bg" aria-hidden="true"><span className="orb o1" /><span className="orb o2" /></div>
      <div className="login-card mfa-card">
        <span className="lc-topline" />
        <div className="lc-logo-wrap"><img className="lc-logo" src="/Grelin_logo.png" alt="Grelin Health" /></div>
        <div className="lc-head">
          <span className="lc-chip"><span className="chip-dot" /> Verify Identity</span>
          <h1>Two-Factor Authentication</h1>
          <p>{mode === 'totp'
            ? <>Enter the 6-digit code from your authenticator app to finish signing in as {user?.email}.</>
            : <>Enter one of your one-time recovery codes.</>}</p>
        </div>

        {err && <div className="lf-alert" role="alert"><span className="lf-alert-ic">!</span><span>{err}</span></div>}

        <form className="lc-fields" onSubmit={onSubmit} noValidate>
          {mode === 'totp' ? (
            <div className={`otp-field${err ? ' has-error' : ''}`}>
              <label className="otp-label" htmlFor="mfa-otp">Authentication code</label>
              <OtpInput
                value={code}
                onChange={(v) => { setCode(v); if (err) setErr(null); }}
                onComplete={(v) => submit(v)}
                autoFocus
                disabled={busy}
                invalid={!!err}
                ariaLabel="6-digit authentication code"
              />
              <span className="otp-hint">6-digit code · refreshes every 30 seconds</span>
            </div>
          ) : (
            <div className="field">
              <label className="otp-label" htmlFor="mfa-recovery">Recovery code</label>
              <input id="mfa-recovery" className="input mfa-code-input recovery" autoComplete="off" maxLength={11}
                value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXXX-XXXXX" autoFocus />
            </div>
          )}
          <button className="btn lg block" type="submit" disabled={!ready || busy}>
            {busy ? <span className="spinner" /> : <><span>Verify</span><span className="cta-arrow">→</span></>}
          </button>
        </form>

        <button className="mfa-switch" type="button" onClick={() => { setMode(mode === 'totp' ? 'recovery' : 'totp'); setCode(''); setErr(null); }}>
          {mode === 'totp' ? 'Lost your device? Use a recovery code' : 'Use your authenticator app instead'}
        </button>
        <button className="lc-signout" onClick={logout}>Sign out</button>
        <div className="lc-copy">© {new Date().getFullYear()} Grelin Health. All rights reserved.</div>
      </div>
    </div>
  );
}
