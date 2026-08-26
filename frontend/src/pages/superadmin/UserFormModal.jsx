import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import PasswordInput from '../../components/PasswordInput.jsx';
import { usersApi, specialtiesApi, facilitiesApi, toApiError } from '../../lib/api.js';
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
  const isMasterUser = isEdit && user?.role === 'master_admin';
  const [role, setRole] = useState(isEdit ? user.role : lockedRole || 'provider');
  const [scope, setScope] = useState(user?.accessLevel?.scope || 'standard');
  const [notes, setNotes] = useState(user?.accessLevel?.notes || '');
  const [credentials, setCredentials] = useState(user?.credentials || []);
  const [newCred, setNewCred] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  // NPPES registry identity (individual provider, NPI-1): the provider's own NPI +
  // primary taxonomy, fetched and verified from the CMS registry.
  const [npi, setNpi] = useState(user?.npi || '');
  const [taxonomy, setTaxonomy] = useState(user?.taxonomy || '');
  const [taxonomyCode, setTaxonomyCode] = useState(user?.taxonomyCode || '');
  const [npiTerm, setNpiTerm] = useState('');
  const [npiResults, setNpiResults] = useState([]);
  const [npiSearching, setNpiSearching] = useState(false);
  const npiDebounce = useRef(null);

  // Facility assignment (providers + billing users) — governs their billing
  // facility and cross-facility isolation.
  const roleNow = isEdit ? role : (lockedRole || role);
  const isAssignable = roleNow === 'provider' || roleNow === 'billing';
  const [allFacilities, setAllFacilities] = useState([]);
  const [facilityUuids, setFacilityUuids] = useState([]);

  useEffect(() => {
    if (!isAssignable) return;
    facilitiesApi.list({ status: 'active' }).then(({ data }) => setAllFacilities(data.facilities || [])).catch(() => {});
    if (isEdit && user?.uuid) {
      usersApi.facilities(user.uuid).then(({ data }) => setFacilityUuids((data.facilities || []).map((f) => f.uuid))).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAssignable]);

  const toggleFacility = (u) => setFacilityUuids((l) => (l.includes(u) ? l.filter((x) => x !== u) : [...l, u]));

  // Specialty (providers only)
  const isProvider = (isEdit ? role : lockedRole || role) === 'provider';
  const [specialties, setSpecialties] = useState([]);
  const [specialtyUuid, setSpecialtyUuid] = useState(user?.specialty?.uuid || null);
  const [newSpec, setNewSpec] = useState('');
  const [newSpecLine, setNewSpecLine] = useState('snf'); // service line for a newly added specialty
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
      const { data } = await specialtiesApi.create(name, newSpecLine);
      setSpecialties((s) => [...s, data.specialty].sort((a, b) => a.name.localeCompare(b.name)));
      setSpecialtyUuid(data.specialty.uuid);
      setNewSpec('');
      setNewSpecLine('snf');
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

  // Auto-trigger the NPPES individual-provider lookup once a name (≥2 chars) or a
  // 10-digit NPI is typed. Providers only.
  useEffect(() => {
    if (!isProvider) return undefined;
    const t = npiTerm.trim();
    const digits = t.replace(/\D/g, '');
    const ready = digits.length === 10 || t.length >= 2;
    if (!ready) { setNpiResults([]); setNpiSearching(false); return undefined; }
    setNpiSearching(true);
    clearTimeout(npiDebounce.current);
    npiDebounce.current = setTimeout(async () => {
      try {
        const params = digits.length === 10 ? { npi: digits } : { q: t };
        const { data } = await usersApi.nppes(params);
        setNpiResults(data.results || []);
      } catch { setNpiResults([]); }
      finally { setNpiSearching(false); }
    }, 400);
    return () => clearTimeout(npiDebounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [npiTerm, isProvider]);

  // Apply a chosen NPPES provider record: fill name, NPI, taxonomy, and merge the
  // registry credential (e.g. MD) into the credential tags. The admin can still edit.
  function chooseProvider(r) {
    if (r.fullName) setFullName(r.fullName);
    setNpi(r.npi || '');
    setTaxonomy(r.taxonomy || '');
    setTaxonomyCode(r.taxonomyCode || '');
    if (Array.isArray(r.credentials) && r.credentials.length) {
      setCredentials((l) => Array.from(new Set([...l, ...r.credentials])));
    }
    setNpiResults([]);
    setNpiTerm('');
  }

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
        const payload = {
          fullName: fullName.trim(),
          accessLevel,
          credentials: isProvider ? credentials : [],
          specialtyUuid: isProvider ? specialtyUuid || null : null,
          npi: isProvider ? npi.trim() : '',
          taxonomy: isProvider ? taxonomy.trim() : '',
          taxonomyCode: isProvider ? taxonomyCode.trim() : '',
        };
        if (!isMasterUser) payload.role = role; // master admin role is immutable
        await usersApi.update(user.uuid, payload);
        if (isAssignable) await usersApi.setFacilities(user.uuid, facilityUuids);
      } else {
        const { data } = await usersApi.create({
          email: email.trim().toLowerCase(),
          fullName: fullName.trim(),
          role: lockedRole || role,
          accessLevel,
          credentials: isProvider ? credentials : undefined,
          specialtyUuid: isProvider ? specialtyUuid || null : undefined,
          npi: isProvider ? npi.trim() : undefined,
          taxonomy: isProvider ? taxonomy.trim() : undefined,
          taxonomyCode: isProvider ? taxonomyCode.trim() : undefined,
          temporaryPassword: tempPassword,
        });
        // Assign the selected facilities to the freshly created user.
        if (isAssignable && data.user?.uuid && facilityUuids.length) {
          await usersApi.setFacilities(data.user.uuid, facilityUuids);
        }
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
      size="full"
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
          {isMasterUser ? (
            <span className="role-locked"><span className="chip-dot" style={{ background: 'var(--c-accent)' }} />Master Admin</span>
          ) : isEdit ? (
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
            <label>NPPES registry lookup <span className="muted">(individual NPI)</span></label>
            <div className="fac-search-box">
              <span className="fac-search-ic" aria-hidden="true" />
              <input
                className="input"
                placeholder="Search by provider name or 10-digit NPI…"
                value={npiTerm}
                onChange={(e) => setNpiTerm(e.target.value)}
              />
              {npiSearching && <span className="spinner dark fac-search-spin" />}
            </div>
            {npiResults.length > 0 && (
              <div className="fac-results">
                {npiResults.map((r) => (
                  <button key={r.npi} type="button" className="fac-result" onClick={() => chooseProvider(r)}>
                    <span className="fac-result-main">
                      <span className="fac-result-name">{r.fullName}{r.credential ? `, ${r.credential}` : ''}</span>
                      <span className="fac-result-sub">{[r.taxonomy, [r.city, r.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="fac-result-meta">
                      <span className="fac-result-npi">NPI {r.npi}</span>
                      {r.status && r.status !== 'active' && <span className="fac-result-tax">{r.status}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!npiSearching && npiTerm.trim().length >= 2 && npiResults.length === 0 && (
              <div className="fac-empty">No matching providers found in the NPPES registry.</div>
            )}
            <div className="fac-grid" style={{ marginTop: 10 }}>
              <div className="fac-fld">
                <label>NPI</label>
                <input className="input" value={npi} maxLength={10} placeholder="10-digit NPI" onChange={(e) => setNpi(e.target.value.replace(/\D/g, '').slice(0, 10))} />
              </div>
              <div className="fac-fld fac-fld-wide">
                <label>Taxonomy <span className="muted">(primary specialty)</span></label>
                <input className="input" value={taxonomy} maxLength={160} placeholder="e.g. Internal Medicine" onChange={(e) => setTaxonomy(e.target.value)} />
              </div>
            </div>
            {taxonomyCode && <span className="hint">Taxonomy code: {taxonomyCode}</span>}
          </div>
        )}

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
                  <span className={`line-tag ${s.serviceLine === 'pain' ? 'pain' : 'snf'}`}>
                    {s.serviceLine === 'pain' ? 'Pain' : 'SNF'}
                  </span>
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
                onChange={(e) => {
                  const v = e.target.value;
                  setNewSpec(v);
                  // Auto-derive the default service line from the name (admin can override below).
                  setNewSpecLine(/\bpain\b/i.test(v) ? 'pain' : 'snf');
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSpecialty(); } }}
              />
              <div className="line-toggle" role="group" aria-label="Service line">
                <button type="button" className={newSpecLine === 'snf' ? 'active' : ''} onClick={() => setNewSpecLine('snf')}>SNF</button>
                <button type="button" className={newSpecLine === 'pain' ? 'active' : ''} onClick={() => setNewSpecLine('pain')}>Pain</button>
              </div>
              <button type="button" className="btn ghost sm" onClick={addSpecialty} disabled={addingSpec || newSpec.trim().length < 2}>
                {addingSpec ? <span className="spinner dark" /> : '+ Add'}
              </button>
            </div>
            <span className="hint">Service line governs clinical data isolation — SNF and Pain providers never see each other's records.</span>
          </div>
        )}

        {isAssignable && (
          <div className="field">
            <label>Assigned facilities <span className="muted">(billing facility &amp; data isolation)</span></label>
            <div className="spec-chips">
              {allFacilities.map((f) => (
                <button
                  key={f.uuid}
                  type="button"
                  className={`spec-chip ${facilityUuids.includes(f.uuid) ? 'active' : ''}`}
                  title={[f.city, f.state].filter(Boolean).join(', ')}
                  onClick={() => toggleFacility(f.uuid)}
                >
                  {f.name}
                </button>
              ))}
              {allFacilities.length === 0 && <span className="hint">No facilities yet — add facilities under the Facilities tab first.</span>}
            </div>
            {facilityUuids.length > 0 && <span className="hint">{facilityUuids.length} facilit{facilityUuids.length === 1 ? 'y' : 'ies'} assigned.</span>}
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
