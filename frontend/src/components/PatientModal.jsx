import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { patientsApi, encountersApi, toApiError } from '../lib/api.js';
import BenefitsVerification from './BenefitsVerification.jsx';
import { EncounterNotesModal, usDate, encNo, loadNoteDefs, loadCustomTemplates, CustomTemplateBuilder, encTypeLabel } from './EncounterNotes.jsx';
import { NOTE_TYPES, SECTION_LABELS } from '../lib/noteTemplates.js';

const ENC_PER_PAGE = 25;
const procedureLabel = (r) => (r.noteTypes ? r.noteTypes.split(',').map((c) => NOTE_TYPES[c]?.label || c).join(', ') : '—');

/** Windowed page numbers with ellipses, e.g. 1 … 4 5 6 … 20 — for the encounters pager. */
function pageWindow(page, pages) {
  const nums = [...new Set([1, pages, page, page - 1, page + 1])].filter((x) => x >= 1 && x <= pages).sort((a, b) => a - b);
  const out = []; let prev = 0;
  for (const n of nums) { if (n - prev > 1) out.push('…'); out.push(n); prev = n; }
  return out;
}

const EMPTY = {
  demographics: { firstName: '', lastName: '', dob: '', gender: 'unknown', phone: '', email: '', address: '', city: '', state: '', zip: '', ssn: '' },
  insurance: [],
  facility: { facilityName: '', npi: '', unit: '', room: '', residentId: '', admittedFrom: '', admissionLocation: '', admitDate: '', address: '', city: '', state: '', zip: '' },
  emergencyContacts: [],
};
const blankContact = () => ({ name: '', relationship: '', phone: '', email: '' });
// Display an ISO date (YYYY-MM-DD, the stored/processing format) as US MM/DD/YYYY.
// Only for read-only display — <input type="date"> values stay ISO as HTML requires.
const mdy = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(d || ''); };
const INS_RANKS = ['primary', 'secondary', 'tertiary'];
const INS_LABEL = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' };
const blankBenefits = () => ({ eligibilityStatus: 'not_verified', planName: '', network: '', effectiveDate: '', termDate: '', copay: '', coinsurance: '', deductible: '', deductibleMet: '', oopMax: '', oopMet: '', coverageNotes: '', verifiedDate: '', verifiedBy: '', referenceNo: '' });
const blankIns = (type) => ({ type, payer: '', payerId: '', memberId: '', group: '', planType: '', mbi: '', benefits: blankBenefits() });
const ELIG_OPTS = [['not_verified', 'Not verified'], ['active', 'Active'], ['inactive', 'Inactive'], ['pending', 'Pending']];
const ELIG_LABEL = { not_verified: 'Not verified', active: 'Active', inactive: 'Inactive', pending: 'Pending' };
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

/**
 * Insurance payer — a plain, DETERMINISTIC entry field (no dropdown, no selection).
 * The provider types the payer name exactly as written on the insurance card; the
 * system resolves it to the correct Stedi payer + ID automatically at verification
 * (a fixed, deterministic mapping — the same entry always routes to the same payer).
 * Editing the payer clears any previously matched ID so it is re-resolved fresh.
 */
function PayerSearch({ value, payerId, onPick }) {
  return (
    <div className="field">
      <label>Payer</label>
      <input
        className="input"
        value={value || ''}
        autoComplete="off"
        placeholder="Insurance payer — e.g. UnitedHealthcare, Cigna, Aetna, Medicare"
        onChange={(e) => onPick({ name: e.target.value, stediId: '' })}
      />
      {payerId ? <div className="payer-id-chip">Matched payer ID: <b>{payerId}</b></div> : null}
    </div>
  );
}

// Section-header icons (thin-line, enterprise).
const SEC_ICONS = {
  person: 'M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20a7 7 0 0 1 14 0',
  shield: 'M12 3l7 3v5c0 4.6-3 7.9-7 9-4-1.1-7-4.4-7-9V6l7-3Zm-3 8 2.2 2.2L15 9',
  contact: 'M4.5 5.5h15v13h-15zM4.5 9.5h15M8 13.5h4M8 16h6',
  building: 'M4 21V5.5A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V21M15 21V10h3.5A1.5 1.5 0 0 1 20 11.5V21M7.5 8h2M7.5 12h2M7.5 16h2',
  file: 'M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1ZM13 3.5V8h5',
  home: 'M4 11.5 12 4l8 7.5M6 10v9.5h12V10',
};
function SecHead({ icon, title, note, children }) {
  return (
    <div className="fs-sh">
      <span className="fs-sh-ic">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={SEC_ICONS[icon]} /></svg>
      </span>
      <span className="fs-sh-t">{title}</span>
      {note && <span className="fs-sh-note">{note}</span>}
      <span className="spacer" />
      {children}
    </div>
  );
}
// Sub-group label inside a section (e.g. "Patient", "SNF facility").
function SubLabel({ children }) { return <div className="fs-sub">{children}</div>; }

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

/** Documents tab — EVERY document received for this patient (uploaded records + slot documents),
 *  each viewable and downloadable. Strictly patient-scoped on the backend (owner + patient_id match),
 *  so it can never show another patient's documents (no cross-leakage). */
