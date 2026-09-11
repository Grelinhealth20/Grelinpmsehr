import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../components/Modal.jsx';
import { useToast } from '../components/Toast.jsx';
import { referralsApi, encountersApi, terminologyApi, toApiError } from '../lib/api.js';

const PER_PAGE = 10; // 10 records per page (server-side paginated; scales to 100k+ referrals)
const PRIORITY_LABEL = { routine: 'Routine', urgent: 'Urgent', stat: 'STAT' };
const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', received: 'Received', accepted: 'Accepted', scheduled: 'Scheduled', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled' };
// Direction-appropriate status filters. Outgoing referrals move draft→sent→accepted→scheduled→completed
// (or declined/cancelled); INCOMING referrals arrive as 'received' and never carry draft/sent. Each tab
// shows only the statuses that can actually occur for that direction — no meaningless filters.
const OUTGOING_STATUSES = ['draft', 'sent', 'accepted', 'scheduled', 'completed', 'declined', 'cancelled'];
const INCOMING_STATUSES = ['received', 'accepted', 'scheduled', 'completed', 'declined', 'cancelled'];
const statusesFor = (dir) => (dir === 'incoming' ? INCOMING_STATUSES : OUTGOING_STATUSES);
const usDate = (s) => (s ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : '—');

export default function Referrals() {
  const toast = useToast();
  const [direction, setDirection] = useState('outgoing');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ outgoing: { total: 0 }, incoming: { total: 0 } });
  const [options, setOptions] = useState({ specialties: [] });
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null); // referral uuid open in the drawer
  const [refreshing, setRefreshing] = useState(false);
  const firstLoad = useRef(true);
  const inflight = useRef(false); // guards overlapping background refreshes (no pile-up, no lag)

  useEffect(() => { referralsApi.options().then(({ data }) => setOptions(data)).catch(() => {}); }, []);

  async function loadStats() { try { const { data } = await referralsApi.stats(); setStats(data); } catch { /* non-fatal */ } }
  useEffect(() => { loadStats(); }, []);

  // `silent` refreshes update the table IN PLACE (no spinner flash) so background/auto refreshes feel seamless.
  async function load(p = page, dir = direction, st = status, q = search, silent = false) {
    if (inflight.current && silent) return; // don't stack background reloads
    inflight.current = true;
    if (!silent) setLoading(true);
    try {
      const { data } = await referralsApi.list({ direction: dir, status: st, q: q.trim(), page: p, pageSize: PER_PAGE });
      setRows(data.referrals || []); setTotal(data.total || 0); setPage(data.page || p);
    } catch (e) { if (!silent) toast.error(toApiError(e).message); } finally { if (!silent) setLoading(false); inflight.current = false; }
  }

  useEffect(() => {
    const delay = firstLoad.current ? 0 : 280; firstLoad.current = false;
    const t = setTimeout(() => { load(1, direction, status, search); }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, status, search]);

  // AUTOMATIC refresh — every 20s, quietly re-read the current view + counts (cheap DB read reflecting what
  // the server reconciler/webhook already fetched). Paused while a tab is hidden or a modal is open, so it
  // never interrupts editing and never lags the UI. Manual Refresh (below) additionally forces a live pull.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden || creating || detail) return;
      load(page, direction, status, search, true);
      loadStats();
    }, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, direction, status, search, creating, detail]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const dirStats = stats[direction] || { total: 0 };
  const refreshAll = () => { load(page, direction, status, search, true); loadStats(); };
  // Manual Refresh: on Incoming, force a LIVE fetch of received faxes from Fax.Plus, then re-read; on
  // Outgoing, re-read (status updates). In-place (silent) so the table doesn't flash.
  async function manualRefresh() {
    setRefreshing(true);
    try {
      if (direction === 'incoming') { try { await referralsApi.refreshInbox(); } catch { /* non-fatal — DB read still refreshes */ } }
      await load(page, direction, status, search, true);
      await loadStats();
    } finally { setRefreshing(false); }
  }
  // A new referral is always OUTGOING — land the user on the Outgoing tab so they see it immediately.
  const onCreated = () => { setCreating(false); setStatus(''); setSearch(''); setDirection('outgoing'); load(1, 'outgoing', '', ''); loadStats(); };

  return (
    <div className="ref">
      <div className="ref-bar">
        <div className="ref-title">
          <span className="ref-title-main">Referral Management</span>
          <span className="ref-title-sub">{loading ? 'Loading…' : `${total.toLocaleString()} ${direction} referral${total === 1 ? '' : 's'}`}</span>
        </div>
        <span className="spacer" />
        <input className="input ref-search" placeholder="Search patient, specialty, referral #…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn ghost sm" onClick={manualRefresh} disabled={refreshing} title={direction === 'incoming' ? 'Fetch received faxes now' : 'Refresh'}>
          {refreshing ? <span className="spinner dark" /> : '↻ Refresh'}
        </button>
        <button className="btn accent sm" onClick={() => setCreating(true)}>+ New Referral</button>
      </div>

      {/* Direction — the primary split: what we send out vs. what comes in */}
      <div className="ref-seg" role="tablist" aria-label="Referral direction">
        {['outgoing', 'incoming'].map((d) => (
          <button key={d} role="tab" aria-selected={direction === d} className={`ref-seg-btn ${direction === d ? 'is-on' : ''}`}
            onClick={() => { setDirection(d); setStatus(''); }}>
            <span className={`ref-seg-ic ${d}`} aria-hidden="true" />
            {d === 'outgoing' ? 'Outgoing' : 'Incoming'}
            <span className="ref-seg-n">{(stats[d] || {}).total || 0}</span>
          </button>
        ))}
      </div>

      {/* Status filter — direction-appropriate chips only (incoming ≠ outgoing lifecycle) */}
      <div className="ref-chips">
        <button className={`ref-chip ${status === '' ? 'is-on' : ''}`} onClick={() => setStatus('')}>All <span className="ref-chip-n">{dirStats.total || 0}</span></button>
        {statusesFor(direction).map((s) => (
          <button key={s} className={`ref-chip ${status === s ? 'is-on' : ''}`} onClick={() => setStatus(s === status ? '' : s)}>
            {STATUS_LABEL[s]} <span className="ref-chip-n">{dirStats[s] || 0}</span>
          </button>
        ))}
      </div>

      <div className="ref-table-wrap">
        <table className="ref-table">
          <thead>
            <tr>
              <th>Referral #</th>
              <th>Date</th>
              <th>Patient</th>
              <th>Specialty / Service</th>
              <th>{direction === 'outgoing' ? 'Referred To' : 'Referred From'}</th>
              <th>Priority</th>
              <th>Status</th>
              <th className="ta-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="ref-empty"><span className="spinner dark" /> Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="ref-empty">{search || status ? 'No referrals match your filters.' : `No ${direction} referrals yet. Create one to begin.`}</td></tr>
            ) : rows.map((r) => (
              <tr key={r.uuid} className="ref-row" onClick={() => setDetail(r.uuid)}>
                <td className="ref-no">{r.referralNo}</td>
                <td>{usDate(r.referralDate)}</td>
                <td className="ref-pt">
                  <span className="ref-pt-name">{r.patient?.name || '—'}</span>
                  {r.patient?.mrn && <span className="ref-pt-mrn">{r.patient.mrn}</span>}
                </td>
                <td>{r.specialty}</td>
                <td>{r.counterpartyName || r.counterpartyOrg || '—'}{r.counterpartyName && r.counterpartyOrg ? <span className="ref-sub"> · {r.counterpartyOrg}</span> : null}</td>
                <td><span className={`ref-prio ${r.priority}`}>{PRIORITY_LABEL[r.priority]}</span></td>
                <td><span className={`ref-status ${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                <td className="ta-right"><button className="act" onClick={(e) => { e.stopPropagation(); setDetail(r.uuid); }}>View</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && total > 0 && (
        <Pager page={page} totalPages={totalPages} total={total} pageSize={PER_PAGE}
          onGo={(n) => load(n, direction, status, search)} />
      )}

      {creating && <ReferralForm specialties={options.specialties} facilities={options.facilities || []} primaryFacilityUuid={options.primaryFacilityUuid || ''} onClose={() => setCreating(false)} onSaved={onCreated} />}
      {detail && <ReferralDetail uuid={detail} facilities={options.facilities || []} onClose={() => setDetail(null)} onChanged={refreshAll} />}
    </div>
  );
}

/* ---------------- Pagination (10 per page; scales to 100k+ records) ---------------- */
function Pager({ page, totalPages, total, pageSize, onGo }) {
  const [jump, setJump] = useState('');
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  // A compact, sliding window of page numbers around the current page (±2), clamped to the ends.
  let lo = Math.max(1, page - 2);
  let hi = Math.min(totalPages, page + 2);
  if (page <= 3) hi = Math.min(totalPages, 5);
  if (page >= totalPages - 2) lo = Math.max(1, totalPages - 4);
  const win = [];
  for (let i = lo; i <= hi; i += 1) win.push(i);
  const go = (n) => { const t = Math.min(totalPages, Math.max(1, n)); if (t !== page) onGo(t); };
  const submitJump = (e) => { e.preventDefault(); const v = parseInt(jump, 10); if (Number.isFinite(v)) go(v); setJump(''); };

  return (
    <div className="ref-pager">
      <span className="ref-pager-range">Showing <b>{from.toLocaleString()}–{to.toLocaleString()}</b> of <b>{total.toLocaleString()}</b> · 10 per page</span>
      <span className="spacer" />
      {totalPages > 1 && (
        <>
          <div className="ref-pager-nav">
            <button className="pgb" disabled={page <= 1} onClick={() => go(1)} title="First page" aria-label="First page">«</button>
            <button className="pgb" disabled={page <= 1} onClick={() => go(page - 1)} title="Previous page" aria-label="Previous page">‹</button>
            {lo > 1 && <span className="pg-ell">…</span>}
            {win.map((n) => (
              <button key={n} className={`pgb ${n === page ? 'is-on' : ''}`} onClick={() => go(n)} aria-current={n === page ? 'page' : undefined}>{n}</button>
            ))}
            {hi < totalPages && <span className="pg-ell">…</span>}
            <button className="pgb" disabled={page >= totalPages} onClick={() => go(page + 1)} title="Next page" aria-label="Next page">›</button>
            <button className="pgb" disabled={page >= totalPages} onClick={() => go(totalPages)} title="Last page" aria-label="Last page">»</button>
          </div>
          {totalPages > 5 && (
            <form className="ref-pager-jump" onSubmit={submitJump}>
              <span>Go to</span>
              <input className="input" type="number" min={1} max={totalPages} value={jump} placeholder={String(page)}
                onChange={(e) => setJump(e.target.value)} aria-label="Jump to page" />
              <span className="ref-pager-of">/ {totalPages.toLocaleString()}</span>
            </form>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- Create referral ---------------- */
function ReferralForm({ specialties, facilities = [], primaryFacilityUuid = '', onClose, onSaved }) {
  // Creating a referral only ever means composing an OUTGOING one to send. Incoming referrals arrive
  // automatically as inbound faxes (the webhook creates them) — they are never hand-authored here.
  const toast = useToast();
  const [patient, setPatient] = useState(null); // { patientUuid, patientName, mrn }
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [showRes, setShowRes] = useState(false);
  // Referring facility: defaults to the provider's PRIMARY assigned facility (auto-captured), the same
  // one the server resolves. The provider can pick a different assigned facility, or leave it to the
  // server's auto-capture (patient's facility → provider primary). This is the facility the fax sends FROM.
  const [form, setForm] = useState({ facilityUuid: primaryFacilityUuid || '', specialty: '', priority: 'routine', counterpartyName: '', counterpartyOrg: '', counterpartyNpi: '', counterpartyFax: '', reason: '', diagnosis: '', notes: '', referralDate: new Date().toISOString().slice(0, 10), scheduledDate: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // NPPES NPI lookup for the RECEIVING consultant / facility (auto-fills name, org, fax, NPI from the
  // federal registry — accurate, no hand-typing). type: provider (NPI-1) | facility (NPI-2) | both.
  const [npiQ, setNpiQ] = useState('');
  const [npiType, setNpiType] = useState('both');
  const [npiResults, setNpiResults] = useState(null);
  const [npiBusy, setNpiBusy] = useState(false);
  async function npiSearch() {
    const q = npiQ.trim(); if (!q) { toast.error('Enter an NPI (10 digits) or a name to look up.'); return; }
    setNpiBusy(true); setNpiResults(null);
    try {
      const isNpi = /^\d{10}$/.test(q.replace(/\D/g, '')) && q.replace(/\D/g, '').length === 10;
      const params = isNpi ? { npi: q.replace(/\D/g, ''), type: npiType } : { q, type: npiType };
      const { data } = await referralsApi.nppesLookup(params);
      setNpiResults(data.candidates || []);
      if (!(data.candidates || []).length) toast.info ? toast.info('No NPI registry matches.') : toast.success('No NPI registry matches.');
    } catch (e) { toast.error(toApiError(e).message); } finally { setNpiBusy(false); }
  }
  function applyNpi(c) {
    setForm((f) => ({
      ...f,
      counterpartyName: c.kind === 'provider' ? c.name : (f.counterpartyName || ''),
      counterpartyOrg: c.org || (c.kind === 'facility' ? c.name : f.counterpartyOrg),
      counterpartyFax: c.fax || f.counterpartyFax,
      counterpartyNpi: c.npi || '',
    }));
    setNpiResults(null); setNpiQ('');
    toast.success(`Applied ${c.kind === 'provider' ? 'provider' : 'facility'} NPI ${c.npi}.`);
  }

  useEffect(() => {
    if (!q.trim() || patient) { setResults([]); return undefined; }
    const t = setTimeout(async () => {
      try { const { data } = await encountersApi.listPatients({ page: 1, pageSize: 8, q: q.trim() }); setResults(data.patients || []); setShowRes(true); } catch { setResults([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, patient]);

  // Working diagnoses — FREE TEXT with real ICD-10-CM suggestions from the loaded dataset. Providers can
  // type anything and press Enter (free text), or pick a suggested code — and add MULTIPLE. The suggestions
  // are live from terminology_cache (ICD10CM); nothing is fabricated. form.diagnosis stays a human-readable
  // "CODE Name; CODE Name" string so the letter/PDF render exactly what was entered.
  const [dxList, setDxList] = useState([]); // [{ code, name }]
  const [dxQ, setDxQ] = useState('');
  const [dxSug, setDxSug] = useState([]);
  const [dxOpen, setDxOpen] = useState(false);
  useEffect(() => {
    const s = dxQ.trim();
    if (s.length < 2) { setDxSug([]); return undefined; }
    const t = setTimeout(async () => {
      try { const { data } = await terminologyApi.icd10(s, 8); setDxSug(data.results || []); setDxOpen(true); } catch { setDxSug([]); }
    }, 220);
    return () => clearTimeout(t);
  }, [dxQ]);
  function syncDx(list) { setDxList(list); set('diagnosis', list.map((d) => (d.code ? `${d.code} ${d.name}` : d.name)).join('; ')); }
  function addDx(d) {
    const k = (x) => `${x.code || ''}|${(x.name || '').toLowerCase()}`;
    if (!d?.name) return;
    if (!dxList.some((x) => k(x) === k(d))) syncDx([...dxList, { code: d.code || '', name: d.name }]);
    setDxQ(''); setDxSug([]); setDxOpen(false);
  }
  function addFreeDx() { const s = dxQ.trim(); if (s) addDx({ code: '', name: s }); }
  function removeDx(i) { syncDx(dxList.filter((_, idx) => idx !== i)); }

  async function save() {
    if (!patient) { toast.error('Select a patient for this referral.'); return; }
    if (!form.specialty.trim()) { toast.error('Choose a service type.'); return; }
    setBusy(true);
    try {
      await referralsApi.create({ direction: 'outgoing', patientUuid: patient.patientUuid, ...form });
      toast.success('Referral created.');
      onSaved();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  const SERVICE_TYPES = ['Consultation', 'Evaluation & Treatment', 'Procedure', 'Diagnostic / Imaging', 'Second Opinion', 'Follow-up'];

  return (
    <Modal onClose={onClose} title="New Outgoing Referral" width={940}>
      <div className="rf">

        {/* ---- Patient & routing ---- */}
        <section className="rf-sec">
          <h4 className="rf-h">Patient &amp; Routing</h4>
          <div className="rf-grid">
            <div className="ref-field rf-full">
              <label>Patient</label>
              {patient ? (
                <div className="ref-pt-pick">
                  <span className="ref-pt-name">{patient.patientName}</span>
                  {patient.mrn && <span className="ref-pt-mrn">{patient.mrn}</span>}
                  <button className="ref-pt-clear" onClick={() => { setPatient(null); setQ(''); }} aria-label="Change patient">×</button>
                </div>
              ) : (
                <div className="ref-pt-search">
                  <input className="input" placeholder="Search patient by name or MRN…" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setShowRes(true)} />
                  {showRes && results.length > 0 && (
                    <div className="ref-pt-list">
                      {results.map((p) => (
                        <button key={p.patientUuid} className="ref-pt-item" onClick={() => { setPatient(p); setShowRes(false); setResults([]); }}>
                          <span className="ref-pt-name">{p.patientName || '—'}</span>
                          <span className="ref-pt-mrn">{p.mrn}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {facilities.length > 0 && (
              <div className="ref-field rf-full">
                <label>Referring Facility <span className="ref-opt">(faxes send from this facility)</span></label>
                <select className="input" value={form.facilityUuid} onChange={(e) => set('facilityUuid', e.target.value)}>
                  {facilities.map((f) => <option key={f.uuid} value={f.uuid}>{f.name}{f.npi ? ` · NPI ${f.npi}` : ''}</option>)}
                </select>
              </div>
            )}

            <div className="ref-field">
              <label>Service Type</label>
              <select className="input" value={form.specialty} onChange={(e) => set('specialty', e.target.value)}>
                <option value="">Select a service type…</option>
                {SERVICE_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="ref-field">
              <label>Priority</label>
              <select className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                <option value="routine">Routine</option><option value="urgent">Urgent</option><option value="stat">STAT</option>
              </select>
            </div>
          </div>
        </section>

        {/* ---- Refer To (NPPES lookup + consultant details) ---- */}
        <section className="rf-sec">
          <h4 className="rf-h">Refer To — Consultant / Facility</h4>
          {/* NPPES lookup — user picks an EXACT registry record (NPI + city/state shown), so no incorrect
              facility is ever auto-filled. */}
          <div className="ref-npi">
            <div className="ref-npi-bar">
              <div className="ref-seg sm">
                {[['both', 'All'], ['provider', 'Provider'], ['facility', 'Facility']].map(([v, l]) => (
                  <button type="button" key={v} className={`ref-seg-btn ${npiType === v ? 'is-on' : ''}`} onClick={() => setNpiType(v)}>{l}</button>
                ))}
              </div>
              <input className="input" placeholder="Look up by NPI (10 digits) or name…" value={npiQ}
                onChange={(e) => setNpiQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); npiSearch(); } }} />
              <button type="button" className="btn ghost" onClick={npiSearch} disabled={npiBusy}>{npiBusy ? <span className="spinner dark" /> : 'Look up'}</button>
            </div>
            {npiResults && (
              npiResults.length === 0
                ? <div className="ref-att-empty">No NPI registry matches. Refine the name or enter the 10-digit NPI.</div>
                : (
                  <div className="ref-npi-list">
                    {npiResults.map((c) => (
                      <button type="button" key={`${c.kind}-${c.npi}`} className="ref-npi-item" onClick={() => applyNpi(c)}>
                        <span className={`ref-npi-kind ${c.kind}`}>{c.kind === 'provider' ? 'Provider' : 'Facility'}</span>
                        <span className="ref-npi-name">{c.name}</span>
                        <span className="ref-npi-meta">NPI {c.npi}{c.city ? ` · ${c.city}, ${c.state}` : ''}{c.taxonomy ? ` · ${c.taxonomy}` : ''}</span>
                      </button>
                    ))}
                  </div>
                )
            )}
            {form.counterpartyNpi && <div className="ref-npi-applied">✓ NPI {form.counterpartyNpi} applied — the fields below were filled from the registry (editable).</div>}
          </div>

          <div className="rf-grid">
            <div className="ref-field">
              <label>Consultant / Provider</label>
              <input className="input" placeholder="Consultant / provider name" value={form.counterpartyName} onChange={(e) => set('counterpartyName', e.target.value)} />
            </div>
            <div className="ref-field">
              <label>Clinic / Facility</label>
              <input className="input" placeholder="Organization / facility" value={form.counterpartyOrg} onChange={(e) => set('counterpartyOrg', e.target.value)} />
            </div>
            <div className="ref-field">
              <label>Consultant NPI <span className="ref-opt">(auto-filled by look-up)</span></label>
              <input className="input" inputMode="numeric" maxLength={10} placeholder="10-digit NPI" value={form.counterpartyNpi}
                onChange={(e) => set('counterpartyNpi', e.target.value.replace(/\D/g, '').slice(0, 10))} />
            </div>
            <div className="ref-field">
              <label>Destination Fax <span className="ref-opt">(to send by fax)</span></label>
              <input className="input" type="tel" placeholder="+1 555 555 5555" value={form.counterpartyFax} onChange={(e) => set('counterpartyFax', e.target.value)} />
            </div>
          </div>
        </section>

        {/* ---- Clinical & scheduling ---- */}
        <section className="rf-sec">
          <h4 className="rf-h">Clinical &amp; Scheduling</h4>
          <div className="rf-grid">
            <div className="ref-field rf-full">
              <label>Working Diagnoses <span className="ref-opt">(type freely; pick an ICD-10 suggestion or press Enter — add multiple)</span></label>
              {dxList.length > 0 && (
                <div className="dx-chips">
                  {dxList.map((d, i) => (
                    <span key={`${d.code}-${i}`} className="dx-chip">
                      {d.code && <b>{d.code}</b>}<span className="dx-chip-name">{d.name}</span>
                      <button type="button" className="dx-x" onClick={() => removeDx(i)} aria-label="Remove diagnosis">×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="dx-inputwrap">
                <input className="input" placeholder="e.g. Atrial fibrillation — or type an ICD-10 code" value={dxQ}
                  onChange={(e) => setDxQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFreeDx(); } }}
                  onFocus={() => { if (dxSug.length) setDxOpen(true); }}
                  onBlur={() => setTimeout(() => setDxOpen(false), 150)} />
                {dxOpen && dxSug.length > 0 && (
                  <div className="dx-sug">
                    {dxSug.map((s) => (
                      <button type="button" key={s.code} className="dx-sug-item" onMouseDown={(e) => { e.preventDefault(); addDx(s); }}>
                        <b>{s.code}</b><span>{s.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="ref-field">
              <label>Referral Date</label>
              <input className="input" type="date" value={form.referralDate} onChange={(e) => set('referralDate', e.target.value)} />
            </div>
            <div className="ref-field">
              <label>Scheduled Date <span className="ref-opt">(optional — appointment)</span></label>
              <input className="input" type="date" value={form.scheduledDate} onChange={(e) => set('scheduledDate', e.target.value)} />
            </div>
            <div className="ref-field rf-full">
              <label>Reason for Referral</label>
              <textarea className="input" rows={3} placeholder="Clinical reason / question for the consultant…" value={form.reason} onChange={(e) => set('reason', e.target.value)} />
            </div>
            <div className="ref-field rf-full">
              <label>Clinical Notes <span className="ref-opt">(optional)</span></label>
              <textarea className="input" rows={2} placeholder="Relevant history, medications, findings…" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </div>
          </div>
        </section>

        <div className="ref-form-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn accent" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : 'Create Referral'}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Detail + status + generate letter ---------------- */
function ReferralDetail({ uuid, facilities = [], onClose, onChanged }) {
  const toast = useToast();
  const [r, setR] = useState(null);
  const [confirm, setConfirm] = useState(null); // { title, body, confirmLabel, tone, onConfirm } — sleek in-app confirm
  const [facBusy, setFacBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [faxBusy, setFaxBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState('');
  const [ai, setAi] = useState(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [atts, setAtts] = useState([]);
  const [attBusy, setAttBusy] = useState(false);
  const fileRef = useRef(null);

  async function load() {
    setLoading(true);
    try { const { data } = await referralsApi.get(uuid); setR(data.referral); } catch (e) { toast.error(toApiError(e).message); onClose(); } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [uuid]);

  // Load the enterprise referral PDF into the preview panel (facility letterhead). Auto-loads once the
  // referral is fetched; regenerated on demand. The blob URL is revoked on unmount / refresh (no leak).
  const loadPdf = useCallback(async () => {
    setPdfBusy(true);
    try {
      const res = await referralsApi.pdf(uuid);
      const url = URL.createObjectURL(res.data);
      setPdfUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
    } catch (e) { toast.error(toApiError(e).message); } finally { setPdfBusy(false); }
  }, [uuid, toast]);
  useEffect(() => { if (r && r.direction === 'outgoing' && !pdfUrl) loadPdf(); /* eslint-disable-next-line */ }, [r]);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  // Incoming: load the RECEIVED fax document (stored in S3) into the right-pane viewer. Auto-loads once the
  // incoming referral is fetched and its document is stored. Blob URL revoked on unmount/refresh (no leak).
  const loadReceivedDoc = useCallback(async () => {
    setPdfBusy(true);
    try {
      const res = await referralsApi.receivedDocument(uuid);
      // SECURITY: pin the blob's MIME to application/pdf. A received fax document is externally supplied
      // (attacker-influenced); without pinning, a blob whose server Content-Type resolved to text/html would
      // execute its scripts SAME-ORIGIN in the viewer iframe. Forcing application/pdf means it is only ever
      // handled by the browser's PDF viewer — HTML/JS is never executed (a non-PDF just renders blank).
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      setPdfUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
    } catch (e) { toast.error(toApiError(e).message); } finally { setPdfBusy(false); }
  }, [uuid, toast]);
  useEffect(() => { if (r && r.direction === 'incoming' && r.fax?.hasDocument && !pdfUrl) loadReceivedDoc(); /* eslint-disable-next-line */ }, [r]);
  function downloadReceived() { if (!pdfUrl) return; const a = document.createElement('a'); a.href = pdfUrl; a.download = `received-${r.referralNo}.pdf`; a.click(); }

  // Real-time fax status: while a fax is still in flight, SYNC the authoritative status straight from the
  // Fax.Plus API every 8s (read-only — never sends), so the timeline updates in real time even if a
  // webhook was missed. Stops once the fax reaches a terminal state. Never triggers a send.
  useEffect(() => {
    const st = r?.fax?.status;
    if (!st || /success|delivered|complete|failed|error|cancel|no_answer|busy|rejected/i.test(st)) return undefined;
    const t = setInterval(() => { referralsApi.faxStatusSync(uuid).then(({ data }) => setR(data.referral)).catch(() => {}); }, 8000);
    return () => clearInterval(t);
  }, [r?.fax?.status, uuid]);

  async function setStatus(status) {
    setSaving(true);
    try { const { data } = await referralsApi.update(uuid, { status }); setR(data.referral); onChanged(); toast.success('Status updated.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setSaving(false); }
  }
  function downloadPdf() { if (!pdfUrl) return; const a = document.createElement('a'); a.href = pdfUrl; a.download = `referral-${r.referralNo}.pdf`; a.click(); }

  const loadAtts = useCallback(async () => {
    try { const { data } = await referralsApi.attachments(uuid); setAtts(data.attachments || []); } catch { /* non-fatal */ }
  }, [uuid]);
  useEffect(() => { if (r && r.direction === 'outgoing') loadAtts(); }, [r, loadAtts]);
  async function uploadAtt(e) {
    const file = e.target.files?.[0]; if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') { toast.error('Only PDF records can be enclosed.'); return; }
    if (file.size > 25 * 1024 * 1024) { toast.error('Record is too large (max 25 MB).'); return; }
    setAttBusy(true);
    try { await referralsApi.uploadAttachment(uuid, file); toast.success('Record enclosed.'); await loadAtts(); loadPdf(); }
    catch (err) { toast.error(toApiError(err).message); } finally { setAttBusy(false); }
  }
  async function delAtt(attUuid) {
    try { await referralsApi.deleteAttachment(uuid, attUuid); await loadAtts(); loadPdf(); toast.success('Record removed.'); }
    catch (err) { toast.error(toApiError(err).message); }
  }
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  function del() {
    setConfirm({
      title: 'Delete referral',
      body: `Referral ${r.referralNo} and its record will be permanently removed. This cannot be undone.`,
      confirmLabel: 'Delete referral', tone: 'danger',
      onConfirm: async () => { await referralsApi.remove(uuid); toast.success('Referral deleted.'); onChanged(); onClose(); },
    });
  }
  function sendFaxNow() {
    const from = r.referringFacility?.name;
    setConfirm({
      title: r.fax?.id ? 'Re-send fax' : 'Send referral by fax',
      body: `The Part B referral package will be generated and faxed to ${r.counterpartyFax}${from ? ` from ${from}` : ''}.`,
      confirmLabel: r.fax?.id ? 'Re-send fax' : 'Send fax', tone: 'accent',
      onConfirm: async () => {
        setFaxBusy(true);
        try { const { data } = await referralsApi.sendFax(uuid); setR(data.referral); onChanged(); toast.success('Referral faxed — sending in progress.'); }
        finally { setFaxBusy(false); }
      },
    });
  }
  // Provider sets/changes the REFERRING facility on this referral via the UI (faxes send FROM it). Only a
  // facility the provider is assigned to is accepted server-side; empty clears it.
  async function setFacility(facilityUuid) {
    setFacBusy(true);
    try { const { data } = await referralsApi.update(uuid, { facilityUuid }); setR(data.referral); onChanged(); toast.success(facilityUuid ? 'Referring facility set.' : 'Referring facility cleared.'); loadPdf(); }
    catch (e) { toast.error(toApiError(e).message); } finally { setFacBusy(false); }
  }
  async function runAi(mode) {
    setAiBusy(mode); setAi(null);
    try { const { data } = await referralsApi.faxAi(uuid, mode); setAi({ mode, data: data.result }); }
    catch (e) { toast.error(toApiError(e).message); } finally { setAiBusy(''); }
  }
  // Self-heal: re-fetch + store a received document that failed to store at intake (no silent data loss).
  async function restoreDoc() {
    setRestoreBusy(true);
    try { const { data } = await referralsApi.restoreDocument(uuid); setR(data.referral); onChanged(); toast.success('Received document retrieved and stored.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setRestoreBusy(false); }
  }

  const outgoing = r?.direction === 'outgoing';
  const kv = (k, v) => (v ? <div className="rd-kv"><span className="rd-k">{k}</span><span className="rd-v">{v}</span></div> : null);

  return (
    <Modal onClose={onClose} size="full" title={r ? (outgoing ? 'Outgoing Referral' : 'Incoming Fax Referral') : 'Referral'}>
      {loading || !r ? (
        <div className="rd-loading"><span className="spinner dark" /> Loading referral…</div>
      ) : (
        <div className="rd">
          {/* ---- Summary hero ---- */}
          <div className="rd-hero">
            <div className={`rd-hero-icon ${r.direction}`} aria-hidden="true">{outgoing ? '↗' : '↙'}</div>
            <div className="rd-hero-info">
              <div className="rd-hero-l1">
                <h2 className="rd-no">{r.referralNo}</h2>
                <span className={`ref-status ${r.status}`}>{STATUS_LABEL[r.status]}</span>
                <span className={`ref-prio ${r.priority}`}>{PRIORITY_LABEL[r.priority]}</span>
                {r.fax?.status && <span className="rd-faxchip" title="Fax status">✦ {r.fax.status}{r.fax.pages ? ` · ${r.fax.pages}p` : ''}</span>}
              </div>
              <div className="rd-hero-l2">
                {r.patient
                  ? <span><strong>{r.patient.name || 'Unnamed patient'}</strong>{r.patient.mrn ? ` · MRN ${r.patient.mrn}` : ''}{r.patient.dob ? ` · DOB ${r.patient.dob}` : ''}{r.patient.sex ? ` · ${r.patient.sex}` : ''}</span>
                  : <span className="rd-unassigned">Unassigned inbound fax — review, then link to a patient</span>}
                <span className="rd-dot">•</span>{r.specialty || 'General'}
                <span className="rd-dot">•</span>{usDate(r.referralDate)}
              </div>
            </div>
            {outgoing && (
              <div className="rd-hero-actions">
                <button className="btn accent" onClick={sendFaxNow} disabled={faxBusy || !r.counterpartyFax} title={!r.counterpartyFax ? 'Add a destination fax number first' : ''}>
                  {faxBusy ? <span className="spinner" /> : (r.fax?.id ? '↗ Re-send fax' : '↗ Send via fax')}
                </button>
              </div>
            )}
          </div>

          {/* ---- Two-pane workspace ---- */}
          <div className="rd-cols">
            {/* LEFT — details & actions */}
            <div className="rd-main">
              {/* Counterparty */}
              <section className="rd-card">
                <h3 className="rd-card-h">{outgoing ? 'Refer to — consultant / facility' : 'Received from'}</h3>
                <div className="rd-kv-list">
                  {kv('Name', r.counterpartyName || (outgoing ? '—' : (r.counterpartyFax ? `Sender ${r.counterpartyFax}` : '—')))}
                  {kv('Clinic / facility', r.counterpartyOrg)}
                  {kv('NPI', r.counterpartyNpi)}
                  {kv(outgoing ? 'Destination fax' : 'Sender fax', r.counterpartyFax)}
                </div>
              </section>

              {/* Sends-from facility (outgoing only) */}
              {outgoing && (
                <section className="rd-card">
                  <h3 className="rd-card-h">Send from — referring facility</h3>
                  {facilities.length > 0 ? (
                    <div className="rd-facpick">
                      <select className="input" value={r.referringFacility?.uuid || ''} disabled={facBusy} onChange={(e) => setFacility(e.target.value)}>
                        <option value="">— Not linked (auto: patient / your primary facility) —</option>
                        {facilities.map((f) => <option key={f.uuid} value={f.uuid}>{f.name}{f.npi ? ` · NPI ${f.npi}` : ''}</option>)}
                      </select>
                      {facBusy && <span className="spinner dark" />}
                    </div>
                  ) : <div className="rd-muted">Your assigned facility is used automatically.</div>}
                  {r.referringFacility
                    ? <div className="rd-note ok">Faxes send from <strong>{r.referringFacility.name}</strong>’s configured number.</div>
                    : <div className="rd-note warn">Not linked to a facility yet — pick one above so the fax sends from its configured number.</div>}
                </section>
              )}

              {/* Clinical */}
              <section className="rd-card">
                <h3 className="rd-card-h">Clinical</h3>
                <div className="rd-para"><span className="rd-k">Reason for referral</span><p>{r.reason || '—'}</p></div>
                <div className="rd-para"><span className="rd-k">Working diagnosis</span><p>{r.diagnosis || '—'}</p></div>
                {r.notes && <div className="rd-para"><span className="rd-k">Clinical notes</span><p>{r.notes}</p></div>}
              </section>

              {/* Enclosed records (outgoing only) */}
              {outgoing && (
                <section className="rd-card">
                  <div className="rd-card-hrow">
                    <h3 className="rd-card-h">Enclosed records {atts.length > 0 && <span className="rd-count">{atts.length}</span>}</h3>
                    <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={uploadAtt} />
                    <button className="btn ghost sm" onClick={() => fileRef.current?.click()} disabled={attBusy}>{attBusy ? <span className="spinner" /> : '+ Upload PDF'}</button>
                  </div>
                  {atts.length === 0
                    ? <div className="rd-muted">No records enclosed. Uploaded PDFs are added to the faxed package after the cover sheet.</div>
                    : (
                      <ul className="ref-att-list">
                        {atts.map((a) => (
                          <li key={a.uuid} className="ref-att-item">
                            <span className="ref-att-ic" aria-hidden="true">📄</span>
                            <span className="ref-att-name">{a.fileName}</span>
                            <span className="ref-att-size">{fmtSize(a.size || 0)}</span>
                            <button className="ref-att-del" onClick={() => delAtt(a.uuid)} aria-label="Remove record">×</button>
                          </li>
                        ))}
                      </ul>
                    )}
                </section>
              )}

              {/* Received-fax facts (incoming only) */}
              {!outgoing && (
                <section className="rd-card">
                  <div className="rd-card-hrow">
                    <h3 className="rd-card-h">Received fax</h3>
                    {!r.fax?.hasDocument && r.fax?.id && (
                      <button className="btn ghost sm" onClick={restoreDoc} disabled={restoreBusy}>{restoreBusy ? <span className="spinner" /> : 'Retrieve document'}</button>
                    )}
                  </div>
                  <div className="rd-kv-list">
                    {kv('From', r.counterpartyFax || '—')}
                    {kv('Pages', r.fax?.pages ? String(r.fax.pages) : '—')}
                    {kv('Document', r.fax?.hasDocument ? 'Stored ✓' : 'Not stored yet')}
                    {kv('Fax ID', r.fax?.id)}
                  </div>
                </section>
              )}

              {/* Status workflow */}
              <section className="rd-card">
                <h3 className="rd-card-h">Status</h3>
                <div className="ref-status-flow">
                  {statusesFor(r.direction).map((s) => (
                    <button key={s} disabled={saving || s === r.status} className={`ref-status-b ${s === r.status ? 'is-on' : ''}`} onClick={() => setStatus(s)}>{STATUS_LABEL[s]}</button>
                  ))}
                </div>
              </section>

              {/* Delivery / errors + timeline */}
              {(r.fax?.error || r.fax?.timeline?.length > 0) && (
                <section className="rd-card">
                  <h3 className="rd-card-h">{outgoing ? 'Delivery timeline' : 'Intake timeline'}</h3>
                  {r.fax?.error && <div className="rd-note err">{outgoing ? 'Last fax error' : 'Document issue'}: {r.fax.error}</div>}
                  {r.fax?.timeline?.length > 0 && (
                    <ol className="ref-timeline">
                      {r.fax.timeline.map((e, i) => (
                        <li key={i} className="ref-tl-item">
                          <span className="ref-tl-dot" aria-hidden="true" />
                          <div className="ref-tl-body">
                            <span className="ref-tl-status">{e.status}</span>
                            <span className="ref-tl-at">{e.at ? new Date(e.at).toLocaleString() : ''}</span>
                            {e.detail && <span className="ref-tl-detail">{e.detail}</span>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}

              {/* AI triage */}
              {(r.fax?.ai || r.fax?.id) && (
                <section className="rd-card">
                  <h3 className="rd-card-h">Fax.Plus AI</h3>
                  {!outgoing && r.fax?.ai && (
                    <div className="ref-ai" style={{ marginTop: 0, borderTop: 0, paddingTop: 0 }}>
                      <div className="ref-ai-head"><span>Auto triage</span><span className="ref-opt">{r.fax.aiAt ? `computed ${new Date(r.fax.aiAt).toLocaleString()}` : 'computed at intake'} · cached</span></div>
                      <AiView ai={r.fax.ai} />
                    </div>
                  )}
                  {r.fax?.id && (
                    <div className="ref-ai" style={{ borderTop: r.fax?.ai ? undefined : 0, paddingTop: r.fax?.ai ? undefined : 0, marginTop: r.fax?.ai ? undefined : 0 }}>
                      <div className="ref-ai-head"><span>{!outgoing ? 'Re-run (optional)' : 'On-demand analysis'}</span><span className="ref-opt">uses an AI credit</span></div>
                      <div className="ref-ai-btns">
                        <button className="btn ghost sm" onClick={() => runAi('transcript')} disabled={!!aiBusy}>{aiBusy === 'transcript' ? <span className="spinner" /> : 'AI Text Transcript'}</button>
                        <button className="btn ghost sm" onClick={() => runAi('extract')} disabled={!!aiBusy}>{aiBusy === 'extract' ? <span className="spinner" /> : 'AI Data Extraction'}</button>
                      </div>
                      {ai && (typeof ai.data === 'string' ? <pre className="ref-letter">{ai.data}</pre> : <AiView ai={ai.data} />)}
                    </div>
                  )}
                </section>
              )}
            </div>

            {/* RIGHT — document viewer */}
            <aside className="rd-side">
              <div className="rd-side-head">
                <span>{outgoing ? 'Referral package' : 'Received document'}</span>
                <span className="rd-side-actions">
                  {outgoing ? (
                    <>
                      <button className="btn ghost sm" onClick={loadPdf} disabled={pdfBusy}>{pdfBusy ? <span className="spinner" /> : 'Refresh'}</button>
                      <button className="btn ghost sm" onClick={downloadPdf} disabled={!pdfUrl}>Download</button>
                    </>
                  ) : (
                    <>
                      {r.fax?.hasDocument && <button className="btn ghost sm" onClick={loadReceivedDoc} disabled={pdfBusy}>{pdfBusy ? <span className="spinner" /> : 'Refresh'}</button>}
                      {r.fax?.hasDocument && <button className="btn ghost sm" onClick={downloadReceived} disabled={!pdfUrl}>Download</button>}
                      {!r.fax?.hasDocument && r.fax?.id && <button className="btn ghost sm" onClick={restoreDoc} disabled={restoreBusy}>{restoreBusy ? <span className="spinner" /> : 'Retrieve'}</button>}
                    </>
                  )}
                </span>
              </div>
              <div className="rd-doc">
                {pdfUrl
                  ? <iframe title="Document" className="rd-doc-frame" src={pdfUrl} />
                  : (
                    <div className="rd-doc-empty">
                      {pdfBusy
                        ? <><span className="spinner dark" /> {outgoing ? 'Generating package…' : 'Loading document…'}</>
                        : (outgoing ? 'The referral package (cover sheet + letter) will appear here.' : (r.fax?.hasDocument ? 'Click Refresh to load the received document.' : 'The received document is not stored yet — use Retrieve.'))}
                    </div>
                  )}
              </div>
            </aside>
          </div>

          {/* ---- Footer ---- */}
          <div className="rd-foot">
            <button className="btn danger sm" onClick={del}>Delete referral</button>
            <span className="spacer" />
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
      {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} onDone={() => setConfirm(null)} />}
    </Modal>
  );
}

/**
 * Sleek in-app confirmation — replaces the browser's native confirm() dialog. Renders as a focused
 * overlay inside the referral modal with a titled prompt and a primary action tinted by `tone`
 * (danger / accent). Runs the async `onConfirm`, surfaces any error as a toast, and closes on success.
 */
function ConfirmDialog({ title, body, confirmLabel = 'Confirm', tone = 'accent', onConfirm, onCancel, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await onConfirm(); onDone(); }
    catch (e) { toast.error(toApiError(e).message); setBusy(false); }
  }
  return (
    <div className="ref-confirm-overlay" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="ref-confirm-card">
        <div className={`ref-confirm-accent ${tone}`} aria-hidden="true" />
        <div className="ref-confirm-body">
          <h3 className="ref-confirm-title">{title}</h3>
          <p className="ref-confirm-text">{body}</p>
          <div className="ref-confirm-actions">
            <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className={`btn ${tone}`} onClick={go} disabled={busy}>{busy ? <span className="spinner" /> : confirmLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, wide }) {
  return (
    <div className={`ref-dfield ${wide ? 'wide' : ''}`}>
      <span className="ref-dlabel">{label}</span>
      <span className="ref-dval">{value}</span>
    </div>
  );
}

/* Render a Fax.Plus AI result: structured fields as key/value, plus any transcript text. Tolerant of
   the varying AI response shapes (fields / data / extracted vs. text / transcript). */
function AiView({ ai }) {
  if (ai == null) return null;
  if (typeof ai === 'string') return <pre className="ref-letter">{ai}</pre>;
  const fields = ai.fields || ai.data || ai.extracted || null;
  const text = ai.text || ai.transcript || ai.content || null;
  const entries = fields && typeof fields === 'object' ? Object.entries(fields).filter(([, v]) => v != null && v !== '') : [];
  return (
    <div className="ref-ai-view">
      {entries.length > 0 && (
        <div className="ref-ai-fields">
          {entries.map(([k, v]) => (
            <div key={k} className="ref-ai-kv">
              <span className="ref-ai-k">{k.replace(/[_-]+/g, ' ')}</span>
              <span className="ref-ai-v">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
            </div>
          ))}
        </div>
      )}
      {text && <pre className="ref-letter">{String(text)}</pre>}
      {entries.length === 0 && !text && <pre className="ref-letter">{JSON.stringify(ai, null, 2)}</pre>}
    </div>
  );
}
