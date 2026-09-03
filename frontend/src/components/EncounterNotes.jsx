import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { encountersApi, terminologyApi, toApiError } from '../lib/api.js';
import { SECTION_LABELS } from '../lib/noteTemplates.js';
import { checksForHeading } from '../lib/snfHeadingChecks.js';

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
      NOTE_DEFS_CACHE = { byType, list, aiTemplates: !!data.aiTemplates };
      NOTE_DEFS_PROMISE = null;
      return NOTE_DEFS_CACHE;
    })
    .catch((e) => { NOTE_DEFS_PROMISE = null; throw e; }); // clear so a later call can retry
  return NOTE_DEFS_PROMISE;
}
// Session cache for the provider's custom templates — so reopening the notes editor is INSTANT (no
// refetch, no flicker). A single in-flight promise coalesces concurrent callers.
let CUSTOM_TPL_CACHE = null; // Template[]
let CUSTOM_TPL_PROMISE = null;
export async function loadCustomTemplates(force = false) {
  if (!force && CUSTOM_TPL_CACHE) return CUSTOM_TPL_CACHE;
  if (CUSTOM_TPL_PROMISE) return CUSTOM_TPL_PROMISE;
  CUSTOM_TPL_PROMISE = encountersApi.listCustomTemplates()
    .then(({ data }) => { CUSTOM_TPL_CACHE = data.templates || []; CUSTOM_TPL_PROMISE = null; return CUSTOM_TPL_CACHE; })
    .catch((e) => { CUSTOM_TPL_PROMISE = null; throw e; });
  return CUSTOM_TPL_PROMISE;
}
const setCustomTplCache = (list) => { CUSTOM_TPL_CACHE = list; };

// The heading order for a note with NO stored sectionOrder (legacy). Deterministic: the full set of
// the note type's clinical headings, in template order (Chief Complaint + Vitals live above the body).
function deriveSectionOrder(note) {
  const c = note?.content || {};
  const tplSecs = (note?.noteType === 'custom' || Array.isArray(c.customSections))
    ? (c.customSections || [])
    : (NOTE_DEFS_CACHE?.byType?.[note?.noteType]?.sections || []);
  const keys = tplSecs.map((s) => s.key).filter((k) => k !== 'chiefComplaint' && k !== 'vitals');
  // Include any saved section not in the template too (never drop written content).
  const extra = Object.keys(c.sections || {}).filter((k) => k !== 'chiefComplaint' && k !== 'vitals' && !keys.includes(k) && String(c.sections[k] || '').trim());
  return [...keys, ...extra];
}

// A PHYSICIAN (MD or DO) is the note signer/finalizer. NPPs (NP/APRN/PA) draft and route to a physician.
const PHYSICIAN_CREDS = ['MD', 'DO'];
const hasMD = (user) => (user?.credentials || []).some((c) => PHYSICIAN_CREDS.includes(String(c).toUpperCase().trim()));
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
// Provider-focused SNF Part B encounter types, each a REAL SNOMED CT concept (code · display).
export const ENCOUNTER_TYPES = [
  { code: '207195004', display: 'Nursing Facility Visit' },        // H&P w/ E/M of nursing facility patient
  { code: '185349003', display: 'Office Visit' },                  // Encounter for check up
  { code: '390906007', display: 'Follow-Up Visit' },               // Follow-up encounter
  { code: '185347001', display: 'Problem / Acute Visit' },         // Encounter for problem
  { code: '406547006', display: 'Urgent / Unscheduled Visit' },    // Urgent follow-up
  { code: '439708006', display: 'Home / Residence Visit' },        // Home visit
  { code: '448337001', display: 'Telehealth Visit' },              // Telemedicine consultation with patient
  { code: '11429006', display: 'Consultation' },                   // Consultation
];
const encTypeByCode = Object.fromEntries(ENCOUNTER_TYPES.map((t) => [t.code, t]));

