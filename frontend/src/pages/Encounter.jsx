import { useEffect, useMemo, useState } from 'react';
import PatientModal from '../components/PatientModal.jsx';
import { useToast } from '../components/Toast.jsx';
import { encountersApi, toApiError } from '../lib/api.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (iso) => { const [y, m, d] = (iso || '').split('-').map(Number); return m ? `${MONTHS[m - 1]} ${d}, ${y}` : '—'; };
const fmtTime = (min) => { if (min == null) return ''; const h = Math.floor(min / 60); const ap = h < 12 ? 'AM' : 'PM'; return `${((h + 11) % 12) + 1}:${pad(min % 60)} ${ap}`; };

const ELIG = {
  not_verified: { label: 'Not verified', cls: 'disabled' },
  pending: { label: 'Pending', cls: 'restricted' },
  eligible: { label: 'Eligible', cls: 'active' },
  ineligible: { label: 'Ineligible', cls: 'danger' },
};
const CHART = {
  not_seen: { label: 'Patient not yet seen', cls: 'restricted' },
  charts_completed: { label: 'Charts completed', cls: 'active' },
  cancelled: { label: 'Cancelled', cls: 'disabled' },
};
function Pill({ map, value }) {
  const s = map[value] || { label: value || '—', cls: 'disabled' };
  const danger = s.cls === 'danger';
  return (
    <span className={`badge ${danger ? '' : s.cls}`} style={danger ? { background: 'var(--c-danger-050)', color: 'var(--c-danger)' } : undefined}>
      <span className="dot" style={danger ? { background: 'var(--c-danger)' } : undefined} />{s.label}
    </span>
  );
}

/** Encounter worklist — backend-wired, grouped by patient with encounter sub-rows. */
export default function Encounter() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [viewPatient, setViewPatient] = useState(null);

  async function load() {
    setLoading(true);
    try { const { data } = await encountersApi.list(); setRows(data.encounters); }
    catch (e) { toast.error(toApiError(e).message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.patientName || '').toLowerCase().includes(q) ||
      (r.mrn || '').toLowerCase().includes(q) ||
      (r.accountNumber || '').toLowerCase().includes(q));
  }, [rows, search]);

  // Group encounters by patient (unlinked ones fall into a single group).
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const key = r.patientUuid || '__unlinked__';
      if (!map.has(key)) {
        map.set(key, {
          key, patientUuid: r.patientUuid,
          accountNumber: r.accountNumber, mrn: r.mrn,
          patientName: r.patientUuid ? r.patientName : 'Unlinked encounters',
          facilityName: r.facilityName, renderingProvider: r.renderingProvider,
          encounters: [],
        });
      }
      map.get(key).encounters.push(r);
    }
    return [...map.values()].sort((a, b) => (a.patientName || '').localeCompare(b.patientName || ''));
  }, [filtered]);

  const toggle = (key) => setCollapsed((c) => { const n = new Set(c); n.has(key) ? n.delete(key) : n.add(key); return n; });

  return (
    <div className="enc">
      <div className="enc-bar">
        <div className="enc-title">
          <span className="enc-title-main">Patients &amp; Encounters</span>
          <span className="enc-title-sub">{loading ? 'Loading…' : `${groups.length} patient${groups.length === 1 ? '' : 's'} · ${filtered.length} encounter${filtered.length === 1 ? '' : 's'}`}</span>
        </div>
        <span className="spacer" />
        <input className="input search" placeholder="Search patient, MRN or account…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="enc-table-wrap">
        <table className="table enc-table">
          <thead>
            <tr>
              <th>Account Number</th>
              <th>MRN</th>
              <th>Appointment Date</th>
              <th>Patient Name</th>
              <th>Facility Name</th>
              <th>Rendering Provider</th>
              <th>Eligibility Status</th>
              <th>Encounter's Count</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="table-empty"><span className="spinner dark" /> Loading…</td></tr>
            ) : groups.length === 0 ? (
              <tr><td colSpan={9} className="table-empty">No encounters yet. Book an appointment to create one.</td></tr>
            ) : (
              groups.map((g) => {
                const open = !collapsed.has(g.key);
                return (
                  <FragmentGroup
                    key={g.key}
                    g={g}
                    open={open}
                    onToggle={() => toggle(g.key)}
                    onView={(uuid) => setViewPatient(uuid)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {viewPatient && <PatientModal uuid={viewPatient} onClose={() => setViewPatient(null)} onSaved={() => load()} />}
    </div>
  );
}

function FragmentGroup({ g, open, onToggle, onView }) {
  const n = g.encounters.length;
  return (
    <>
      <tr className={`enc-group ${open ? 'is-open' : ''}`} onClick={onToggle}>
        <td className="mono">{g.accountNumber || '—'}</td>
        <td className="mono">{g.mrn || '—'}</td>
        <td className="enc-nowrap">{fmtDate(g.encounters[0].date)} · {fmtTime(g.encounters[0].startMin)}</td>
        <td className="enc-strong">
          <span className="enc-group-name"><span className={`enc-chev ${open ? 'open' : ''}`} aria-hidden="true" />{g.patientName || '—'}</span>
        </td>
        <td>{g.facilityName || '—'}</td>
        <td>{g.renderingProvider || '—'}</td>
        <td />
        <td><span className="enc-count-badge">{n}</span></td>
        <td className="enc-action">
          {g.patientUuid && <button className="act" onClick={(e) => { e.stopPropagation(); onView(g.patientUuid); }} title="View face sheet">View</button>}
        </td>
      </tr>
      {open && g.encounters.map((r) => (
        <tr className="enc-child" key={r.appointmentUuid}>
          <td />
          <td />
          <td className="enc-nowrap enc-child-date">{fmtDate(r.date)} · {fmtTime(r.startMin)}</td>
          <td />
          <td />
          <td />
          <td><Pill map={ELIG} value={r.eligibilityStatus} /></td>
          <td><Pill map={CHART} value={r.chartStatus} /></td>
          <td className="enc-action">
            <button className="act" disabled={!r.patientUuid} onClick={() => onView(r.patientUuid)} title={r.patientUuid ? 'View face sheet' : 'No patient linked'}>View</button>
          </td>
        </tr>
      ))}
    </>
  );
}
