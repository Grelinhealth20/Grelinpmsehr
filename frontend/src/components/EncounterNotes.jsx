import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { encountersApi, patientsApi, toApiError } from '../lib/api.js';
import { NOTE_TYPES, NOTE_MENU, NOTE_MENU_MORE, TEMPLATES } from '../lib/noteTemplates.js';

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
  const [busy, setBusy] = useState(false);
  const [autoState, setAutoState] = useState('idle'); // idle | saving | saved
  const skipSave = useRef(true); // skip the save that a fresh load/open would trigger

  async function loadNotes() {
    setLoading(true);
    try { const { data } = await encountersApi.listNotes(encounter.encounterUuid); setNotes(data.notes || []); }
    catch (e) { toast.error(toApiError(e).message); } finally { setLoading(false); }
  }
  useEffect(() => { if (encounter?.encounterUuid) loadNotes(); /* eslint-disable-next-line */ }, [encounter?.encounterUuid]);

  async function openNote(uuid) {
    try {
      const { data } = await encountersApi.getNote(uuid);
      skipSave.current = true;
      setAutoState('idle');
      setActive(data.note);
      setContent({ vitals: data.note.content?.vitals || {}, sections: data.note.content?.sections || {}, prescriptions: data.note.content?.prescriptions || [] });
      setReason(data.note.reason || '');
      setTab('note');
    } catch (e) { toast.error(toApiError(e).message); }
  }

  async function createNote(noteType) {
    setPicking(false);
    setBusy(true);
    try {
      const { data } = await encountersApi.createNote(encounter.encounterUuid, { noteType, content: { vitals: {}, sections: {}, prescriptions: [] } });
      // Show the template immediately (single round-trip) — refresh the tab list
      // in the background so there's no perceived wait.
      skipSave.current = true;
      setAutoState('idle');
      setActive(data.note);
      setContent({ vitals: {}, sections: {}, prescriptions: [] });
      setReason('');
      setTab('note');
      loadNotes();
      onChanged?.();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  const signed = active?.status === 'signed';
  // Read-only unless the viewer OWNS the note. A facility-wide MD may open another
  // provider's note to review/sign, but only the author edits it (no silent
  // failed saves, no cross-provider edits).
  const readOnly = signed || active?.isOwner === false;
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

  const template = active ? (TEMPLATES[active.noteType] || []) : [];

  return (
    <>
    {picking && <NoteTypePicker busy={busy} onPick={createNote} onClose={() => setPicking(false)} />}
    <Modal size="full" title={`Encounter · ${encounter.patientName || 'Patient'}`} onClose={closeWithSave} footer={<>
      <span className="nt-foot-meta">Encounter {encNo(encounter.encounterNo)} · DOS {usDate(encounter.date)}</span>
      {active && !readOnly && (
        <span className={`nt-autosave ${autoState}`}>
          {autoState === 'saving' ? 'Saving…' : autoState === 'saved' ? 'All changes saved' : 'Auto-saves as you type'}
        </span>
      )}
      {active && !signed && active.isOwner === false && (
        <span className="clr-draft-flag" style={{ marginLeft: 12 }}>Read-only · another provider's note</span>
      )}
      <span className="spacer" />
      <button className="btn ghost" onClick={closeWithSave}>Close</button>
      {active && !signed && (
        <button className="btn" onClick={sign} disabled={busy || !canSign} title={canSign ? 'Sign & finalize for billing' : 'Only an MD can sign off'}>
          {busy ? <span className="spinner" /> : 'Sign & finalize'}
        </button>
      )}
    </>}>
      <div className="nt2">
        {/* Encounter identity band — Patient · MRN · Encounter ID · DOS */}
        <div className="nt2-info">
          <span className="nt2-info-nm">{encounter.patientName || 'Patient'}</span>
          <span className="nt2-info-item"><b>MRN</b> {encounter.mrn || '—'}</span>
          <span className="nt2-info-item"><b>Encounter ID</b> {encNo(encounter.encounterNo)}</span>
          <span className="nt2-info-item"><b>DOS</b> {usDate(encounter.date)}</span>
        </div>
        {/* Top toolbar: note tabs (horizontal) + New note (top-right) */}
        <div className="nt2-bar">
          <div className="nt2-tabs">
            {notes.map((n) => (
              <button key={n.uuid} type="button" className={`nt2-tab ${active?.uuid === n.uuid ? 'is-on' : ''}`} onClick={() => openNote(n.uuid)}>
                {NOTE_TYPES[n.noteType]?.label || n.noteType}
                <span className={`nt2-dot ${n.status === 'signed' ? 'signed' : 'draft'}`} title={n.status === 'signed' ? 'Signed' : 'Draft'} />
              </button>
            ))}
          </div>
          <button className="btn sm nt2-new" onClick={() => setPicking(true)}>+ New note</button>
        </div>

        <section className="nt-main">
          {!active ? (
            <div className="nt-placeholder">
              <div className="nt-ph-icon" aria-hidden="true" />
              <div>Click <strong>+ New note</strong> to create a clinical note.</div>
              <div className="nt-ph-sub">CMS-compliant SNF templates · MD sign-off required for billing</div>
            </div>
          ) : (
            <>
              <div className="nt-doc-head">
                <div>
                  <div className="nt-doc-title">{NOTE_TYPES[active.noteType]?.label}</div>
                  <div className="nt-doc-cat">{encounter.patientName} · MRN {encounter.mrn || '—'} · DOS {usDate(encounter.date)} · {NOTE_TYPES[active.noteType]?.category} · CPT {NOTE_TYPES[active.noteType]?.cpt}</div>
                </div>
                {signed
                  ? <span className="nt-signed"><span className="nt-signed-dot" />Signed by {active.signedByName || 'MD'} · Ready for billing</span>
                  : <span className="nt-draft-flag">Draft</span>}
              </div>

              <div className="nt-tabs">
                <button className={`nt-tab ${tab === 'note' ? 'is-on' : ''}`} onClick={() => setTab('note')}>Clinical Note</button>
                <button className={`nt-tab ${tab === 'rx' ? 'is-on' : ''}`} onClick={() => setTab('rx')}>Prescriptions{content.prescriptions.length ? ` (${content.prescriptions.length})` : ''}</button>
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
                readOnly ? (
                  <div className="nt-doc-scroll">
                    <article className="nt-doc-page">
                      <h4 className="nt-sec-h" style={{ marginBottom: 12 }}>Prescriptions</h4>
                      {content.prescriptions.filter((r) => r.drug).length === 0 ? (
                        <p className="nt-sec-blank">No prescriptions on this note.</p>
                      ) : (
                        <table className="nt-rx-table">
                          <thead><tr><th>Medication</th><th>Dose</th><th>Route</th><th>Frequency</th><th>Qty</th><th>Refills</th></tr></thead>
                          <tbody>
                            {content.prescriptions.filter((r) => r.drug).map((r, i) => (
                              <>
                                <tr key={i}>
                                  <td className="nt-rx-drug">{r.drug}</td><td>{r.dose || '—'}</td><td>{r.route || '—'}</td>
                                  <td>{r.frequency || '—'}</td><td>{r.quantity || '—'}</td><td>{r.refills || '—'}</td>
                                </tr>
                                {r.sig && <tr className="nt-rx-sigrow" key={`s${i}`}><td colSpan={6}>Sig: {r.sig}</td></tr>}
                              </>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </article>
                  </div>
                ) : (
                  <div className="nt-rx">
                    <div className="nt-rx-head">
                      <span>Prescriptions</span>
                      <button className="btn ghost sm" onClick={addRx}>+ Add medication</button>
                    </div>
                    {content.prescriptions.length === 0 && <div className="nt-empty" style={{ padding: '14px 0' }}>No prescriptions. Add a medication to prescribe.</div>}
                    {content.prescriptions.map((r, i) => (
                      <div className="nt-rx-item" key={i}>
                        <div className="nt-rx-grid">
                          <Fld label="Medication" v={r.drug} on={(v) => setRxAt(i, 'drug', v)} d={readOnly} wide />
                          <Fld label="Dose" v={r.dose} on={(v) => setRxAt(i, 'dose', v)} d={readOnly} />
                          <Fld label="Route" v={r.route} on={(v) => setRxAt(i, 'route', v)} d={readOnly} />
                          <Fld label="Frequency" v={r.frequency} on={(v) => setRxAt(i, 'frequency', v)} d={readOnly} />
                          <Fld label="Quantity" v={r.quantity} on={(v) => setRxAt(i, 'quantity', v)} d={readOnly} />
                          <Fld label="Refills" v={r.refills} on={(v) => setRxAt(i, 'refills', v)} d={readOnly} />
                        </div>
                        <div className="nt-rx-sig">
                          <Fld label="Sig / directions" v={r.sig} on={(v) => setRxAt(i, 'sig', v)} d={readOnly} wide />
                          <button className="act danger" onClick={() => removeRx(i)}>Remove</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
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

/** Pop-up: choose the note template to create (enterprise-grade template gallery). */
function NoteTypePicker({ onPick, onClose, busy }) {
  const card = (k) => {
    const t = NOTE_TYPES[k];
    return (
      <button key={k} type="button" className="ntp-card" disabled={busy} onClick={() => onPick(k)}>
        <span className="ntp-card-top">
          <span className="ntp-card-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <path d="M6 3h7l5 5v12.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-17a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M13 3v5h5M8.5 12.5h7M8.5 16h4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <span className="ntp-card-cpt">CPT {t.cpt}</span>
        </span>
        <span className="ntp-card-title">{t.label}</span>
        <span className="ntp-card-cat">{t.category}</span>
        <span className="ntp-card-arrow" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none">
            <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
    );
  };
  return (
    <Modal title="Create a New Note" width={900} onClose={onClose} footer={<>
      <span className="ntp-foot">CMS-compliant SNF templates · MD sign-off required for billing</span>
      <span className="spacer" />
      <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
    </>}>
      <div className="ntp">
        <p className="ntp-intro">Select a template to begin. Every note is patient- and encounter-specific and requires MD sign-off before it is billable.</p>
        <div className="ntp-sec">
          <div className="ntp-group"><span>Common</span><i /></div>
          <div className="ntp-grid">{NOTE_MENU.map(card)}</div>
        </div>
        <div className="ntp-sec">
          <div className="ntp-group"><span>More templates</span><i /></div>
          <div className="ntp-grid">{NOTE_MENU_MORE.map(card)}</div>
        </div>
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
