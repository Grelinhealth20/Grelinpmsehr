import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { patientsApi, toApiError } from '../lib/api.js';

const EMPTY = {
  demographics: { firstName: '', lastName: '', dob: '', gender: 'unknown', phone: '', email: '', address: '', city: '', state: '', zip: '', ssn: '' },
  insurance: [],
  facility: { facilityName: '', npi: '', unit: '', room: '', residentId: '', admittedFrom: '', admissionLocation: '', admitDate: '', address: '', city: '', state: '', zip: '' },
  emergencyContacts: [],
};
const blankContact = () => ({ name: '', relationship: '', phone: '', email: '' });
const INS_RANKS = ['primary', 'secondary', 'tertiary'];
const INS_LABEL = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' };
const blankIns = (type) => ({ type, payer: '', memberId: '', group: '', planType: '', mbi: '' });
const GENDERS = [['unknown', 'Unknown'], ['male', 'Male'], ['female', 'Female'], ['other', 'Other']];
const DOC_SLOTS = [
  { key: 'license_front', label: "Driver's License — Front" },
  { key: 'license_back', label: "Driver's License — Back" },
  { key: 'insurance_front', label: 'Insurance Card — Front' },
  { key: 'insurance_back', label: 'Insurance Card — Back' },
];
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
// Records also accept Word documents (in addition to OCR-able images + PDF).
const RECORDS_ACCEPT = `${ACCEPT},.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document`;
const RECORDS_OK = /\.(jpe?g|png|webp|pdf|docx?)$/i;
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

// Provider-facing steps shown while the document is being read (clinical framing).
const EXTRACT_STEPS = [
  'Scanning the document…',
  'Reading patient demographics…',
  'Capturing insurance & Medicare ID…',
  'Reading SNF facility details…',
  'Preparing fields for your review…',
];

/** Animated "reading the chart" indicator shown during OCR extraction. */
function ExtractionProgress({ phase = 'extract' }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (phase === 'upload') return undefined;
    const id = setInterval(() => setStep((s) => Math.min(s + 1, EXTRACT_STEPS.length - 1)), 2400);
    return () => clearInterval(id);
  }, [phase]);
  const pct = phase === 'upload' ? 12 : ((step + 1) / EXTRACT_STEPS.length) * 100;
  return (
    <div className="fs-extract" role="status" aria-live="polite">
      <div className="fs-extract-doc" aria-hidden="true">
        <span className="fs-extract-lines"><i /><i /><i /><i /><i /></span>
        <span className="fs-extract-scan" />
      </div>
      <div className="fs-extract-txt">
        <span className="fs-extract-title">Analyzing face sheet</span>
        <span className="fs-extract-step">{phase === 'upload' ? 'Uploading document…' : EXTRACT_STEPS[step]}</span>
        <span className="fs-extract-bar"><i style={{ width: `${pct}%` }} /></span>
      </div>
    </div>
  );
}

function DropZone({ slot, doc, patientUuid, onChanged, onExtract, disabled }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);

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
            {onExtract && EXTRACTABLE.test(doc.contentType || '') && (
              <button type="button" className="act accent" title="Read info from this card" disabled={extracting}
                onClick={async () => { setExtracting(true); try { await onExtract(doc.uuid); } finally { setExtracting(false); } }}>
                {extracting ? <span className="spinner dark" /> : 'Auto-fill'}
              </button>
            )}
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

// OCR-able types only — Word records are stored but never auto-extracted.
const EXTRACTABLE = /^image\/(jpeg|png|webp)$|^application\/pdf$/;

