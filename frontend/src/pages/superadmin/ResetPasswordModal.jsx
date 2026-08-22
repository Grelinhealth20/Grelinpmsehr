import { useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import PasswordInput from '../../components/PasswordInput.jsx';
import { usersApi, toApiError } from '../../lib/api.js';
import { evaluatePassword } from '../../lib/passwordPolicy.js';

function genPassword() {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^&*?-_'];
  const arr = new Uint32Array(16);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < 16; i++) out += sets[i % sets.length][arr[i] % sets[i % sets.length].length];
  return out;
}

export default function ResetPasswordModal({ user, onClose, onSaved }) {
  const [temp, setTemp] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const pw = useMemo(() => evaluatePassword(temp), [temp]);

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      await usersApi.resetPassword(user.uuid, temp);
      onSaved(`Temporary password set for ${user.email}. They must reset it on next login.`);
    } catch (e) {
      const ae = toApiError(e);
      setErr(ae.details?.map((d) => d.message || d).join(' ') || ae.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Reset password"
      size="full"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={submit} disabled={!pw.valid || busy}>
            {busy ? <span className="spinner" /> : 'Set temporary password'}
          </button>
        </>
      }
    >
      {err && <div className="alert error" style={{ marginBottom: 14 }}><span>⚠</span><span>{err}</span></div>}
      <p className="muted" style={{ marginBottom: 14 }}>
        Set a temporary password for <strong style={{ color: 'var(--c-ink)' }}>{user.email}</strong>. They will be
        required to choose a new one at their next sign-in.
      </p>
      <div className="field">
        <label>Temporary password</label>
        <div className="row" style={{ gap: 8 }}>
          <div style={{ flex: 1 }}>
            <PasswordInput value={temp} onChange={(e) => setTemp(e.target.value)} autoComplete="new-password" invalid={temp.length > 0 && !pw.valid} />
          </div>
          <button type="button" className="btn ghost sm" onClick={() => setTemp(genPassword())}>Generate</button>
        </div>
      </div>
    </Modal>
  );
}
