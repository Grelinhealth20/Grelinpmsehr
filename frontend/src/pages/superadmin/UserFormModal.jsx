import { useEffect, useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import PasswordInput from '../../components/PasswordInput.jsx';
import { usersApi, specialtiesApi, toApiError } from '../../lib/api.js';
import { evaluatePassword } from '../../lib/passwordPolicy.js';

const ROLE_OPTIONS = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'provider', label: 'Provider' },
  { value: 'billing', label: 'Billing' },
];
const SCOPES = [
  { value: 'full', label: 'Full' },
  { value: 'standard', label: 'Standard' },
  { value: 'read_only', label: 'Read only' },
];
// Common provider credentials; admins can also add custom tags.
const CREDENTIALS = ['MD', 'DO', 'NP', 'APRN', 'ASNP', 'PA', 'PA-C', 'RN', 'DNP', 'DPM', 'PsyD', 'PhD', 'LCSW'];

function genPassword() {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^&*?-_'];
  const arr = new Uint32Array(16);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < 16; i++) out += sets[i % sets.length][arr[i] % sets[i % sets.length].length];
  return out;
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="seg-ctrl">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`seg-opt ${value === o.value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function UserFormModal({ mode, user, lockedRole, onClose, onSaved }) {
  const isEdit = mode === 'edit';
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [email, setEmail] = useState(user?.email || '');
  const [role, setRole] = useState(
    isEdit ? (user?.role !== 'master_admin' ? user.role : 'super_admin') : lockedRole || 'provider',
  );
  const [scope, setScope] = useState(user?.accessLevel?.scope || 'standard');
  const [notes, setNotes] = useState(user?.accessLevel?.notes || '');
  const [credentials, setCredentials] = useState(user?.credentials || []);
  const [newCred, setNewCred] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  // Specialty (providers only)
  const isProvider = (isEdit ? role : lockedRole || role) === 'provider';
  const [specialties, setSpecialties] = useState([]);
  const [specialtyUuid, setSpecialtyUuid] = useState(user?.specialty?.uuid || null);
  const [newSpec, setNewSpec] = useState('');
  const [addingSpec, setAddingSpec] = useState(false);

  useEffect(() => {
    let active = true;
    if (isProvider) {
      specialtiesApi
        .list()
        .then(({ data }) => active && setSpecialties(data.specialties))
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [isProvider]);

  async function addSpecialty() {
    const name = newSpec.trim();
    if (name.length < 2) return;
    setAddingSpec(true);
    try {
      const { data } = await specialtiesApi.create(name);
      setSpecialties((s) => [...s, data.specialty].sort((a, b) => a.name.localeCompare(b.name)));
      setSpecialtyUuid(data.specialty.uuid);
      setNewSpec('');
    } catch (e) {
      setErr(toApiError(e).message);
    } finally {
      setAddingSpec(false);
    }
  }

  const toggleCred = (c) => setCredentials((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]));
  const addCred = () => {
    const c = newCred.trim().toUpperCase();
    if (c && !credentials.includes(c)) setCredentials((l) => [...l, c]);
    setNewCred('');
  };

  const pw = useMemo(() => evaluatePassword(tempPassword), [tempPassword]);
  const canSubmit =
    fullName.trim().length >= 2 && (isEdit || (/^\S+@\S+\.\S+$/.test(email) && pw.valid)) && !busy;

  const lockedLabel = ROLE_OPTIONS.find((r) => r.value === (lockedRole || role))?.label || role;

  async function onSubmit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      // Preserve any module-level permissions/modules set via Access Control —
      // editing scope/notes must never silently wipe a user's granted access.
      const accessLevel = { ...(user?.accessLevel || {}), scope, notes: notes.trim() || undefined };
      if (isEdit) {
        await usersApi.update(user.uuid, {
          fullName: fullName.trim(),
          role,
          accessLevel,
          credentials: isProvider ? credentials : [],
          specialtyUuid: isProvider ? specialtyUuid || null : null,
        });
      } else {
        await usersApi.create({
          email: email.trim().toLowerCase(),
          fullName: fullName.trim(),
          role: lockedRole || role,
          accessLevel,
          credentials: isProvider ? credentials : undefined,
          specialtyUuid: isProvider ? specialtyUuid || null : undefined,
          temporaryPassword: tempPassword,
        });
      }
      onSaved(isEdit ? 'User updated.' : 'User created. A temporary password was set.');
    } catch (e2) {
      const ae = toApiError(e2);
      setErr(ae.details?.map((d) => d.message || d).join(' ') || ae.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit user' : `Create ${lockedLabel}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={onSubmit} disabled={!canSubmit}>
            {busy ? <span className="spinner" /> : isEdit ? 'Save changes' : 'Create user'}
          </button>
        </>
      }
    >
      {err && <div className="lf-alert" style={{ marginBottom: 14 }}><span className="lf-alert-ic">!</span><span>{err}</span></div>}
      <form className="stack" style={{ gap: 14 }} onSubmit={onSubmit}>
        <div className="field">
          <label>Full name</label>
          <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Doe" />
        </div>

        <div className="field">
          <label>Email address</label>
          <input className="input" type="email" value={email} disabled={isEdit} onChange={(e) => setEmail(e.target.value)} placeholder="user@grelinhealth.com" />
          {isEdit && <span className="hint">Email is the account identity and cannot be changed here.</span>}
        </div>

        <div className="field">
          <label>Role</label>
          {isEdit ? (
            <Segmented options={ROLE_OPTIONS} value={role} onChange={setRole} />
          ) : (
            <span className="role-locked"><span className="chip-dot" style={{ background: 'var(--c-accent)' }} />{lockedLabel}</span>
          )}
        </div>

        <div className="field">
          <label>System access level</label>
          <Segmented options={SCOPES} value={scope} onChange={setScope} />
        </div>

        {isProvider && (
          <div className="field">
            <label>Provider credentials</label>
            <div className="spec-chips">
              {CREDENTIALS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`spec-chip ${credentials.includes(c) ? 'active' : ''}`}
                  onClick={() => toggleCred(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="spec-add">
              <input
                className="input"
                value={newCred}
                maxLength={20}
                placeholder="Add a credential (e.g. FACP)…"
                onChange={(e) => setNewCred(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCred(); } }}
              />
              <button type="button" className="btn ghost sm" onClick={addCred} disabled={!newCred.trim()}>+ Add</button>
            </div>
            {credentials.length > 0 && <span className="hint">Selected: {credentials.join(', ')}</span>}
          </div>
        )}

        {isProvider && (
          <div className="field">
            <label>Specialty</label>
            <div className="spec-chips">
              {specialties.map((s) => (
                <button
                  key={s.uuid}
                  type="button"
                  className={`spec-chip ${specialtyUuid === s.uuid ? 'active' : ''}`}
                  onClick={() => setSpecialtyUuid(specialtyUuid === s.uuid ? null : s.uuid)}
                >
                  {s.name}
                </button>
              ))}
              {specialties.length === 0 && <span className="hint">No specialties yet — add one below.</span>}
            </div>
            <div className="spec-add">
              <input
                className="input"
                value={newSpec}
                maxLength={120}
                placeholder="Add a new specialty…"
                onChange={(e) => setNewSpec(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSpecialty(); } }}
              />
              <button type="button" className="btn ghost sm" onClick={addSpecialty} disabled={addingSpec || newSpec.trim().length < 2}>
                {addingSpec ? <span className="spinner dark" /> : '+ Add'}
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label>Access notes <span className="muted">(optional)</span></label>
          <input className="input" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Billing module only" />
        </div>

        {!isEdit && (
          <div className="field">
            <label>Temporary password</label>
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1 }}>
                <PasswordInput value={tempPassword} onChange={(e) => setTempPassword(e.target.value)} autoComplete="new-password" invalid={tempPassword.length > 0 && !pw.valid} />
              </div>
              <button type="button" className="btn ghost sm" onClick={() => setTempPassword(genPassword())}>Generate</button>
            </div>
            <span className="hint">The user must change this on first login. Min 12 chars, mixed case, number &amp; symbol.</span>
          </div>
        )}
      </form>
    </Modal>
  );
}