/** General patient records — multi-file drag-and-drop (stored as `other` docs). */
function RecordsUpload({ patientUuid, docs, onChanged, onExtract, disabled }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extractingId, setExtractingId] = useState(null);
  const records = docs.filter((d) => d.docType === 'other');

  async function uploadMany(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    setBusy(true);
    const uploaded = [];
    try {
      for (const f of list) {
        if (!RECORDS_OK.test(f.name)) { toast.error(`${f.name}: only image, PDF or Word files are allowed.`); continue; }
        if (f.size > 10 * 1024 * 1024) { toast.error(`${f.name} exceeds the 10 MB limit.`); continue; }
        const { data } = await patientsApi.uploadDocument(patientUuid, 'other', f);
        if (data?.document) uploaded.push(data.document);
      }
      toast.success('Documents uploaded.');
      onChanged();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
    // Extraction starts automatically on the first readable (image/PDF) upload.
    const first = uploaded.find((d) => EXTRACTABLE.test(d.contentType || ''));
    if (first && onExtract) {
      setExtractingId(first.uuid);
      try { await onExtract(first.uuid); } finally { setExtractingId(null); }
    }
  }
  async function view(d) {
    try { const { data } = await patientsApi.documentUrl(patientUuid, d.uuid); window.open(data.url, '_blank', 'noopener'); }
    catch (e) { toast.error(toApiError(e).message); }
  }
  async function remove(d) {
    try { await patientsApi.removeDocument(patientUuid, d.uuid); onChanged(); }
    catch (e) { toast.error(toApiError(e).message); }
  }

  return (
    <>
      <div
        className={`fs-drop fs-records ${over ? 'is-over' : ''} ${disabled ? 'is-disabled' : ''}`}
        onDragOver={(e) => { if (disabled) return; e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { if (disabled) return; e.preventDefault(); setOver(false); uploadMany(e.dataTransfer.files); }}
      >
        {busy || extractingId ? (
          <ExtractionProgress phase={busy ? 'upload' : 'extract'} />
        ) : (
          <button type="button" className="fs-drop-empty" onClick={() => !disabled && inputRef.current?.click()} disabled={disabled}>
            <span className="fs-drop-plus" aria-hidden="true" />
            <span>{disabled ? 'Create the patient first to upload documents' : 'Drag & drop face sheets & PCC documents, or click to browse'}</span>
            <span className="fs-drop-hint">Image, PDF or Word · max 10 MB each · auto-fills on upload</span>
          </button>
        )}
        <input ref={inputRef} type="file" accept={RECORDS_ACCEPT} multiple hidden onChange={(e) => { uploadMany(e.target.files); e.target.value = ''; }} />
      </div>
      {records.length > 0 && (
        <div className="fs-records-list">
          {records.map((d) => (
            <div className="fs-records-item" key={d.uuid}>
              <span className="fs-doc-ic" aria-hidden="true" />
              <span className="fs-doc-name" title={d.fileName || ''}>{d.fileName || 'Document'}</span>
              <div className="fs-doc-acts">
                {EXTRACTABLE.test(d.contentType || '') && (
                  <button type="button" className="act accent" title="Read patient & insurance info from this document"
                    disabled={extractingId === d.uuid}
                    onClick={async () => { setExtractingId(d.uuid); try { await onExtract(d.uuid); } finally { setExtractingId(null); } }}>
                    {extractingId === d.uuid ? <span className="spinner dark" /> : 'Auto-fill'}
                  </button>
                )}
                <button type="button" className="act" onClick={() => view(d)}>View</button>
                <button type="button" className="act danger" onClick={() => remove(d)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Pre-create auto-fill dropzone: OCR a face sheet to populate the form; the
 * file is never stored (it's persisted only after the patient is created). */
function AutofillDrop({ onFile, busy }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const handle = (files) => { const f = files?.[0]; if (f) onFile(f); };
  return (
    <>
      <div
        className={`fs-drop fs-records ${over ? 'is-over' : ''} ${busy ? 'is-disabled' : ''}`}
        onDragOver={(e) => { if (busy) return; e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { if (busy) return; e.preventDefault(); setOver(false); handle(e.dataTransfer.files); }}
      >
        {busy ? (
          <ExtractionProgress phase="extract" />
        ) : (
          <button type="button" className="fs-drop-empty" onClick={() => inputRef.current?.click()}>
            <span className="fs-drop-plus" aria-hidden="true" />
            <span>Drag &amp; drop a face sheet to auto-fill, or click to browse</span>
            <span className="fs-drop-hint">Image or PDF · auto-fills on upload · nothing is stored until you create the patient</span>
          </button>
        )}
        <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(e) => { handle(e.target.files); e.target.value = ''; }} />
      </div>
    </>
  );
}

/**
 * Full patient face sheet as a modal. Create a new patient or manage an existing
 * one (demographics / insurance / SNF facility + license & insurance documents).
 * onSaved(patient) fires on every successful create/update so callers (e.g. the
 * appointment popup) can link to the patient.
 */
export default function PatientModal({ uuid = null, docMode = 'license', onClose, onSaved }) {
  const toast = useToast();
  const [pUuid, setPUuid] = useState(uuid);
  const [form, setForm] = useState(clone(EMPTY));
  const [docs, setDocs] = useState([]);
  const [mrn, setMrn] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!uuid);
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    let active = true;
    if (uuid) {
      patientsApi.get(uuid).then(({ data }) => {
        if (!active) return;
        const insRaw = data.patient.insurance;
        const insurance = Array.isArray(insRaw) ? insRaw : insRaw ? [insRaw] : [];
        const emgRaw = data.patient.emergencyContacts || (data.patient.emergencyContact ? [data.patient.emergencyContact] : []);
        setForm({
          demographics: { ...EMPTY.demographics, ...data.patient.demographics },
          insurance: insurance.map((x) => ({ ...blankIns(x.type || 'primary'), ...x })),
          facility: { ...EMPTY.facility, ...(data.patient.facility || {}) },
          emergencyContacts: (Array.isArray(emgRaw) ? emgRaw : []).map((c) => ({ ...blankContact(), ...c })),
        });
        setDocs(data.documents || []);
        setMrn(data.patient.mrn);
        setLoading(false);
      }).catch((e) => { toast.error(toApiError(e).message); setLoading(false); });
    }
    return () => { active = false; };
  }, [uuid, toast]);

  const setD = (k, v) => setForm((f) => ({ ...f, demographics: { ...f.demographics, [k]: v } }));
  const setFac = (k, v) => setForm((f) => ({ ...f, facility: { ...f.facility, [k]: v } }));
  const setEmgAt = (i, k, v) => setForm((f) => ({ ...f, emergencyContacts: f.emergencyContacts.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)) }));
  const addEmg = () => setForm((f) => (f.emergencyContacts.length >= 8 ? f : { ...f, emergencyContacts: [...f.emergencyContacts, blankContact()] }));
  const removeEmg = (i) => setForm((f) => ({ ...f, emergencyContacts: f.emergencyContacts.filter((_, idx) => idx !== i) }));
  const setInsAt = (i, k, v) => setForm((f) => ({ ...f, insurance: f.insurance.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)) }));
  const addIns = () => setForm((f) => (f.insurance.length >= 3 ? f : { ...f, insurance: [...f.insurance, blankIns(INS_RANKS[f.insurance.length] || 'secondary')] }));
  const removeIns = (i) => setForm((f) => ({ ...f, insurance: f.insurance.filter((_, idx) => idx !== i) }));

  // Merge document-AI suggestions into the form. Fills only EMPTY fields (never
  // clobbers a manual edit) and applies every insurance tier found. No guesses.
  // 'unknown' (the gender default) counts as empty so an extracted value applies.
  const isBlank = (val) => !String(val || '').trim() || val === 'unknown';
  function applyExtraction(sug) {
    if (!sug) return 0;
    // Count synchronously so the toast is accurate (setForm's updater is async).
    const count = Object.values(sug.demographics || {}).filter((v) => v && String(v).trim()).length
      + Object.values(sug.facility || {}).filter((v) => v && String(v).trim()).length
      + (Array.isArray(sug.insurance) ? sug.insurance.filter((s) => s && (s.payer || s.memberId || s.mbi)).length : 0)
      + (Array.isArray(sug.emergencyContacts) ? sug.emergencyContacts.filter((c) => c && c.name).length : 0);
    setForm((f) => {
      const demographics = { ...f.demographics };
      for (const [k, v] of Object.entries(sug.demographics || {})) {
        if (v && isBlank(demographics[k])) demographics[k] = v;
      }
      const facility = { ...f.facility };
      for (const [k, v] of Object.entries(sug.facility || {})) {
        if (v && isBlank(facility[k])) facility[k] = v;
      }
      let insurance = f.insurance.slice();
      for (const s of (sug.insurance || [])) {
        if (!s || (!s.payer && !s.memberId && !s.mbi)) continue;
        const slot = insurance.findIndex((x) => x.type === s.type && !x.payer && !x.memberId);
        const dup = insurance.some((x) => x.payer && s.payer && x.payer.toLowerCase() === s.payer.toLowerCase());
        if (slot >= 0) insurance[slot] = { ...insurance[slot], ...s };
        else if (!dup && insurance.length < 3) {
          const type = INS_RANKS[insurance.length] || 'tertiary';
          insurance = [...insurance, { ...blankIns(type), ...s, type }];
        }
      }
      // Emergency contacts: add each distinct contact (dedupe by name), up to 8.
      let emergencyContacts = f.emergencyContacts.slice();
      for (const c of (sug.emergencyContacts || [])) {
        if (!c || !c.name) continue;
        if (emergencyContacts.some((x) => x.name && x.name.toLowerCase() === c.name.toLowerCase())) continue;
        if (emergencyContacts.length >= 8) break;
        emergencyContacts = [...emergencyContacts, { ...blankContact(), ...c }];
      }
      return { ...f, demographics, facility, insurance, emergencyContacts };
    });
    return count;
  }
  async function runExtract(docUuid) {
    if (!pUuid) return;
    try {
      const { data } = await patientsApi.extractDocument(pUuid, docUuid);
      const n = applyExtraction(data.suggestions);
      if (n) toast.success(`Extracted ${n} field${n === 1 ? '' : 's'} — please review before saving.`);
      else toast.info('No patient fields could be read from this document.');
    } catch (e) { toast.error(toApiError(e).message); }
  }

  // Stateless auto-fill before the patient exists — OCR only, nothing stored.
  async function runExtractStateless(file) {
    if (!/\.(jpe?g|png|webp|pdf)$/i.test(file.name)) { toast.error('Auto-fill supports image or PDF face sheets.'); return; }
    setExtracting(true);
    try {
      const { data } = await patientsApi.extractUpload(file);
      const n = applyExtraction(data.suggestions);
      if (n) toast.success(`Extracted ${n} field${n === 1 ? '' : 's'} — please review before saving.`);
      else toast.info('No patient fields could be read from this document.');
    } catch (e) { toast.error(toApiError(e).message); } finally { setExtracting(false); }
  }

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
    const payload = { demographics: form.demographics, insurance: form.insurance, facility: form.facility, emergencyContacts: form.emergencyContacts };
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
      size="full"
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

          {docMode === 'records' && (
            <div className="fs-section">
              <div className="fs-section-h">Face Sheets &amp; PCC Documents{!pUuid && <span className="fs-section-note"> — auto-fill now, files are saved after you create the patient</span>}</div>
              {pUuid
                ? <RecordsUpload patientUuid={pUuid} docs={docs} onChanged={reloadDocs} onExtract={runExtract} disabled={false} />
                : <AutofillDrop onFile={runExtractStateless} busy={extracting} />}
            </div>
          )}

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
            <div className="fs-section-h">
              Insurance
              <span className="spacer" />
              {form.insurance.length < 3 && <button type="button" className="btn ghost sm" onClick={addIns}>+ Add insurance</button>}
            </div>
            {form.insurance.length === 0 && <div className="fs-empty" style={{ padding: '10px 0' }}>No insurance on file. Add primary insurance.</div>}
            {form.insurance.map((ins, i) => (
              <div className="fs-ins" key={i}>
                <div className="fs-ins-head">
                  <span className={`fs-ins-rank r-${ins.type || 'primary'}`}>{INS_LABEL[ins.type] || `Policy ${i + 1}`}</span>
                  <span className="spacer" />
                  <button type="button" className="act danger" onClick={() => removeIns(i)}>Remove</button>
                </div>
                <div className="fs-grid fs-grid-3">
                  <Field label="Payer" value={ins.payer} onChange={(v) => setInsAt(i, 'payer', v)} maxLength={120} />
                  <Field label="Member ID" value={ins.memberId} onChange={(v) => setInsAt(i, 'memberId', v)} maxLength={80} />
                  <Field label="Group #" value={ins.group} onChange={(v) => setInsAt(i, 'group', v)} maxLength={80} />
                  <Field label="Medicare Beneficiary ID (MBI)" value={ins.mbi} onChange={(v) => setInsAt(i, 'mbi', v)} maxLength={20} />
                  <Field label="Plan type" value={ins.planType} onChange={(v) => setInsAt(i, 'planType', v)} maxLength={60} />
                </div>
              </div>
            ))}
          </div>

          <div className="fs-section">
            <div className="fs-section-h">
              Emergency Contacts
              <span className="spacer" />
              {form.emergencyContacts.length < 8 && <button type="button" className="btn ghost sm" onClick={addEmg}>+ Add contact</button>}
            </div>
            {form.emergencyContacts.length === 0 && <div className="fs-empty" style={{ padding: '10px 0' }}>No emergency contacts on file. Add a contact.</div>}
            {form.emergencyContacts.map((c, i) => (
              <div className="fs-ins" key={i}>
                <div className="fs-ins-head">
                  <span className="fs-ins-rank r-primary">{c.relationship ? c.relationship : `Contact ${i + 1}`}</span>
                  <span className="spacer" />
                  <button type="button" className="act danger" onClick={() => removeEmg(i)}>Remove</button>
                </div>
                <div className="fs-grid fs-grid-3">
                  <Field label="Full name" value={c.name} onChange={(v) => setEmgAt(i, 'name', v)} maxLength={120} />
                  <Field label="Relationship" value={c.relationship} onChange={(v) => setEmgAt(i, 'relationship', v)} maxLength={60} />
                  <Field label="Phone" value={c.phone} onChange={(v) => setEmgAt(i, 'phone', v)} maxLength={40} />
                  <Field label="Email" type="email" value={c.email} onChange={(v) => setEmgAt(i, 'email', v)} maxLength={254} />
                </div>
              </div>
            ))}
          </div>

          <div className="fs-section">
            <div className="fs-section-h">SNF Facility</div>
            <div className="fs-grid fs-grid-3">
              <Field label="Facility name" value={form.facility.facilityName} onChange={(v) => setFac('facilityName', v)} maxLength={160} />
              <Field label="Resident ID" value={form.facility.residentId} onChange={(v) => setFac('residentId', v)} maxLength={40} />
              <Field label="NPI" value={form.facility.npi} onChange={(v) => setFac('npi', v)} maxLength={20} />
              <Field label="Unit" value={form.facility.unit} onChange={(v) => setFac('unit', v)} maxLength={40} />
              <Field label="Room" value={form.facility.room} onChange={(v) => setFac('room', v)} maxLength={40} />
              <Field label="Admit date" type="date" value={form.facility.admitDate} onChange={(v) => setFac('admitDate', v)} />
              <Field label="Admitted from" value={form.facility.admittedFrom} onChange={(v) => setFac('admittedFrom', v)} maxLength={120} />
              <Field label="Admission location" value={form.facility.admissionLocation} onChange={(v) => setFac('admissionLocation', v)} maxLength={160} />
              <Field label="Facility address" value={form.facility.address} onChange={(v) => setFac('address', v)} maxLength={200} />
              <Field label="City" value={form.facility.city} onChange={(v) => setFac('city', v)} maxLength={80} />
              <Field label="State" value={form.facility.state} onChange={(v) => setFac('state', v)} maxLength={40} />
              <Field label="ZIP" value={form.facility.zip} onChange={(v) => setFac('zip', v)} maxLength={12} />
            </div>
          </div>

          {docMode !== 'records' && (
            <div className="fs-section" style={{ marginBottom: 0 }}>
              <div className="fs-section-h">Documents{!pUuid && <span className="fs-section-note"> — create the patient to enable uploads</span>}</div>
              <div className="fs-docs">
                {DOC_SLOTS.map((slot) => (
                  <DropZone key={slot.key} slot={slot} doc={docFor(slot.key)} patientUuid={pUuid} onChanged={reloadDocs} onExtract={runExtract} disabled={!pUuid} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
