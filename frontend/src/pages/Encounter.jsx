import { useEffect, useRef, useState } from 'react';
import PatientModal from '../components/PatientModal.jsx';
import { useToast } from '../components/Toast.jsx';
import { encountersApi, toApiError } from '../lib/api.js';

const PATIENTS_PER_PAGE = 25;

/**
 * Patients & Encounters — SERVER-PAGINATED for enterprise scale (50k+ patients,
 * 10k+ encounters/patient). Only one page of patients is loaded; each patient's
 * encounters live inside that patient's Face Sheet modal (Encounters tab), fetched
 * on demand and paginated independently.
 */
export default function Encounter() {
  const toast = useToast();
  const [patients, setPatients] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewPatient, setViewPatient] = useState(null); // { uuid, tab } → open the Face Sheet modal (optionally on a tab)
  const [newPatient, setNewPatient] = useState(false);
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
  const reloadAll = () => { load(page, search.trim()); };

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
                  onView={(uuid) => setViewPatient({ uuid, tab: 'facesheet' })}
                  onEncounters={(uuid) => setViewPatient({ uuid, tab: 'encounters' })}
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

      {viewPatient && <PatientModal uuid={viewPatient.uuid} initialTab={viewPatient.tab} onClose={() => setViewPatient(null)} onSaved={reloadAll} />}
      {newPatient && <PatientModal docMode="records" onClose={() => setNewPatient(false)} onSaved={reloadAll} />}
    </div>
  );
}

function PatientRow({ p, onView, onEncounters }) {
  return (
    <tr className="enc-group" onClick={() => onEncounters(p.patientUuid)} title="Open this patient's encounters">
      <td className="mono">{p.mrn || '—'}</td>
      <td className="enc-strong"><span className="enc-group-name">{p.patientName || '—'}</span></td>
      <td>{p.facilityName || '—'}</td>
      <td>{p.renderingProvider || '—'}</td>
      <td className="pf-muted">—</td>
      <td><span className="enc-count-badge">{p.encounterCount}</span></td>
      <td className="enc-action">
        <button className="act" onClick={(e) => { e.stopPropagation(); onView(p.patientUuid); }} title="View face sheet">View</button>
      </td>
    </tr>
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
