import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { patientsApi, toApiError } from '../lib/api.js';

const EMPTY = {
  demographics: { firstName: '', lastName: '', dob: '', gender: 'unknown', phone: '', email: '', address: '', city: '', state: '', zip: '', ssn: '' },
  insurance: { payer: '', memberId: '', group: '', planType: '' },
  facility: { facilityName: '', npi: '', unit: '', room: '', admitDate: '', address: '', city: '', state: '', zip: '' },
};
const GENDERS = [['unknown', 'Unknown'], ['male', 'Male'], ['female', 'Female'], ['other', 'Other']];
const DOC_SLOTS = [
  { key: 'license_front', label: "Driver's License — Front" },
  { key: 'license_back', label: "Driver's License — Back" },
  { key: 'insurance_front', label: 'Insurance Card — Front' },
  { key: 'insurance_back', label: 'Insurance Card — Back' },
];
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
export const patientDisplayName = (p) => `${p?.demographics?.firstName || ''} ${p?.demographics?.lastName || ''}`.trim() || '(unnamed)';
const clone = (o) => JSON.parse(JSON.stringify(o));

function Field({ label, value, onChange, type = 'text', required, options, placeholder, maxLength }) {
  return (
    <div className="field">
      <label>{label}{required && <span className="fs-req">*</span>}</label>
      {options ? (
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      ) : (
        <input className="input" type={type} value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function DropZone({ slot, doc, patientUuid, onChanged, disabled }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  async function upload(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error('File exceeds the 10 MB limit.'); return; }
    setBusy(true);
    try { await patientsApi.uploadDocument(patientUuid, slot.key, file); toast.success(`${slot.label} uploaded.`); onChanged(); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }
  async function view() {
    try { const { data } = await patientsApi.documentUrl(patientUuid, doc.uuid); window.open(data.url, '_blank', 'noopener'); }
    catch (e) { toast.error(toApiError(e).message); }
  }
  async function remove() {
    setBusy(true);
    try { await patientsApi.removeDocument(patientUuid, doc.uuid); toast.success('Document removed.'); onChanged(); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  return (
    <div className={`fs-drop ${over ? 'is-over' : ''} ${doc ? 'has-doc' : ''} ${disabled ? 'is-disabled' : ''}`}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (disabled) return; e.preventDefault(); setOver(false); upload(e.dataTransfer.files?.[0]); }}
    >
      <div className="fs-drop-label">{slot.label}</div>
      {doc ? (
        <div className="fs-drop-doc">
          <span className="fs-doc-ic" aria-hidden="true" />
          <span className="fs-doc-name" title={doc.fileName || ''}>{doc.fileName || 'Document'}</span>
          <div className="fs-doc-acts">
            <button type="button" className="act" onClick={view} disabled={busy}>View</button>
            <button type="button" className="act" onClick={() => inputRef.current?.click()} disabled={busy}>Replace</button>
            <button type="button" className="act danger" onClick={remove} disabled={busy}>Remove</button>
          </div>
        </div>
      ) : (
        <button type="button" className="fs-drop-empty" onClick={() => !disabled && inputRef.current?.click()} disabled={disabled}>
          {busy ? <span className="spinner dark" /> : (
            <>
              <span className="fs-drop-plus" aria-hidden="true" />
              <span>{disabled ? 'Save the patient first' : 'Drag & drop or click to upload'}</span>
              <span className="fs-drop-hint">JPG, PNG, WEBP or PDF · max 10 MB</span>
            </>
          )}
        </button>
      )}
      <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}

/**
 * Full patient face sheet as a modal. Create a new patient or manage an existing
 * one (demographics / insurance / SNF facility + license & insurance documents).
 * onSaved(patient) fires on every successful create/update so callers (e.g. the
 * appointment popup) can link to the patient.
 */
export default function PatientModal({ uuid = null, onClose, onSaved }) {
  const toast = useToast();
  const [pUuid, setPUuid] = useState(uuid);
  const [form, setForm] = useState(clone(EMPTY));
  const [docs, setDocs] = useState([]);
  const [mrn, setMrn] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!uuid);

  useEffect(() => {
    let active = true;
    if (uuid) {
      patientsApi.get(uuid).then(({ data }) => {
        if (!active) return;
        setForm({ demographics: { ...EMPTY.demographics, ...data.patient.demographics }, insurance: { ...EMPTY.insurance, ...(data.patient.insurance || {}) }, facility: { ...EMPTY.facility, ...(data.patient.facility || {}) } });
        setDocs(data.documents || []);
        setMrn(data.patient.mrn);
        setLoading(false);
      }).catch((e) => { toast.error(toApiError(e).message); setLoading(false); });
    }
    return () => { active = false; };
  }, [uuid, toast]);

  const setD = (k, v) => setForm((f) => ({ ...f, demographics: { ...f.demographics, [k]: v } }));
  const setI = (k, v) => setForm((f) => ({ ...f, insurance: { ...f.insurance, [k]: v } }));
  const setFac = (k, v) => setForm((f) => ({ ...f, facility: { ...f.facility, [k]: v } }));

  async function reloadDocs() {
    if (!pUuid) return;
    try { const { data } = await patientsApi.listDocuments(pUuid); setDocs(data.documents); } catch { /* ignore */ }
  }

  async function save() {
    const d = form.demographics;
    if (!d.firstName.trim() || !d.lastName.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(d.dob)) {
      toast.error('First name, last name and a valid date of birth are required.');
      return;
    }
    setSaving(true);
    const payload = { demographics: form.demographics, insurance: form.insurance, facility: form.facility };
    try {
      if (pUuid) {
        const { data } = await patientsApi.update(pUuid, payload);
        setMrn(data.patient.mrn);
        toast.success('Face sheet saved.');
        onSaved?.(data.patient);
      } else {
        const { data } = await patientsApi.create(payload);
        setPUuid(data.patient.uuid);
        setMrn(data.patient.mrn);
        toast.success('Patient created. You can now upload documents.');
        onSaved?.(data.patient);
      }
    } catch (e) { toast.error(toApiError(e).message); } finally { setSaving(false); }
  }

  const docFor = (t) => docs.find((x) => x.docType === t);

  return (
    <Modal
      title={pUuid ? 'Patient Face Sheet' : 'New Patient — Face Sheet'}
      width={680}
      onClose={onClose}
      footer={
        <>
          <span className="fs-modal-mrn">{mrn ? `MRN ${mrn}` : 'Complete the required fields to create'}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose} disabled={saving}>Close</button>
          <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spinner" /> : pUuid ? 'Save' : 'Create patient'}</button>
        </>
      }
    >
      {loading ? (
        <div className="fs-empty"><span className="spinner dark" /> Loading…</div>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          <div className="fs-summary">
            <span className="fs-summary-av">{((form.demographics.firstName[0] || '') + (form.demographics.lastName[0] || '')).toUpperCase() || '·'}</span>
            <div className="fs-summary-main">
              <span className="fs-summary-nm">{patientDisplayName({ demographics: form.demographics })}</span>
              <span className="fs-summary-sub">
                {form.demographics.dob ? `DOB ${form.demographics.dob}` : 'New patient'}
                {form.demographics.gender && form.demographics.gender !== 'unknown' ? ` · ${form.demographics.gender}` : ''}
              </span>
            </div>
            {mrn && <span className="fs-summary-mrn">MRN {mrn}</span>}
          </div>

          <div className="fs-section">
            <div className="fs-section-h">Demographics</div>
            <div className="fs-grid fs-grid-3">
              <Field label="First name" required value={form.demographics.firstName} onChange={(v) => setD('firstName', v)} maxLength={80} />
              <Field label="Last name" required value={form.demographics.lastName} onChange={(v) => setD('lastName', v)} maxLength={80} />
              <Field label="Date of birth" required type="date" value={form.demographics.dob} onChange={(v) => setD('dob', v)} />
              <Field label="Gender" options={GENDERS} value={form.demographics.gender} onChange={(v) => setD('gender', v)} />
              <Field label="Phone" value={form.demographics.phone} onChange={(v) => setD('phone', v)} maxLength={40} />
              <Field label="Email" type="email" value={form.demographics.email} onChange={(v) => setD('email', v)} maxLength={254} />
              <Field label="SSN" value={form.demographics.ssn} onChange={(v) => setD('ssn', v)} placeholder="###-##-####" maxLength={11} />
              <Field label="Address" value={form.demographics.address} onChange={(v) => setD('address', v)} maxLength={200} />
              <Field label="City" value={form.demographics.city} onChange={(v) => setD('city', v)} maxLength={80} />
              <Field label="State" value={form.demographics.state} onChange={(v) => setD('state', v)} maxLength={40} />
              <Field label="ZIP" value={form.demographics.zip} onChange={(v) => setD('zip', v)} maxLength={12} />
            </div>
          </div>

          <div className="fs-section">
            <div className="fs-section-h">Insurance</div>
            <div className="fs-grid fs-grid-3">
              <Field label="Payer" value={form.insurance.payer} onChange={(v) => setI('payer', v)} maxLength={120} />
              <Field label="Member ID" value={form.insurance.memberId} onChange={(v) => setI('memberId', v)} maxLength={80} />
              <Field label="Group #" value={form.insurance.group} onChange={(v) => setI('group', v)} maxLength={80} />
              <Field label="Plan type" value={form.insurance.planType} onChange={(v) => setI('planType', v)} maxLength={60} />
            </div>
          </div>

          <div className="fs-section">
            <div className="fs-section-h">SNF Facility</div>
            <div className="fs-grid fs-grid-3">
              <Field label="Facility name" value={form.facility.facilityName} onChange={(v) => setFac('facilityName', v)} maxLength={160} />
              <Field label="NPI" value={form.facility.npi} onChange={(v) => setFac('npi', v)} maxLength={20} />
              <Field label="Unit" value={form.facility.unit} onChange={(v) => setFac('unit', v)} maxLength={40} />
              <Field label="Room" value={form.facility.room} onChange={(v) => setFac('room', v)} maxLength={40} />
              <Field label="Admit date" type="date" value={form.facility.admitDate} onChange={(v) => setFac('admitDate', v)} />
              <Field label="Facility address" value={form.facility.address} onChange={(v) => setFac('address', v)} maxLength={200} />
              <Field label="City" value={form.facility.city} onChange={(v) => setFac('city', v)} maxLength={80} />
              <Field label="State" value={form.facility.state} onChange={(v) => setFac('state', v)} maxLength={40} />
              <Field label="ZIP" value={form.facility.zip} onChange={(v) => setFac('zip', v)} maxLength={12} />
            </div>
          </div>

          <div className="fs-section" style={{ marginBottom: 0 }}>
            <div className="fs-section-h">Documents{!pUuid && <span className="fs-section-note"> — create the patient to enable uploads</span>}</div>
            <div className="fs-docs">
              {DOC_SLOTS.map((slot) => (
                <DropZone key={slot.key} slot={slot} doc={docFor(slot.key)} patientUuid={pUuid} onChanged={reloadDocs} disabled={!pUuid} />
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
