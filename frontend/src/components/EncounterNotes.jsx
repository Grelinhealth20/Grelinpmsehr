import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { encountersApi, terminologyApi, toApiError } from '../lib/api.js';

// Display DOS in US format (MM/DD/YYYY); inputs keep the ISO value they require.
export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : (iso || '—'); };
// Encounter ID display — clean sequential number, strip any legacy leading zeros.
export const encNo = (v) => { const s = String(v ?? '').trim(); return s ? s.replace(/^0+(?=\d)/, '') : '—'; };
// Date + time (for the signed-at status line), e.g. 11/29/2025 08:07 am.
const usDateTime = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return usDate(iso);
  let h = Number(m[4]); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
  return `${m[2]}/${m[3]}/${m[1]} ${String(h).padStart(2, '0')}:${m[5]} ${ap}`;
};
// Age (in whole years) at the date of service, from the patient's DOB. Empty if unknown.
const ageAtEncounter = (dob, dos) => {
  const d = String(dob || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const s = String(dos || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d || !s) return '';
  let a = Number(s[1]) - Number(d[1]);
  if (Number(s[2]) < Number(d[2]) || (Number(s[2]) === Number(d[2]) && Number(s[3]) < Number(d[3]))) a -= 1;
  return a >= 0 && a < 140 ? `${a} yrs` : '';
};
// Note-type templates are BACKEND-AUTHORITATIVE — fetched once per session from
// GET /encounters/note-templates — the SINGLE source of truth. No static/legacy fallback.
let NOTE_DEFS_CACHE = null; // { byType, list } — populated once, reused for the session
let NOTE_DEFS_PROMISE = null; // in-flight request, so concurrent callers share ONE fetch
export async function loadNoteDefs() {
  if (NOTE_DEFS_CACHE) return NOTE_DEFS_CACHE;
  if (NOTE_DEFS_PROMISE) return NOTE_DEFS_PROMISE;
  NOTE_DEFS_PROMISE = encountersApi.noteTemplates()
    .then(({ data }) => {
      const list = data.noteTypes || [];
      const byType = {};
      for (const t of list) byType[t.noteType] = t;
      NOTE_DEFS_CACHE = { byType, list };
      NOTE_DEFS_PROMISE = null;
      return NOTE_DEFS_CACHE;
    })
    .catch((e) => { NOTE_DEFS_PROMISE = null; throw e; }); // clear so a later call can retry
  return NOTE_DEFS_PROMISE;
}
const hasMD = (user) => (user?.credentials || []).some((c) => String(c).toUpperCase().trim() === 'MD');
const blankRx = () => ({ drug: '', dose: '', route: '', frequency: '', quantity: '', refills: '', sig: '' });
// Structured vital signs (Objective). Reference ranges are shown Epic-style beside each field.
const VITALS = [
  { k: 'temp', label: 'Temp °F', ph: '98.6', range: '97–99' },
  { k: 'hr', label: 'HR bpm', ph: '72', range: '60–100' },
  { k: 'bp', label: 'BP', ph: '120/80', range: '<120/80' },
  { k: 'rr', label: 'RR', ph: '16', range: '12–20' },
  { k: 'spo2', label: 'SpO₂ %', ph: '98', range: '≥95' },
  { k: 'weight', label: 'Wt lb', ph: '—', range: '' },
  { k: 'pain', label: 'Pain', ph: '0', range: '0–10' },
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
  phone: <path d="M5 4h4l1.4 4.9-2 1.2a11 11 0 0 0 5.3 5.3l1.2-2 4.9 1.4V19a1 1 0 0 1-1 1A15 15 0 0 1 4 5a1 1 0 0 1 1-1Z" />,
  clipboard: <><path d="M8 5h8a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" /><path d="M9.5 5V4a2.5 2.5 0 0 1 5 0v1M9.5 11h5M9.5 14.5h3" /></>,
  heart: <path d="M12 20s-6.5-4.2-6.5-9A3.5 3.5 0 0 1 12 8a3.5 3.5 0 0 1 6.5 2c0 4.8-6.5 10-6.5 10Z" />,
  education: <><path d="M12 5 3 9l9 4 9-4-9-4Z" /><path d="M7 11v4.5c0 1 2.5 2 5 2s5-1 5-2V11" /></>,
  scale: <><path d="M12 4v15M8 19h8M5 7.5h14M12 5 6 7.5M12 5l6 2.5" /><path d="M6 7.5 3.6 13a2.4 2.4 0 0 0 4.8 0L6 7.5Zm12 0L15.6 13a2.4 2.4 0 0 0 4.8 0L18 7.5Z" /></>,
  pen: <><path d="M4 20l4-1L19 8a2 2 0 0 0-3-3L5 16l-1 4Z" /><path d="M14.5 6.5l3 3" /></>,
  droplet: <path d="M12 3.5s6 6.2 6 10.2a6 6 0 0 1-12 0c0-4 6-10.2 6-10.2Z" />,
};
const SEC_ICON = {
  // Shared / SNF
  chiefComplaint: 'doc', changeDescription: 'alert', hpi: 'doc', interval: 'clock', hospitalCourse: 'hospital',
  ros: 'list', pmh: 'clock', psh: 'clock', familyHistory: 'users', socialHistory: 'users',
  medications: 'pill', medChanges: 'pill', dischargeMeds: 'pill', allergies: 'alert', adverseEffects: 'alert',
  vitals: 'activity', exam: 'activity', wound: 'plus', treatment: 'plus', results: 'flask', carePlanReview: 'list',
  assessment: 'check', mdm: 'brain', plan: 'target', orders: 'list', notifications: 'bell', prognosis: 'trend',
  goals: 'target', participants: 'users', decisionsMade: 'check', codeStatus: 'shield', advanceDirective: 'shield',
  dischargeDiagnoses: 'doc', procedures: 'activity', functionalStatus: 'activity', disposition: 'home',
  followUp: 'clock', dischargeInstructions: 'doc', careCoordination: 'users', pronouncement: 'doc',
  circumstances: 'doc', causeOfDeath: 'doc', regulatoryAttestation: 'pen', timeSpent: 'clock', addendum: 'doc',
  // Procedure note (Part B / interventional)
  procedureName: 'plus', indication: 'doc', consent: 'pen', procTechnique: 'list', procFindings: 'flask',
  specimen: 'flask', ebl: 'droplet', complications: 'alert', postProcedure: 'check',
  // Behavioral health / cognitive
  psychHistory: 'clock', mentalStatus: 'brain', riskAssessment: 'alert', cognitiveAssessment: 'brain',
  neuroPsych: 'brain', safetyEval: 'shield', caregiver: 'users', dementiaPlan: 'target',
  // Pain Management
  painHistory: 'doc', painScale: 'activity', priorTreatments: 'clock', pdmpReview: 'shield',
  opioidRisk: 'alert', udsResult: 'flask', injectate: 'droplet',
  // Transitional Care Management (TCM 99495 / 99496)
  dischargeInfo: 'clipboard', interactiveContact: 'phone', pendingFollowUp: 'list', communityServices: 'heart',
  caregiverEducation: 'education', tcmComplexity: 'scale', transitionGoals: 'target', tcmAttestation: 'pen',
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


/**
 * Encounter details — the header card (Practice-Fusion layout, Grelin colors). Every
 * value comes from real encounter / note / patient data. Fields with no backing data
 * yet (SNOMED encounter type, appointment link, self-pay restriction) show a neutral
 * default rather than fabricated content.
 */
function PFDetails({ encounter, noteLabel, ageStr, seenBy, statusStr }) {
  return (
    <section className="pf-card">
      <div className="pf-card-h">Encounter details</div>
      <div className="pf-grid">
        <div className="pf-field"><span className="pf-flabel">Encounter type</span><span className="pf-fval">{encounter.encounterType || 'Office Visit'}</span></div>
        <div className="pf-field"><span className="pf-flabel">Note type</span><span className="pf-fval">{noteLabel}</span></div>
        <div className="pf-field"><span className="pf-flabel">Date</span><span className="pf-fval">{usDate(encounter.date)}</span></div>
        <div className="pf-field"><span className="pf-flabel">Age at encounter</span><span className="pf-fval">{ageStr || '—'}</span></div>
        <div className="pf-field"><span className="pf-flabel">Seen by</span><span className="pf-fval">{seenBy || '—'}</span></div>
        <div className="pf-field"><span className="pf-flabel">Facility</span><span className="pf-fval">{encounter.facilityName || '—'}</span></div>
        <div className="pf-field"><span className="pf-flabel">Assigned Facility</span><span className="pf-fval">{encounter.assignedFacility || '—'}</span></div>
        <div className="pf-field"><span className="pf-flabel">Encounter</span><span className="pf-fval">{encNo(encounter.encounterNo)}</span></div>
        <div className="pf-field"><span className="pf-flabel">MRN</span><span className="pf-fval">{encounter.mrn || '—'}</span></div>
        <div className="pf-field pf-field-wide"><span className="pf-flabel">Status</span><span className="pf-fval">{statusStr}</span></div>
      </div>
    </section>
  );
}

/* -------- Encounter workspace: notes list + editor ------------------------ */
export function EncounterNotesModal({ encounter, onClose, onChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const canSign = hasMD(user);

  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
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
  const [defs, setDefs] = useState(NOTE_DEFS_CACHE); // backend note-type templates (authoritative)
  const [detail, setDetail] = useState(null); // authoritative encounter-header details (fetched)
  const skipSave = useRef(true); // skip the save that a fresh load/open would trigger
  const createToken = useRef(0); // guards the async Rx merge to the LATEST note created
  // Auto-save engine refs — persistence must never silently drop an edit.
  const contentRef = useRef(content); // always the LATEST content (avoids stale closures)
  const reasonRef = useRef(reason);
  const savingRef = useRef(false);    // a save request is in flight
  const dirtyRef = useRef(false);     // edits exist that are not yet confirmed saved
  const retryRef = useRef(null);      // pending retry timer after a failed save
  contentRef.current = content;
  reasonRef.current = reason;

  // Fetch the backend-authoritative note-type templates once. No static fallback — the
  // server defs are the single source of truth for the note structure.
  useEffect(() => { let a = true; loadNoteDefs().then((d) => { if (a) setDefs(d); }).catch(() => { if (a) toast.error('Could not load note types. Please retry.'); }); return () => { a = false; }; }, [toast]);

  // Fetch authoritative encounter-header details (patient, MRN, DOB, server-computed age,
  // facility, rendering provider) so every field is filled regardless of how the modal opened.
  useEffect(() => {
    if (!encounter?.encounterUuid) return undefined;
    let a = true;
    encountersApi.encounterDetails(encounter.encounterUuid)
      .then(({ data }) => { if (a) setDetail(data.details || null); })
      .catch(() => { /* keep whatever was passed in */ });
    return () => { a = false; };
  }, [encounter?.encounterUuid]);

  // If the encounter was opened from the "New encounter" dropdown with a note type,
  // auto-create that note once (waits for the notes list + backend defs to be ready).
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (!encounter?.startNoteType || loading || active || notes.length || !defs) return;
    autoStartedRef.current = true;
    createNote(encounter.startNoteType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounter?.startNoteType, loading, active, notes, defs]);

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
        // Keep the note's OWN stored section order; if missing, use the backend template's
        // order for this note type. Never a static client copy.
        sectionOrder: (data.note.content?.sectionOrder?.length
          ? data.note.content.sectionOrder
          : (NOTE_DEFS_CACHE?.byType?.[data.note.noteType]?.sections || []).map((s) => s.key)),
      });
      setReason(data.note.reason || '');
      setRxCarry(null);
      setTab('note');
      // Load the pharmacy/PBM vendor from the patient's benefits (display only). A failure
      // is surfaced (never silent) so the provider knows the detail couldn't be loaded.
      if (encounter.patientUuid) {
        encountersApi.rxContext(encounter.patientUuid)
          .then((rc) => setPharmacy(rc.data.pharmacy || null))
          .catch((e) => { setPharmacy(null); toast.error(`Couldn’t load the pharmacy detail: ${toApiError(e).message}`); });
      }
    } catch (e) { toast.error(toApiError(e).message); }
  }

  // Create a new note of the chosen type (H&P / SOAP / Progress) and open it for
  // free-form writing. No popup — the type is picked inline; autosave takes over.
  async function createNote(noteType) {
    const secs = defs?.byType?.[noteType]?.sections;
    if (!secs?.length) { toast.error('Note types are still loading — please try again in a moment.'); return; }
    setBusy(true);
    try {
      // Chief Complaint is its own card (not part of the dynamic note body).
      // Compact, well-known structures (SOAP → S/O/A/P) show their FULL template up front so
      // the note reads accurately as that type. Long structures (H&P) start with the first
      // heading and reveal the rest one by one as the provider writes (progressive).
      const bodySecs = secs.filter((s) => s.key !== 'chiefComplaint');
      const seed = bodySecs.length <= 6 ? bodySecs.map((s) => s.key) : (bodySecs.length ? [bodySecs[0].key] : []);
      const initContent = { vitals: {}, sections: {}, prescriptions: [], sectionOrder: seed };
      const { data } = await encountersApi.createNote(encounter.encounterUuid, { noteType, content: initContent });
      skipSave.current = true;
      setAutoState('idle');
      setAmending(false); setAmendReason('');
      setActive(data.note);
      setContent(initContent);
      setPharmacy(null);
      setRxCarry(null);
      setReason('');
      setTab('note');
      await loadNotes();
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
  // Remove a clinical heading the provider doesn't need (clears its content + drops it
  // from the kept order). It is not auto-re-added, so removals stick.
  const removeSection = (key) => setContent((c) => {
    const sections = { ...c.sections }; delete sections[key];
    return { ...c, sections, vitals: key === 'vitals' ? {} : c.vitals, sectionOrder: (c.sectionOrder || []).filter((k) => k !== key) };
  });

  // Epic-style progressive note: once the LAST kept heading has content, auto-append the
  // NEXT clinical heading (in the note type's order). Kept headings live in
  // content.sectionOrder (persisted/autosaved). Only appends after the last heading, so a
  // removed middle section is never re-added.
  useEffect(() => {
    if (!active || readOnly) return;
    // Chief Complaint is a separate card — never part of the dynamic note body.
    const tpl = (defs?.byType?.[active.noteType]?.sections || []).filter((s) => s.key !== 'chiefComplaint');
    if (!tpl.length) return;
    const order = (Array.isArray(content.sectionOrder) ? content.sectionOrder : []).filter((k) => k !== 'chiefComplaint');
    // Never leave the note with no heading to write in — re-seed the first clinical heading.
    if (!order.length) { setContent((c) => ({ ...c, sectionOrder: [tpl[0].key] })); return; }
    const lastKey = order[order.length - 1];
    const filled = lastKey === 'vitals'
      ? VITALS.some((v) => String(content.vitals?.[v.k] || '').trim())
      : String(content.sections[lastKey] || '').trim().length > 0;
    if (!filled) return;
    const lastIdx = tpl.findIndex((s) => s.key === lastKey);
    const next = tpl[lastIdx + 1];
    if (next && !order.includes(next.key)) setContent((c) => ({ ...c, sectionOrder: [...(c.sectionOrder || []), next.key] }));
  }, [content.sections, content.vitals, content.sectionOrder, active, defs, readOnly]);

  // Persist the LATEST edit. Coalesces concurrent calls (last-write-wins by always
  // sending contentRef/reasonRef), and NEVER swallows a failure: a failed save moves
  // to the 'error' state and auto-retries, and the dirty flag stays set until the
  // server confirms — so a transient blip can never silently drop a medical-record edit.
  async function flushSave() {
    if (!active || active.status === 'signed' || active.isOwner === false) return true;
    if (savingRef.current) { dirtyRef.current = true; return false; } // fold into the in-flight save
    if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
    savingRef.current = true;
    setAutoState('saving');
    try {
      await encountersApi.updateNote(active.uuid, { content: contentRef.current, reason: reasonRef.current });
      savingRef.current = false;
      if (dirtyRef.current) { dirtyRef.current = false; return flushSave(); } // edits arrived mid-save
      setAutoState('saved');
      return true;
    } catch {
      savingRef.current = false;
      setAutoState('error'); // visible: "Not saved — retrying" — never silent
      retryRef.current = setTimeout(() => { flushSave(); }, 3000); // auto-recover
      return false;
    }
  }

  // Auto-save: debounced persistence of EVERY edit (vitals, sections, Rx, reason).
  // Skips signed (immutable) notes, read-only viewers, and the initial load.
  useEffect(() => {
    if (!active || active.status === 'signed' || active.isOwner === false) return undefined;
    if (skipSave.current) { skipSave.current = false; return undefined; }
    dirtyRef.current = true;
    setAutoState('saving');
    const t = setTimeout(() => { flushSave(); }, 800);
    return () => clearTimeout(t);
  }, [content, reason]); // eslint-disable-line react-hooks/exhaustive-deps

  // Warn before leaving with unsaved edits (tab close / refresh within the save window).
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (dirtyRef.current || savingRef.current) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Flush any pending edit before closing. If the final save FAILS, keep the editor
  // open and tell the provider — never close over unsaved medical-record changes.
  async function closeWithSave() {
    if (active && active.status !== 'signed' && active.isOwner !== false && !skipSave.current
        && (dirtyRef.current || savingRef.current || autoState === 'error')) {
      const ok = await flushSave();
      if (!ok) { toast.error('Your last changes could not be saved yet — staying open so nothing is lost. Retrying…'); return; }
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

  // Non-MD: writing a note and SIGNING it are separate authorities. A non-MD provider saves
  // their completed note and routes it to signing — the saved draft appears in a same-line
  // facility MD's "Yet to Sign" queue for review and sign-off. No MD sign-off happens here.
  async function sendToSigning() {
    if (!active || readOnly) return;
    setBusy(true);
    try {
      const okSaved = await flushSave();
      if (!okSaved) { toast.error('Your changes could not be saved yet — please try again.'); return; }
      await loadNotes();
      onChanged?.();
      toast.success('Saved and sent to signing — an MD at your facility can now review and sign it for billing.');
      onClose();
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

  // The BACKEND note-type templates are the SINGLE source of truth (fetched). No static
  // fallback and no legacy types — the note structure always comes from the server defs.
  const defsByType = defs?.byType || null;
  const typeList = defs?.list || [];
  const sectionsForType = (nt) => defsByType?.[nt]?.sections || [];
  const template = active ? sectionsForType(active.noteType) : [];
  const noteMeta = active ? (defsByType?.[active.noteType] || { label: 'Clinical Note', category: '', cpt: '' }) : null;
  // DYNAMIC clinical note (Epic-style): headings appear one after another in the note
  // type's clinical order — never a pre-structured static list. Read mode shows only the
  // sections that were filled; edit mode shows every filled section PLUS the next empty
  // one, so a fresh note starts with a single heading and reveals the next automatically
  // as the provider writes. No SOAP scaffolding, no "add section" button.
  const sectionHasContent = (s) => (s.key === 'vitals'
    ? VITALS.some((v) => String(content.vitals?.[v.k] || '').trim())
    : String(content.sections[s.key] || '').trim().length > 0);
  // The kept headings, in order (content.sectionOrder). Edit mode shows them all (with the
  // next auto-appended by the effect above); read/signed shows only the ones with content.
  const secByKey = {};
  template.forEach((s) => { secByKey[s.key] = s; });
  const noteSecs = (() => {
    // Chief Complaint has its own card — exclude it from the dynamic note body.
    const order = (Array.isArray(content.sectionOrder) ? content.sectionOrder : []).filter((k) => k !== 'chiefComplaint');
    const secs = order.map((k) => secByKey[k] || { key: k, label: k, prompt: '', rows: 4 });
    return readOnly ? secs.filter(sectionHasContent) : secs;
  })();

  // Encounter-header values — prefer the AUTHORITATIVE backend detail, fall back to what
  // was passed in. `enc` merges them so MRN / facility / DOS / patient are always filled.
  const enc = { ...encounter, ...(detail || {}) };
  const ageStr = detail?.ageAtEncounter || ageAtEncounter(enc.dob, enc.date);
  const seenBy = detail?.renderingProvider
    || (signed ? active?.signedByName : (active && active.isOwner !== false && user?.fullName ? `${user.fullName}${canSign ? ', MD' : ''}` : ''))
    || '—';
  const statusStr = !active
    ? 'No note started'
    : signed
      ? `Electronically signed by ${active.signedByName || 'Provider'}${active.signedAt ? ` at ${usDateTime(active.signedAt)}` : ''}`
      : 'Draft — not signed';

  return (
    <>
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
    <Modal size="full" title={`Encounter · ${enc.patientName || 'Patient'}`} onClose={closeWithSave} footer={<>
      <span className="nt-foot-meta">Encounter {encNo(enc.encounterNo)} · DOS {usDate(enc.date)}</span>
      {active && !readOnly && !amending && (
        <span className={`nt-autosave ${autoState}`}>
          {autoState === 'saving' ? 'Saving…'
            : autoState === 'saved' ? 'All changes saved'
            : autoState === 'error' ? 'Not saved — retrying…'
            : 'Auto-saves as you type'}
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
            canSign ? (
              <button className="btn" onClick={sign} disabled={busy} title="Sign & finalize for billing">
                {busy ? <span className="spinner" /> : 'Sign & finalize'}
              </button>
            ) : (
              <button className="btn" onClick={sendToSigning} disabled={busy || readOnly} title="Save this note and send it to an MD at your facility for signing">
                {busy ? <span className="spinner" /> : 'Save & send to signing'}
              </button>
            )
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
                {defsByType?.[n.noteType]?.label || n.noteType}
                <span className={`nt2-dot ${n.status === 'signed' ? 'signed' : 'draft'}`} title={n.status === 'signed' ? 'Signed' : 'Draft'} />
              </button>
            ))}
          </div>
          <div className="nt2-ident">
            <span className="nt2-ident-nm">{enc.patientName || 'Patient'}</span>
            <span className="nt2-ident-meta">
              <span><b>MRN</b> {enc.mrn || '—'}</span>
              <span><b>Enc</b> {encNo(enc.encounterNo)}</span>
              <span><b>DOS</b> {usDate(enc.date)}</span>
            </span>
          </div>
          <span className="spacer" />
          {active && (signed
            ? <span className="nt-status-pill signed"><span className="nt-signed-dot" />Signed · {active.signedByName || 'MD'}</span>
            : <span className="nt-status-pill draft">Draft</span>)}
        </div>

        <section className="nt-main">
          {(loading && !active) || (busy && !active) || (!active && !!encounter?.startNoteType && !autoStartedRef.current) ? (
            // A note type was chosen from the dropdown (or is being created) — show a
            // loader straight through to the template, never the "Start a note" chooser.
            <div className="nt-placeholder"><span className="spinner dark" /></div>
          ) : !active ? (
            <div className="nt-doc-scroll">
              <article className="pf-doc">
                <PFDetails encounter={enc} noteLabel="—" ageStr={ageStr} seenBy={seenBy} statusStr={statusStr} />
                <section className="pf-card pf-start">
                  <div className="pf-card-h">Start a note</div>
                  <div className="pf-start-sub">Choose a note type to begin documenting this encounter — every section is free-form.</div>
                  <div className="pf-start-choices">
                    {typeList.map((t) => (
                      <button key={t.noteType} type="button" className="pf-start-btn" disabled={busy} onClick={() => createNote(t.noteType)}>
                        <span className="pf-start-btn-t">{t.label}</span>
                        <span className="pf-start-btn-s">{t.category}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </article>
            </div>
          ) : (
            <>
              <div className="nt-subbar">
                <div className="nt-subtabs">
                  <button className={`nt-tab ${tab === 'note' ? 'is-on' : ''}`} onClick={() => setTab('note')}>Clinical Note</button>
                  <button className={`nt-tab ${tab === 'rx' ? 'is-on' : ''}`} onClick={() => setTab('rx')}>Prescriptions{content.prescriptions.length ? ` (${content.prescriptions.length})` : ''}</button>
                  <button className={`nt-tab ${tab === 'coding' ? 'is-on' : ''}`} onClick={() => setTab('coding')}>Coding &amp; Billing</button>
                </div>
                <span className="nt-subcat">{noteMeta?.category}</span>
              </div>

              {tab === 'note' ? (
                <div className="nt-doc-scroll">
                  <article className={`pf-doc ${readOnly ? 'is-signed' : 'is-editing'}`}>
                    <PFDetails encounter={enc} noteLabel={noteMeta?.label || 'Clinical Note'} ageStr={ageStr} seenBy={seenBy} statusStr={statusStr} />

                    <section className="pf-card">
                      <div className="pf-card-h">Chief complaint</div>
                      {readOnly ? (
                        <div className="pf-body">{(content.sections.chiefComplaint || '').trim()
                          ? content.sections.chiefComplaint.split('\n').map((ln, i) => <p key={i}>{ln || ' '}</p>)
                          : <span className="pf-muted">No acute complaints</span>}</div>
                      ) : (
                        <AutoText rows={2} value={content.sections.chiefComplaint || ''} placeholder="Chief complaint — e.g. No acute complaints" onChange={(v) => setSection('chiefComplaint', v)} />
                      )}
                    </section>

                    <section className="pf-card pf-note">
                      {noteSecs.length ? noteSecs.map((s) => (s.key === 'vitals' ? (
                        <div className="pf-sec" key="vitals">
                          <div className="pf-sec-h"><span>Vitals</span>{!readOnly && <button type="button" className="pf-sec-x" title="Remove Vitals" onClick={() => removeSection('vitals')}>×</button>}</div>
                          {readOnly ? (
                            <div className="pf-body"><p>{VITALS.map((v) => (content.vitals?.[v.k] ? `${v.label}: ${content.vitals[v.k]}` : null)).filter(Boolean).join('    ·    ') || '—'}</p></div>
                          ) : (
                            <div className="nt-vgrid">
                              {VITALS.map((v) => (
                                <div className="nt-vfld" key={v.k}>
                                  <label>{v.label}{v.range ? <span className="nt-vrange">{v.range}</span> : null}</label>
                                  <input className="input" value={content.vitals?.[v.k] || ''} placeholder={v.ph} onChange={(e) => setVital(v.k, e.target.value)} />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="pf-sec" key={s.key}>
                          <div className="pf-sec-h"><span>{s.label}</span>{!readOnly && <button type="button" className="pf-sec-x" title={`Remove ${s.label}`} onClick={() => removeSection(s.key)}>×</button>}</div>
                          {readOnly ? (
                            <div className="pf-body">
                              {(content.sections[s.key] || '').trim()
                                ? (content.sections[s.key]).split('\n').map((ln, i) => <p key={i}>{ln || ' '}</p>)
                                : <span className="pf-muted">—</span>}
                            </div>
                          ) : (
                            <AutoText rows={s.rows >= 4 ? 4 : 2} value={content.sections[s.key] || ''} placeholder={s.prompt} onChange={(v) => setSection(s.key, v)} />
                          )}
                        </div>
                      ))) : <div className="pf-body"><span className="pf-muted">This note has no documentation.</span></div>}

                      {signed && (
                        <div className="pf-sign">
                          <div className="pf-sign-line" />
                          <div className="pf-sign-name">Electronically signed by {active.signedByName || 'Provider'}</div>
                          <div className="pf-sign-sub">Finalized and ready for billing.</div>
                        </div>
                      )}
                    </section>
                  </article>
                </div>
              ) : tab === 'coding' ? (
                <CodingPanel noteUuid={active?.uuid} readOnly={readOnly} enc={enc} toast={toast} />
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

              {!canSign && !signed && <div className="nt-md-note">You can write and save this note. Sign-off is restricted to an <strong>MD</strong> — use <strong>Save &amp; send to signing</strong> to route it to a facility MD in your specialty for review and sign-off.</div>}
            </>
          )}
        </section>
      </div>
    </Modal>
    </>
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

/** Type-ahead search box for a terminology (SNOMED / CPT). Debounced; calls `search(q)` → rows. */
function CodeSearch({ placeholder, search, onPick, disabled, render }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); setOpen(false); return undefined; }
    let a = true; setBusy(true);
    const t = setTimeout(async () => {
      try { const rows = await search(q.trim()); if (a) { setResults(rows); setOpen(true); } }
      catch { if (a) setResults([]); }
      finally { if (a) setBusy(false); }
    }, 300);
    return () => { a = false; clearTimeout(t); };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="cq-search">
      <input className="input" placeholder={placeholder} value={q} disabled={disabled}
        onChange={(e) => setQ(e.target.value)} onFocus={() => results.length && setOpen(true)} />
      {busy && <span className="cq-busy" aria-hidden="true">⋯</span>}
      {open && results.length > 0 && (
        <div className="cq-menu">
          {results.map((r, i) => (
            <button key={i} type="button" className="cq-opt"
              onClick={() => { onPick(r); setQ(''); setResults([]); setOpen(false); }}>
              {render(r)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SEV_RANK = { error: 0, warning: 1, info: 2 };

/**
 * Coding & Billing panel for a note — Medicare Part B, Central FL. Diagnoses are captured
 * SNOMED-first and auto-mapped to a billable ICD-10-CM (official complex map); procedures are
 * CPT. Codes autosave to the note; the claim is scrubbed live against NCCI PTP/MUE, ICD
 * specificity/age-sex, and First Coast (FL) LCD/Article medical necessity. Real data only.
 */
function CodingPanel({ noteUuid, readOnly, enc, toast }) {
  const [dx, setDx] = useState([]);
  const [px, setPx] = useState([]);
  const [scrub, setScrub] = useState(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [predicting, setPredicting] = useState(false);
  const [unmatched, setUnmatched] = useState([]);
  const loaded = useRef(false);
  const saveT = useRef(null);

  useEffect(() => {
    loaded.current = false; setDx([]); setPx([]); setScrub(null); setUnmatched([]);
    if (!noteUuid) return undefined;
    let a = true;
    encountersApi.getNoteCodes(noteUuid).then(({ data }) => {
      if (!a) return;
      const d = data.diagnoses || []; const p = data.procedures || [];
      setDx(d); setPx(p);
      loaded.current = true;
      if (d.length || p.length) runScrub();
      else if (!readOnly) runPredict(); // no codes yet → auto-suggest from the note content
    }).catch(() => { if (a) loaded.current = true; });
    return () => { a = false; };
  }, [noteUuid]); // eslint-disable-line react-hooks/exhaustive-deps

  const runScrub = async () => {
    if (!noteUuid) return;
    setScrubbing(true);
    try {
      const { data } = await encountersApi.scrubNote(noteUuid, { age: enc?.ageYears, sex: enc?.sex });
      setScrub(data);
    } catch { /* non-fatal: scrub is advisory */ } finally { setScrubbing(false); }
  };

  // Deterministic auto-coding: read the note and MERGE suggested billable diagnoses + the visit
  // charge into the panel (never overwrites codes the coder already added). The coder confirms.
  const runPredict = async () => {
    if (!noteUuid || readOnly) return;
    setPredicting(true);
    try {
      const { data } = await encountersApi.predictCodes(noteUuid);
      setDx((cur) => {
        const have = new Set(cur.map((d) => d.icd));
        const add = (data.diagnoses || []).filter((d) => d.icd && !have.has(d.icd)).map((d, k) => ({
          icd: d.icd, description: d.description, snomedCode: d.snomedCode || null, snomedTerm: d.snomedTerm || null,
          candidates: [], contextDependent: d.contextDependent, primary: cur.length === 0 && k === 0, suggested: true,
        }));
        return [...cur, ...add];
      });
      setPx((cur) => {
        const have = new Set(cur.map((p) => p.cpt));
        const add = (data.procedures || []).filter((p) => p.cpt && !have.has(p.cpt)).map((p) => ({
          cpt: p.cpt, description: p.description, modifiers: p.modifiers || '', units: p.units || 1, suggested: true, basis: p.basis, confirm: p.confirm,
        }));
        return [...cur, ...add];
      });
      setUnmatched(data.unmatched || []);
      loaded.current = true;
    } catch (e) { toast.error(`Couldn’t suggest codes: ${toApiError(e).message}`); }
    finally { setPredicting(false); }
  };

  // Autosave codes (debounced), then re-scrub.
  useEffect(() => {
    if (!loaded.current || readOnly || !noteUuid) return undefined;
    clearTimeout(saveT.current);
    saveT.current = setTimeout(async () => {
      try {
        const clean = {
          diagnoses: dx.map((d) => ({ icd: d.icd, description: d.description, snomedCode: d.snomedCode, snomedTerm: d.snomedTerm, primary: !!d.primary })),
          procedures: px.map((p) => ({ cpt: p.cpt, description: p.description, modifiers: p.modifiers, units: p.units })),
        };
        await encountersApi.saveNoteCodes(noteUuid, clean);
        runScrub();
      } catch (e) { toast.error(`Couldn’t save codes: ${toApiError(e).message}`); }
    }, 700);
    return () => clearTimeout(saveT.current);
  }, [dx, px]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addDx(sct) {
    if (dx.some((d) => d.snomedCode === sct.code)) return;
    try {
      const { data } = await terminologyApi.snomedToIcd(sct.code);
      if (!data.primary) { toast.error(`No billable ICD-10-CM map for “${sct.name}”.`); return; }
      setDx((cur) => [...cur, {
        snomedCode: sct.code, snomedTerm: sct.name,
        icd: data.primary.icd, description: data.primary.description,
        candidates: data.candidates || [], contextDependent: data.primary.contextDependent, advice: data.primary.advice,
        primary: cur.length === 0,
      }]);
    } catch (e) { toast.error(`SNOMED→ICD mapping failed: ${toApiError(e).message}`); }
  }
  // Add a supporting diagnosis directly by ICD-10 (e.g. from a medical-necessity suggestion).
  const addIcdDx = (icd, description) => {
    if (dx.some((d) => d.icd === icd)) return;
    setDx((cur) => [...cur, { icd, description, snomedCode: null, snomedTerm: null, candidates: [], primary: cur.length === 0 }]);
  };
  const setDxIcd = (i, icd) => setDx((cur) => cur.map((d, j) => (j === i ? { ...d, icd, description: (d.candidates.find((c) => c.icd === icd)?.description) || d.description } : d)));
  const setPrimary = (i) => setDx((cur) => cur.map((d, j) => ({ ...d, primary: j === i })));
  const removeDx = (i) => setDx((cur) => cur.filter((_, j) => j !== i).map((d, j) => ({ ...d, primary: cur[i]?.primary && j === 0 ? true : d.primary })));
  const addPx = (cpt) => { if (!px.some((p) => p.cpt === cpt.code)) setPx((cur) => [...cur, { cpt: cpt.code, description: cpt.long || cpt.name || cpt.description, modifiers: '', units: 1, billable: cpt.billable, statusMeaning: cpt.statusMeaning }]); };
  const setPxField = (i, k, v) => setPx((cur) => cur.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const removePx = (i) => setPx((cur) => cur.filter((_, j) => j !== i));

  const findings = (scrub?.findings || []).slice().sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]));
  const sum = scrub?.summary || { errors: 0, warnings: 0, info: 0 };
  const hasPrimary = dx.some((d) => d.primary);

  return (
    <div className="nt-doc-scroll cq-scroll">
      <div className="cq">
        <div className="cq-bar">
          <span className={`cq-pill ${sum.errors ? 'is-err' : dx.length ? 'is-ok' : ''}`}>
            {sum.errors ? `${sum.errors} error${sum.errors > 1 ? 's' : ''}` : dx.length ? 'Ready to bill' : 'No codes yet'}
          </span>
          {sum.warnings ? <span className="cq-pill is-warn">{sum.warnings} warning{sum.warnings > 1 ? 's' : ''}</span> : null}
          {scrub?.raf && scrub.raf.raf > 0 ? (
            <span className="cq-pill cq-raf" title={`CMS-HCC V28 · segment ${scrub.raf.segment}${scrub.raf.segmentBasis ? ` (${scrub.raf.segmentBasis})` : ''} · HCCs ${scrub.raf.hccs.join(', ') || 'none'}`}>RAF {scrub.raf.raf.toFixed(3)}</span>
          ) : null}
          <span className="cq-jur">Medicare Part B · Central FL (First Coast)</span>
          <span className="spacer" />
          {predicting && <span className="cq-scrubbing">Auto-coding…</span>}
          {scrubbing ? <span className="cq-scrubbing">Scrubbing…</span>
            : <button type="button" className="btn ghost sm" onClick={runScrub} disabled={!dx.length && !px.length}>Re-scrub</button>}
        </div>

        {/* Diagnoses — SNOMED-first, auto-mapped to billable ICD-10-CM */}
        <section className="cq-sec">
          <div className="cq-sec-h"><span>Diagnoses</span><span className="cq-sec-sub">SNOMED CT → billable ICD-10-CM{dx.length ? ` · ${dx.length}` : ''}</span></div>
          {!readOnly && (
            <CodeSearch placeholder="Search SNOMED CT — e.g. pneumonia, type 2 diabetes…"
              search={async (q) => (await terminologyApi.snomed(q, 12)).data.results}
              onPick={addDx}
              render={(r) => (<><span className="cq-code">{r.code}</span><span className="cq-name">{r.name}</span></>)} />
          )}
          {unmatched.length > 0 && (
            <div className="cq-empty" style={{ color: '#b45309' }}>Needs coder review — no billable code auto-matched for: {unmatched.join('; ')}</div>
          )}
          {dx.length === 0 ? <div className="cq-empty">No diagnoses. Search a SNOMED concept, or use “Suggest from note”.</div> : (
            <div className="cq-list">
              {dx.map((d, i) => (
                <div className={`cq-row ${d.primary ? 'is-primary' : ''}`} key={`${d.snomedCode || d.icd}-${i}`}>
                  <label className="cq-primary" title="Primary diagnosis">
                    <input type="radio" name="cq-primary" checked={!!d.primary} disabled={readOnly} onChange={() => setPrimary(i)} />
                  </label>
                  <div className="cq-row-main">
                    <div className="cq-row-top">
                      <span className="cq-icd">{d.icd}</span>
                      <span className="cq-desc">{d.description || '—'}</span>
                      {d.contextDependent && <span className="cq-flag" title={d.advice || ''}>context-dependent</span>}
                    </div>
                    <div className="cq-row-sub">
                      {d.snomedTerm && <span className="cq-sct">SNOMED {d.snomedCode} · {d.snomedTerm}</span>}
                      {!readOnly && d.candidates && d.candidates.length > 1 && (
                        <select className="cq-mini" value={d.icd} onChange={(e) => setDxIcd(i, e.target.value)}>
                          {d.candidates.map((c) => <option key={c.icd} value={c.icd}>{c.icd} — {c.description || c.advice || ''}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  {!readOnly && <button type="button" className="cq-x" title="Remove" onClick={() => removeDx(i)}>✕</button>}
                </div>
              ))}
            </div>
          )}
          {dx.length > 0 && !hasPrimary && <div className="cq-hint is-warn">Select a primary diagnosis.</div>}
        </section>

        {/* Procedures — CPT/HCPCS */}
        <section className="cq-sec">
          <div className="cq-sec-h"><span>Procedures</span><span className="cq-sec-sub">CPT / HCPCS{px.length ? ` · ${px.length}` : ''}</span></div>
          {!readOnly && (
            <CodeSearch placeholder="Search CPT — e.g. 99308, nursing facility, trigger point…"
              search={async (q) => (await terminologyApi.cpt(q, 12)).data.results}
              onPick={addPx}
              render={(r) => (<><span className="cq-code">{r.code}</span><span className="cq-name">{r.long || r.short}</span>{r.billable === false ? <span className="cq-nopay" title={r.statusMeaning || ''}>not payable</span> : null}</>)} />
          )}
          {px.length === 0 ? <div className="cq-empty">No procedures. Search a CPT/HCPCS code to bill for this encounter.</div> : (
            <div className="cq-list">
              {px.map((p, i) => (
                <div className="cq-row" key={`${p.cpt}-${i}`}>
                  <div className="cq-row-main">
                    <div className="cq-row-top"><span className="cq-icd">{p.cpt}</span><span className="cq-desc">{p.description || '—'}</span>{p.billable === false ? <span className="cq-nopay" title={p.statusMeaning || ''}>not separately payable</span> : null}</div>
                    <div className="cq-row-sub cq-proc-fields">
                      <label>Mod<input className="cq-mini" value={p.modifiers || ''} disabled={readOnly} maxLength={8} placeholder="25" onChange={(e) => setPxField(i, 'modifiers', e.target.value)} /></label>
                      <label>Units<input className="cq-mini cq-units" type="number" min="1" value={p.units || 1} disabled={readOnly} onChange={(e) => setPxField(i, 'units', Number(e.target.value) || 1)} /></label>
                    </div>
                  </div>
                  {!readOnly && <button type="button" className="cq-x" title="Remove" onClick={() => removePx(i)}>✕</button>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Live claim scrub findings */}
        {findings.length > 0 && (
          <section className="cq-sec">
            <div className="cq-sec-h"><span>Claim edits</span><span className="cq-sec-sub">NCCI PTP/MUE · ICD edits · LCD/NCD medical necessity</span></div>
            <div className="cq-findings">
              {findings.map((f, i) => (
                <div className={`cq-finding sev-${f.severity}`} key={i}>
                  <span className="cq-sev">{f.severity}</span>
                  <div className="cq-finding-body">
                    <span className="cq-finding-type">{f.type.replace(/_/g, ' ')}</span>
                    <span className="cq-finding-msg">{f.message}</span>
                    {!readOnly && f.coveredExamples && f.coveredExamples.length > 0 && (
                      <div className="cq-sugg">
                        <span className="cq-sugg-lbl">Add supporting Dx:</span>
                        {f.coveredExamples.slice(0, 8).map((c) => (
                          <button type="button" className="cq-chip" key={c.icd} title={c.description || ''}
                            onClick={() => addIcdDx(c.icd, c.description)}>+ {c.icd}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        {scrub && findings.length === 0 && (dx.length > 0 || px.length > 0) && (
          <div className="cq-clean">✓ No claim edits triggered — codes pass NCCI, MUE, ICD, and First Coast (FL) medical-necessity checks.</div>
        )}
      </div>
    </div>
  );
}
