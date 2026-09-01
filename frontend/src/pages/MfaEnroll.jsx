import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi, toApiError } from '../lib/api.js';

/**
 * First-login MFA enrollment. Fetches a fresh authenticator secret, shows the QR to scan (with the
 * manual Base32 key as a fallback), verifies the first code, then presents one-time recovery codes.
 */
export default function MfaEnroll() {
  const { user, logout, completeMfa } = useAuth();
  const [setup, setSetup] = useState(null); // { qr, manualKey, otpauthUri, issuer }
  const [code, setCode] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(null); // shown once after enrollment
  const [csrf, setCsrf] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    authApi.mfaSetup()
      .then(({ data }) => { if (active) setSetup(data); })
      .catch((e) => { if (active) setLoadErr(toApiError(e).message); });
    return () => { active = false; };
  }, []);

  async function onVerify(e) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const { data } = await authApi.mfaEnroll(code.replace(/\s/g, ''));
      setRecovery(data.recoveryCodes || []);
      setCsrf(data.csrfToken || null);
    } catch (e2) { setErr(toApiError(e2).message); setBusy(false); }
  }

  function finish() { completeMfa(csrf); }
  function copyCodes() {
    try { navigator.clipboard.writeText((recovery || []).join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }

  return (
    <div className="login-stage">
      <div className="login-bg" aria-hidden="true"><span className="orb o1" /><span className="orb o2" /></div>
      <div className="login-card mfa-card">
        <span className="lc-topline" />
        <div className="lc-logo-wrap"><img className="lc-logo" src="/Grelin_logo.png" alt="Grelin Health" /></div>

        {recovery ? (
          <>
            <div className="lc-head">
              <span className="lc-chip"><span className="chip-dot" /> Save These Codes</span>
              <h1>Recovery Codes</h1>
              <p>Store these somewhere safe. Each code works <strong>once</strong> if you ever lose your authenticator. They will not be shown again.</p>
            </div>
            <div className="mfa-recovery">{recovery.map((c) => <code key={c}>{c}</code>)}</div>
            <div className="mfa-row">
              <button className="btn ghost" type="button" onClick={copyCodes}>{copied ? 'Copied ✓' : 'Copy codes'}</button>
              <button className="btn lg" type="button" onClick={finish}>I’ve saved them — Continue →</button>
            </div>
          </>
        ) : (
          <>
            <div className="lc-head">
              <span className="lc-chip"><span className="chip-dot" /> Secure Your Account</span>
              <h1>Set Up Authentication</h1>
              <p>Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) for {user?.email}.</p>
            </div>

            {loadErr ? <div className="lf-alert" role="alert"><span className="lf-alert-ic">!</span><span>{loadErr}</span></div> : !setup ? (
              <div className="mfa-qr-loading"><span className="spinner" /> Generating your secure key…</div>
            ) : (
              <>
                <div className="mfa-qr"><img src={setup.qr} alt="MFA QR code" width="200" height="200" /></div>
                <div className="mfa-manual">
                  <span className="mfa-manual-lbl">Can’t scan? Enter this key manually:</span>
                  <code className="mfa-key">{setup.manualKey}</code>
                </div>
                {err && <div className="lf-alert" role="alert"><span className="lf-alert-ic">!</span><span>{err}</span></div>}
                <form className="lc-fields" onSubmit={onVerify} noValidate>
                  <div className="field">
                    <label htmlFor="mfacode">Enter the 6-digit code from your app</label>
                    <input id="mfacode" className="input mfa-code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                      value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" autoFocus />
                  </div>
                  <button className="btn lg block" type="submit" disabled={code.length !== 6 || busy}>
                    {busy ? <span className="spinner" /> : <><span>Verify &amp; Activate</span><span className="cta-arrow">→</span></>}
                  </button>
                </form>
              </>
            )}
          </>
        )}
        <button className="lc-signout" onClick={logout}>Sign out</button>
        <div className="lc-copy">© {new Date().getFullYear()} Grelin Health. All rights reserved.</div>
      </div>
    </div>
  );
}
