import { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { usersApi, toApiError } from '../../lib/api.js';

function Switch({ checked, onChange, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
    </label>
  );
}

// Two blank systems. Each row targets a permission namespace (`ns`) + key so the
// stored shape stays { pms:{access}, billing:{editPatient,deletePatient},
// ehr:{access,editNotes,deleteNotes} }. The top "Access …" toggle in each group
// gates whether the user can enter that system at all.
const GROUPS = [
  {
    label: 'EHR System',
    badge: 'ehr',
    rows: [
      { ns: 'ehr', key: 'access', label: 'Access EHR System', desc: 'Sign in to and navigate the EHR System.' },
      { ns: 'ehr', key: 'editNotes', label: 'Edit Notes', desc: 'Amend clinical notes in the health record.' },
      { ns: 'ehr', key: 'deleteNotes', label: 'Delete Notes', desc: 'Remove clinical notes from the health record.' },
    ],
  },
  {
    label: 'Billing Module',
    badge: 'billing',
    rows: [
      { ns: 'pms', key: 'access', label: 'Access Billing Module', desc: 'Sign in to and navigate the Billing Module.' },
      { ns: 'billing', key: 'editPatient', label: 'Edit Patient', desc: 'Modify patient billing records.' },
      { ns: 'billing', key: 'deletePatient', label: 'Delete Patient', desc: 'Remove patient billing records.' },
    ],
  },
];

export default function AccessControlModal({ user, onClose, onSaved }) {
  const initial = user?.accessLevel?.permissions || {};
  const [perms, setPerms] = useState({
    pms: { access: !!initial.pms?.access },
    billing: { editPatient: !!initial.billing?.editPatient, deletePatient: !!initial.billing?.deletePatient },
    ehr: { access: !!initial.ehr?.access, editNotes: !!initial.ehr?.editNotes, deleteNotes: !!initial.ehr?.deleteNotes },
  });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (ns, key, val) => setPerms((p) => ({ ...p, [ns]: { ...p[ns], [key]: val } }));

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const accessLevel = { ...(user.accessLevel || {}), permissions: perms };
      // scope/notes are preserved; strip any nullish extras the API rejects.
      if (accessLevel.scope === undefined) delete accessLevel.scope;
      await usersApi.update(user.uuid, { accessLevel });
      onSaved('Access controls updated.');
    } catch (e) {
      setErr(toApiError(e).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Access Control"
      width={540}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : 'Save access'}
          </button>
        </>
      }
    >
      {err && <div className="lf-alert" style={{ marginBottom: 14 }}><span className="lf-alert-ic">!</span><span>{err}</span></div>}
      <p className="ac-intro">
        Grant module-level permissions for <strong style={{ color: 'var(--c-ink)' }}>{user.fullName}</strong> ({user.email}).
      </p>

      {GROUPS.map((g) => (
        <div className="ac-group" key={g.label}>
          <div className="ac-group-head"><span className={`ac-badge ${g.badge}`} />{g.label}</div>
          {g.rows.map((r) => (
            <div className="ac-row" key={`${r.ns}.${r.key}`}>
              <div>
                <div className="ac-label">{r.label}</div>
                <div className="ac-desc">{r.desc}</div>
              </div>
              <Switch checked={!!perms[r.ns]?.[r.key]} onChange={(v) => set(r.ns, r.key, v)} />
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}
