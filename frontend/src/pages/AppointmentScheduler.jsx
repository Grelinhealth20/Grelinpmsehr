import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../components/Modal.jsx';
import PatientModal from '../components/PatientModal.jsx';
import AppointmentEligibilityModal from '../components/AppointmentEligibilityModal.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { appointmentsApi, patientsApi, providersApi, encountersApi, toApiError } from '../lib/api.js';
import { specialtyProcedures } from '../lib/procedureCatalog.js';

const ELIG_TAG = { active: 'Active', inactive: 'Inactive', pending: 'Pending', error: 'Recheck' };

const providerLabel = (p) => `${p.fullName}${p.credentials?.length ? `, ${p.credentials.join(', ')}` : ''}${p.specialty ? ` · ${p.specialty.name}` : ''}`;

const patientName = (p) => `${p?.demographics?.firstName || ''} ${p?.demographics?.lastName || ''}`.trim() || '(unnamed)';

/* --- Schedule geometry ----------------------------------------------------- */
const DAY_START = 7 * 60; // 07:00
const DAY_END = 19 * 60; // 19:00
const STEP = 30; // minutes per row
const SLOT_H = 62; // px per row (roomier, enterprise)
const SLOTS = (DAY_END - DAY_START) / STEP; // 24 rows
const BODY_H = SLOTS * SLOT_H;
const COL_W = 172;

const TYPES = [
  { key: 'consult', label: 'Consultation' },
  { key: 'followup', label: 'Follow-up' },
  { key: 'procedure', label: 'Procedure' },
];
const STATUSES = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'checked_in', label: 'Checked In' },
  { key: 'checked_out', label: 'Checked Out' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));
const DURATIONS = [15, 30, 45, 60, 90, 120];