function PFDetails({ encounter, noteLabel, ageStr, seenBy, statusStr, encType, onEncType, readOnly }) {
  const et = encType && encType.display ? encType : ENCOUNTER_TYPES[0];
  return (
    <section className="pf-card">
      <div className="pf-card-h">Encounter details</div>
      <div className="pf-grid">
        <div className="pf-field">
          <span className="pf-flabel">Encounter type</span>
          {!readOnly && onEncType ? (
            <select className="pf-enc-select" value={et.code} title={`SNOMED CT ${et.code}`}
              onChange={(e) => onEncType(encTypeByCode[e.target.value])}>
              {ENCOUNTER_TYPES.map((t) => <option key={t.code} value={t.code}>{t.display}</option>)}
            </select>
          ) : (
            <span className="pf-fval" title={`SNOMED CT ${et.code}`}>{et.display}</span>
          )}
        </div>
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

/** The note's opening header — sits directly above the clinical headings. Every note opens with the
 *  Note Type, then the patient (name + DOB), then the date of service. All values are fetched live from
 *  the encounter detail (note type, patient name, DOB, DOS) — never hand-entered. */
function PFNoteHeader({ encounter, noteLabel }) {
  return (
    <header className="pf-nhead">
      <div className="pf-nhead-bar"><span className="pf-sec-tick" aria-hidden="true" /><span className="pf-nhead-barlbl">Note</span></div>
      <div className="pf-nhead-body">
        <div className="pf-nhead-item pf-nhead-item-type">
          <span className="pf-nhead-l">Note Type</span>
          <span className="pf-nhead-v pf-nhead-type-v">{noteLabel || 'Clinical Note'}</span>
        </div>
        <div className="pf-nhead-meta">
          <div className="pf-nhead-item"><span className="pf-nhead-l">Patient Name</span><span className="pf-nhead-v">{encounter.patientName || '—'}</span></div>
          <div className="pf-nhead-item"><span className="pf-nhead-l">DOB</span><span className="pf-nhead-v">{encounter.dob ? usDate(encounter.dob) : '—'}</span></div>
        </div>
        <div className="pf-nhead-item"><span className="pf-nhead-l">Date of Service (DOS)</span><span className="pf-nhead-v">{usDate(encounter.date) || '—'}</span></div>
      </div>
    </header>
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
  const [showVitals, setShowVitals] = useState(false); // vitals revealed under Chief Complaint (on demand)
  const [content, setContent] = useState({ vitals: {}, sections: {}, checks: {}, prescriptions: [] });
  const [reason, setReason] = useState('');
  const [pharmacy, setPharmacy] = useState(null);   // pharmacy/PBM vendor from benefits
  const [rxCarry, setRxCarry] = useState(null);      // carry-forward source info
  const [busy, setBusy] = useState(false);
  const [autoState, setAutoState] = useState('idle'); // idle | saving | saved
  const [amending, setAmending] = useState(false); // MD editing a signed note
  const [amendModal, setAmendModal] = useState(false); // reason prompt for amendment
  const [amendReason, setAmendReason] = useState('');
  const [defs, setDefs] = useState(NOTE_DEFS_CACHE); // backend note-type templates (authoritative)
  const [customTpls, setCustomTpls] = useState(CUSTOM_TPL_CACHE || []); // provider's own custom templates (cached)
  const [builder, setBuilder] = useState(null); // custom-template builder modal (null | {} | template)
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

  // Load the provider's OWN custom templates (owner-scoped, session-cached → no refetch lag). A failure
  // is surfaced, never silent. Served instantly from cache on reopen; refreshed in the background.
  useEffect(() => {
    let a = true;
    loadCustomTemplates(!CUSTOM_TPL_CACHE)
      .then((list) => { if (a) setCustomTpls(list); })
      .catch((e) => { if (a) toast.error(`Couldn’t load your custom templates: ${toApiError(e).message}`); });
    return () => { a = false; };
  }, [toast]);

  // Save a custom template (create or update) — persists to the server and updates the list in real time.
  async function saveCustomTemplate({ uuid, name, category, sections }) {
    try {
      let next;
      if (uuid) {
        const { data } = await encountersApi.updateCustomTemplate(uuid, { name, category, sections });
        next = (customTpls || []).map((c) => (c.uuid === uuid ? data.template : c));
      } else {
        const { data } = await encountersApi.createCustomTemplate({ name, category, sections });
        next = [data.template, ...(customTpls || [])];
      }
      setCustomTpls(next); setCustomTplCache(next); // keep the session cache in sync (instant everywhere)
      setBuilder(null);
      toast.success('Template saved.');
    } catch (e) { toast.error(toApiError(e).message); throw e; }
  }
  async function deleteCustomTemplate(tpl) {
    if (!window.confirm(`Delete the “${tpl.label}” template? Notes already created from it are unaffected.`)) return;
    try {
      await encountersApi.deleteCustomTemplate(tpl.uuid);
      const next = (customTpls || []).filter((c) => c.uuid !== tpl.uuid);
      setCustomTpls(next); setCustomTplCache(next);
      toast.success('Template deleted.');
    } catch (e) { toast.error(toApiError(e).message); }
  }

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
    // A custom template is passed as "custom:<uuid>" — resolve it from the provider's templates and
    // snapshot it into the note. Wait until the custom templates have loaded before starting.
    if (String(encounter.startNoteType).startsWith('custom:')) {
      const uuid = String(encounter.startNoteType).slice(7);
      const tpl = customTpls.find((t) => t.uuid === uuid);
      if (!tpl) return; // templates not loaded yet — the effect re-runs when customTpls arrives
      autoStartedRef.current = true;
      createNote('custom', tpl);
      return;
    }
    autoStartedRef.current = true;
    createNote(encounter.startNoteType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounter?.startNoteType, loading, active, notes, defs, customTpls]);

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
        checks: data.note.content?.checks || {},
        ...(data.note.content?.encounterType ? { encounterType: data.note.content.encounterType } : {}),
        ...(data.note.content?.customSections ? { customSections: data.note.content.customSections } : {}),
        ...(data.note.content?.templateName ? { templateName: data.note.content.templateName } : {}),
        prescriptions: data.note.content?.prescriptions || [],
        // DYNAMIC flow, preserved on reopen: use the note's OWN stored heading order. If a note has NONE
        // (legacy), derive it from CONTENT — the headings that were actually filled, in template order —
        // so nothing written is hidden AND an empty note starts with just the FIRST heading (never a
        // static full list). New headings then reveal one-by-one as the provider writes.
        sectionOrder: (data.note.content?.sectionOrder?.length
          ? data.note.content.sectionOrder
          : deriveSectionOrder(data.note)),
      });
      setReason(data.note.reason || '');
      setRxCarry(null);
      setShowVitals(false); // vitals auto-show only if this note already has vitals data
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

  // Create a new note of the chosen type and open it for free-form writing. No popup — the type is
  // picked inline; autosave takes over. `tpl` (a provider custom template) snapshots its sections into
  // the note so the record is self-contained (noteType 'custom').
  async function createNote(noteType, tpl) {
    const secs = tpl ? tpl.sections : defs?.byType?.[noteType]?.sections;
    if (!secs?.length) { toast.error(tpl ? 'This template has no headings yet.' : 'Note types are still loading — please try again in a moment.'); return; }
    setBusy(true);
    try {
      // Chief Complaint is its own card, and Vitals live under it. Show the FULL set of clinical
      // headings for the note type up front — all visible, in the note type's deterministic clinical
      // order — so the provider sees the complete template (not a progressive reveal).
      const bodySecs = secs.filter((s) => s.key !== 'chiefComplaint' && s.key !== 'vitals');
      const seed = bodySecs.map((s) => s.key);
      const initContent = { vitals: {}, sections: {}, checks: {}, prescriptions: [], sectionOrder: seed };
      if (tpl) { initContent.templateName = tpl.label; initContent.customSections = secs.map((s) => ({ ...s })); }
      const { data } = await encountersApi.createNote(encounter.encounterUuid, { noteType: tpl ? 'custom' : noteType, content: initContent });
      skipSave.current = true;
      setAutoState('idle');
      setAmending(false); setAmendReason('');
      setActive(data.note);
      setContent(initContent);
      setPharmacy(null);
      setRxCarry(null);
      setShowVitals(false); // vitals auto-show only if this note already has vitals data
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
  // Toggle a checkbox option for a section (stored in content.checks[key]; autosaves with the note).
  const toggleCheck = (k, opt) => setContent((c) => {
    const cur = (c.checks && c.checks[k]) || [];
    const next = cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt];
    return { ...c, checks: { ...(c.checks || {}), [k]: next } };
  });
  const isChecked = (k, opt) => !!(content.checks && content.checks[k] && content.checks[k].includes(opt));
  const setRxAt = (i, k, v) => setContent((c) => ({ ...c, prescriptions: c.prescriptions.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)) }));
  const addRx = () => setContent((c) => ({ ...c, prescriptions: [...c.prescriptions, blankRx()] }));
  const removeRx = (i) => setContent((c) => ({ ...c, prescriptions: c.prescriptions.filter((_, idx) => idx !== i) }));
  // Remove a clinical heading the provider doesn't need (clears its content + drops it
  // from the kept order). It is not auto-re-added, so removals stick.
  const removeSection = (key) => setContent((c) => {
    const sections = { ...c.sections }; delete sections[key];
    return { ...c, sections, vitals: key === 'vitals' ? {} : c.vitals, sectionOrder: (c.sectionOrder || []).filter((k) => k !== key) };
  });

  // ALL headings visible (no progressive reveal). New notes are seeded with the full template set, so
  // this only acts as a SAFETY net: if a note somehow has no body headings (all removed, or a legacy
  // note), restore the complete template set in clinical order. A single heading removed with × is
  // respected (order is non-empty → no action) — the full set is never force-re-added over a removal.
  useEffect(() => {
    if (!active || readOnly) return;
    const tplSecs = (active.noteType === 'custom' || Array.isArray(content.customSections))
      ? (content.customSections || [])
      : (defs?.byType?.[active.noteType]?.sections || []);
    const tpl = tplSecs.filter((s) => s.key !== 'chiefComplaint' && s.key !== 'vitals');
    if (!tpl.length) return;
    const order = (Array.isArray(content.sectionOrder) ? content.sectionOrder : []).filter((k) => k !== 'chiefComplaint' && k !== 'vitals');
    if (!order.length) setContent((c) => ({ ...c, sectionOrder: tpl.map((s) => s.key) }));
  }, [content.sectionOrder, content.customSections, active, defs, readOnly]);

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
    if (!canSign) { toast.error('Only a physician (MD or DO) can sign off and finalize a note for billing.'); return; }
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
  // Heading-suggestion vocabulary — built from the REAL note templates the backend serves (every section
  // key + label actually used in the system), merged with the shared clinical-heading reference. Single
  // source of truth, not a static frontend-only list. Deterministic (key → label), de-duplicated.
  const headingDict = useMemo(() => {
    const d = { ...SECTION_LABELS };
    for (const t of (defs?.list || [])) for (const s of (t.sections || [])) if (s.key && s.label) d[s.key] = s.label;
    for (const t of customTpls) for (const s of (t.sections || [])) if (s.key && s.label && !d[s.key]) d[s.key] = s.label;
    return Object.entries(d);
  }, [defs, customTpls]);
  const sectionsForType = (nt) => defsByType?.[nt]?.sections || [];
  // A CUSTOM note carries its own section list in the content snapshot (self-contained record); a
  // built-in note uses the backend-authoritative template. No fallback to a static client copy.
  const isCustom = active?.noteType === 'custom' || Array.isArray(content.customSections);
  const template = active ? (isCustom ? (content.customSections || []) : sectionsForType(active.noteType)) : [];
  const noteMeta = active
    ? (isCustom
      ? { label: content.templateName || 'Custom Note', category: content.templateName ? `Custom template · ${content.templateName}` : 'Custom template', cpt: '' }
      : (defsByType?.[active.noteType] || { label: 'Clinical Note', category: '', cpt: '' }))
    : null;
  // DYNAMIC clinical note (Epic-style): headings appear one after another in the note
  // type's clinical order — never a pre-structured static list. Read mode shows only the
  // sections that were filled; edit mode shows every filled section PLUS the next empty
  // one, so a fresh note starts with a single heading and reveals the next automatically
  // as the provider writes. No SOAP scaffolding, no "add section" button.
  const sectionHasContent = (s) => (s.key === 'vitals'
    ? VITALS.some((v) => String(content.vitals?.[v.k] || '').trim())
    : String(content.sections[s.key] || '').trim().length > 0
      || ((content.checks?.[s.key] || []).length > 0)); // ticked checkboxes count as content
  // The headings, in order (content.sectionOrder). Edit mode shows the FULL set (all visible);
  // read/signed shows only the ones that were filled.
  const secByKey = {};
  template.forEach((s) => { secByKey[s.key] = s; });
  const noteSecs = (() => {
    // Chief Complaint has its own card — exclude it from the dynamic note body.
    const order = (Array.isArray(content.sectionOrder) ? content.sectionOrder : []).filter((k) => k !== 'chiefComplaint' && k !== 'vitals');
    const secs = order.map((k) => secByKey[k] || { key: k, label: k, prompt: '', rows: 4 });
    return readOnly ? secs.filter(sectionHasContent) : secs;
  })();

  // Encounter-header values — prefer the AUTHORITATIVE backend detail, fall back to what
  // was passed in. `enc` merges them so MRN / facility / DOS / patient are always filled.
  const enc = { ...encounter, ...(detail || {}) };
  const ageStr = detail?.ageAtEncounter || ageAtEncounter(enc.dob, enc.date);
  const myPhysicianCred = (user?.credentials || []).map((c) => String(c).toUpperCase().trim()).find((c) => PHYSICIAN_CREDS.includes(c));
  const seenBy = detail?.renderingProvider
    || (signed ? active?.signedByName : (active && active.isOwner !== false && user?.fullName ? `${user.fullName}${myPhysicianCred ? `, ${myPhysicianCred}` : ''}` : ''))
    || '—';
  const statusStr = !active
    ? 'No note started'
    : signed
      ? `Electronically signed by ${active.signedByName || 'Provider'}${active.signedAt ? ` at ${usDateTime(active.signedAt)}` : ''}`
      : 'Draft — not signed';

  return (
    <>
    {builder && <CustomTemplateBuilder initial={builder} headingDict={headingDict} onSave={saveCustomTemplate} onClose={() => setBuilder(null)} />}
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
                        <span className="pf-start-btn-main">
                          <span className="pf-start-btn-t">{t.label}</span>
                          <span className="pf-start-btn-s">{t.category}</span>
                        </span>
                        <span className="pf-start-btn-go" aria-hidden="true">→</span>
                      </button>
                    ))}
                  </div>

                  <div className="pf-start-custom-h">
                    <span>My templates</span>
                    <button type="button" className="pf-start-build" disabled={busy} onClick={() => setBuilder({})}>+ Build custom template</button>
                  </div>
                  {customTpls.length === 0 ? (
                    <div className="pf-start-custom-empty">No custom templates yet. Build your own with the headings you use — it saves automatically and shows up here.</div>
                  ) : (
                    <div className="pf-start-choices">
                      {customTpls.map((t) => (
                        <div key={t.uuid} className="pf-start-btn is-custom">
                          <button type="button" className="pf-start-btn-open" disabled={busy} onClick={() => createNote('custom', t)}>
                            <span className="pf-start-btn-main">
                              <span className="pf-start-btn-t">{t.label}</span>
                              <span className="pf-start-btn-s">{t.sections.length} heading{t.sections.length === 1 ? '' : 's'} · custom</span>
                            </span>
                            <span className="pf-start-btn-go" aria-hidden="true">→</span>
                          </button>
                          <span className="pf-start-btn-tools">
                            <button type="button" className="pf-sec-b" title="Edit template" onClick={() => setBuilder(t)}><EditIcon /></button>
                            <button type="button" className="pf-sec-b danger" title="Delete template" aria-label="Delete template" onClick={() => deleteCustomTemplate(t)}>×</button>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </article>
            </div>
          ) : (
            <>
              <div className="nt-subbar">
                <div className="nt-subtabs">
                  <button className={`nt-tab ${tab === 'note' ? 'is-on' : ''}`} onClick={() => setTab('note')}>Clinical Note</button>
                  <button className={`nt-tab ${tab === 'rx' ? 'is-on' : ''}`} onClick={() => setTab('rx')}>Prescriptions{content.prescriptions.length ? ` (${content.prescriptions.length})` : ''}</button>
                  {/* Coding & Billing is intentionally NOT a per-encounter provider tab — coding is done in
                      the Billing Module. The CodingPanel component + the /coding backend engine remain
                      intact and wired for that workflow. */}
                </div>
                <span className="nt-subcat">{noteMeta?.category}</span>
              </div>

              {tab === 'note' ? (
                <div className="nt-doc-scroll">
                  <article className={`pf-doc ${readOnly ? 'is-signed' : 'is-editing'}`}>
                    <PFDetails encounter={enc} noteLabel={noteMeta?.label || 'Clinical Note'} ageStr={ageStr} seenBy={seenBy} statusStr={statusStr}
                      encType={content.encounterType} readOnly={readOnly}
                      onEncType={(v) => setContent((c) => ({ ...c, encounterType: v }))} />

                    <section className="pf-card">
                      <div className="pf-card-h">Chief complaint</div>
                      {readOnly ? (
                        <div className="pf-body">{(content.sections.chiefComplaint || '').trim()
                          ? content.sections.chiefComplaint.split('\n').map((ln, i) => <p key={i}>{ln || ' '}</p>)
                          : <span className="pf-muted">No acute complaints</span>}</div>
                      ) : (
                        <AutoText rows={2} value={content.sections.chiefComplaint || ''} placeholder="Chief complaint — e.g. No acute complaints" onChange={(v) => setSection('chiefComplaint', v)} />
                      )}
                      {/* Vitals live under the Chief Complaint — on demand, not in the note-body flow. */}
                      {(showVitals || VITALS.some((v) => String(content.vitals?.[v.k] || '').trim())) ? (
                        <div className="pf-vitals">
                          <div className="pf-vitals-h">
                            <span className="pf-sec-hl"><span className="pf-sec-tick" aria-hidden="true" /><span className="pf-sec-t">Vitals</span></span>
                            {!readOnly && (
                              <button type="button" className="pf-sec-b danger" title="Hide / clear vitals" aria-label="Hide vitals"
                                onClick={() => { setShowVitals(false); setContent((c) => ({ ...c, vitals: {} })); }}>×</button>
                            )}
                          </div>
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
                      ) : (!readOnly && (
                        <button type="button" className="pf-vitals-btn" onClick={() => setShowVitals(true)}>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12h4l2 6 4-14 2 8h6" /></svg>
                          Add vitals
                        </button>
                      ))}
                    </section>

                    <section className="pf-card pf-note">
                      {/* Note header — Note Type · Patient + DOB · DOS — sits directly above the first
                          clinical heading (Code Status for SOAP, the first heading for H&P, etc.). */}
                      <PFNoteHeader encounter={enc} noteLabel={noteMeta?.label || 'Clinical Note'} />
                      {noteSecs.length ? noteSecs.map((s, i) => (s.key === 'vitals' ? (
                        <div className="pf-sec" key="vitals">
                          <div className="pf-sec-h">
                            <span className="pf-sec-hl"><span className="pf-sec-tick" aria-hidden="true" /><span className="pf-sec-t">Vitals</span></span>
                            {!readOnly && (
                              <span className="pf-sec-actions">
                                <button type="button" className="pf-sec-b" title="Edit Vitals" onClick={() => focusSection('vitals-first')}><EditIcon /></button>
                                <button type="button" className="pf-sec-b danger" title="Remove Vitals" onClick={() => removeSection('vitals')} aria-label="Remove Vitals">×</button>
                              </span>
                            )}
                          </div>
                          {readOnly ? (
                            <div className="pf-body"><p>{VITALS.map((v) => (content.vitals?.[v.k] ? `${v.label}: ${content.vitals[v.k]}` : null)).filter(Boolean).join('    ·    ') || '—'}</p></div>
                          ) : (
                            <div className="nt-vgrid">
                              {VITALS.map((v, vi) => (
                                <div className="nt-vfld" key={v.k}>
                                  <label>{v.label}{v.range ? <span className="nt-vrange">{v.range}</span> : null}</label>
                                  <input className="input" id={vi === 0 ? 'sec-vitals-first' : undefined} value={content.vitals?.[v.k] || ''} placeholder={v.ph} onChange={(e) => setVital(v.k, e.target.value)} />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="pf-sec" key={s.key}>
                          <div className="pf-sec-h">
                            <span className="pf-sec-hl"><span className="pf-sec-tick" aria-hidden="true" /><span className="pf-sec-t">{s.label}</span></span>
                            {!readOnly && (
                              <span className="pf-sec-actions">
                                <button type="button" className="pf-sec-b" title={`Edit ${s.label}`} onClick={() => focusSection(s.key)}><EditIcon /></button>
                                <button type="button" className="pf-sec-b danger" title={`Remove ${s.label}`} onClick={() => removeSection(s.key)} aria-label={`Remove ${s.label}`}>×</button>
                              </span>
                            )}
                          </div>
                          {s.key === 'attestation' ? (
                            <AttestationPanel signed={signed} attestation={content.signedAttestation} signedByName={active?.signedByName} signedAt={active?.signedAt} physician={canSign} />
                          ) : (<>
                          {Array.isArray(s.checks) && s.checks.length > 0 && (
                            readOnly ? (
                              (content.checks?.[s.key] || []).length > 0 && (
                                <div className="pf-checks read">
                                  {(content.checks[s.key] || []).map((opt) => <span className="pf-chk-tag" key={opt}>{opt}</span>)}
                                </div>
                              )
                            ) : (
                              <div className="pf-checks">
                                {s.checks.map((opt) => (
                                  <button type="button" key={opt} className={`pf-chk ${isChecked(s.key, opt) ? 'on' : ''}`} onClick={() => toggleCheck(s.key, opt)} aria-pressed={isChecked(s.key, opt)}>
                                    <span className="pf-chk-box" aria-hidden="true" />
                                    <span className="pf-chk-lbl">{opt}</span>
                                  </button>
                                ))}
                              </div>
                            )
                          )}
                          {readOnly ? (
                            <div className="pf-body">
                              {(content.sections[s.key] || '').trim()
                                ? (content.sections[s.key]).split('\n').map((ln, li) => <p key={li}>{ln || ' '}</p>)
                                : (!(content.checks?.[s.key] || []).length && <span className="pf-muted">—</span>)}
                            </div>
                          ) : s.key === 'prescriptionOrders' ? (
                            // Medication assist INTEGRATED into the free-form order field itself (no separate
                            // search box): RxNorm suggestions appear inline as the provider types a drug;
                            // picking one standardizes the name inline AND auto-loads a structured, RxCUI-coded
                            // prescription to the Prescriptions tab + runs the live safety check. If RxNorm has
                            // no match, "use as typed" adds it manually (no RxCUI) — the provider is never blocked.
                            <RxFreeText
                              id={`sec-${s.key}`} rows={s.rows >= 4 ? 4 : 2}
                              value={content.sections[s.key] || ''} placeholder={s.prompt}
                              onChange={(v) => setSection(s.key, v)}
                              allergies={content.sections?.allergies || ''}
                              currentDrugs={(content.prescriptions || []).map((p) => `${p.drug || ''} ${p.dose || ''}`.trim()).filter(Boolean)}
                              onDrug={(r) => {
                                setContent((c) => ({ ...c, prescriptions: addRxToList(c.prescriptions, r) }));
                                toast.success(`${r.name} added to the Prescriptions tab.`);
                              }}
                              toast={toast}
                            />
                          ) : (
                            <AutoText id={`sec-${s.key}`} rows={s.rows >= 4 ? 4 : 2} value={content.sections[s.key] || ''} placeholder={s.prompt} onChange={(v) => setSection(s.key, v)} />
                          )}
                          </>)}
                          {(s.key === 'labOrders' || s.key === 'imagingOrders') && enc?.encounterUuid && (
                            <OrderAttachments
                              encounterUuid={enc.encounterUuid}
                              kind={s.key === 'labOrders' ? 'lab' : 'imaging'}
                              label={s.label}
                              readOnly={readOnly}
                              orderText={content.sections[s.key] || ''}
                              enc={enc}
                              toast={toast}
                            />
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
                    {/* Rx assist (add-on): the same live RxNorm search + FDA safety check as the note's
                        Prescription Orders section — picking a drug loads it here as a structured,
                        RxCUI-coded medication and runs the allergy / interaction / duplicate check. */}
                    {!readOnly && (
                      <RxAssist
                        allergies={content.sections?.allergies || ''}
                        currentDrugs={(content.prescriptions || []).map((p) => `${p.drug || ''} ${p.dose || ''}`.trim()).filter(Boolean)}
                        onInsert={(r) => {
                          setContent((c) => ({ ...c, prescriptions: addRxToList(c.prescriptions, r) }));
                          toast.success(`${r.name} added as a prescription.`);
                        }}
                        toast={toast}
                      />
                    )}
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
/**
 * Auto-growing section text area. The box height always fits its content exactly — it grows as the
 * provider types (or when text is inserted programmatically, e.g. the Rx assist) and shrinks when text
 * is deleted. It also re-measures when the box WIDTH changes (the note going full-width, a window
 * resize, or the web font finishing loading) so the height stays accurate after any reflow.
 */
function AutoText({ value, onChange, placeholder, rows = 3, id }) {
  const ref = useRef(null);
  const minH = rows * 28 + 18; // document-scale line height (matches 15px / 1.85 body text)
  const lastW = useRef(0);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const borderY = el.offsetHeight - el.clientHeight; // top+bottom border (border-box)
    el.style.height = `${Math.max(el.scrollHeight + borderY, minH)}px`;
  }, [minH]);
  // Re-measure on every content change — typing AND programmatic inserts.
  useEffect(resize, [value, resize]);
  // Measure on mount, after the web font loads, and whenever the box WIDTH changes (text reflows).
  // Observing width only (not height) avoids a feedback loop from our own height writes.
  useEffect(() => {
    resize();
    const el = ref.current;
    if (!el) return undefined;
    lastW.current = el.clientWidth;
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const w = el.clientWidth;
        if (w !== lastW.current) { lastW.current = w; resize(); }
      });
      ro.observe(el);
    }
    let cancelled = false;
    if (document.fonts?.ready) document.fonts.ready.then(() => { if (!cancelled) resize(); }).catch(() => {});
    return () => { cancelled = true; if (ro) ro.disconnect(); };
  }, [resize]);
  return (
    <textarea
      ref={ref}
      id={id}
      className="nt-sec-edit"
      style={{ minHeight: `${minH}px` }}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onInput={resize}
      rows={1}
    />
  );
}

/** Small inline pencil — per-section "edit" affordance next to a heading. */
function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/** Focus a section's editor by key (used by the per-heading edit button). */
function focusSection(key) {
  const el = document.getElementById(`sec-${key}`);
  if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

// Append a picked RxNorm drug to the free-form Medications/Prescription Orders text, on its own line,
// ending in " — " so the provider continues with the sig (dose · route · frequency · qty · refills).
function appendRx(existing, r) {
  const base = String(existing || '');
  const sep = base.trim() ? (base.endsWith('\n') ? '' : '\n') : '';
  return `${base}${sep}${r.name} — `;
}

// Parse an RxNorm concept name ("amoxicillin 875 MG / clavulanate 125 MG Oral Tablet [Augmentin]") into a
// structured prescription for the Prescriptions tab. The RxNorm SCD/SBD name has a fixed grammar —
// `ingredient strength [/ ingredient strength …] doseForm [pack]` — so splitting on the strength tokens
// yields the ingredient(s) (all segments before the strengths) and the dose FORM (the final segment).
// This is form-vocabulary-independent (no hard-coded 182-form list), so EVERY drug parses accurately.
// The RxCUI is carried so the entry is a real, coded medication.
// A strength token: single ("10 MG"), combination ("875 MG / 125 MG"), a concentration/rate
// ("100 UNT/ML", "0.1 MG/HR", "90 MCG/ACTUAT", "0.154 MEQ/ML"), or a biologic/allergen unit
// ("1000 PNU/ML", "10000 BAU/ML", "5000 AU/ML"). Covers every strength RxNorm uses.
const RX_STRENGTH = /\d+(?:\.\d+)?\s*(?:Amb a \d+-U|SQ-HDM|VECTOR-GENOMES|MG|MCG|G|ML|UNT|UNIT|%|MEQ|MMOL|IU|BAU|AU|PNU|IR|SQCM|CELLS|MCI|SQ)(?:\s*\/\s*(?:\d+(?:\.\d+)?\s*)?(?:ML|HR|ACTUAT|MG|MCG|MEQ|SQCM))?/gi;
// Pack products interleave several "N (ingredient strength doseForm)" groups; strip the pack scaffolding
// (counts, inner dose forms, inert fillers) so the drug reads as the active ingredient(s).
const RX_PACK_INNER = /\b(?:Delayed Release |Extended Release |Chewable |Disintegrating )?(?:Oral (?:Tablet|Capsule)|Chewable Tablet|Sublingual Tablet|Oral Lozenge|Prefilled Syringe|Injectable Solution|Injection)\b/gi;
// Trailing dose-form phrase — used as a FALLBACK when the strength wasn't matched (exotic biologics), so
// the form is still detected and stripped from the drug. Anchored at the end; form nouns only.
const RX_FORM_TAIL = /(?:^|\s)((?:(?:delayed|extended|chewable|disintegrating|effervescent|sublingual|buccal|oral|topical|nasal|ophthalmic|otic|rectal|vaginal|transdermal|injectable|inhalation|mucosal|dental|intrauterine|auto|pen|prefilled|metered|dry|medicated|chewing|for|release|dose)\s+)*(?:tablet|capsule|solution|suspension|cream|ointment|gel|lotion|foam|spray|powder|granules?|film|patch|system|injection|injector|syringe|suppository|lozenge|pellet|paste|implant|cartridge|inhaler|enema|douche|gum|shampoo|soap|oil|pad|bar|wafer|insert|kit|mouthwash|toothpaste|irrigation|aerosol|sponge|ring|strip|troche|tape))\s*$/i;
// Route from the dose FORM keywords — SPECIFIC (non-oral) routes checked FIRST so a form containing
// "Solution" (Injectable/Topical/Ophthalmic/Nasal Solution) is never mistaken for oral. Covers all forms.
function routeForForm(form) {
  const f = String(form || '').toLowerCase();
  if (!f) return '';
  if (/inject|syringe|auto-injector|pen injector|cartridge|implant/.test(f)) return 'IV/IM';
  if (/transdermal|patch/.test(f)) return 'Transdermal';
  if (/sublingual/.test(f)) return 'SL';
  if (/buccal/.test(f)) return 'Buccal';
  if (/ophthalmic/.test(f)) return 'OU';
  if (/otic/.test(f)) return 'Otic';
  if (/nasal/.test(f)) return 'Nasal';
  if (/inhal|inhaler|nebuli/.test(f)) return 'INH';
  if (/intrauterine/.test(f)) return 'IU';
  if (/rectal|suppository|enema/.test(f)) return 'PR';
  if (/vaginal|douche/.test(f)) return 'PV';
  if (/topical|cream|ointment|lotion|\bgel\b|\boil\b|\bfoam\b|shampoo|soap|\bpad\b|\bbar\b|\btape\b/.test(f)) return 'Topical';
  if (/irrigation/.test(f)) return 'Irrigation';
  if (/mouthwash|toothpaste|dental|mucous membrane|mucosal|troche|lozenge|chewing gum/.test(f)) return 'Oral/Topical';
  if (/oral|tablet|capsule|suspension|solution|chewable|disintegrating|powder|granule|film|pellet|paste|effervescent|\bgum\b|pack/.test(f)) return 'PO';
  return '';
}
function rxToPrescription(r) {
  let name = String(r?.name || '').replace(/\[.*?\]/g, ' ').replace(/\s{2,}/g, ' ').trim(); // drop [brand] tag
  // Strip a LEADING fill volume — RxNorm prefixes injections/vaccines with "0.5 ML", "3 ML" (the syringe
  // fill), which is not the strength; removing it keeps the ingredient split clean.
  name = name.replace(/^\d+(?:\.\d+)?\s*ML\s+/i, '');
  const isPack = /\bpack\b/i.test(name) || name.startsWith('{');
  const strengths = (name.match(RX_STRENGTH) || []).map((s) => s.replace(/\s+/g, ' ').trim());
  const dose = isPack ? '' : strengths.join(' / '); // a multi-tablet pack has no single dose
  // Split by strengths → [ingredient1, ingredient2?, …, formTail]. When no strength matched (exotic
  // biologic), fall back to the trailing form phrase so the form/route are still resolved.
  const parts = name.split(RX_STRENGTH);
  const formTail = (parts.length > 1 ? parts[parts.length - 1] : ((name.match(RX_FORM_TAIL) || [])[1] || '')).trim();
  let drug = (parts.length > 1 ? parts.slice(0, -1).join('') : name.replace(RX_FORM_TAIL, ''))
    .replace(/\s*\/\s*/g, ' / ').replace(/[{}()]/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s/]+|[\s/]+$/g, '').trim();
  if (isPack) {
    // Distill a pack to its distinct ACTIVE ingredients: drop pack counts, inner forms, and fillers.
    const seen = new Set();
    drug = drug.replace(RX_PACK_INNER, ' ').replace(/\b\d+\b/g, ' ').replace(/\binert ingredients?\b/gi, ' ').replace(/\bpack\b/gi, ' ')
      .split('/').map((s) => s.trim()).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
      .join(' / ').replace(/\s{2,}/g, ' ').trim();
  }
  // Final cleanup: strip any trailing dose-form phrase still on the drug (exotic-unit concepts).
  drug = drug.replace(RX_FORM_TAIL, '').replace(/\s{2,}/g, ' ').replace(/^[\s/]+|[\s/]+$/g, '').trim();
  if (!drug) drug = name;
  let route = routeForForm(formTail);
  if (!route && /\bvaccine\b|\btoxoid\b|polysaccharide antigen/i.test(name)) route = 'IV/IM'; // injected biologic/vaccine
  // Cap to the prescription schema limits (drug ≤200, dose ≤80) so EVERY entry always saves — the full
  // standardized name always remains in the free-form order text and the RxCUI is carried regardless.
  return { drug: drug.slice(0, 200).trim(), dose: dose.slice(0, 80).trim(), route: route.slice(0, 60), frequency: '', quantity: '', refills: '', sig: '', rxcui: String(r?.code || '').slice(0, 20) };
}

// Add a parsed prescription to the list, de-duplicating by RxCUI (or drug+dose) so the same pick isn't
// added twice. Fills the FIRST blank row if the list ends with an empty one, else appends.
function addRxToList(list, r) {
  const rx = rxToPrescription(r);
  const cur = Array.isArray(list) ? list : [];
  if (rx.rxcui && cur.some((p) => p.rxcui && p.rxcui === rx.rxcui)) return cur; // already added
  if (cur.some((p) => (p.drug || '').toLowerCase() === rx.drug.toLowerCase() && (p.dose || '') === rx.dose && rx.drug)) return cur;
  const last = cur[cur.length - 1];
  if (last && !String(last.drug || '').trim() && !String(last.dose || '').trim()) {
    return cur.map((p, i) => (i === cur.length - 1 ? rx : p)); // fill the trailing blank row
  }
  return [...cur, rx];
}

/**
 * Real-time medication-writing assist for the free-form Medications/Prescription Orders section. As the
 * provider types, it searches the local RxNorm set (UMLS/RxNav-loaded, 110k+ concepts) via the live
 * /terminology/rxnorm API and suggests REAL prescribable drugs (strength + form). Picking one inserts the
 * standardized drug name into the note text (the section stays free-form — no grid, no checkboxes) and,
 * in the same step, runs a live safety check via /terminology/rx-safety:
 *   • allergy cross-check — the note's documented allergies vs the drug's name and its FDA-label
 *     hypersensitivity text (so a penicillin allergy flags amoxicillin/cephalexin);
 *   • drug interactions + serious warnings — from the drug's own FDA label (openFDA, live);
 *   • duplicate therapy — the same ingredient already on this note.
 * Every alert traces to real FDA/RxNorm data — nothing curated or fabricated.
 */
function RxAssist({ onInsert, toast, allergies = '', currentDrugs = [] }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [safety, setSafety] = useState(null);   // last-picked drug's safety result
  const [checking, setChecking] = useState(false);
  const checkSeq = useRef(0);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); setOpen(false); return undefined; }
    let a = true; setBusy(true);
    const t = setTimeout(async () => {
      // On search failure we still OPEN the menu so the provider can enter the drug manually.
      try { const { data } = await terminologyApi.rxnorm(q.trim(), 12); if (a) { setResults(data.results || []); setOpen(true); } }
      catch (e) { if (a) { setResults([]); setOpen(true); toast?.error(`Medication search failed: ${toApiError(e).message}`); } }
      finally { if (a) setBusy(false); }
    }, 260);
    return () => { a = false; clearTimeout(t); };
  }, [q, toast]);

  const pick = async (r) => {
    onInsert(r);
    setQ(''); setResults([]); setOpen(false);
    // Run the live safety check for the drug just added.
    const seq = ++checkSeq.current;
    setChecking(true); setSafety({ drug: r.name, loading: true });
    try {
      const { data } = await terminologyApi.rxSafety({
        name: r.name, rxcui: r.code, allergies, current: currentDrugs.join('|'),
      });
      if (seq === checkSeq.current) setSafety({ ...data, loading: false });
    } catch (e) {
      if (seq === checkSeq.current) { setSafety(null); toast?.error(`Safety check unavailable: ${toApiError(e).message}`); }
    } finally { if (seq === checkSeq.current) setChecking(false); }
  };

  return (
    <div className="rxa">
      <div className="rxa-bar">
        <svg className="rxa-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)" /><path d="M8.5 8.5l7 7" /></svg>
        <input className="rxa-input" value={q} placeholder="Search medication (RxNorm) — or type any drug and add it manually…" autoComplete="off"
          onChange={(e) => setQ(e.target.value)} onFocus={() => q.trim().length >= 2 && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
        {busy && <span className="spinner sm" aria-label="Searching" />}
      </div>
      {open && q.trim().length >= 2 && !busy && (
        <div className="rxa-menu">
          {results.map((r) => (
            <button type="button" key={r.code} className="rxa-opt" onMouseDown={(e) => { e.preventDefault(); pick(r); }}>
              <span className="rxa-opt-n">{r.name}</span>
              <span className="rxa-opt-t">{r.tty || 'RXNORM'} · RxCUI {r.code}</span>
            </button>
          ))}
          {/* Manual entry — always available so a provider is never blocked when RxNorm lacks the drug.
              Routed through the SAME onInsert path (free-form text + auto-loaded structured Rx) and the
              same live safety check; it carries no RxCUI (flagged as manual/un-coded). */}
          {!results.some((r) => r.name.toLowerCase() === q.trim().toLowerCase()) && (
            <button type="button" className="rxa-opt rxa-manual" onMouseDown={(e) => { e.preventDefault(); pick({ name: q.trim(), code: '', tty: 'MANUAL' }); }}>
              <span className="rxa-opt-n">+ Add “{q.trim()}” as a medication</span>
              <span className="rxa-opt-t">{results.length ? 'Not the drug you need? Enter it manually' : 'No RxNorm match'} · manual entry (no RxCUI)</span>
            </button>
          )}
        </div>
      )}
      {safety && <RxSafetyPanel safety={safety} checking={checking} onClose={() => setSafety(null)} />}
    </div>
  );
}

/**
 * Medication-aware FREE-FORM order field — the RxNorm assist is built INTO the writing area itself (no
 * separate search box). As the provider types a drug name on a line, live RxNorm suggestions appear
 * inline; picking one standardizes the name in place, auto-loads a structured RxCUI-coded prescription
 * to the Prescriptions tab (via onDrug), and runs the live safety check. A leading order verb
 * (start/continue/change/d-c…) is ignored for the search but preserved in the text. When RxNorm has no
 * match, "use as typed" adds the medication manually (no RxCUI) so the provider is never blocked.
 * The textarea keeps the same auto-grow behavior as the other sections; Esc dismisses the suggestions.
 */
const RX_VERB = /^((?:start|begin|continue|cont|change|increase|decrease|discontinue|d\/c|dc|stop|hold|add|resume|taper|give|order|initiate)\s+)/i;
function RxFreeText({ value, onChange, onDrug, allergies, currentDrugs, toast, placeholder, rows = 3, id }) {
  const ref = useRef(null);
  const minH = rows * 28 + 18;
  const lastW = useRef(0);
  const [token, setToken] = useState('');        // current line up to the cursor
  const [suggest, setSuggest] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [safety, setSafety] = useState(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  const dismissed = useRef('');

  const resize = useCallback(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; const b = el.offsetHeight - el.clientHeight; el.style.height = `${Math.max(el.scrollHeight + b, minH)}px`; }, [minH]);
  useEffect(resize, [value, resize]);
  useEffect(() => {
    resize(); const el = ref.current; if (!el) return undefined; lastW.current = el.clientWidth; let ro;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => { const w = el.clientWidth; if (w !== lastW.current) { lastW.current = w; resize(); } }); ro.observe(el); }
    let cancelled = false; if (document.fonts?.ready) document.fonts.ready.then(() => { if (!cancelled) resize(); }).catch(() => {});
    return () => { cancelled = true; if (ro) ro.disconnect(); };
  }, [resize]);

  const lineToCursor = () => { const el = ref.current; if (!el) return ''; const v = el.value; const pos = el.selectionStart; const ls = v.lastIndexOf('\n', pos - 1) + 1; return v.slice(ls, pos); };
  const refreshToken = () => setToken(lineToCursor());
  const searchTerm = (() => { const m = token.match(RX_VERB); return (m ? token.slice(m[0].length) : token).trim(); })();

  useEffect(() => {
    // Suggest only while the provider is typing a drug NAME: ≥3 chars, line not yet committed (no em-dash),
    // and not dismissed for this exact term.
    if (searchTerm.length < 3 || /—/.test(token) || dismissed.current === searchTerm) { setSuggest([]); setOpen(false); return undefined; }
    let a = true; setBusy(true);
    const t = setTimeout(async () => {
      try { const { data } = await terminologyApi.rxnorm(searchTerm, 10); if (a) { setSuggest(data.results || []); setOpen(true); } }
      catch { if (a) { setSuggest([]); setOpen(true); } } // still open → manual "use as typed" is available
      finally { if (a) setBusy(false); }
    }, 260);
    return () => { a = false; clearTimeout(t); };
  }, [searchTerm, token]);

  const runSafety = async (r) => {
    const s = ++seq.current; setChecking(true); setSafety({ drug: r.name, loading: true });
    try { const { data } = await terminologyApi.rxSafety({ name: r.name, rxcui: r.code || '', allergies, current: (currentDrugs || []).join('|') }); if (s === seq.current) setSafety({ ...data, loading: false }); }
    catch (e) { if (s === seq.current) { setSafety(null); toast?.error(`Safety check unavailable: ${toApiError(e).message}`); } }
    finally { if (s === seq.current) setChecking(false); }
  };

  // Replace the drug-name portion of the current line with the standardized name (keeping any order verb),
  // append " — " for the sig, auto-load the structured Rx, and run the safety check.
  const pick = (r) => {
    const el = ref.current; const v = el.value; const pos = el.selectionStart; const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const lc = v.slice(ls, pos); const m = lc.match(RX_VERB); const verb = m ? m[0] : '';
    const before = v.slice(0, ls) + verb; const after = v.slice(pos);
    const inserted = `${r.name} — `;
    onChange(`${before}${inserted}${after}`);
    setOpen(false); setSuggest([]); setToken(''); dismissed.current = '';
    onDrug(r); runSafety(r);
    setTimeout(() => { const e2 = ref.current; if (e2) { const np = (before + inserted).length; e2.focus(); e2.setSelectionRange(np, np); resize(); } }, 12);
  };

  const onKeyDown = (e) => { if (e.key === 'Escape' && open) { e.preventDefault(); dismissed.current = searchTerm; setOpen(false); } };

  return (
    <div className="rxft">
      <textarea
        ref={ref} id={id} className="nt-sec-edit" style={{ minHeight: `${minH}px` }} value={value} placeholder={placeholder} rows={1}
        onChange={(e) => { onChange(e.target.value); refreshToken(); }} onInput={resize}
        onKeyUp={refreshToken} onClick={refreshToken} onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
      />
      {open && searchTerm.length >= 3 && !busy && (
        <div className="rxa-menu rxft-menu">
          {suggest.map((r) => (
            <button type="button" key={r.code} className="rxa-opt" onMouseDown={(e) => { e.preventDefault(); pick(r); }}>
              <span className="rxa-opt-n">{r.name}</span>
              <span className="rxa-opt-t">{r.tty || 'RXNORM'} · RxCUI {r.code}</span>
            </button>
          ))}
          {!suggest.some((r) => r.name.toLowerCase() === searchTerm.toLowerCase()) && (
            <button type="button" className="rxa-opt rxa-manual" onMouseDown={(e) => { e.preventDefault(); pick({ name: searchTerm, code: '', tty: 'MANUAL' }); }}>
              <span className="rxa-opt-n">+ Use “{searchTerm}” as typed</span>
              <span className="rxa-opt-t">{suggest.length ? 'Not listed? Enter manually' : 'No RxNorm match'} · manual (no RxCUI)</span>
            </button>
          )}
        </div>
      )}
      {safety && <RxSafetyPanel safety={safety} checking={checking} onClose={() => setSafety(null)} />}
    </div>
  );
}

/**
 * Provider-facing safety readout for the drug just prescribed. Ordered by clinical urgency: allergy
 * alerts (red) first, then duplicate therapy (amber), then FDA interactions/warnings (collapsible).
 * Shows an honest note when the FDA label carries no interaction data for the ingredient.
 */
function RxSafetyPanel({ safety, checking, onClose }) {
  const [showRx, setShowRx] = useState(false);
  if (safety.loading || checking) {
    return (
      <div className="rxs rxs-load">
        <span className="spinner sm" aria-hidden="true" />
        <span>Checking {safety.drug} — allergies, drug class, duplicates…</span>
      </div>
    );
  }
  const allergy = safety.allergyAlerts || [];
  const dup = safety.duplicates || [];
  const classes = safety.classes || [];
  // classKnown === false → the ingredient is not in the ATC drug-class crosswalk, so class-based
  // allergy and therapeutic-duplication screening could NOT be applied. Never present that as "clear/safe".
  const classUnknown = safety.classKnown === false;
  const clear = !classUnknown && !allergy.length && !dup.length;
  return (
    <div className={`rxs ${allergy.length ? 'rxs-danger' : (dup.length || classUnknown) ? 'rxs-warn' : 'rxs-ok'}`}>
      <div className="rxs-head">
        <span className="rxs-title">
          {allergy.length ? '⚠ Safety alert' : classUnknown ? 'Class not on file' : dup.length ? 'Review before prescribing' : 'Safety check'} · {safety.drug}
        </span>
        <button type="button" className="rxs-x" onClick={onClose} aria-label="Dismiss safety panel">×</button>
      </div>

      {allergy.length > 0 && (
        <div className="rxs-block rxs-b-danger">
          <div className="rxs-b-lbl">Allergy</div>
          <ul>{allergy.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      {dup.length > 0 && (
        <div className="rxs-block rxs-b-warn">
          <div className="rxs-b-lbl">Duplicate therapy</div>
          <ul>{dup.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}

      {classUnknown && (
        <div className="rxs-block rxs-b-warn">
          <div className="rxs-b-lbl">Not screened</div>
          <ul><li>No drug class is on file for this ingredient, so <strong>class-based allergy and duplicate screening could not be applied</strong>. Verify allergies manually before prescribing.</li></ul>
        </div>
      )}

      {classes.length > 0 && (
        <div className="rxs-rx">
          <button type="button" className="rxs-rx-toggle" onClick={() => setShowRx((v) => !v)} aria-expanded={showRx}>
            {showRx ? '▾' : '▸'} Drug class ({classes.length})
          </button>
          {showRx && (
            <div className="rxs-rx-body">
              {classes.map((c, i) => <p key={`c${i}`}>{c}</p>)}
            </div>
          )}
        </div>
      )}

      {clear && <div className="rxs-clear">No documented-allergy or duplicate-therapy conflict for this medication.</div>}
      <div className="rxs-src">Source: {safety.source || 'WHO ATC drug classification (local)'}</div>
    </div>
  );
}

/**
 * Attestation & Signature — AUTOMATIC and compliance-proof. The provider never hand-types it: on
 * sign-off the backend composes the CMS attestation for the note type plus the physician's identity
 * (name, credentials, NPI) and, when a non-physician practitioner performed the visit, names them as
 * the rendering practitioner. A draft shows what will be captured; a signed note shows the real one.
 */
function AttestationPanel({ signed, attestation, signedByName, signedAt, physician }) {
  if (signed && attestation?.statement) {
    const r = attestation.rendering;
    return (
      <div className="pf-attest signed">
        <p className="pf-attest-stmt">{attestation.statement}</p>
        {r?.name && (
          <p className="pf-attest-rend">Rendering practitioner: {r.name}{r.creds?.length ? `, ${r.creds.join(', ')}` : ''}{r.npi ? ` · NPI ${r.npi}` : ''}</p>
        )}
        <p className="pf-attest-sig">✓ Electronically signed by {signedByName || attestation.signer || 'Provider'}{signedAt ? ` · ${usDateTime(signedAt)}` : ''} · Finalized and part of the billing record.</p>
      </div>
    );
  }
  if (signed) {
    // Legacy signed note finalized before auto-attestation — show the captured signature.
    return <div className="pf-attest signed"><p className="pf-attest-sig">✓ Electronically signed by {signedByName || 'Provider'}{signedAt ? ` · ${usDateTime(signedAt)}` : ''} · Finalized and part of the billing record.</p></div>;
  }
  return (
    <div className="pf-attest draft">
      <p>The attestation and your electronic signature are <strong>generated automatically and compliance-verified on sign-off</strong> — the correct CMS attestation for this note type plus your name, credentials, NPI, and the date/time are captured when a physician (MD/DO) signs and finalizes. No manual entry needed.</p>
      {!physician && <p className="pf-attest-npp">You’ll save this note and route it to a facility physician (MD/DO), who performs the final signature; you’ll be named as the rendering practitioner.</p>}
    </div>
  );
}

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (b) => { const n = Number(b); if (!n) return ''; if (n < 1024) return `${n} B`; if (n < 1048576) return `${Math.round(n / 1024)} KB`; return `${(n / 1048576).toFixed(1)} MB`; };

/**
 * Lab / Imaging order attachments for ONE encounter — supports uploading documents AND images (PDF,
 * JPG, PNG, WEBP, TIFF, DICOM, Word). Files are stored in S3 under the patient's per-encounter folder
 * (labs/ or imaging/); this panel lists them, opens a short-lived signed URL to view/download, and
 * prints a requisition (the order text + attached-record list). The narrative order stays in the note
 * section text; these are the resulted records for the encounter.
 */
function OrderAttachments({ encounterUuid, kind, label, readOnly, orderText, enc, toast }) {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(() => {
    encountersApi.listEncounterDocs(encounterUuid, kind)
      .then(({ data }) => setDocs(data.documents || []))
      .catch((e) => toast.error(`Couldn’t load ${label}: ${toApiError(e).message}`));
  }, [encounterUuid, kind, label, toast]);
  useEffect(() => { load(); }, [load]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    setBusy(true);
    try { await encountersApi.uploadEncounterDoc(encounterUuid, kind, file); toast.success(`${label} record attached.`); load(); }
    catch (e2) { toast.error(toApiError(e2).message); } finally { setBusy(false); }
  }
  async function view(doc) {
    try { const { data } = await encountersApi.encounterDocUrl(doc.uuid); window.open(data.url, '_blank', 'noopener'); }
    catch (e) { toast.error(toApiError(e).message); }
  }
  async function del(doc) {
    if (!window.confirm(`Remove “${doc.fileName || 'this record'}” from this encounter?`)) return;
    try { await encountersApi.deleteEncounterDoc(doc.uuid); load(); toast.success('Record removed.'); }
    catch (e) { toast.error(toApiError(e).message); }
  }
  function print() {
    const rows = docs.length
      ? docs.map((d) => `<li>${escapeHtml(d.fileName || 'Attachment')}${d.size ? ` <span class="mut">(${fmtSize(d.size)})</span>` : ''}</li>`).join('')
      : '<li class="mut">No records attached</li>';
    const w = window.open('', '_blank', 'width=820,height=920');
    if (!w) { toast.error('Allow pop-ups to print the requisition.'); return; }
    w.document.write(`<!doctype html><html><head><title>${escapeHtml(label)} — ${escapeHtml(enc?.patientName || 'Patient')}</title>
      <style>body{font:13px/1.5 Segoe UI,Arial,sans-serif;color:#0f1b33;margin:32px}h1{font-size:19px;margin:0 0 4px}
      .meta{color:#55617a;font-size:12px;margin-bottom:18px}h3{font-size:13px;margin:18px 0 6px;border-bottom:1px solid #dbe2ef;padding-bottom:4px}
      pre{white-space:pre-wrap;font:inherit;margin:0}ul{margin:4px 0;padding-left:20px}.mut{color:#8a94a6}</style></head><body>
      <h1>${escapeHtml(label)}</h1>
      <div class="meta">${escapeHtml(enc?.patientName || 'Patient')} · MRN ${escapeHtml(enc?.mrn || '—')} · DOS ${escapeHtml(usDate(enc?.date))} · Encounter ${escapeHtml(encNo(enc?.encounterNo))}</div>
      <h3>Order</h3><pre>${escapeHtml(orderText || '—')}</pre>
      <h3>Attached records</h3><ul>${rows}</ul>
      <script>window.onload=function(){window.print();}</script></body></html>`);
    w.document.close();
  }

  return (
    <div className="ord-attach">
      <div className="ord-attach-bar">
        <span className="ord-attach-t">Records for this encounter{docs.length ? ` · ${docs.length}` : ''}</span>
        <span className="spacer" />
        {!readOnly && (
          <button type="button" className="ord-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <span className="spinner" /> : <>+ Add</>}
          </button>
        )}
        <button type="button" className="ord-btn" onClick={print}>Print</button>
        <input ref={fileRef} type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.dcm,.doc,.docx,image/*,application/pdf" onChange={onFile} />
      </div>
      {docs.length === 0 ? (
        <div className="ord-attach-empty">No {kind === 'lab' ? 'lab' : 'imaging'} records attached to this encounter yet.{!readOnly && ' Use + Add to upload a document or image.'}</div>
      ) : (
        <ul className="ord-attach-list">
          {docs.map((d) => (
            <li key={d.uuid} className="ord-attach-item">
              <button type="button" className="ord-attach-name" onClick={() => view(d)} title="View / download">{d.fileName || 'Attachment'}</button>
              {d.size ? <span className="ord-attach-meta">{fmtSize(d.size)}</span> : null}
              {!readOnly && <button type="button" className="ord-attach-x" title="Remove record" aria-label="Remove record" onClick={() => del(d)}>×</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Heading input with LIVE suggestions from the canonical clinical-heading dictionary. As the provider
 * types (e.g. "HPI"), matching standard headings appear; picking one keeps the note aligned with the
 * system's known section keys (coding + document labels), while typing a fully custom heading is also
 * allowed. Deterministic — the suggestion list is the fixed dictionary, filtered by the typed text.
 */
function HeadingSuggest({ value, onChange, onPick, placeholder, dict }) {
  const [open, setOpen] = useState(false);
  const q = String(value || '').trim().toLowerCase();
  const source = dict && dict.length ? dict : Object.entries(SECTION_LABELS);
  const suggestions = q.length >= 1
    ? source
      .filter(([k, label]) => label.toLowerCase().includes(q) || k.toLowerCase().includes(q))
      .filter(([, label]) => label.toLowerCase() !== q)
      .slice(0, 8)
    : [];
  return (
    <div className="hs">
      <input
        className="input" value={value} placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 130)}
      />
      {open && suggestions.length > 0 && (
        <div className="hs-menu">
          {suggestions.map(([k, label]) => (
            <button type="button" key={k} className="hs-opt" onMouseDown={(e) => { e.preventDefault(); onPick(k, label); setOpen(false); }}>
              <span className="hs-opt-l">{label}</span>
              <span className="hs-opt-k">{k}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Common SNF clinical headings — one-click building blocks (canonical keys so they stay wired to the
// system's labels, coding, and document rendering). Providers assemble a template in seconds.
const QUICK_HEADINGS = [
  { key: 'chiefComplaint', label: 'Chief Complaint' }, { key: 'hpi', label: 'HPI' },
  { key: 'codeStatus', label: 'Code Status' }, { key: 'allergies', label: 'Allergy' },
  { key: 'medications', label: 'Home Medications' }, { key: 'pmh', label: 'Past Medical History' },
  { key: 'psh', label: 'Past Surgical History' }, { key: 'ros', label: 'Review of Systems' },
  { key: 'exam', label: 'Physical Examination' }, { key: 'results', label: 'Labs / Imaging' },
  { key: 'assessment', label: 'Assessment & Plan' }, { key: 'carePlanReview', label: 'Care Plan Review' },
  { key: 'prescriptionOrders', label: 'Medications / Prescription Orders' }, { key: 'labOrders', label: 'Lab Orders' },
  { key: 'imagingOrders', label: 'Imaging Orders' }, { key: 'followUp', label: 'Follow-Up' },
  { key: 'attestation', label: 'Attestation & Signature' },
];

/**
 * Custom-template builder — an enterprise-grade, full-window workspace where a provider designs their
 * own note template. Left: the editor (name, quick-add clinical headings, an ordered list of headings
 * each with optional guidance + checkboxes). Right: a LARGE live preview that renders the template
 * exactly as it will appear in the note (header + headings + guidance + checkboxes), updating in real
 * time. Saved to the provider's account and available in the note chooser instantly.
 */
export function CustomTemplateBuilder({ initial, headingDict, onSave, onClose }) {
  const toast = useToast();
  const isEdit = !!initial?.uuid;
  const [name, setName] = useState(initial?.label || '');
  const [rows, setRows] = useState(() => {
    const secs = initial?.sections?.length ? initial.sections : [{ key: 'chiefComplaint', label: 'Chief Complaint', prompt: '' }];
    return secs.map((s) => ({ key: s.key || '', label: s.label || '', prompt: s.prompt || '', checks: (s.checks || []).join(', '), more: !!(s.prompt || (s.checks || []).length) }));
  });
  const [saving, setSaving] = useState(false);
  // AI-assisted drafting (shown only when configured server-side). Generates a SNF, CMS-compliant,
  // provider-focused draft the provider then reviews/edits/saves — nothing is auto-saved.
  const [aiOn, setAiOn] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => { let a = true; loadNoteDefs().then((d) => { if (a) setAiOn(!!d.aiTemplates); }).catch(() => {}); return () => { a = false; }; }, []);
  async function generateDraft() {
    const p = aiPrompt.trim();
    if (p.length < 3) { toast?.error('Describe the note you need (a sentence or two).'); return; }
    setAiBusy(true);
    try {
      const { data } = await encountersApi.generateCustomTemplate(p);
      const d = data.draft || {};
      if (d.name) setName(d.name);
      setRows((d.sections || []).map((s) => ({ key: s.key || '', label: s.label || '', prompt: s.prompt || '', checks: (s.checks || []).join(', '), more: !!(s.prompt || (s.checks || []).length) })));
      toast?.success('Draft ready — review the headings and checkboxes, edit as needed, then Save.');
    } catch (e) { toast?.error(toApiError(e).message); } finally { setAiBusy(false); }
  }

  const setRowAt = (i, patch) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addRow = () => setRows((r) => [...r, { key: '', label: '', prompt: '', checks: '', more: false }]);
  const removeRow = (i) => setRows((r) => (r.length > 1 ? r.filter((_, idx) => idx !== i) : r));
  const move = (i, d) => setRows((r) => { const n = [...r]; const j = i + d; if (j < 0 || j >= n.length) return r; [n[i], n[j]] = [n[j], n[i]]; return n; });
  // Heading checkbox: CHECK adds the heading (fills the first blank row, else appends); UNCHECK removes
  // that heading. Canonical key keeps it wired to the system's labels/coding. De-dupes by label/key.
  const toggleHeading = (h) => setRows((r) => {
    const idx = r.findIndex((row) => row.label.trim().toLowerCase() === h.label.toLowerCase() || (row.key && row.key === h.key));
    if (idx >= 0) { // uncheck → remove (never drop below one row — blank the last one instead)
      if (r.length === 1) return [{ key: '', label: '', prompt: '', checks: '', more: false }];
      return r.filter((_, i) => i !== idx);
    }
    const blank = r.findIndex((row) => !row.label.trim());
    // Auto-attach the heading's CMS-compliant checkbox set (from the SNF template catalog), if any.
    const preset = checksForHeading(h.key);
    const entry = { key: h.key, label: h.label, prompt: '', checks: preset ? preset.join(', ') : '', more: !!preset };
    if (blank >= 0) return r.map((row, i) => (i === blank ? entry : row));
    return [...r, entry];
  });
  const used = new Set(rows.map((row) => row.label.trim().toLowerCase()));

  // EVERY clinical heading the system knows — the note-template dictionary (H&P, SOAP, Progress,
  // Discharge, procedure, pain, TCM, behavioral, cognitive…) merged with the full canonical label set,
  // de-duped by label. A provider can build ANY note type by checking the headings they need.
  const [hq, setHq] = useState('');
  const headingSource = useMemo(() => {
    const seen = new Set(); const out = [];
    const push = (key, label) => { const lk = String(label || '').trim().toLowerCase(); if (!lk || seen.has(lk)) return; seen.add(lk); out.push({ key, label }); };
    for (const [key, label] of (headingDict || [])) push(key, label);
    for (const [key, label] of Object.entries(SECTION_LABELS)) push(key, label); // guarantee the full canonical set
    const commonRank = new Map(QUICK_HEADINGS.map((h, i) => [h.key, i]));
    out.sort((a, b) => {
      const ar = commonRank.has(a.key) ? commonRank.get(a.key) : 999;
      const br = commonRank.has(b.key) ? commonRank.get(b.key) : 999;
      return ar - br || a.label.localeCompare(b.label);
    });
    return out;
  }, [headingDict]);
  const q = hq.trim().toLowerCase();
  const shownHeadings = q ? headingSource.filter((h) => h.label.toLowerCase().includes(q) || h.key.toLowerCase().includes(q)) : headingSource;

  const filled = rows.filter((row) => row.label.trim());
  const valid = name.trim() && filled.length;
  async function submit() {
    const sections = filled.map((row) => ({
      ...(row.key ? { key: row.key } : {}),
      label: row.label.trim(),
      ...(row.prompt.trim() ? { prompt: row.prompt.trim() } : {}),
      ...(row.checks.trim() ? { checks: row.checks.split(',').map((c) => c.trim()).filter(Boolean) } : {}),
    }));
    setSaving(true);
    try { await onSave({ uuid: initial?.uuid, name: name.trim(), sections }); } catch { setSaving(false); }
  }

  const chev = (dir) => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === 'up' ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );

  return (
    <Modal size="full" title={isEdit ? 'Edit custom template' : 'Build a custom template'} onClose={onClose} footer={<>
      <span className="ctb-foot-hint">{valid ? `${filled.length} heading${filled.length === 1 ? '' : 's'} · saved to your account, in the note chooser instantly` : 'Add a name and at least one heading to save'}</span>
      <span className="spacer" />
      <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="btn" onClick={submit} disabled={!valid || saving}>{saving ? <span className="spinner" /> : (isEdit ? 'Save changes' : 'Save template')}</button>
    </>}>
      <div className="ctb2">
        {/* ── Editor pane ─────────────────────────────────────────── */}
        <div className="ctb2-editor">
          {aiOn && (
            <div className="ctb2-ai">
              <div className="ctb2-ai-h">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z" /><path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" /></svg>
                <span>Describe your note — get a ready SNF template</span>
              </div>
              <textarea className="input ctb2-ai-in" rows={2} value={aiPrompt} disabled={aiBusy}
                placeholder="e.g. Weekly wound rounds with photo documentation and dressing orders — provider-focused, CMS compliant"
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generateDraft(); }} />
              <div className="ctb2-ai-foot">
                <span className="ctb2-ai-note">Builds headings + compliance checkboxes. You review &amp; edit before saving.</span>
                <span className="spacer" />
                <button type="button" className="btn sm" onClick={generateDraft} disabled={aiBusy || aiPrompt.trim().length < 3}>
                  {aiBusy ? <><span className="spinner" /> Generating…</> : 'Generate template'}
                </button>
              </div>
            </div>
          )}
          <div className="ctb2-field">
            <label className="ctb2-lbl">Template name<span className="fs-req">*</span></label>
            <input className="input ctb2-name" value={name} placeholder="e.g. My SNF Follow-Up" autoFocus onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="ctb2-quick">
            <div className="ctb2-quick-h">Clinical headings <span className="ctb2-quick-hint">— check any to include ({headingSource.length} available)</span></div>
            <div className="ctb2-quick-search">
              <svg className="ctb2-quick-search-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
              <input className="input" value={hq} placeholder="Search all headings — e.g. wound, ROS, procedure, PDMP…" onChange={(e) => setHq(e.target.value)} />
              {hq && <button type="button" className="ctb2-quick-clear" onClick={() => setHq('')} aria-label="Clear search">✕</button>}
            </div>
            <div className="ctb2-quick-grid ctb2-quick-scroll">
              {shownHeadings.map((h) => {
                const on = used.has(h.label.toLowerCase());
                return (
                  <label key={`${h.key}:${h.label}`} className={`ctb2-check ${on ? 'is-on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => toggleHeading(h)} />
                    <span className="ctb2-check-box" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
                    </span>
                    <span className="ctb2-check-lbl">{h.label}</span>
                  </label>
                );
              })}
              {shownHeadings.length === 0 && (
                <div className="ctb2-quick-empty">No heading matches “{hq}”. Type it into the Headings list below to add it as your own.</div>
              )}
            </div>
          </div>

          <div className="ctb2-secs-h">
            <span className="ctb2-secs-title">Headings</span>
            <span className="ctb2-secs-sub">Type your own — suggestions appear as you type · {filled.length} added</span>
          </div>
          <div className="ctb-secs">
            {rows.map((row, i) => (
              <div className={`ctb-sec ${row.more ? 'is-open' : ''}`} key={i}>
                <span className="ctb-num">{i + 1}</span>
                <div className="ctb-fields">
                  <div className="ctb-primary">
                    <div className="ctb-head-input">
                      <HeadingSuggest
                        value={row.label} placeholder="Heading — e.g. HPI, Assessment, Plan…" dict={headingDict}
                        onChange={(v) => setRowAt(i, { label: v, key: '' })}
                        onPick={(k, label) => { const preset = checksForHeading(k); setRowAt(i, { key: k, label, ...(preset && !row.checks.trim() ? { checks: preset.join(', '), more: true } : {}) }); }}
                      />
                    </div>
                    <div className="ctb-tools">
                      <span className="ctb-reorder">
                        <button type="button" className="ctb-rb" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>{chev('up')}</button>
                        <button type="button" className="ctb-rb" title="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>{chev('down')}</button>
                      </span>
                      <button type="button" className="ctb-rb danger" title="Remove heading" aria-label="Remove heading" disabled={rows.length === 1} onClick={() => removeRow(i)}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </div>
                  </div>
                  <button type="button" className="ctb-optbtn" onClick={() => setRowAt(i, { more: !row.more })}>
                    {row.more ? '− Hide guidance & checkboxes' : '+ Add guidance or checkboxes'}
                  </button>
                  {row.more && (
                    <div className="ctb-more">
                      <label className="ctb-mini">Guidance prompt</label>
                      <input className="input ctb-sub" value={row.prompt} placeholder="What the provider should write here (optional)" onChange={(e) => setRowAt(i, { prompt: e.target.value })} />
                      <label className="ctb-mini">Checkbox options</label>
                      <input className="input ctb-sub" value={row.checks} placeholder="Comma-separated, e.g. Stable, Improving, Worsening (optional)" onChange={(e) => setRowAt(i, { checks: e.target.value })} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="ctb-add" onClick={addRow}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            Add heading
          </button>
        </div>

        {/* ── Live preview pane ───────────────────────────────────── */}
        <div className="ctb2-preview">
          <div className="ctb2-pv-bar">
            <span className="ctb2-pv-bar-t">Live preview</span>
            <span className="ctb2-pv-bar-s">Exactly how the note will appear</span>
          </div>
          <div className="ctb2-pv-scroll">
            <div className="ctb2-pv-doc">
              <div className="ctb2-pv-nhead">
                <div className="ctb2-pv-note">Note</div>
                <div className="ctb2-pv-grid">
                  <div className="ctb2-pv-item"><span className="ctb2-pv-l">Note Type</span><span className="ctb2-pv-v ctb2-pv-type">{name.trim() || 'Untitled template'}</span></div>
                  <div className="ctb2-pv-row">
                    <div className="ctb2-pv-item"><span className="ctb2-pv-l">Patient Name</span><span className="ctb2-pv-v">Jane Doe</span></div>
                    <div className="ctb2-pv-item"><span className="ctb2-pv-l">DOB</span><span className="ctb2-pv-v">05/02/1940</span></div>
                  </div>
                  <div className="ctb2-pv-item"><span className="ctb2-pv-l">Date of Service (DOS)</span><span className="ctb2-pv-v">Today</span></div>
                </div>
              </div>
              {filled.length === 0 ? (
                <div className="ctb2-pv-empty">Add headings on the left — they appear here exactly as the provider will see them.</div>
              ) : filled.map((row, i) => {
                const checks = row.checks.split(',').map((c) => c.trim()).filter(Boolean);
                return (
                  <div className="ctb2-pv-sec" key={i}>
                    <div className="ctb2-pv-sec-h"><span className="pf-sec-tick" aria-hidden="true" /><span className="ctb2-pv-sec-t">{row.label.trim()}</span></div>
                    {checks.length > 0 && (
                      <div className="ctb2-pv-chips">{checks.map((c, ci) => <span className="ctb2-pv-chip" key={ci}>{c}</span>)}</div>
                    )}
                    <div className="ctb2-pv-body">{row.prompt.trim() || 'Free-form clinical text…'}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Modal>
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

  if (enc?.codingEnabled === false) {
    return <div className="nt-doc-scroll cq-scroll"><div className="cq-empty" style={{ margin: 16 }}>The coding engine is turned off for this facility by your administrator.</div></div>;
  }

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
