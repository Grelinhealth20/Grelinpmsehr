import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { encountersApi, patientsApi, toApiError } from '../lib/api.js';
import { NOTE_TYPES, NOTE_MENU, NOTE_MENU_MORE, PROGRESS_REASONS, TEMPLATES } from '../lib/noteTemplates.js';

const today = () => new Date().toISOString().slice(0, 10);
// Display DOS in US format (MM/DD/YYYY); inputs keep the ISO value they require.
export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : (iso || '—'); };
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
      await loadNotes();
      skipSave.current = true;
      setAutoState('idle');
      setActive(data.note);
      setContent({ vitals: {}, sections: {}, prescriptions: [] });
      setReason('');
      setTab('note');
      onChanged?.();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  const signed = active?.status === 'signed';
  const setSection = (k, v) => setContent((c) => ({ ...c, sections: { ...c.sections, [k]: v } }));
  const setVital = (k, v) => setContent((c) => ({ ...c, vitals: { ...(c.vitals || {}), [k]: v } }));
  const setRxAt = (i, k, v) => setContent((c) => ({ ...c, prescriptions: c.prescriptions.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)) }));
  const addRx = () => setContent((c) => ({ ...c, prescriptions: [...c.prescriptions, blankRx()] }));
  const removeRx = (i) => setContent((c) => ({ ...c, prescriptions: c.prescriptions.filter((_, idx) => idx !== i) }));

  // Auto-save: debounced persistence of EVERY edit (vitals, sections, Rx, reason)
  // so nothing is ever lost. Skips signed (immutable) notes and the initial load.
  useEffect(() => {
    if (!active || active.status === 'signed') return undefined;
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
    if (active && active.status !== 'signed' && !skipSave.current) {
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
  const isProgress = active?.noteType === 'progress';

  return (
    <>
    {picking && <NoteTypePicker busy={busy} onPick={createNote} onClose={() => setPicking(false)} />}
    <Modal size="full" title={`Encounter · ${encounter.patientName || 'Patient'}`} onClose={closeWithSave} footer={<>
      <span className="nt-foot-meta">{encounter.encounterNo || ''} · DOS {usDate(encounter.date)}</span>
      {active && !signed && (
        <span className={`nt-autosave ${autoState}`}>
          {autoState === 'saving' ? 'Saving…' : autoState === 'saved' ? 'All changes saved' : 'Auto-saves as you type'}
        </span>
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
          <span className="nt2-info-item"><b>Encounter ID</b> {encounter.encounterNo || '—'}</span>
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
                  <article className="nt-doc-page">
                    <header className="nt-page-head">
                      {encounter.facilityName && <div className="nt-page-fac">{encounter.facilityName}</div>}
                      <div className="nt-page-title">{NOTE_TYPES[active.noteType]?.label}</div>
                      <div className="nt-page-meta">
                        <span><b>Patient:</b> {encounter.patientName || '—'}</span>
                        <span><b>MRN:</b> {encounter.mrn || '—'}</span>
                        <span><b>Encounter ID:</b> {encounter.encounterNo || '—'}</span>
                        <span><b>Date of Service:</b> {usDate(encounter.date)}</span>
                      </div>
                    </header>

                    {template.some((s) => s.key === 'vitals') && (!signed || VITALS.some((v) => content.vitals?.[v.k])) && (
                      <section className={`nt-sec ${signed ? '' : 'nt-vitals-sec'}`}>
                        <h4 className="nt-sec-h">Vital Signs</h4>
                        {signed ? (
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

                    {isProgress && (!signed || reason) && (
                      <section className="nt-sec">
                        <h4 className="nt-sec-h">Reason for Encounter</h4>
                        {signed
                          ? <div className="nt-sec-body"><p>{reason || '—'}</p></div>
                          : (
                            <select className="nt-sec-select" value={reason} onChange={(e) => setReason(e.target.value)}>
                              <option value="">Select reason…</option>
                              {PROGRESS_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                            </select>
                          )}
                      </section>
                    )}

                    {template.filter((s) => s.key !== 'vitals' && (!signed || (content.sections[s.key] || '').trim())).map((s) => (
                      <section className="nt-sec" key={s.key}>
                        <h4 className="nt-sec-h">{s.label}</h4>
                        {signed ? (
                          <div className="nt-sec-body">
                            {(content.sections[s.key] || '').trim()
                              ? (content.sections[s.key]).split('\n').map((ln, i) => <p key={i}>{ln || ' '}</p>)
                              : <p className="nt-sec-blank">—</p>}
                          </div>
                        ) : (
                          <AutoText rows={s.rows >= 4 ? 5 : 3} value={content.sections[s.key] || ''} placeholder={s.prompt} onChange={(v) => setSection(s.key, v)} />
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
                signed ? (
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
                          <Fld label="Medication" v={r.drug} on={(v) => setRxAt(i, 'drug', v)} d={signed} wide />
                          <Fld label="Dose" v={r.dose} on={(v) => setRxAt(i, 'dose', v)} d={signed} />
                          <Fld label="Route" v={r.route} on={(v) => setRxAt(i, 'route', v)} d={signed} />
                          <Fld label="Frequency" v={r.frequency} on={(v) => setRxAt(i, 'frequency', v)} d={signed} />
                          <Fld label="Quantity" v={r.quantity} on={(v) => setRxAt(i, 'quantity', v)} d={signed} />
                          <Fld label="Refills" v={r.refills} on={(v) => setRxAt(i, 'refills', v)} d={signed} />
                        </div>
                        <div className="nt-rx-sig">
                          <Fld label="Sig / directions" v={r.sig} on={(v) => setRxAt(i, 'sig', v)} d={signed} wide />
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

/** Pop-up: choose the note template to create (enterprise-grade card picker). */
function NoteTypePicker({ onPick, onClose, busy }) {
  const card = (k) => {
    const t = NOTE_TYPES[k];
    return (
      <button key={k} type="button" className="ntp-card" disabled={busy} onClick={() => onPick(k)}>
        <span className="ntp-card-head">
          <span className="ntp-card-cat">{t.category}</span>
          <span className="ntp-card-cpt">CPT {t.cpt}</span>
        </span>
        <span className="ntp-card-title">{t.label}</span>
        <span className="ntp-card-go">
          Start note
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
            <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
    );
  };
  return (
    <Modal title="Create a New Note" width={880} onClose={onClose} footer={<>
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

/** Large, clean, auto-growing writing area — document typography, generous size. */
function AutoText({ value, onChange, placeholder, rows = 3 }) {
  const ref = useRef(null);
  const minH = rows * 24 + 20;
  const resize = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.max(el.scrollHeight, minH)}px`; } };
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
