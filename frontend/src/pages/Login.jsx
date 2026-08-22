import { useState } from 'react';
import PasswordInput from '../components/PasswordInput.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { toApiError } from '../lib/api.js';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (e2) {
      setErr(toApiError(e2).message);
      setBusy(false);
    }
  }

  return (
    <div className="login-stage">
      {/* Subtle ambient depth — two slow, low-opacity glows behind the panel */}
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
          <span className="lc-chip"><span className="chip-dot" /> Provider Portal</span>
          <h1>Access the System</h1>
          <p>Welcome back. Sign in to your Grelin Health workspace.</p>
        </div>

        {err && (
          <div className="lf-alert" role="alert">
            <span className="lf-alert-ic">!</span>
            <span>{err}</span>
          </div>
        )}

        <form className="lc-fields" onSubmit={onSubmit} noValidate>
          <div className="field lf-anim" style={{ '--d': '0.10s' }}>
            <label htmlFor="email">Username</label>
            <input
              id="email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="provider@grelinhealth.com"
              autoComplete="username"
              required
            />
          </div>

          <div className="field lf-anim" style={{ '--d': '0.17s' }}>
            <label htmlFor="password">Authentication</label>
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
            />
          </div>

          <button className="btn lg block lf-anim lf-cta" style={{ '--d': '0.24s' }} type="submit" disabled={busy || !email || !password}>
            {busy ? <span className="spinner" /> : <><span>Access the System</span><span className="cta-arrow">→</span></>}
          </button>
        </form>

        <div className="lc-copy">© {new Date().getFullYear()} Grelin Health. All rights reserved.</div>
      </div>
    </div>
  );
}