const DOC_PER_PAGE = 20;
const DOC_CATEGORIES = [
  { key: 'medical_record', label: 'Medical Records' },
  { key: 'lab_result', label: 'Lab Results' },
  { key: 'imaging', label: 'Imaging' },
  { key: 'insurance_card', label: 'Insurance Cards' },
  { key: 'other', label: 'Other Records' },
];
const DOC_CAT_LABEL = Object.fromEntries(DOC_CATEGORIES.map((c) => [c.key, c.label]));

/** Documents tab — every document received for this patient, categorized (Medical Records / Labs /
 *  Imaging / Insurance Cards / Other), arranged by Date of Service, view + download. SERVER-paginated,
 *  server-searched and server-category-filtered, so it stays instant even with thousands of documents
 *  per patient. Strictly patient-scoped on the backend (owner + patient_id) — no cross-leakage. */
const DocFileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" /><path d="M13 3v5h5" />
  </svg>
);

function DocumentsLibrary({ patientUuid, onChanged }) {
  const toast = useToast();
  const [category, setCategory] = useState('all');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyId, setBusyId] = useState(null);
  // Integrated upload panel
  const today = new Date().toISOString().slice(0, 10);
  const [showUpload, setShowUpload] = useState(false);
  const [upCategory, setUpCategory] = useState('medical_record');
  const [upDos, setUpDos] = useState(today);
  const [upBusy, setUpBusy] = useState(false);
  const [over, setOver] = useState(false);
  const upRef = useRef(null);

  useEffect(() => { const t = setTimeout(() => { setDebouncedQ(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); }, [category]);
  // Category counts: fetched ONCE per patient / after a mutation (NOT on every page nav) so paging is a single query.
  useEffect(() => {
    let active = true;
    patientsApi.listDocuments(patientUuid, { page: 1, pageSize: 1, counts: 1 })
      .then(({ data: d }) => { if (active && d.counts) setCounts(d.counts); })
      .catch(() => { /* chip tallies are cosmetic — never block the list */ });
    return () => { active = false; };
  }, [patientUuid, refreshKey]);
  // The document PAGE — one query per page/search/category change.
  useEffect(() => {
    let active = true; setLoading(true);
    patientsApi.listDocuments(patientUuid, { page, pageSize: DOC_PER_PAGE, q: debouncedQ, category: category === 'all' ? '' : category })
      .then(({ data: d }) => { if (active) setData(d); })
      .catch((e) => { if (active) { setData({ documents: [], total: 0 }); toast.error(toApiError(e).message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [patientUuid, page, debouncedQ, category, refreshKey, toast]);

  const reload = () => setRefreshKey((k) => k + 1);
  const total = data?.total || 0;
  const docs = data?.documents || [];
  const pages = Math.max(1, Math.ceil(total / DOC_PER_PAGE));
  const chips = [{ key: 'all', label: 'All' }, ...DOC_CATEGORIES];
  const cnt = (k) => (k === 'all' ? counts.all : counts[k]);

  async function view(d) { try { const { data: r } = await patientsApi.documentUrl(patientUuid, d.uuid); window.open(r.url, '_blank', 'noopener'); } catch (e) { toast.error(toApiError(e).message); } }
  async function download(d) {
    setBusyId(d.uuid);
    try { const { data: r } = await patientsApi.documentUrl(patientUuid, d.uuid, true); const a = document.createElement('a'); a.href = r.url; a.download = d.fileName || 'document'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusyId(null); }
  }
  async function remove(d) {
    if (!window.confirm(`Remove “${d.fileName || 'this document'}”? This cannot be undone.`)) return;
    try { await patientsApi.removeDocument(patientUuid, d.uuid); toast.success('Document removed.'); reload(); onChanged?.(); }
    catch (e) { toast.error(toApiError(e).message); }
  }
  async function uploadMany(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    setUpBusy(true); let done = 0;
    try {
      for (const f of list) {
        if (!RECORDS_OK.test(f.name)) { toast.error(`${f.name}: only image, PDF or Word files are allowed.`); continue; }
        if (f.size > 250 * 1024 * 1024) { toast.error(`${f.name} exceeds the 250 MB limit.`); continue; }
        await patientsApi.uploadDocument(patientUuid, upCategory, f, undefined, upDos); // real upload → S3 + DB (no OCR)
        done += 1;
      }
      if (done) { toast.success(`${done} document${done === 1 ? '' : 's'} uploaded to ${DOC_CAT_LABEL[upCategory]}.`); setCategory(upCategory); setPage(1); reload(); onChanged?.(); }
    } catch (e) { toast.error(toApiError(e).message); } finally { setUpBusy(false); }
  }

  return (
    <div className="docmgr">
      <div className="docmgr-toolbar">
        <div className="docmgr-chips">
          {chips.map((c) => (
            <button key={c.key} type="button" className={`docmgr-chip ${category === c.key ? 'is-on' : ''}`} onClick={() => setCategory(c.key)}>
              {c.label}{cnt(c.key) != null ? <span className="docmgr-chip-n">{cnt(c.key)}</span> : null}
            </button>
          ))}
        </div>
        <div className="docmgr-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input type="search" placeholder="Search documents…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search this patient's documents" />
        </div>
        <button type="button" className={`docmgr-upbtn ${showUpload ? 'is-open' : ''}`} onClick={() => setShowUpload((s) => !s)}>
          {showUpload
            ? <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg> Close</>
            : <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg> Upload</>}
        </button>
      </div>

      {showUpload && (
        <div className="docmgr-uploader">
          <div className="docmgr-upfields">
            <label className="docmgr-upfield"><span className="docmgr-uplabel">Category</span>
              <select value={upCategory} onChange={(e) => setUpCategory(e.target.value)}>{DOC_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            </label>
            <label className="docmgr-upfield"><span className="docmgr-uplabel">Date of Service</span>
              <input type="date" value={upDos} max={today} onChange={(e) => setUpDos(e.target.value)} />
            </label>
          </div>
          <div className={`fs-drop fs-records ${over ? 'is-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); uploadMany(e.dataTransfer.files); }}>
            {upBusy ? <ExtractionProgress phase="upload" /> : (
              <button type="button" className="fs-drop-empty" onClick={() => upRef.current?.click()}>
                <span className="fs-drop-plus" aria-hidden="true" />
                <span>Drop files into “{DOC_CAT_LABEL[upCategory]}”, or click to browse</span>
                <span className="fs-drop-hint">Images, PDF or Word · one or many · up to 250 MB each · dated {upDos}</span>
              </button>
            )}
            <input ref={upRef} type="file" accept={RECORDS_ACCEPT} multiple hidden onChange={(e) => { uploadMany(e.target.files); e.target.value = ''; }} />
          </div>
          <p className="docmgr-uphint">One place for every record — pick a category (incl. Insurance Cards) and drop one or many files, or click to browse. Accepts images, PDF and Word.</p>
        </div>
      )}

      <div className="docmgr-toolbar" style={{ marginBottom: 10, justifyContent: 'flex-end' }}>
        <span className="docmgr-count">{loading ? 'Loading…' : `${total} document${total === 1 ? '' : 's'}${category !== 'all' ? ` · ${DOC_CAT_LABEL[category] || ''}` : ''}`}</span>
      </div>

      {loading && !data ? (
        <div className="docmgr-empty"><span className="spinner dark" /> Loading…</div>
      ) : docs.length === 0 ? (
        <div className="docmgr-empty">{(debouncedQ || category !== 'all')
          ? 'No documents match this filter.'
          : <>No documents received for this patient yet. Click <strong>Upload</strong> to add medical records, labs, imaging or insurance cards.</>}</div>
      ) : (
        <div className="docmgr-tablewrap">
          <div className="docmgr-scroll">
            <table className="docmgr-table">
              <thead><tr><th>Date of Service</th><th>Document</th><th>Category</th><th className="ta-right">Actions</th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.uuid}>
                    <td className="docmgr-dos">{d.dos ? usDate(d.dos) : '—'}</td>
                    <td><div className="docmgr-doc"><span className="docmgr-doc-ic"><DocFileIcon /></span><span className="docmgr-doc-name" title={d.fileName || ''}>{d.fileName || 'Document'}</span></div></td>
                    <td><span className="docmgr-badge">{DOC_CAT_LABEL[d.category] || 'Other Records'}</span></td>
                    <td><div className="docmgr-actions">
                      <button type="button" className="act" onClick={() => view(d)}>View</button>
                      <button type="button" className="act accent" disabled={busyId === d.uuid} onClick={() => download(d)}>{busyId === d.uuid ? <span className="spinner dark" /> : 'Download'}</button>
                      <button type="button" className="act danger" onClick={() => remove(d)}>Remove</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="pager pager-c">
              <span className="pager-label">Showing {(page - 1) * DOC_PER_PAGE + 1}–{Math.min(page * DOC_PER_PAGE, total)} of {total}</span>
              <span className="spacer" />
              <button className="pager-btn" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Prev</button>
              {pageWindow(page, pages).map((x, i) => (x === '…'
                ? <span key={`d${i}`} className="pager-ellipsis">…</span>
                : <button key={x} className={`pager-num ${x === page ? 'is-on' : ''}`} disabled={loading} onClick={() => setPage(x)}>{x}</button>))}
              <button className="pager-btn" disabled={page >= pages || loading} onClick={() => setPage((p) => Math.min(pages, p + 1))}>Next ›</button>
            </div>
          )}
        </div>
      )}
    </div>
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
export default function PatientModal({ uuid = null, docMode = 'license', initialTab = 'facesheet', onClose, onSaved }) {
  const toast = useToast();
  const [pUuid, setPUuid] = useState(uuid);
  const [form, setForm] = useState(clone(EMPTY));
  const [pEligibility, setPEligibility] = useState(true); // this patient's facility eligibility switch
  const [docs, setDocs] = useState([]);
  const [mrn, setMrn] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!uuid);
  const [extracting, setExtracting] = useState(false);
  const [viewTab, setViewTab] = useState(uuid ? initialTab : 'facesheet'); // 'facesheet' | 'benefits' | 'encounters'
  const [downloading, setDownloading] = useState(false);
  const [pendingNewEnc, setPendingNewEnc] = useState(false); // header "New encounter" → create + open on the Encounters tab
  const [pendingNewEncType, setPendingNewEncType] = useState(null); // note type chosen from the dropdown (or null = pick in editor)
  const [noteMenuOpen, setNoteMenuOpen] = useState(false);
  const [noteTypeDefs, setNoteTypeDefs] = useState([]); // backend note types for the dropdown
  const [customTpls, setCustomTpls] = useState([]); // provider's own custom templates for the dropdown
  const [builderOpen, setBuilderOpen] = useState(false); // custom-template builder from the dropdown

  // Download the record that matches the tab in view — the Face Sheet, or the
  // benefits/eligibility document. Both are facility-branded, grayscale PDFs.
  async function downloadDoc() {
    if (!pUuid) return;
    setDownloading(true);
    try {
      if (viewTab === 'benefits') await patientsApi.downloadBenefits(pUuid, undefined, `benefits-${mrn || pUuid}.pdf`);
      else await patientsApi.downloadFaceSheet(pUuid, `face-sheet-${mrn || pUuid}.pdf`);
    } catch (e) { toast.error(toApiError(e).message); } finally { setDownloading(false); }
  }

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
        setPEligibility(data.patient.eligibilityEnabled !== false);
        setLoading(false);
      }).catch((e) => { toast.error(toApiError(e).message); setLoading(false); });
    }
    return () => { active = false; };
  }, [uuid, toast]);

  // Backend-authoritative note types + the provider's custom templates for the dropdown (shared, cached).
  useEffect(() => {
    let active = true;
    loadNoteDefs().then((d) => { if (active) setNoteTypeDefs(d.list || []); }).catch(() => { /* retried on open */ });
    loadCustomTemplates().then((list) => { if (active) setCustomTpls(list || []); }).catch(() => { /* non-fatal */ });
    return () => { active = false; };
  }, []);

  const setD = (k, v) => setForm((f) => ({ ...f, demographics: { ...f.demographics, [k]: v } }));
  const setFac = (k, v) => setForm((f) => ({ ...f, facility: { ...f.facility, [k]: v } }));
  const setEmgAt = (i, k, v) => setForm((f) => ({ ...f, emergencyContacts: f.emergencyContacts.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)) }));
  const addEmg = () => setForm((f) => (f.emergencyContacts.length >= 8 ? f : { ...f, emergencyContacts: [...f.emergencyContacts, blankContact()] }));
  const removeEmg = (i) => setForm((f) => ({ ...f, emergencyContacts: f.emergencyContacts.filter((_, idx) => idx !== i) }));
  const setInsAt = (i, k, v) => setForm((f) => ({ ...f, insurance: f.insurance.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)) }));
  const setBenAt = (i, k, v) => setForm((f) => ({ ...f, insurance: f.insurance.map((it, idx) => (idx === i ? { ...it, benefits: { ...(it.benefits || {}), [k]: v } } : it)) }));
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
        toast.success(`Patient created — MRN ${data.patient.mrn}.`);
        onSaved?.(data.patient);
        onClose(); // creation is complete; the patient now appears in the list
      }
    } catch (e) { toast.error(toApiError(e).message); } finally { setSaving(false); }
  }

  const docFor = (t) => docs.find((x) => x.docType === t);

  return (
    <Modal
      title={pUuid
        ? `${patientDisplayName({ demographics: form.demographics }) || 'Patient'}${mrn ? ` · MRN ${mrn}` : ''}`
        : 'New Patient — Face Sheet'}
      size="full"
      onClose={onClose}
      footer={
        <>
          <span className="fs-modal-mrn">{mrn ? `MRN ${mrn}` : 'Complete the required fields to create'}</span>
          <span className="spacer" />
          {pUuid && (
            <button className="btn ghost" onClick={downloadDoc} disabled={downloading || saving}
              title={viewTab === 'benefits' ? 'Download the benefits document (PDF)' : 'Download the Face Sheet (PDF)'}>
              {downloading ? <span className="spinner" /> : viewTab === 'benefits' ? 'Download benefits' : 'Download Face Sheet'}
            </button>
          )}
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
                {form.demographics.dob ? `DOB ${mdy(form.demographics.dob)}` : 'New patient'}
                {form.demographics.gender && form.demographics.gender !== 'unknown' ? ` · ${form.demographics.gender}` : ''}
              </span>
            </div>
            {mrn && <span className="fs-summary-mrn">MRN {mrn}</span>}
            {pUuid && (
              <div className="newenc-split">
                <button type="button" className="newenc-main" onClick={() => { setNoteMenuOpen(false); setPendingNewEncType(null); setViewTab('encounters'); setPendingNewEnc(true); }}>
                  New encounter
                </button>
                <button type="button" className={`newenc-caret ${noteMenuOpen ? 'is-open' : ''}`} aria-haspopup="menu" aria-expanded={noteMenuOpen} title="Start with a note type"
                  onClick={() => {
                    setNoteMenuOpen((o) => !o);
                    if (noteTypeDefs.length === 0) loadNoteDefs().then((d) => setNoteTypeDefs(d.list || [])).catch(() => {});
                    loadCustomTemplates().then((list) => setCustomTpls(list || [])).catch(() => {});
                  }}>
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
                </button>
                {noteMenuOpen && (
                  <>
                    <div className="newenc-scrim" onClick={() => setNoteMenuOpen(false)} />
                    <div className="newenc-menu" role="menu">
                      <div className="newenc-menu-h">New encounter · start a note</div>
                      <div className="newenc-menu-scroll">
                        {noteTypeDefs.length === 0 ? (
                          <div className="newenc-menu-empty">Loading note types…</div>
                        ) : noteTypeDefs.map((t) => (
                          <button key={t.noteType} type="button" role="menuitem" className="newenc-menu-item"
                            onClick={() => { setNoteMenuOpen(false); setPendingNewEncType(t.noteType); setViewTab('encounters'); setPendingNewEnc(true); }}>
                            <span className="newenc-menu-lbl">{t.label}</span>
                            <span className="newenc-menu-cat">{t.category}</span>
                          </button>
                        ))}
                        <div className="newenc-menu-sub">My custom templates</div>
                        {customTpls.map((t) => (
                          <button key={t.uuid} type="button" role="menuitem" className="newenc-menu-item"
                            onClick={() => { setNoteMenuOpen(false); setPendingNewEncType(`custom:${t.uuid}`); setViewTab('encounters'); setPendingNewEnc(true); }}>
                            <span className="newenc-menu-lbl">{t.label}</span>
                            <span className="newenc-menu-cat">{t.sections.length} heading{t.sections.length === 1 ? '' : 's'} · custom</span>
                          </button>
                        ))}
                      </div>
                      {/* Fixed footer — OUTSIDE the scroll area, so it never overlaps the scrolling list. */}
                      <button type="button" role="menuitem" className="newenc-menu-build"
                        onClick={() => { setNoteMenuOpen(false); setBuilderOpen(true); }}>
                        <span className="newenc-menu-lbl">+ Build custom template</span>
                        <span className="newenc-menu-cat">Design your own headings — saved to your account</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="fs-vtabs" role="tablist">
            <button type="button" role="tab" aria-selected={viewTab === 'facesheet'} className={`fs-vtab ${viewTab === 'facesheet' ? 'is-on' : ''}`} onClick={() => setViewTab('facesheet')}>
              <svg className="fs-vtab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v4h4M9 13h6M9 16.5h4" />
              </svg>
              Patient Face Sheet
            </button>
            <button type="button" role="tab" aria-selected={viewTab === 'benefits'} className={`fs-vtab ${viewTab === 'benefits' ? 'is-on' : ''}`} onClick={() => setViewTab('benefits')}>
              <svg className="fs-vtab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3l7.5 3.2v5.3c0 4.8-3.2 8.3-7.5 10.2-4.3-1.9-7.5-5.4-7.5-10.2V6.2z" /><path d="M9 12l2 2 4-4" />
              </svg>
              Benefits Information
            </button>
            {pUuid && (
              <button type="button" role="tab" aria-selected={viewTab === 'encounters'} className={`fs-vtab ${viewTab === 'encounters' ? 'is-on' : ''}`} onClick={() => setViewTab('encounters')}>
                <svg className="fs-vtab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3v3M16 3v3M4 8.5h16M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z" /><path d="M8 12h3M8 15.5h6" />
                </svg>
                Encounters
              </button>
            )}
            {pUuid && (
              <button type="button" role="tab" aria-selected={viewTab === 'documents'} className={`fs-vtab ${viewTab === 'documents' ? 'is-on' : ''}`} onClick={() => setViewTab('documents')}>
                <svg className="fs-vtab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v4h4M9 12h6M9 15.5h6M9 8.5h2" />
                </svg>
                Documents
              </button>
            )}
          </div>

          {viewTab === 'facesheet' && (
          <div className="fs-sheet">
          {docMode === 'records' && (
            <div className="fs-section">
              <SecHead icon="file" title="Face sheets & PCC documents" note={!pUuid ? 'auto-fill now — files save after you create the patient' : undefined} />
              {pUuid
                ? <RecordsUpload patientUuid={pUuid} docs={docs} onChanged={reloadDocs} onExtract={runExtract} disabled={false} />
                : <AutofillDrop onFile={runExtractStateless} busy={extracting} />}
            </div>
          )}

          <div className="fs-section">
            <SecHead icon="person" title="Demographics" note="Patient identity, address & nursing facility" />
            <SubLabel>Patient</SubLabel>
            <div className="fs-grid fs-grid-3">
              <Field label="First name" required value={form.demographics.firstName} onChange={(v) => setD('firstName', v)} maxLength={80} />
              <Field label="Last name" required value={form.demographics.lastName} onChange={(v) => setD('lastName', v)} maxLength={80} />
              <Field label="Date of birth" required type="date" value={form.demographics.dob} onChange={(v) => setD('dob', v)} />
              <Field label="Gender" options={GENDERS} value={form.demographics.gender} onChange={(v) => setD('gender', v)} />
              <Field label="Phone" value={form.demographics.phone} onChange={(v) => setD('phone', v)} maxLength={40} />
              <Field label="Email" type="email" value={form.demographics.email} onChange={(v) => setD('email', v)} maxLength={254} />
              <Field label="SSN" value={form.demographics.ssn} onChange={(v) => setD('ssn', v)} placeholder="###-##-####" maxLength={11} />
            </div>
            <SubLabel>Home address</SubLabel>
            <div className="fs-grid fs-grid-3">
              <Field label="Address" value={form.demographics.address} onChange={(v) => setD('address', v)} maxLength={200} />
              <Field label="City" value={form.demographics.city} onChange={(v) => setD('city', v)} maxLength={80} />
              <Field label="State" value={form.demographics.state} onChange={(v) => setD('state', v)} maxLength={40} />
              <Field label="ZIP" value={form.demographics.zip} onChange={(v) => setD('zip', v)} maxLength={12} />
            </div>
            <SubLabel>SNF facility &amp; admission</SubLabel>
            <div className="fs-grid fs-grid-3">
              <Field label="Facility name" value={form.facility.facilityName} onChange={(v) => setFac('facilityName', v)} maxLength={160} />
              <Field label="Facility NPI" value={form.facility.npi} onChange={(v) => setFac('npi', v)} maxLength={20} />
              <Field label="Resident ID" value={form.facility.residentId} onChange={(v) => setFac('residentId', v)} maxLength={40} />
              <Field label="Unit" value={form.facility.unit} onChange={(v) => setFac('unit', v)} maxLength={40} />
              <Field label="Room" value={form.facility.room} onChange={(v) => setFac('room', v)} maxLength={40} />
              <Field label="Admit date" type="date" value={form.facility.admitDate} onChange={(v) => setFac('admitDate', v)} />
              <Field label="Admitted from" value={form.facility.admittedFrom} onChange={(v) => setFac('admittedFrom', v)} maxLength={120} />
              <Field label="Admission location" value={form.facility.admissionLocation} onChange={(v) => setFac('admissionLocation', v)} maxLength={160} />
              <Field label="Facility address" value={form.facility.address} onChange={(v) => setFac('address', v)} maxLength={200} />
              <Field label="Facility city" value={form.facility.city} onChange={(v) => setFac('city', v)} maxLength={80} />
              <Field label="Facility state" value={form.facility.state} onChange={(v) => setFac('state', v)} maxLength={40} />
              <Field label="Facility ZIP" value={form.facility.zip} onChange={(v) => setFac('zip', v)} maxLength={12} />
            </div>
          </div>

          <div className="fs-section">
            <SecHead icon="shield" title="Insurance">
              {form.insurance.length < 3 && <button type="button" className="btn ghost sm" onClick={addIns}>+ Add insurance</button>}
            </SecHead>
            {form.insurance.length === 0 && <div className="fs-empty" style={{ padding: '10px 0' }}>No insurance on file. Add primary insurance.</div>}
            {form.insurance.map((ins, i) => (
              <div className="fs-ins" key={i}>
                <div className="fs-ins-head">
                  <span className={`fs-ins-rank r-${ins.type || 'primary'}`}>{INS_LABEL[ins.type] || `Policy ${i + 1}`}</span>
                  <span className="spacer" />
                  <button type="button" className="act danger" onClick={() => removeIns(i)}>Remove</button>
                </div>
                <div className="fs-grid fs-grid-3">
                  <PayerSearch
                    value={ins.payer}
                    payerId={ins.payerId}
                    onPick={(p) => setForm((f) => ({ ...f, insurance: f.insurance.map((it, idx) => (idx === i ? { ...it, payer: p.name, payerId: p.stediId || '' } : it)) }))}
                  />
                  <Field label="Member ID" value={ins.memberId} onChange={(v) => setInsAt(i, 'memberId', v)} maxLength={80} />
                  <Field label="Group #" value={ins.group} onChange={(v) => setInsAt(i, 'group', v)} maxLength={80} />
                  <Field label="Medicare Beneficiary ID (MBI)" value={ins.mbi} onChange={(v) => setInsAt(i, 'mbi', v)} maxLength={20} />
                  <Field label="Plan type" value={ins.planType} onChange={(v) => setInsAt(i, 'planType', v)} maxLength={60} />
                </div>
              </div>
            ))}
          </div>

          <div className="fs-section">
            <SecHead icon="contact" title="Emergency contacts">
              {form.emergencyContacts.length < 8 && <button type="button" className="btn ghost sm" onClick={addEmg}>+ Add contact</button>}
            </SecHead>
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

          {docMode !== 'records' && (
            <div className="fs-section" style={{ marginBottom: 0 }}>
              <SecHead icon="file" title="Documents" note={!pUuid ? 'create the patient to enable uploads' : undefined} />
              <div className="fs-docs">
                {DOC_SLOTS.map((slot) => (
                  <DropZone key={slot.key} slot={slot} doc={docFor(slot.key)} patientUuid={pUuid} onChanged={reloadDocs} onExtract={runExtract} disabled={!pUuid} />
                ))}
              </div>
            </div>
          )}
          </div>
          )}

          {viewTab === 'benefits' && (
          <div className="fs-section" style={{ marginBottom: 0 }}>
            <div className="fs-section-h">
              Insurance Benefits
              <span className="fs-section-note"> — coverage &amp; eligibility for each policy</span>
            </div>
            {!pUuid ? (
              <div className="fs-empty" style={{ padding: '14px 0' }}>Create the patient first, then verify eligibility here. Verified benefits are stored with this patient only.</div>
            ) : form.insurance.length === 0 ? (
              <div className="fs-empty" style={{ padding: '14px 0' }}>No insurance on file yet. Add insurance under the <strong>Patient Face Sheet</strong> tab, then verify eligibility here.</div>
            ) : (
              <BenefitsVerification
                patientUuid={pUuid}
                insurance={form.insurance}
                eligibilityEnabled={pEligibility}
                onPatientUpdated={(p) => setForm((f) => ({
                  ...f,
                  demographics: { ...f.demographics, ...(p.demographics || {}) },
                  insurance: Array.isArray(p.insurance) ? p.insurance : f.insurance,
                }))}
              />
            )}

            {form.insurance.length > 0 && (
            <details className="fs-manual-ben">
              <summary>Record benefits manually (phone verification)</summary>
              {form.insurance.map((ins, i) => {
                const ben = ins.benefits || {};
                const elig = ben.eligibilityStatus || 'not_verified';
                return (
                  <div className="fs-ben" key={i}>
                    <div className="fs-ben-head">
                      <span className={`fs-ins-rank r-${ins.type || 'primary'}`}>{INS_LABEL[ins.type] || `Policy ${i + 1}`}</span>
                      <span className="fs-ben-payer">{ins.payer || 'Payer not set'}{ins.memberId ? ` · ${ins.memberId}` : ''}</span>
                      <span className="spacer" />
                      <span className={`fs-elig ${elig}`}><span className="dot" />{ELIG_LABEL[elig]}</span>
                    </div>
                    <div className="fs-grid fs-grid-3">
                      <Field label="Eligibility status" options={ELIG_OPTS} value={elig} onChange={(v) => setBenAt(i, 'eligibilityStatus', v)} />
                      <Field label="Plan name" value={ben.planName} onChange={(v) => setBenAt(i, 'planName', v)} maxLength={120} />
                      <Field label="Network" value={ben.network} onChange={(v) => setBenAt(i, 'network', v)} maxLength={60} />
                      <Field label="Effective date" type="date" value={ben.effectiveDate} onChange={(v) => setBenAt(i, 'effectiveDate', v)} />
                      <Field label="Termination date" type="date" value={ben.termDate} onChange={(v) => setBenAt(i, 'termDate', v)} />
                      <Field label="Copay" value={ben.copay} onChange={(v) => setBenAt(i, 'copay', v)} maxLength={60} />
                      <Field label="Coinsurance" value={ben.coinsurance} onChange={(v) => setBenAt(i, 'coinsurance', v)} maxLength={60} />
                      <Field label="Deductible" value={ben.deductible} onChange={(v) => setBenAt(i, 'deductible', v)} maxLength={60} />
                      <Field label="Deductible met" value={ben.deductibleMet} onChange={(v) => setBenAt(i, 'deductibleMet', v)} maxLength={60} />
                      <Field label="Out-of-pocket max" value={ben.oopMax} onChange={(v) => setBenAt(i, 'oopMax', v)} maxLength={60} />
                      <Field label="Out-of-pocket met" value={ben.oopMet} onChange={(v) => setBenAt(i, 'oopMet', v)} maxLength={60} />
                    </div>
                    <div className="fs-grid fs-grid-3" style={{ marginTop: 10 }}>
                      <Field label="Verified date" type="date" value={ben.verifiedDate} onChange={(v) => setBenAt(i, 'verifiedDate', v)} />
                      <Field label="Verified by" value={ben.verifiedBy} onChange={(v) => setBenAt(i, 'verifiedBy', v)} maxLength={120} />
                      <Field label="Reference #" value={ben.referenceNo} onChange={(v) => setBenAt(i, 'referenceNo', v)} maxLength={60} />
                    </div>
                    <div className="field" style={{ marginTop: 10 }}>
                      <label>Coverage notes</label>
                      <input className="input" value={ben.coverageNotes || ''} maxLength={1000} placeholder="Prior auth, limitations, covered services…" onChange={(e) => setBenAt(i, 'coverageNotes', e.target.value)} />
                    </div>
                  </div>
                );
              })}
            </details>
            )}
          </div>
          )}

          {viewTab === 'encounters' && pUuid && (
            <EncountersTab
              patientUuid={pUuid}
              openNew={pendingNewEnc}
              startNoteType={pendingNewEncType}
              onOpenedNew={() => setPendingNewEnc(false)}
              patient={{ patientUuid: pUuid, patientName: patientDisplayName({ demographics: form.demographics }), mrn, facilityName: form.facility.facilityName, dob: form.demographics.dob, gender: form.demographics.gender }}
            />
          )}

          {viewTab === 'documents' && pUuid && (
          <div className="fs-sheet">
            <div className="fs-section" style={{ marginBottom: 0 }}>
              <SecHead icon="file" title="Documents" note="All documents received for this patient — by category, arranged by Date of Service. View or download." />
              <DocumentsLibrary patientUuid={pUuid} onChanged={reloadDocs} />
            </div>
          </div>
          )}

        </div>
      )}
      {builderOpen && (
        <CustomTemplateBuilder
          initial={{}}
          headingDict={Object.entries(SECTION_LABELS)}
          onSave={async ({ name, sections }) => {
            try {
              const { data } = await encountersApi.createCustomTemplate({ name, sections });
              setCustomTpls((cs) => [data.template, ...cs]);
              setBuilderOpen(false);
              toast.success('Template saved — starting an encounter with it.');
              if (pUuid) { setPendingNewEncType(`custom:${data.template.uuid}`); setViewTab('encounters'); setPendingNewEnc(true); }
            } catch (e) { toast.error(toApiError(e).message); throw e; }
          }}
          onClose={() => setBuilderOpen(false)}
        />
      )}
    </Modal>
  );
}

/**
 * Encounters for a single patient — the full encounters table plus New Encounter,
 * living inside the Face Sheet modal (next to Benefits Information). Server-paginated;
 * New Encounter and note editing open scoped to this patient only.
 */
function EncountersTab({ patientUuid, patient, openNew = false, startNoteType = null, onOpenedNew }) {
  const toast = useToast();
  const [encs, setEncs] = useState(null);
  const [encTotal, setEncTotal] = useState(0);
  const [ePage, setEPage] = useState(1);
  const [eLoading, setELoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notesEnc, setNotesEnc] = useState(null);

  // Create a new encounter for this patient (dated today) and open its note editor — no
  // dialog. If a note type was chosen from the dropdown, the editor auto-starts that note.
  async function createEncounterNow(noteType = null) {
    if (creating) return;
    setCreating(true);
    try {
      const encounterDate = new Date().toISOString().slice(0, 10);
      const { data } = await encountersApi.create({ patientUuid, encounterDate });
      setRefreshKey((k) => k + 1);
      setNotesEnc({ encounterUuid: data.encounter.uuid, encounterNo: data.encounter.encounterNo, patientUuid, date: encounterDate, patientName: patient.patientName, mrn: patient.mrn, facilityName: patient.facilityName, dob: patient.dob, gender: patient.gender, startNoteType: noteType || null });
    } catch (e) { toast.error(toApiError(e).message); } finally { setCreating(false); }
  }

  // The "New encounter" button lives in the patient header. Clicking it (or a note type in
  // its dropdown) switches to this tab and sets openNew → create the encounter and open it.
  useEffect(() => {
    if (openNew) { onOpenedNew?.(); createEncounterNow(startNoteType); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNew]);

  useEffect(() => {
    let active = true;
    setELoading(true);
    encountersApi.patientEncounters(patientUuid, { page: ePage, pageSize: ENC_PER_PAGE })
      .then(({ data }) => { if (active) { setEncs(data.encounters || []); setEncTotal(data.total || 0); } })
      .catch((e) => { if (active) { setEncs([]); toast.error(toApiError(e).message); } })
      .finally(() => { if (active) setELoading(false); });
    return () => { active = false; };
  }, [ePage, patientUuid, refreshKey, toast]);

  const ePages = Math.max(1, Math.ceil(encTotal / ENC_PER_PAGE));
  // If the total shrinks (e.g. an encounter is removed) and the current page no longer exists,
  // snap back to the last valid page so the table never shows a stale empty page.
  useEffect(() => { if (ePage > ePages) setEPage(ePages); }, [ePages, ePage]);
  const reload = () => setRefreshKey((k) => k + 1);
  const encFor = (r) => ({ encounterUuid: r.encounterUuid, encounterNo: r.encounterNo, patientName: patient.patientName, mrn: patient.mrn, date: r.date, facilityName: patient.facilityName, dob: patient.dob, gender: patient.gender, renderingProvider: r.renderingProvider, signedOffProvider: r.signedOffProvider });

  return (
    <div className="fs-section" style={{ marginBottom: 0 }}>
      <div className="enc-sub-toolbar">
        <span className="enc-sub-toolbar-lbl">{encTotal} encounter{encTotal === 1 ? '' : 's'} for {patient.patientName || 'this patient'}</span>
      </div>
      {/* 7-column table can exceed the modal width — scroll it horizontally within the panel so the
          Main Panel never overflows/breaks. */}
      <div className="enc-subtable-wrap" style={{ overflowX: 'auto', width: '100%' }}>
      <table className="enc-subtable">
        <thead>
          <tr>
            <th>Encounter ID</th>
            <th>Date of Service</th>
            <th>Note Type</th>
            <th>Service Type</th>
            <th>Rendering Provider</th>
            <th>Signed off Provider</th>
            <th className="enc-sub-act">Action</th>
          </tr>
        </thead>
        <tbody>
          {eLoading && !encs ? (
            <tr><td colSpan={7} className="table-empty"><span className="spinner dark" /> Loading…</td></tr>
          ) : (encs && encs.length === 0) ? (
            <tr><td colSpan={7} className="table-empty">No encounters for this patient yet.</td></tr>
          ) : (encs || []).map((r) => (
            <tr key={r.encounterUuid}>
              <td className="mono">{encNo(r.encounterNo)}</td>
              <td>{usDate(r.date)}</td>
              <td>{procedureLabel(r)}</td>
              <td>{encTypeLabel(r.encounterType)}</td>
              <td>{r.renderingProvider || '—'}</td>
              <td>{r.signedOffProvider || <span className="enc-unsigned">Not signed</span>}</td>
              <td className="enc-sub-act">
                <button type="button" className="act accent" onClick={() => setNotesEnc(encFor(r))} title="Open encounter & clinical notes">View</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {ePages > 1 && (
        <div className="pager pager-c">
          <span className="pager-label">Showing {(ePage - 1) * ENC_PER_PAGE + 1}–{Math.min(ePage * ENC_PER_PAGE, encTotal)} of {encTotal}</span>
          <span className="spacer" />
          <button className="pager-btn" disabled={ePage <= 1 || eLoading} onClick={() => setEPage((p) => Math.max(1, p - 1))}>‹ Prev</button>
          {pageWindow(ePage, ePages).map((x, i) => (x === '…'
            ? <span key={`e${i}`} className="pager-ellipsis">…</span>
            : <button key={x} className={`pager-num ${x === ePage ? 'is-on' : ''}`} disabled={eLoading} onClick={() => setEPage(x)}>{x}</button>))}
          <button className="pager-btn" disabled={ePage >= ePages || eLoading} onClick={() => setEPage((p) => Math.min(ePages, p + 1))}>Next ›</button>
        </div>
      )}

      {notesEnc && <EncounterNotesModal encounter={notesEnc} onClose={() => setNotesEnc(null)} onChanged={reload} />}
    </div>
  );
}
