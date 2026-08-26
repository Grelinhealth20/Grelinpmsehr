import { useEffect, useRef, useState } from 'react';
import PatientModal from '../components/PatientModal.jsx';
import { NewEncounterModal, EncounterNotesModal, usDate, encNo } from '../components/EncounterNotes.jsx';
import { useToast } from '../components/Toast.jsx';
import { encountersApi, toApiError } from '../lib/api.js';
import { NOTE_TYPES } from '../lib/noteTemplates.js';

const PATIENTS_PER_PAGE = 25;
const ENC_PER_PAGE = 25;
const procedureLabel = (r) => (r.noteTypes ? r.noteTypes.split(',').map((c) => NOTE_TYPES[c]?.label || c).join(', ') : '—');

/**
 * Patients & Encounters — SERVER-PAGINATED for enterprise scale (50k+ patients,
 * 10k+ encounters/patient). Only one page of patients is loaded; each patient's
 * encounters are fetched on demand when expanded, and paginated independently.
 */
export default function Encounter() {
  const toast = useToast();
  const [patients, setPatients] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewPatient, setViewPatient] = useState(null);
  const [newPatient, setNewPatient] = useState(false);
  const [newEncounter, setNewEncounter] = useState(false);
  const [notesEnc, setNotesEnc] = useState(null);
  const firstLoad = useRef(true);

  async function load(p, q) {
    setLoading(true);
    try {
      const { data } = await encountersApi.listPatients({ page: p, pageSize: PATIENTS_PER_PAGE, q });
      setPatients(data.patients || []);
      setTotal(data.total || 0);
    } catch (e) { toast.error(toApiError(e).message); } finally { setLoading(false); }
  }

  // Initial load + debounced server-side search.
  useEffect(() => {
    const delay = firstLoad.current ? 0 : 300;
    firstLoad.current = false;
    const t = setTimeout(() => { setPage(1); load(1, search.trim()); }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / PATIENTS_PER_PAGE));
  const goPage = (pp) => { setPage(pp); load(pp, search.trim()); };
  const toggle = (uuid) => setExpanded((s) => { const n = new Set(s); n.has(uuid) ? n.delete(uuid) : n.add(uuid); return n; });
  const reloadAll = () => { load(page, search.trim()); setRefreshKey((k) => k + 1); };

  return (
    <div className="enc">
      <div className="enc-bar">
        <div className="enc-title">
          <span className="enc-title-main">Patients &amp; Encounters</span>
          <span className="enc-title-sub">{loading ? 'Loading…' : `${total} patient${total === 1 ? '' : 's'}`}</span>
        </div>
        <span className="spacer" />
        <input className="input search" placeholder="Search patient name or MRN…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn ghost sm" onClick={() => setNewPatient(true)}>+ New Patient</button>
        <button className="btn sm" onClick={() => setNewEncounter(true)}>+ New Encounter</button>
      </div>

      <div className="enc-table-wrap">
        <table className="table enc-table">
          <thead>
            <tr>
              <th>MRN</th>
              <th>Patient Name</th>
              <th>Facility Name</th>
              <th>Rendering Provider</th>
              <th>Eligibility Status</th>
              <th>Encounter&apos;s Count</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="table-empty"><span className="spinner dark" /> Loading…</td></tr>
            ) : patients.length === 0 ? (
              <tr><td colSpan={7} className="table-empty">{search ? 'No patients match your search.' : 'No patients yet. Add a patient to begin.'}</td></tr>
            ) : (
              patients.map((p) => (
                <PatientRow
                  key={p.patientUuid}
                  p={p}
                  open={expanded.has(p.patientUuid)}
                  refreshKey={refreshKey}
                  onToggle={() => toggle(p.patientUuid)}
                  onView={(uuid) => setViewPatient(uuid)}
                  onNotes={(enc) => setNotesEnc(enc)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {!loading && total > 0 && (
        <Pager page={page} pages={totalPages} onPage={goPage}
          label={`Showing ${(page - 1) * PATIENTS_PER_PAGE + 1}–${Math.min(page * PATIENTS_PER_PAGE, total)} of ${total} patients`} />
      )}

      {viewPatient && <PatientModal uuid={viewPatient} onClose={() => setViewPatient(null)} onSaved={reloadAll} />}
      {newPatient && <PatientModal docMode="records" onClose={() => setNewPatient(false)} onSaved={reloadAll} />}
      {newEncounter && (
        <NewEncounterModal
          onClose={() => setNewEncounter(false)}
          onCreated={(enc) => { setNewEncounter(false); reloadAll(); setNotesEnc(enc); }}
        />
      )}
      {notesEnc && <EncounterNotesModal encounter={notesEnc} onClose={() => setNotesEnc(null)} onChanged={reloadAll} />}
    </div>
  );
}

function PatientRow({ p, open, onToggle, onView, onNotes, refreshKey }) {
  const [encs, setEncs] = useState(null);
  const [encTotal, setEncTotal] = useState(0);
  const [ePage, setEPage] = useState(1);
  const [eLoading, setELoading] = useState(false);

  // Lazy-load this patient's encounters when expanded (server-paginated).
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setELoading(true);
    encountersApi.patientEncounters(p.patientUuid, { page: ePage, pageSize: ENC_PER_PAGE })
      .then(({ data }) => { if (active) { setEncs(data.encounters || []); setEncTotal(data.total || 0); } })
      .catch(() => { if (active) setEncs([]); })
      .finally(() => { if (active) setELoading(false); });
    return () => { active = false; };
  }, [open, ePage, p.patientUuid, refreshKey]);

  const ePages = Math.max(1, Math.ceil(encTotal / ENC_PER_PAGE));
  const encFor = (r) => ({ encounterUuid: r.encounterUuid, encounterNo: r.encounterNo, patientName: p.patientName, mrn: p.mrn, date: r.date, facilityName: p.facilityName });

  return (
    <>
      <tr className={`enc-group ${open ? 'is-open' : ''}`} onClick={onToggle}>
        <td className="mono">{p.mrn || '—'}</td>
        <td className="enc-strong">
          <span className="enc-group-name"><span className={`enc-chev ${open ? 'open' : ''}`} aria-hidden="true" />{p.patientName || '—'}</span>
        </td>
        <td>{p.facilityName || '—'}</td>
        <td>{p.renderingProvider || '—'}</td>
        <td />
        <td><span className="enc-count-badge">{p.encounterCount}</span></td>
        <td className="enc-action">
          <button className="act" onClick={(e) => { e.stopPropagation(); onView(p.patientUuid); }} title="View face sheet">View</button>
        </td>
      </tr>
      {open && (
        <tr className="enc-sub-row">
          <td colSpan={7}>
            <table className="enc-subtable">
              <thead>
                <tr>
                  <th>Encounter ID</th>
                  <th>Date of Service</th>
                  <th>Notes</th>
                  <th>Rendering Provider</th>
                  <th>Signed off Provider</th>
                  <th className="enc-sub-act">Action</th>
                </tr>
              </thead>
              <tbody>
                {eLoading && !encs ? (
                  <tr><td colSpan={6} className="table-empty"><span className="spinner dark" /> Loading…</td></tr>
                ) : (encs && encs.length === 0) ? (
                  <tr><td colSpan={6} className="table-empty">No encounters for this patient yet.</td></tr>
                ) : (encs || []).map((r) => (
                  <tr key={r.encounterUuid}>
                    <td className="mono">{encNo(r.encounterNo)}</td>
                    <td>{usDate(r.date)}</td>
                    <td>{procedureLabel(r)}</td>
                    <td>{r.renderingProvider || '—'}</td>
                    <td>{r.signedOffProvider || <span className="enc-unsigned">Not signed</span>}</td>
                    <td className="enc-sub-act">
                      <button className="act accent" onClick={() => onNotes(encFor(r))} title="Open encounter & clinical notes">View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ePages > 1 && (
              <Pager compact page={ePage} pages={ePages} onPage={setEPage} label={`${encTotal} encounters`} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** Windowed page numbers with ellipses, e.g. 1 … 4 5 6 … 20. */
function pageWindow(page, pages) {
  const s = new Set([1, pages, page, page - 1, page + 1]);
  const nums = [...s].filter((x) => x >= 1 && x <= pages).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const x of nums) { if (x - prev > 1) out.push('…'); out.push(x); prev = x; }
  return out;
}

function Pager({ page, pages, onPage, label, compact }) {
  return (
    <div className={`pager ${compact ? 'pager-c' : ''}`}>
      {label && <span className="pager-label">{label}</span>}
      <span className="spacer" />
      {pages > 1 && (
        <>
          <button className="pager-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
          {pageWindow(page, pages).map((x, i) => (x === '…'
            ? <span key={`e${i}`} className="pager-ellipsis">…</span>
            : <button key={x} className={`pager-num ${x === page ? 'is-on' : ''}`} onClick={() => onPage(x)}>{x}</button>))}
          <button className="pager-btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
        </>
      )}
    </div>
  );
}
