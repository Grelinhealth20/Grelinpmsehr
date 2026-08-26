import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { encountersApi, patientsApi, toApiError } from '../lib/api.js';
import { NOTE_TYPES, TEMPLATES } from '../lib/noteTemplates.js';

const today = () => new Date().toISOString().slice(0, 10);
// Display DOS in US format (MM/DD/YYYY); inputs keep the ISO value they require.
export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : (iso || '—'); };
// Encounter ID display — clean sequential number, strip any legacy leading zeros.
export const encNo = (v) => { const s = String(v ?? '').trim(); return s ? s.replace(/^0+(?=\d)/, '') : '—'; };
const hasMD = (user) => (user?.credentials || []).some((c) => String(c).toUpperCase().trim() === 'MD');
const blankRx = () => ({ drug: '', dose: '', route: '', frequency: '', quantity: '', refills: '', sig: '' });
// Structured vital signs shown at the TOP of the note.
const VITALS = [
  { k: 'temp', label: 'Temp °F', ph: '98.6' },
  { k: 'hr', label: 'HR bpm', ph: '72' },
  { k: 'bp', label: 'BP', ph: '120/80' },
  { k: 'rr', label: 'RR', ph: '16' },
  { k: 'spo2', label: 'SpO₂ %', ph: '98' },
  { k: 'weight', label: 'Wt lb', ph: '—' },
  { k: 'pain', label: 'Pain', ph: '0' },
];

// Section icons — a clean, monochrome visual anchor per section (enterprise EHR feel).
const ICON_PATHS = {
  doc: <><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v4h4M9 13h6M9 16.5h4" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  pill: <><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)" /><path d="M8.5 8.5l7 7" /></>,
  alert: <><path d="M12 4l8.5 15H3.5z" /><path d="M12 10v4M12 17h.01" /></>,
  activity: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  list: <><path d="M8 6h11M8 12h11M8 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
  check: <path d="M4 12.5l5 5 11-11" />,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.2" /></>,
  shield: <path d="M12 3l7.5 3.2v5.3c0 4.8-3.2 8.3-7.5 10.2-4.3-1.9-7.5-5.4-7.5-10.2V6.2z" />,
  users: <><circle cx="9" cy="9" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.3a3 3 0 0 1 0 5.4M15.5 13.6a5.5 5.5 0 0 1 5 5.4" /></>,
  home: <><path d="M4 11l8-6.5 8 6.5" /><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9M10 20v-6h4v6" /></>,
  bell: <><path d="M6.5 9a5.5 5.5 0 0 1 11 0c0 5 2 6 2 6H4.5s2-1 2-6Z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  flask: <path d="M9.5 3h5M10.5 3v5.5L5.6 18a1.2 1.2 0 0 0 1 1.9h10.8a1.2 1.2 0 0 0 1-1.9L13.5 8.5V3" />,
  hospital: <><rect x="4" y="7" width="16" height="13" rx="1" /><path d="M12 10v5M9.5 12.5h5" /></>,
  trend: <><path d="M4 16l5-5 4 3 7-7" /><path d="M15 7h5v5" /></>,
  brain: <><path d="M12 5a3.5 3.5 0 0 0-3.5 3.5A3 3 0 0 0 7 14v.5a3 3 0 0 0 5 2 3 3 0 0 0 5-2V14a3 3 0 0 0-1.5-5.5A3.5 3.5 0 0 0 12 5Z" /><path d="M12 5v11.5" /></>,
  plus: <><circle cx="12" cy="12" r="8" /><path d="M12 8.5v7M8.5 12h7" /></>,
};
const SEC_ICON = {
  chiefComplaint: 'doc', changeDescription: 'alert', hpi: 'doc', interval: 'clock', hospitalCourse: 'hospital',
  ros: 'list', pmh: 'clock', psh: 'clock', familyHistory: 'users', socialHistory: 'users',
  medications: 'pill', medChanges: 'pill', dischargeMeds: 'pill', allergies: 'alert', adverseEffects: 'alert',
  vitals: 'activity', exam: 'activity', wound: 'plus', treatment: 'plus', results: 'flask', carePlanReview: 'list',
  assessment: 'check', mdm: 'brain', plan: 'target', orders: 'list', notifications: 'bell', prognosis: 'trend',
  goals: 'target', participants: 'users', decisionsMade: 'check', codeStatus: 'shield', advanceDirective: 'shield',
  dischargeDiagnoses: 'doc', procedures: 'activity', functionalStatus: 'activity', disposition: 'home',
  followUp: 'clock', dischargeInstructions: 'doc', careCoordination: 'users', pronouncement: 'doc',
  circumstances: 'doc', causeOfDeath: 'doc', regulatoryAttestation: 'shield', timeSpent: 'clock', addendum: 'doc',
};
function SectionIcon({ k }) {
  return (
    <span className="nt-sec-ic" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {ICON_PATHS[SEC_ICON[k] || 'doc']}
      </svg>
    </span>
  );
}