/* --- Date/time helpers ----------------------------------------------------- */
const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function startOfWeek(date) {
  const d = new Date(date);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d;
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function fmtTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${pad(m)} ${ampm}`;
}
const clampStart = (start, dur) => Math.min(Math.max(start, DAY_START), DAY_END - dur);
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Greedy lane assignment so overlapping appointments render side by side. */
function withLanes(dayAppts) {
  const sorted = [...dayAppts].sort((a, b) => a.startMin - b.startMin || a.durationMin - b.durationMin);
  const laneEnds = [];
  const placed = sorted.map((a) => {
    let lane = laneEnds.findIndex((end) => end <= a.startMin);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(a.startMin + a.durationMin); }
    else laneEnds[lane] = a.startMin + a.durationMin;
    return { ...a, lane };
  });
  const laneCount = Math.max(1, laneEnds.length);
  return placed.map((p) => ({ ...p, laneCount }));
}

export default function AppointmentScheduler() {
  const toast = useToast();
  const { user } = useAuth();
  // Front-desk billing users MUST assign a rendering provider (within their facility).
  const isBilling = user?.role === 'billing';
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [appts, setAppts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [delModal, setDelModal] = useState(null); // { uuid, title } — delete-reason prompt
  const [delReason, setDelReason] = useState('');
  const [busy, setBusy] = useState(false); // guards actions so each runs only once
  const [drag, setDrag] = useState(null); // live drag ghost { appt, x, y, w }
  const dragRef = useRef(null); // { appt, offsetY, startX, startY, moved }
  const [patResults, setPatResults] = useState([]); // server-side patient search results
  const [patLoading, setPatLoading] = useState(false);
  const [patientOpen, setPatientOpen] = useState(false);
  const [patientModal, setPatientModal] = useState(null); // { uuid? } — face sheet popup
  const [eligModal, setEligModal] = useState(null); // { uuid, title } — eligibility benefits popup
  const [providers, setProviders] = useState([]); // active providers (from DB)
  const [provOpen, setProvOpen] = useState(false);
  const [provQuery, setProvQuery] = useState('');
  const [procOpen, setProcOpen] = useState(false);

  const refreshPatients = useCallback(() => { setPatResults([]); }, []);

  useEffect(() => {
    let active = true;
    // Facility-scoped rendering providers the caller may schedule (front-desk/MD → their
    // facility's providers; a provider → their facility colleagues). No fallback list.
    providersApi.schedulable().then(({ data }) => active && setProviders(data.providers || [])).catch(() => {});
    return () => { active = false; };
  }, []);

  // Debounced, server-side patient search — scoped + paginated, so it scales to
  // 100k+ patients without ever loading the full list into the browser.
  useEffect(() => {
    if (!patientOpen) return undefined;
    const q = (modal?.form?.patient || '').trim();
    setPatLoading(true);
    const t = setTimeout(async () => {
      try { const { data } = await encountersApi.listPatients({ q, pageSize: 8 }); setPatResults(data.patients || []); }
      catch { setPatResults([]); } finally { setPatLoading(false); }
    }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal?.form?.patient, patientOpen]);

  const now = new Date();
  const todayKey = toKey(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const weekEnd = days[6];
  const rangeLabel =
    weekStart.getMonth() === weekEnd.getMonth()
      ? `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} – ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
      : `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;

  const timeOptions = useMemo(() => {
    const out = [];
    for (let m = DAY_START; m <= DAY_END - 15; m += 15) out.push(m);
    return out;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await appointmentsApi.list(toKey(days[0]), toKey(days[6]));
      setAppts(data.appointments);
    } catch (e) {
      toast.error(toApiError(e).message);
    } finally {
      setLoading(false);
    }
  }, [days, toast]);

  useEffect(() => { load(); }, [load]);

  /* --- Create / edit modal ------------------------------------------------- */
  function openNew(dateKey, startMin) {
    setPatientOpen(false);
    setModal({ mode: 'new', form: { title: '', patient: '', patientUuid: '', renderingProviderUuid: '', type: 'consult', procedureCode: '', dateKey, startMin: clampStart(startMin, 30), durationMin: 30, status: 'scheduled' } });
  }
  function openEdit(a) {
    setPatientOpen(false);
    setModal({ mode: 'edit', uuid: a.uuid, form: { title: a.title, patient: a.patient || '', patientUuid: a.patientUuid || '', renderingProviderUuid: a.renderingProviderUuid || '', type: a.type, procedureCode: a.procedureCode || '', dateKey: a.date, startMin: a.startMin, durationMin: a.durationMin, status: a.status } });
  }
  function onColClick(e, dateKey) {
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = Math.floor((e.clientY - rect.top) / SLOT_H);
    openNew(dateKey, DAY_START + Math.max(0, Math.min(SLOTS - 1, slot)) * STEP);
  }
  function newFromToolbar() {
    const inWeek = days.some((d) => toKey(d) === todayKey);
    const dateKey = inWeek ? todayKey : toKey(days[0]);
    openNew(dateKey, inWeek ? Math.ceil(nowMin / STEP) * STEP : DAY_START + 120);
  }
  const setF = (patch) => setModal((c) => ({ ...c, form: { ...c.form, ...patch } }));

  // Refresh once shortly after a booking so the background eligibility tag appears.
  const refreshForTag = () => { window.setTimeout(() => load(), 3500); };

  async function saveForm() {
    const f = modal.form;
    if (!f.title.trim() || busy) return;          // guard: only once
    setBusy(true);
    const payload = {
      title: f.title.trim(),
      patient: f.patient.trim() || undefined,
      patientUuid: f.patientUuid || undefined,
      renderingProviderUuid: f.renderingProviderUuid || undefined,
      type: f.type,
      procedureCode: (f.procedureCode || '').trim(),
      date: f.dateKey,
      startMin: clampStart(f.startMin, f.durationMin),
      durationMin: f.durationMin,
    };
    const wasEdit = modal.mode === 'edit';
    const hadPatient = !!f.patientUuid;
    try {
      if (wasEdit) await appointmentsApi.update(modal.uuid, { ...payload, status: f.status });
      else await appointmentsApi.create(payload);
      setModal(null);                              // close immediately
      load();
      if (hadPatient) refreshForTag();             // eligibility runs in the background
      toast.success(wasEdit ? 'Appointment updated.' : 'Appointment booked.');
    } catch (e) {
      toast.error(toApiError(e).message);          // e.g. "That time slot is already booked"
    } finally { setBusy(false); }
  }
  async function deleteForm(reason) {
    if (busy || !delModal) return;
    if (!reason || reason.trim().length < 2) { toast.error('Please record a reason for deletion.'); return; }
    setBusy(true);
    try {
      await appointmentsApi.remove(delModal.uuid, reason.trim());
      setDelModal(null); setModal(null); load();
      toast.success('Appointment deleted.');
    } catch (e) { toast.error(toApiError(e).message); }
    finally { setBusy(false); }
  }
  // Front-desk check-in / check-out — persists the status immediately.
  async function checkAppt(status) {
    if (busy) return;
    setBusy(true);
    try {
      await appointmentsApi.setStatus(modal.uuid, status);
      setModal(null); load();
      toast.success(status === 'checked_in' ? 'Patient checked in.' : 'Patient checked out.');
    } catch (e) { toast.error(toApiError(e).message); }
    finally { setBusy(false); }
  }

  /* --- Drag to reschedule -------------------------------------------------- */
  const onApptPointerDown = (e, a) => {
    if (e.button !== 0 || a.status === 'cancelled') return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = { appt: a, offsetY: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, w: rect.width, moved: false };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    d.moved = true;
    setDrag({ appt: d.appt, x: e.clientX, y: e.clientY - d.offsetY, w: d.w });
  };
  const onPointerUp = async (e) => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (!d.moved) { openEdit(d.appt); return; } // was a click

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const col = el?.closest?.('.sch-col');
    if (!col) return;
    const dateKey = col.getAttribute('data-datekey');
    const rect = col.getBoundingClientRect();
    const slot = Math.round((e.clientY - d.offsetY - rect.top) / SLOT_H);
    const startMin = clampStart(DAY_START + slot * STEP, d.appt.durationMin);
    if (dateKey === d.appt.date && startMin === d.appt.startMin) return; // no change

    // optimistic
    setAppts((list) => list.map((a) => (a.uuid === d.appt.uuid ? { ...a, date: dateKey, startMin } : a)));
    try {
      await appointmentsApi.reschedule(d.appt.uuid, { date: dateKey, startMin, durationMin: d.appt.durationMin });
      toast.success('Appointment rescheduled.');
    } catch (err) {
      toast.error(toApiError(err).message);
      load(); // reconcile on failure
    }
  };

  // Real-time specialty-focused procedures for the picker — from the selected
  // rendering provider's specialty (else the current user's).
  const selProvider = modal ? providers.find((p) => p.uuid === modal.form.renderingProviderUuid) : null;
  const procCat = specialtyProcedures(selProvider?.specialty?.name || user?.specialty?.name || '');

  return (
    <div className="sch">
      <div className="sch-bar">
        <div className="sch-nav">
          <button className="sch-navbtn" title="Previous week" onClick={() => setWeekStart((w) => addDays(w, -7))} aria-label="Previous week"><span className="sch-arw left" /></button>
          <button className="sch-today" onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</button>
          <button className="sch-navbtn" title="Next week" onClick={() => setWeekStart((w) => addDays(w, 7))} aria-label="Next week"><span className="sch-arw right" /></button>
        </div>
        <div className="sch-title">
          <span className="sch-title-main">{rangeLabel}</span>
          <span className="sch-title-sub">Appointment Schedule{loading ? ' · syncing…' : ''}</span>
        </div>
        <button className="btn sm sch-new" onClick={newFromToolbar}>+ New appointment</button>
      </div>

      <div className="sch-cal">
        <div className="sch-head" style={{ minWidth: 66 + 7 * COL_W }}>
          <div className="sch-head-gutter" />
          {days.map((d) => (
            <div key={toKey(d)} className={`sch-head-day ${toKey(d) === todayKey ? 'today' : ''}`}>
              <span className="dow">{WEEKDAYS[(d.getDay() + 6) % 7]}</span>
              <span className="dnum">{d.getDate()}</span>
            </div>
          ))}
        </div>

        <div className="sch-body" style={{ minWidth: 66 + 7 * COL_W, height: BODY_H }}>
          <div className="sch-gutter">
            {Array.from({ length: SLOTS / 2 }, (_, i) => (
              <div key={i} className="sch-hour" style={{ top: i * 2 * SLOT_H }}>{fmtTime(DAY_START + i * 60)}</div>
            ))}
          </div>

          {days.map((d) => {
            const key = toKey(d);
            const isToday = key === todayKey;
            const laid = withLanes(appts.filter((a) => a.date === key));
            return (
              <div key={key} className={`sch-col ${isToday ? 'today' : ''}`} data-datekey={key} onClick={(e) => onColClick(e, key)}>
                {laid.map((a) => {
                  const top = ((a.startMin - DAY_START) / STEP) * SLOT_H + 2;
                  const height = Math.max((a.durationMin / STEP) * SLOT_H - 4, 22);
                  const w = 100 / a.laneCount;
                  return (
                    <button
                      key={a.uuid}
                      className={`sch-appt type-${a.type} ${a.status !== 'scheduled' ? `is-${a.status}` : ''} ${drag?.appt?.uuid === a.uuid ? 'is-dragging' : ''}`}
                      style={{ top, height, left: `calc(${a.lane * w}% + 3px)`, width: `calc(${w}% - 6px)` }}
                      onPointerDown={(e) => onApptPointerDown(e, a)}
                      onClick={(e) => e.stopPropagation()}
                      title={`${a.title} · ${fmtTime(a.startMin)}–${fmtTime(a.startMin + a.durationMin)}`}
                    >
                      <span className="sch-appt-t">{a.title}</span>
                      <span className="sch-appt-time">{fmtTime(a.startMin)} – {fmtTime(a.startMin + a.durationMin)}</span>
                      {a.patient && (
                        <span className="sch-appt-pt" title={`Patient: ${a.patient}`}>
                          <svg className="sch-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20a7 7 0 0 1 14 0" /></svg>
                          {a.patient}
                        </span>
                      )}
                      {a.renderingProvider && (
                        <span className="sch-appt-pr" title={`Rendering provider: ${a.renderingProvider}`}>
                          <svg className="sch-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v5a4 4 0 0 0 8 0V3M10 12.5V15a4 4 0 0 0 8 0v-.5M18 11.5a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z" /></svg>
                          {a.renderingProvider}
                        </span>
                      )}
                      <span className="sch-appt-foot">
                        {a.eligibilityStatus && (
                          <span
                            className={`sch-elig ${a.eligibilityStatus}`}
                            role="button"
                            title="View eligibility & benefits"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); setEligModal({ uuid: a.uuid, title: a.title }); }}
                          >
                            <span className="dot" />{ELIG_TAG[a.eligibilityStatus] || a.eligibilityStatus}
                          </span>
                        )}
                        {a.status === 'cancelled' && <span className="sch-appt-flag">Cancelled</span>}
                        {a.status === 'completed' && <span className="sch-appt-flag ok">Completed</span>}
                        {a.status === 'checked_in' && <span className="sch-appt-flag in">Checked In</span>}
                        {a.status === 'checked_out' && <span className="sch-appt-flag out">Checked Out</span>}
                      </span>
                    </button>
                  );
                })}
                {isToday && nowMin >= DAY_START && nowMin <= DAY_END && (
                  <div className="sch-now" style={{ top: ((nowMin - DAY_START) / STEP) * SLOT_H }}><span className="sch-now-dot" /></div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {drag && (
        <div className={`sch-ghost type-${drag.appt.type}`} style={{ left: drag.x - 6, top: drag.y, width: drag.w }}>
          <span className="sch-appt-t">{drag.appt.title}</span>
          <span className="sch-appt-time">{fmtTime(drag.appt.startMin)} – {fmtTime(drag.appt.startMin + drag.appt.durationMin)}</span>
        </div>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'edit' ? 'Edit appointment' : 'New appointment'}
          width={760}
          onClose={() => setModal(null)}
          footer={
            <>
              {modal.mode === 'edit' && <button className="btn danger" onClick={() => { setDelReason(''); setDelModal({ uuid: modal.uuid, title: modal.form.title }); }} disabled={busy} style={{ marginRight: 'auto' }}>Delete</button>}
              {modal.mode === 'edit' && !['cancelled', 'completed', 'checked_out'].includes(modal.form.status) && (
                modal.form.status === 'checked_in'
                  ? <button className="btn ghost" onClick={() => checkAppt('checked_out')} disabled={busy} title="Check out — patient has left">Check out</button>
                  : <button className="btn ghost" onClick={() => checkAppt('checked_in')} disabled={busy} title="Check in — patient has arrived">Check in</button>
              )}
              {modal.mode === 'edit' && modal.form.patientUuid && (
                <button className="btn ghost" onClick={() => setEligModal({ uuid: modal.uuid, title: modal.form.title })} title="Real-time eligibility & benefits">Eligibility</button>
              )}
              <button className="btn ghost" onClick={() => setModal(null)} disabled={busy}>Cancel</button>
              <button className="btn" onClick={saveForm} disabled={busy || !modal.form.title.trim() || (isBilling && !modal.form.renderingProviderUuid)}>
                {busy ? (modal.mode === 'edit' ? 'Saving…' : 'Booking…') : (modal.mode === 'edit' ? 'Save changes' : 'Book appointment')}
              </button>
            </>
          }
        >
          <form className="appt-form" onSubmit={(e) => { e.preventDefault(); if (modal.form.title.trim()) saveForm(); }}>
            <div className="appt-cols">
            <div className="appt-col">
            <div className="field">
              <label>Title</label>
              <input className="input" value={modal.form.title} autoFocus placeholder="e.g. New patient consult" onChange={(e) => setF({ title: e.target.value })} />
            </div>
            <div className="field">
              <label>Patient <span className="muted">(search existing or type a name)</span></label>
              <div className="sch-pt">
                <input
                  className="input"
                  value={modal.form.patient}
                  placeholder="Search by name or MRN…"
                  autoComplete="off"
                  onChange={(e) => { setF({ patient: e.target.value, patientUuid: '' }); setPatientOpen(true); }}
                  onFocus={() => setPatientOpen(true)}
                  onBlur={() => setTimeout(() => setPatientOpen(false), 150)}
                />
                {modal.form.patientUuid && <span className="sch-pt-linked" title="Linked to a patient record">● Linked</span>}
                {patientOpen && (
                  <div className="sch-pt-list">
                    {patLoading ? (
                      <div className="sch-pt-note"><span className="spinner dark" /> Searching…</div>
                    ) : patResults.length === 0 ? (
                      <div className="sch-pt-note">{(modal.form.patient || '').trim() ? 'No matching patients. Try the full name or the MRN.' : 'Type a name or MRN to search.'}</div>
                    ) : patResults.map((p) => (
                      <button
                        type="button"
                        key={p.patientUuid}
                        className="sch-pt-item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setF({ patient: p.patientName || '', patientUuid: p.patientUuid }); setPatResults([]); setPatientOpen(false); }}
                      >
                        <span className="sch-pt-nm">{p.patientName || '—'}{p.facilityName ? <span className="sch-pt-fac"> · {p.facilityName}</span> : ''}</span>
                        <span className="sch-pt-mrn">{p.mrn}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="sch-pt-actions">
                <button type="button" className="btn ghost sm" onClick={() => setPatientModal({})}>+ New patient</button>
                {modal.form.patientUuid && (
                  <button type="button" className="btn ghost sm" onClick={() => setPatientModal({ uuid: modal.form.patientUuid })}>Face sheet &amp; documents</button>
                )}
              </div>
            </div>
            <div className="field">
              <label>Rendering provider{isBilling && <span className="fs-req">*</span>}</label>
              <div className="sch-pt">
                <input
                  className="input"
                  value={provOpen ? provQuery : (selProvider ? providerLabel(selProvider) : '')}
                  placeholder="Search provider by name or specialty…"
                  autoComplete="off"
                  onChange={(e) => { setProvQuery(e.target.value); setF({ renderingProviderUuid: '' }); setProvOpen(true); }}
                  onFocus={() => { setProvQuery(selProvider ? providerLabel(selProvider) : ''); setProvOpen(true); }}
                  onBlur={() => setTimeout(() => setProvOpen(false), 150)}
                />
                {provOpen && (() => {
                  const pq = provQuery.trim().toLowerCase();
                  const matches = (pq ? providers.filter((p) => providerLabel(p).toLowerCase().includes(pq)) : providers).slice(0, 20);
                  return (
                    <div className="sch-pt-list">
                      {matches.length === 0
                        ? <div className="sch-pt-note">{providers.length ? 'No providers match.' : 'No providers assigned to your facility.'}</div>
                        : matches.map((p) => (
                          <button type="button" key={p.uuid} className="sch-pt-item" onMouseDown={(e) => e.preventDefault()}
                            onClick={() => { setF({ renderingProviderUuid: p.uuid }); setProvOpen(false); }}>
                            <span className="sch-pt-nm">{providerLabel(p)}</span>
                          </button>
                        ))}
                    </div>
                  );
                })()}
              </div>
              {providers.length === 0
                ? <span className="hint">No providers are assigned to your facility yet — assign providers to a facility in the Admin panel.</span>
                : isBilling && <span className="hint">Select the provider whose schedule this appointment belongs to.</span>}
            </div>
            </div>

            <div className="appt-col">
            <div className="field">
              <label>Type</label>
              <div className="seg-ctrl">
                {TYPES.map((t) => (
                  <button key={t.key} type="button" className={`seg-opt ${modal.form.type === t.key ? 'active' : ''}`} onClick={() => setF({ type: t.key })}>{t.label}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Procedure <span className="muted">(CPT/HCPCS — what the appointment is for; drives eligibility)</span></label>
              <div className="sch-pt">
                <input
                  className="input" value={modal.form.procedureCode} autoComplete="off"
                  placeholder={procCat.procedures[0] ? `e.g. ${procCat.procedures[0].code} — ${procCat.procedures[0].desc}` : 'e.g. 99309'}
                  onChange={(e) => { setF({ procedureCode: e.target.value }); setProcOpen(true); }}
                  onFocus={() => setProcOpen(true)}
                  onBlur={() => setTimeout(() => setProcOpen(false), 150)}
                />
                {procOpen && (() => {
                  const pq = (modal.form.procedureCode || '').trim().toLowerCase();
                  const matches = (pq
                    ? procCat.procedures.filter((p) => p.code.toLowerCase().includes(pq) || p.desc.toLowerCase().includes(pq))
                    : procCat.procedures
                  ).slice(0, 12);
                  if (!matches.length) return null;
                  return (
                    <div className="sch-pt-list">
                      {matches.map((p) => (
                        <button type="button" key={p.code} className="sch-pt-item sch-cpt-item" onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setF({ procedureCode: p.code }); setProcOpen(false); }}>
                          <span className="sch-cpt-code">{p.code}</span>
                          <span className="sch-cpt-desc">{p.desc}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <span className="hint">
                {procCat.matched
                  ? `Showing ${procCat.label} procedures`
                  : 'General SNF Part B — select a rendering provider for specialty-specific codes'}
              </span>
            </div>
            <div className="grid-2">
              <div className="field">
                <label>Date</label>
                <input className="input" type="date" value={modal.form.dateKey} onChange={(e) => e.target.value && setF({ dateKey: e.target.value })} />
              </div>
              <div className="field">
                <label>Start time</label>
                <select className="select" value={modal.form.startMin} onChange={(e) => setF({ startMin: Number(e.target.value) })}>
                  {timeOptions.map((m) => <option key={m} value={m}>{fmtTime(m)}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Duration</label>
              <div className="seg-ctrl">
                {DURATIONS.map((dm) => (
                  <button key={dm} type="button" className={`seg-opt ${modal.form.durationMin === dm ? 'active' : ''}`} onClick={() => setF({ durationMin: dm })}>{dm}m</button>
                ))}
              </div>
            </div>
            </div>
            </div>
            {modal.mode === 'edit' && (
              <div className="field appt-status">
                <label>Status</label>
                <div className="seg-ctrl">
                  {STATUSES.map((s) => (
                    <button key={s.key} type="button" className={`seg-opt ${modal.form.status === s.key ? 'active' : ''}`} onClick={() => setF({ status: s.key })}>{s.label}</button>
                  ))}
                </div>
              </div>
            )}
          </form>
        </Modal>
      )}

      {patientModal && (
        <PatientModal
          uuid={patientModal.uuid || null}
          onClose={() => setPatientModal(null)}
          onSaved={(p) => {
            refreshPatients();
            setModal((c) => (c ? { ...c, form: { ...c.form, patient: patientName(p), patientUuid: p.uuid } } : c));
          }}
        />
      )}

      {eligModal && (
        <AppointmentEligibilityModal
          appointment={eligModal}
          onClose={() => setEligModal(null)}
          onChanged={load}
        />
      )}

      {delModal && (
        <Modal
          title="Delete appointment"
          width={460}
          onClose={() => setDelModal(null)}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setDelModal(null)} disabled={busy}>Cancel</button>
              <button className="btn danger" onClick={() => deleteForm(delReason)} disabled={busy || delReason.trim().length < 2}>
                {busy ? 'Deleting…' : 'Delete appointment'}
              </button>
            </>
          )}
        >
          <div className="stack" style={{ gap: 12 }}>
            <p className="muted" style={{ margin: 0 }}>
              Deleting <strong>{delModal.title || 'this appointment'}</strong> is permanent and removes its eligibility record. Please record a reason — it is saved to the audit log.
            </p>
            <div className="field">
              <label>Reason for deletion <span className="fs-req">*</span></label>
              <textarea
                className="input" rows={3} value={delReason} autoFocus
                placeholder="e.g. Duplicate booking · patient cancelled · entered in error"
                onChange={(e) => setDelReason(e.target.value)}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
