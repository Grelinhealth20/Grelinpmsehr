import { useMemo, useState } from 'react';
import PasswordInput from '../components/PasswordInput.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi, toApiError } from '../lib/api.js';
import { evaluatePassword } from '../lib/passwordPolicy.js';

export default function ForcePasswordReset() {
  const { user, completePasswordReset, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const strength = useMemo(() => evaluatePassword(next), [next]);
  const matches = next.length > 0 && next === confirm;
  const canSubmit = current && strength.valid && matches && !busy;

  async function onSubmit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      setDone(true);
      setTimeout(() => completePasswordReset(), 1600);
    } catch (e2) {
      const ae = toApiError(e2);
      setErr(ae.details?.length ? ae.details.join(' ') : ae.message);
      setBusy(false);
    }
  }

  const barColor =
    strength.score >= 100 ? 'var(--c-accent)' : strength.score >= 66 ? 'var(--c-blue)' : 'var(--c-dark-blue)';

  return (
    <div className="login-stage">
      <div className="login-bg" aria-hidden="true">
        <span className="orb o1" />
        <span className="orb o2" />
      </div>

      <div className="login-card">
        <span className="lc-topline" />

        <div className="lc-logo-wrap">
          <img className="lc-logo" src="/Grelin_logo.png" alt="Grelin Health" />
        </div>

        <div className="lc-head">
          <span className="lc-chip"><span className="chip-dot" /> Action Required</span>
          <h1>Set a New Password</h1>
          <p>Create a new password for {user?.email} to continue.</p>
        </div>

        {done ? (
          <div className="lf-alert lf-ok"><span className="lf-alert-ic">✓</span><span>Password updated. Redirecting to sign in…</span></div>
        ) : (
          <>
            {err && (
              <div className="lf-alert" role="alert">
                <span className="lf-alert-ic">!</span>
                <span>{err}</span>
              </div>
            )}
            <form className="lc-fields" onSubmit={onSubmit} noValidate>
              <div className="field lf-anim" style={{ '--d': '0.08s' }}>
                <label htmlFor="cur">Current / temporary password</label>
                <PasswordInput id="cur" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
              </div>

              <div className="field lf-anim" style={{ '--d': '0.14s' }}>
                <label htmlFor="new">New password</label>
                <PasswordInput id="new" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" invalid={next.length > 0 && !strength.valid} />
                {next.length > 0 && (
                  <div className="pw-meter">
                    <div className="pw-track"><div className="pw-fill" style={{ width: `${strength.score}%`, background: barColor }} /></div>
                    <span className="pw-label" style={{ color: barColor }}>{strength.strength}</span>
                  </div>
                )}
                <ul className="pw-checks">
                  {strength.checks.map((c) => (
                    <li key={c.id} className={c.ok ? 'ok' : ''}>{c.ok ? '✓' : '○'} {c.label}</li>
                  ))}
                </ul>
              </div>

              <div className="field lf-anim" style={{ '--d': '0.20s' }}>
                <label htmlFor="cf">Confirm new password</label>
                <PasswordInput id="cf" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" invalid={confirm.length > 0 && !matches} />
                {confirm.length > 0 && !matches && <span className="hint" style={{ color: 'var(--c-danger)' }}>Passwords do not match.</span>}
              </div>

              <button className="btn lg block lf-anim lf-cta" style={{ '--d': '0.26s' }} type="submit" disabled={!canSubmit}>
                {busy ? <span className="spinner" /> : <><span>Update Password</span><span className="cta-arrow">→</span></>}
              </button>
            </form>
          </>
        )}

        <button className="lc-signout" onClick={logout}>Sign out</button>
        <div className="lc-copy">© {new Date().getFullYear()} Grelin Health. All rights reserved.</div>
      </div>
    </div>
  );
}