/* -------- New Encounter: select patient + date ---------------------------- */
export function NewEncounterModal({ onClose, onCreated }) {
  const toast = useToast();
  const [patients, setPatients] = useState([]);
  const [patientUuid, setPatientUuid] = useState('');
  const [encounterDate, setEncounterDate] = useState(today());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    patientsApi.list().then(({ data }) => setPatients(data.patients || [])).catch((e) => toast.error(toApiError(e).message));
  }, [toast]);

  async function create() {
    if (!patientUuid) { toast.error('Select a patient.'); return; }
    setSaving(true);
    try {
      const { data } = await encountersApi.create({ patientUuid, encounterDate });
      const p = patients.find((x) => x.uuid === patientUuid);
      const patientName = p?.demographics ? `${p.demographics.firstName || ''} ${p.demographics.lastName || ''}`.trim() : '';
      toast.success('Encounter created.');
      onCreated?.({ encounterUuid: data.encounter.uuid, encounterNo: data.encounter.encounterNo, patientUuid, date: encounterDate, patientName });
    } catch (e) { toast.error(toApiError(e).message); } finally { setSaving(false); }
  }

  return (
    <Modal title="New Encounter" onClose={onClose} footer={<>
      <span className="spacer" />
      <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="btn" onClick={create} disabled={saving || !patientUuid}>{saving ? <span className="spinner" /> : 'Create encounter'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="field">
          <label>Patient<span className="fs-req">*</span></label>
          <select className="select" value={patientUuid} onChange={(e) => setPatientUuid(e.target.value)}>
            <option value="">Select a patient…</option>
            {patients.map((p) => (
              <option key={p.uuid} value={p.uuid}>
                {(p.demographics ? `${p.demographics.firstName || ''} ${p.demographics.lastName || ''}`.trim() : '') || 'Unnamed'} · {p.mrn}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Encounter date<span className="fs-req">*</span></label>
          <input className="input" type="date" value={encounterDate} max={today()} onChange={(e) => setEncounterDate(e.target.value)} />
        </div>
        <div className="nt-hint">A DOS-scoped encounter number is generated automatically and wired to the patient MRN.</div>
      </div>
    </Modal>
  );
}

/* -------- Encounter workspace: notes list + editor ------------------------ */
export function EncounterNotesModal({ encounter, onClose, onChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const canSign = hasMD(user);

  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const [active, setActive] = useState(null); // full note being edited/viewed
  const [tab, setTab] = useState('note');
  const [content, setContent] = useState({ vitals: {}, sections: {}, prescriptions: [] });
  const [reason, setReason] = useState('');
  const [pharmacy, setPharmacy] = useState(null);   // pharmacy/PBM vendor from benefits
  const [rxCarry, setRxCarry] = useState(null);      // carry-forward source info
  const [busy, setBusy] = useState(false);
  const [autoState, setAutoState] = useState('idle'); // idle | saving | saved
  const [amending, setAmending] = useState(false); // MD editing a signed note
  const [amendModal, setAmendModal] = useState(false); // reason prompt for amendment
  const [amendReason, setAmendReason] = useState('');
  const skipSave = useRef(true); // skip the save that a fresh load/open would trigger

  async function loadNotes({ autoOpen = false } = {}) {
    setLoading(true);
    try {
      const { data } = await encountersApi.listNotes(encounter.encounterUuid);
      const list = data.notes || [];
      setNotes(list);
      // On first open of the encounter, auto-open the LATEST note (newest first) so the
      // provider sees it immediately instead of the empty "Click + New note" placeholder.
      if (autoOpen && list.length && !active) await openNote(list[0].uuid);
    } catch (e) { toast.error(toApiError(e).message); } finally { setLoading(false); }
  }
  useEffect(() => { if (encounter?.encounterUuid) loadNotes({ autoOpen: true }); /* eslint-disable-next-line */ }, [encounter?.encounterUuid]);

  async function openNote(uuid) {
    try {
      const { data } = await encountersApi.getNote(uuid);
      skipSave.current = true;
      setAutoState('idle');
      setAmending(false); setAmendReason('');
      setActive(data.note);
      setContent({
        vitals: data.note.content?.vitals || {},
        sections: data.note.content?.sections || {},
        prescriptions: data.note.content?.prescriptions || [],
        // Persist the template's clinical section order so the downloaded record
        // renders in the exact provider order (dynamic, per note type).
        sectionOrder: (TEMPLATES[data.note.noteType] || []).map((s) => s.key),
      });
      setReason(data.note.reason || '');
      setRxCarry(null);
      setTab('note');
      // Load the pharmacy/PBM vendor from the patient's benefits (display only).
      if (encounter.patientUuid) {
        encountersApi.rxContext(encounter.patientUuid).then((rc) => setPharmacy(rc.data.pharmacy || null)).catch(() => setPharmacy(null));
      }
    } catch (e) { toast.error(toApiError(e).message); }
  }

  async function createNote(noteType) {
    setPicking(false);
    setBusy(true);
    try {
      const order = (TEMPLATES[noteType] || []).map((s) => s.key);
      // Carry forward the patient's current medication list + pull the pharmacy/PBM
      // vendor from their benefits, so a new encounter starts with the active meds.
      let carriedRx = []; let pharm = null; let carrySrc = null;
      try {
        if (encounter.patientUuid) {
          const rc = await encountersApi.rxContext(encounter.patientUuid);
          carriedRx = rc.data.prescriptions || [];
          pharm = rc.data.pharmacy || null;
          if (carriedRx.length) carrySrc = { date: rc.data.sourceDate };
        }
      } catch { /* best-effort — a new note simply starts empty */ }
      const initContent = { vitals: {}, sections: {}, prescriptions: carriedRx, sectionOrder: order };
      const { data } = await encountersApi.createNote(encounter.encounterUuid, { noteType, content: initContent });
      // Show the template immediately (single round-trip) — refresh the tab list
      // in the background so there's no perceived wait.
      skipSave.current = true;
      setAutoState('idle');
      setActive(data.note);
      setContent(initContent);
      setPharmacy(pharm);
      setRxCarry(carrySrc);
      setReason('');
      setTab('note');
      loadNotes();
      onChanged?.();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  const signed = active?.status === 'signed';
  // Read-only unless the viewer OWNS the note. A facility-wide MD may open another
  // provider's note to review/sign, but only the author edits it (no silent
  // failed saves, no cross-provider edits). EXCEPTION: an MD actively amending a
  // signed note edits it in place — the amendment is saved explicitly with a reason.
  const readOnly = amending ? false : (signed || active?.isOwner === false);
  const setSection = (k, v) => setContent((c) => ({ ...c, sections: { ...c.sections, [k]: v } }));
  const setVital = (k, v) => setContent((c) => ({ ...c, vitals: { ...(c.vitals || {}), [k]: v } }));
  const setRxAt = (i, k, v) => setContent((c) => ({ ...c, prescriptions: c.prescriptions.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)) }));
  const addRx = () => setContent((c) => ({ ...c, prescriptions: [...c.prescriptions, blankRx()] }));
  const removeRx = (i) => setContent((c) => ({ ...c, prescriptions: c.prescriptions.filter((_, idx) => idx !== i) }));

  // Auto-save: debounced persistence of EVERY edit (vitals, sections, Rx, reason)
  // so nothing is ever lost. Skips signed (immutable) notes and the initial load.
  useEffect(() => {
    // Never auto-save a signed note or a note the viewer does not own (read-only).
    if (!active || active.status === 'signed' || active.isOwner === false) return undefined;
    if (skipSave.current) { skipSave.current = false; return undefined; }
    setAutoState('saving');
    const t = setTimeout(async () => {
      try {
        await encountersApi.updateNote(active.uuid, { content, reason });
        setAutoState('saved');
      } catch { setAutoState('idle'); }
    }, 800);
    return () => clearTimeout(t);
  }, [content, reason]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush any pending edit before closing (covers the debounce window).
  async function closeWithSave() {
    if (active && active.status !== 'signed' && active.isOwner !== false && !skipSave.current) {
      try { await encountersApi.updateNote(active.uuid, { content, reason }); } catch { /* best-effort */ }
    }
    onClose();
  }

  async function save() {
    if (!active) return;
    setBusy(true);
    try {
      await encountersApi.updateNote(active.uuid, { content, reason });
      toast.success('Draft saved.');
      await loadNotes();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  async function sign() {
    if (!active) return;
    if (!canSign) { toast.error('Only a provider with an MD credential can sign off a note.'); return; }
    setBusy(true);
    try {
      const { data } = await encountersApi.signNote(active.uuid, { content, reason });
      setActive(data.note);
      toast.success('Note signed — finalized and saved to the patient folder for billing.');
      await loadNotes();
      onChanged?.();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  async function downloadPdf() {
    if (!active) return;
    setBusy(true);
    try {
      await encountersApi.downloadNote(active.uuid, `medical-record-${encounter.mrn || 'record'}.pdf`);
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  // MD-only: unlock a signed note for editing after capturing a required reason.
  function startAmend() {
    setAmendReason('');
    setAmendModal(true);
  }
  function confirmAmend() {
    if (amendReason.trim().length < 3) { toast.error('Enter a reason for editing this signed note.'); return; }
    setAmendModal(false);
    skipSave.current = true; // amend is saved explicitly, never auto-saved
    setAmending(true);
  }
  async function saveAmendment() {
    if (!active) return;
    setBusy(true);
    try {
      const { data } = await encountersApi.amendNote(active.uuid, { content, reason: amendReason.trim() });
      setActive(data.note);
      setAmending(false);
      setAmendReason('');
      toast.success('Signed note amended — reason logged and the patient document re-issued.');
      await loadNotes();
      onChanged?.();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }
  function cancelAmend() {
    // Discard in-progress edits by reloading the note from the server.
    setAmending(false);
    setAmendReason('');
    if (active) openNote(active.uuid);
  }

  const template = active ? (TEMPLATES[active.noteType] || []) : [];

  return (
    <>
    {picking && <NoteTypePicker busy={busy} onPick={createNote} onClose={() => setPicking(false)} />}
    {amendModal && (
      <Modal title="Edit signed note" onClose={() => setAmendModal(false)} footer={<>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setAmendModal(false)}>Cancel</button>
        <button className="btn" onClick={confirmAmend} disabled={amendReason.trim().length < 3}>Continue editing</button>
      </>}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="nt-amend-note">
            This note is signed and part of the billing record. Editing it creates an amendment.
            A reason is required and is recorded in the audit log under your name.
          </div>
          <div className="field">
            <label>Reason for editing<span className="fs-req">*</span></label>
            <textarea
              className="input" rows={3} autoFocus value={amendReason}
              placeholder="e.g. Corrected medication dose documented in error."
              onChange={(e) => setAmendReason(e.target.value)}
            />
          </div>
        </div>
      </Modal>
    )}
    <Modal size="full" title={`Encounter · ${encounter.patientName || 'Patient'}`} onClose={closeWithSave} footer={<>
      <span className="nt-foot-meta">Encounter {encNo(encounter.encounterNo)} · DOS {usDate(encounter.date)}</span>
      {active && !readOnly && !amending && (
        <span className={`nt-autosave ${autoState}`}>
          {autoState === 'saving' ? 'Saving…' : autoState === 'saved' ? 'All changes saved' : 'Auto-saves as you type'}
        </span>
      )}
      {active && amending && (
        <span className="nt-amend-flag">Amending signed note · save to finalize the correction</span>
      )}
      {active && !signed && active.isOwner === false && (
        <span className="clr-draft-flag" style={{ marginLeft: 12 }}>Read-only · another provider's note</span>
      )}
      <span className="spacer" />
      {amending ? (
        <>
          <button className="btn ghost" onClick={cancelAmend} disabled={busy}>Cancel edit</button>
          <button className="btn" onClick={saveAmendment} disabled={busy}>
            {busy ? <span className="spinner" /> : 'Save amendment'}
          </button>
        </>
      ) : (
        <>
          <button className="btn ghost" onClick={closeWithSave}>Close</button>
          {active && (signed || canSign) && (
            <button className="btn ghost" onClick={downloadPdf} disabled={busy} title="Download this record as a PDF">
              {busy ? <span className="spinner" /> : 'Download PDF'}
            </button>
          )}
          {active && !signed && (
            <button className="btn" onClick={sign} disabled={busy || !canSign} title={canSign ? 'Sign & finalize for billing' : 'Only an MD can sign off'}>
              {busy ? <span className="spinner" /> : 'Sign & finalize'}
            </button>
          )}
          {active && signed && canSign && (
            <button className="btn ghost" onClick={startAmend} disabled={busy} title="Edit this signed note (reason required)">
              Edit signed note
            </button>
          )}
        </>
      )}
    </>}>
      <div className="nt2">
        {/* Slim command bar: note pills · patient identity · status · New note */}
        <div className="nt2-top">
          <div className="nt2-tabs">
            {notes.map((n) => (
              <button key={n.uuid} type="button" className={`nt2-tab ${active?.uuid === n.uuid ? 'is-on' : ''}`} onClick={() => openNote(n.uuid)}>
                {NOTE_TYPES[n.noteType]?.label || n.noteType}
                <span className={`nt2-dot ${n.status === 'signed' ? 'signed' : 'draft'}`} title={n.status === 'signed' ? 'Signed' : 'Draft'} />
              </button>
            ))}
          </div>
          <div className="nt2-ident">
            <span className="nt2-ident-nm">{encounter.patientName || 'Patient'}</span>
            <span className="nt2-ident-meta">
              <span><b>MRN</b> {encounter.mrn || '—'}</span>
              <span><b>Enc</b> {encNo(encounter.encounterNo)}</span>
              <span><b>DOS</b> {usDate(encounter.date)}</span>
            </span>
          </div>
          <span className="spacer" />
          {active && (signed
            ? <span className="nt-status-pill signed"><span className="nt-signed-dot" />Signed · {active.signedByName || 'MD'}</span>
            : <span className="nt-status-pill draft">Draft</span>)}
          <button className="btn sm nt2-new" onClick={() => setPicking(true)}>+ New note</button>
        </div>

        <section className="nt-main">
          {loading && !active ? (
            <div className="nt-placeholder"><span className="spinner dark" /></div>
          ) : !active ? (
            <div className="nt-placeholder">
              <div className="nt-ph-icon" aria-hidden="true" />
              <div>Click <strong>+ New note</strong> to create a clinical note.</div>
              <div className="nt-ph-sub">CMS-compliant SNF templates · MD sign-off required for billing</div>
            </div>
          ) : (
            <>
              <div className="nt-subbar">
                <div className="nt-subtabs">
                  <button className={`nt-tab ${tab === 'note' ? 'is-on' : ''}`} onClick={() => setTab('note')}>Clinical Note</button>
                  <button className={`nt-tab ${tab === 'rx' ? 'is-on' : ''}`} onClick={() => setTab('rx')}>Prescriptions{content.prescriptions.length ? ` (${content.prescriptions.length})` : ''}</button>
                </div>
                <span className="nt-subcat">{NOTE_TYPES[active.noteType]?.category} · CPT {NOTE_TYPES[active.noteType]?.cpt}</span>
              </div>

              {tab === 'note' ? (
                <div className="nt-doc-scroll">
                  <article className={`nt-doc-page ${readOnly ? 'is-signed' : 'is-editing'}`}>
                    <header className="nt-page-head">
                      {encounter.facilityName && <div className="nt-page-fac">{encounter.facilityName}</div>}
                      <div className="nt-page-title">{NOTE_TYPES[active.noteType]?.label}</div>
                      <div className="nt-page-meta">
                        <span><b>Patient:</b> {encounter.patientName || '—'}</span>
                        <span><b>MRN:</b> {encounter.mrn || '—'}</span>
                        <span><b>Encounter ID:</b> {encNo(encounter.encounterNo)}</span>
                        <span><b>Date of Service:</b> {usDate(encounter.date)}</span>
                      </div>
                    </header>

                    {template.some((s) => s.key === 'vitals') && (!readOnly || VITALS.some((v) => content.vitals?.[v.k])) && (
                      <section className={`nt-sec ${readOnly ? '' : 'nt-vitals-sec'}`}>
                        <h4 className="nt-sec-h">{!readOnly && <SectionIcon k="vitals" />}Vital Signs</h4>
                        {readOnly ? (
                          <div className="nt-sec-body"><p>{VITALS.map((v) => (content.vitals?.[v.k] ? `${v.label}: ${content.vitals[v.k]}` : null)).filter(Boolean).join('    ·    ')}</p></div>
                        ) : (
                          <div className="nt-vgrid">
                            {VITALS.map((v) => (
                              <div className="nt-vfld" key={v.k}>
                                <label>{v.label}</label>
                                <input className="input" value={content.vitals?.[v.k] || ''} placeholder={v.ph} onChange={(e) => setVital(v.k, e.target.value)} />
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    )}

                    {template.filter((s) => s.key !== 'vitals' && (!readOnly || (content.sections[s.key] || '').trim())).map((s) => (
                      <section className="nt-sec" key={s.key}>
                        <h4 className="nt-sec-h">{!readOnly && <SectionIcon k={s.key} />}{s.label}</h4>
                        {readOnly ? (
                          <div className="nt-sec-body">
                            {(content.sections[s.key] || '').trim()
                              ? (content.sections[s.key]).split('\n').map((ln, i) => <p key={i}>{ln || ' '}</p>)
                              : <p className="nt-sec-blank">—</p>}
                          </div>
                        ) : (
                          <AutoText rows={s.rows >= 4 ? 4 : 2} value={content.sections[s.key] || ''} placeholder={s.prompt} onChange={(v) => setSection(s.key, v)} />
                        )}
                      </section>
                    ))}

                    {signed && (
                      <footer className="nt-page-sign">
                        <div className="nt-sign-line" />
                        <div className="nt-sign-name">Electronically signed by {active.signedByName || 'Provider'}, MD</div>
                        <div className="nt-sign-sub">Finalized and ready for billing.</div>
                      </footer>
                    )}
                  </article>
                </div>
              ) : (
                <div className="nt-doc-scroll rx2-scroll">
                  <div className="rx2">
                    <PharmacyBanner pharmacy={pharmacy} />
                    {rxCarry && !readOnly && (
                      <div className="rx2-carry">
                        <span className="rx2-carry-ic" aria-hidden="true">⟳</span>
                        Medications carried forward{rxCarry.date ? ` from ${usDate(rxCarry.date)}` : ''} — review and update for this encounter.
                      </div>
                    )}
                    <div className="rx2-head">
                      <span className="rx2-head-t">Active Medications{content.prescriptions.filter((r) => r.drug).length ? ` · ${content.prescriptions.filter((r) => r.drug).length}` : ''}</span>
                      <span className="spacer" />
                      {!readOnly && <button className="btn ghost sm" onClick={addRx}>+ Add medication</button>}
                    </div>
                    {content.prescriptions.length === 0 ? (
                      <div className="rx2-empty">No active medications{readOnly ? ' on this note.' : '. Add a medication to prescribe, or it carries forward from the last encounter.'}</div>
                    ) : content.prescriptions.map((r, i) => (
                      <div className="rx2-med" key={i}>
                        <div className="rx2-med-top">
                          <span className="rx2-med-n">{i + 1}</span>
                          <input className="rx2-drug" placeholder="Medication name" value={r.drug || ''} disabled={readOnly} onChange={(e) => setRxAt(i, 'drug', e.target.value)} />
                          {!readOnly && <button type="button" className="rx2-x" title="Remove medication" onClick={() => removeRx(i)}>✕</button>}
                        </div>
                        <div className="rx2-grid">
                          <RxF label="Dose" v={r.dose} on={(v) => setRxAt(i, 'dose', v)} d={readOnly} />
                          <RxF label="Route" v={r.route} on={(v) => setRxAt(i, 'route', v)} d={readOnly} />
                          <RxF label="Frequency" v={r.frequency} on={(v) => setRxAt(i, 'frequency', v)} d={readOnly} />
                          <RxF label="Quantity" v={r.quantity} on={(v) => setRxAt(i, 'quantity', v)} d={readOnly} />
                          <RxF label="Refills" v={r.refills} on={(v) => setRxAt(i, 'refills', v)} d={readOnly} />
                        </div>
                        <div className="rx2-sigrow">
                          <label>Sig / Directions</label>
                          <input className="input rx2-sig" placeholder="e.g. Take one tablet by mouth daily" value={r.sig || ''} disabled={readOnly} onChange={(e) => setRxAt(i, 'sig', e.target.value)} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!canSign && !signed && <div className="nt-md-note">Sign-off is restricted to providers with an <strong>MD</strong> credential. You can draft and save this note.</div>}
            </>
          )}
        </section>
      </div>
    </Modal>
    </>
  );
}

const SERVICE_LABEL = { snf: 'Skilled Nursing Facility', pain: 'Pain Management' };

/**
 * Pop-up: choose the note template to create. The list is fetched from the note-
 * template registry (DB) filtered to the current provider's SERVICE LINE — an SNF
 * provider sees only SNF templates, a Pain provider only Pain templates. Access is
 * also enforced on the server when the note is created.
 */
function NoteTypePicker({ onPick, onClose, busy }) {
  const [q, setQ] = useState('');
  const [templates, setTemplates] = useState(null); // null = loading
  const [serviceLine, setServiceLine] = useState('snf');

  useEffect(() => {
    let active = true;
    encountersApi.noteTemplates()
      .then(({ data }) => { if (active) { setTemplates(data.templates || []); setServiceLine(data.serviceLine || 'snf'); } })
      .catch(() => { if (active) setTemplates([]); });
    return () => { active = false; };
  }, []);

  const query = q.trim().toLowerCase();
  const match = (t) => !query
    || (t.label || '').toLowerCase().includes(query)
    || (t.category || '').toLowerCase().includes(query)
    || String(t.cpt || '').toLowerCase().includes(query);
  const row = (t) => (
    <button key={t.noteType} type="button" className="ntp-row" disabled={busy} onClick={() => onPick(t.noteType)}>
      <span className="ntp-row-ic" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v4h4M9 13h6M9 16.5h4" />
        </svg>
      </span>
      <span className="ntp-row-main">
        <span className="ntp-row-title">{t.label}</span>
        <span className="ntp-row-cat">{t.category}</span>
      </span>
      <span className="ntp-row-cpt">{t.cpt}</span>
      <span className="ntp-row-arrow" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h9M8.5 4l4 4-4 4" /></svg>
      </span>
    </button>
  );
  const list = templates || [];
  const common = list.filter((t) => t.menuGroup === 'common' && match(t));
  const more = list.filter((t) => t.menuGroup !== 'common' && match(t));
  const all = list.filter(match);
  const searching = !!query;
  return (
    <Modal title="Create a New Note" width={840} onClose={onClose} footer={<>
      <span className="ntp-foot">CMS-compliant {SERVICE_LABEL[serviceLine] || 'clinical'} templates · MD sign-off required for billing</span>
      <span className="spacer" />
      <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
    </>}>
      <div className="ntp">
        <div className="ntp-search">
          <svg className="ntp-search-ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" /></svg>
          <input className="ntp-search-in" autoFocus placeholder="Search note templates by name, category or CPT…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {templates === null ? (
          <div className="ntp-empty">Loading your templates…</div>
        ) : list.length === 0 ? (
          <div className="ntp-empty">No note templates are available for your specialty.</div>
        ) : searching ? (
          <div className="ntp-sec">
            <div className="ntp-group"><span>{all.length} result{all.length === 1 ? '' : 's'}</span><i /></div>
            {all.length ? <div className="ntp-list">{all.map(row)}</div> : <div className="ntp-empty">No templates match “{q}”.</div>}
          </div>
        ) : (
          <>
            <div className="ntp-sec">
              <div className="ntp-group"><span>Common</span><i /></div>
              <div className="ntp-list">{common.map(row)}</div>
            </div>
            {more.length > 0 && (
              <div className="ntp-sec">
                <div className="ntp-group"><span>More templates</span><i /></div>
                <div className="ntp-list">{more.map(row)}</div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** Large, clean, auto-growing writing area — grows to fit the text exactly, no
 *  scrollbar. Accounts for the border (box-sizing: border-box) so the last line
 *  is never clipped. */
function AutoText({ value, onChange, placeholder, rows = 3 }) {
  const ref = useRef(null);
  const minH = rows * 24 + 20;
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const borderY = el.offsetHeight - el.clientHeight; // top+bottom border (border-box)
    el.style.height = `${Math.max(el.scrollHeight + borderY, minH)}px`;
  };
  useEffect(resize, [value]);
  return (
    <textarea
      ref={ref}
      className="nt-sec-edit"
      style={{ minHeight: `${minH}px` }}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onInput={resize}
    />
  );
}

function Fld({ label, v, on, d, wide }) {
  return (
    <div className={`field ${wide ? 'nt-fld-wide' : ''}`}>
      <label>{label}</label>
      <input className="input" value={v} disabled={d} onChange={(e) => on(e.target.value)} />
    </div>
  );
}

/** Compact medication field (dose/route/frequency/…). */
function RxF({ label, v, on, d }) {
  return (
    <div className="rx2-f">
      <label>{label}</label>
      <input className="input" value={v || ''} disabled={d} onChange={(e) => on(e.target.value)} />
    </div>
  );
}

/** Pharmacy / PBM vendor pulled from the patient's benefits (real data only). */
function PharmacyBanner({ pharmacy: p }) {
  const cost = p ? [p.copay && `Copay ${p.copay}`, p.coinsurance && `Coinsurance ${p.coinsurance}`].filter(Boolean).join('  ·  ') : '';
  return (
    <div className={`rx2-pharm ${p ? '' : 'is-empty'}`}>
      <span className="rx2-pharm-ic" aria-hidden="true">℞</span>
      <div className="rx2-pharm-main">
        <span className="rx2-pharm-lbl">Pharmacy Benefit{p?.network ? `  ·  ${p.network}` : ''}</span>
        {p ? (
          <>
            <span className="rx2-pharm-v">{p.vendor || p.planName || 'Covered'}</span>
            {(cost || (p.messages && p.messages.length)) && (
              <span className="rx2-pharm-sub">{[cost, (p.messages || [])[0]].filter(Boolean).join('  ·  ')}</span>
            )}
          </>
        ) : (
          <span className="rx2-pharm-sub">No pharmacy benefit returned by the payer. Run eligibility on the Benefits tab to populate the pharmacy vendor.</span>
        )}
      </div>
    </div>
  );
}
