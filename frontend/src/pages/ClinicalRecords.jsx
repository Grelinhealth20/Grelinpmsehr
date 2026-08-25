import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../components/Modal.jsx';
import NoteDocumentView from '../components/NoteDocumentView.jsx';
import { usDate, encNo } from '../components/EncounterNotes.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { encountersApi, toApiError } from '../lib/api.js';
import { NOTE_TYPES } from '../lib/noteTemplates.js';

const PER_PAGE = 25;
const hasMD = (user) => (user?.credentials || []).some((c) => String(c).toUpperCase().trim() === 'MD');
const procedureOf = (type) => NOTE_TYPES[type]?.label || type || '—';

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Yet to Sign' },
  { key: 'signed', label: 'Signed' },
];

function pageWindow(page, totalPages) {
  const out = [];
  const add = (n) => out.push(n);
  if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) add(i); return out; }
  add(1);
  const s = Math.max(2, page - 1);
  const e = Math.min(totalPages - 1, page + 1);
  if (s > 2) add('…');
  for (let i = s; i <= e; i++) add(i);
  if (e < totalPages - 1) add('…');
  add(totalPages);
  return out;
}

export default function ClinicalRecords() {
  const toast = useToast();
  const { user } = useAuth();
  const isMD = hasMD(user);

  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const firstLoad = useRef(true);

  // Per-record PDF download. Signed records are downloadable by anyone with access;
  // an unsigned draft is downloadable only by an MD (also enforced server-side).
  async function downloadRecord(r, e) {
    e?.stopPropagation();
    setDownloadingId(r.noteUuid);
    try {
      await encountersApi.downloadNote(r.noteUuid, `medical-record-${r.mrn || 'record'}-${(r.date || '').replace(/-/g, '') || r.encounterNo || ''}.pdf`);
    } catch (err) { toast.error(toApiError(err).message); } finally { setDownloadingId(null); }
  }

  async function load(p, q, st) {
    setLoading(true);
    try {
      const { data } = await encountersApi.clinicalRecords({ page: p, pageSize: PER_PAGE, q, status: st });
      setRecords(data.records || []);
      setTotal(data.total || 0);
    } catch (e) { toast.error(toApiError(e).message); } finally { setLoading(false); }
  }

  useEffect(() => {
    const delay = firstLoad.current ? 0 : 300;
    firstLoad.current = false;
    const t = setTimeout(() => { setPage(1); load(1, search.trim(), status); }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const goPage = (pp) => { setPage(pp); load(pp, search.trim(), status); };
  const win = useMemo(() => pageWindow(page, totalPages), [page, totalPages]);

  return (
    <div className="clr">
      <div className="clr-bar">
        <div className="clr-title">
          <span className="clr-title-main">Clinical Records</span>
          <span className="clr-title-sub">
            {loading ? 'Loading…' : `${total} record${total === 1 ? '' : 's'}`}
            {isMD ? ' · facility-wide (MD)' : ' · your records'}
          </span>
        </div>
        <span className="spacer" />
        <div className="clr-tabs">
          {STATUS_TABS.map((t) => (
            <button key={t.key} className={`clr-tab ${status === t.key ? 'is-on' : ''}`} onClick={() => setStatus(t.key)}>{t.label}</button>
          ))}
        </div>
        <input className="input search" placeholder="Search MRN, Encounter ID or name…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="clr-table-wrap">
        <table className="table clr-table">
          <thead>
            <tr>
              <th>MRN</th>
              <th>Encounter ID</th>
              <th>Date of Service</th>
              <th>Patient Name</th>
              <th>SNF Facility</th>
              <th>Rendering Provider</th>
              <th>Notes</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="table-empty"><span className="spinner dark" /> Loading…</td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={9} className="table-empty">{search || status ? 'No records match.' : 'No clinical records yet.'}</td></tr>
            ) : (
              records.map((r) => (
                <tr key={r.noteUuid}>
                  <td className="mono">{r.mrn || '—'}</td>
                  <td className="mono">{encNo(r.encounterNo)}</td>
                  <td>{usDate(r.date)}</td>
                  <td className="clr-nm">{r.patientName || '—'}</td>
                  <td>{r.facilityName || '—'}</td>
                  <td>{r.renderingProvider || '—'}</td>
                  <td>{procedureOf(r.noteType)}</td>
                  <td>
                    {r.status === 'signed'
                      ? <span className="clr-badge signed"><span className="dot" />Signed</span>
                      : <span className="clr-badge draft"><span className="dot" />Yet to Sign</span>}
                  </td>
                  <td>
                    <div className="clr-actions">
                      <button className="act accent" onClick={() => setViewing(r)}>View</button>
                      {(r.status === 'signed' || isMD) && (
                        <button
                          className="act"
                          onClick={(e) => downloadRecord(r, e)}
                          disabled={downloadingId === r.noteUuid}
                          title={r.status === 'signed' ? 'Download this record as a PDF' : 'Download draft (MD)'}
                        >
                          {downloadingId === r.noteUuid ? <span className="spinner dark" /> : 'Download'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="pager">
          <button className="pager-btn" disabled={page <= 1} onClick={() => goPage(page - 1)}>‹ Prev</button>
          {win.map((n, i) => (n === '…'
            ? <span key={`e${i}`} className="pager-ellipsis">…</span>
            : <button key={n} className={`pager-num ${n === page ? 'is-on' : ''}`} onClick={() => goPage(n)}>{n}</button>))}
          <button className="pager-btn" disabled={page >= totalPages} onClick={() => goPage(page + 1)}>Next ›</button>
        </div>
      )}

      {viewing && (
        <ClinicalNoteModal
          record={viewing}
          canSign={isMD}
          onClose={() => setViewing(null)}
          onSigned={() => { setViewing(null); load(page, search.trim(), status); }}
        />
      )}
    </div>
  );
}

/** Full-window read-only note view with MD sign-off. */
function ClinicalNoteModal({ record, canSign, onClose, onSigned }) {
  const toast = useToast();
  const [note, setNote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    encountersApi.getNote(record.noteUuid)
      .then(({ data }) => active && setNote(data.note))
      .catch((e) => active && toast.error(toApiError(e).message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.noteUuid]);

  const signed = note?.status === 'signed';
  // Only signed records download; a draft is downloadable only by an MD (also
  // enforced server-side). Hide the control entirely when neither applies.
  const canDownload = !loading && !!note && (signed || canSign);

  async function download() {
    setBusy(true);
    try {
      await encountersApi.downloadNote(record.noteUuid, `medical-record-${record.mrn || 'record'}.pdf`);
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  }

  async function sign() {
    setBusy(true);
    try {
      await encountersApi.signNote(record.noteUuid, { content: note.content, reason: note.reason || undefined });
      toast.success('Note signed — finalized and saved for billing.');
      onSigned();
    } catch (e) { toast.error(toApiError(e).message); setBusy(false); }
  }

  return (
    <Modal
      size="full"
      title={`Clinical Note · ${record.patientName || 'Patient'}`}
      onClose={onClose}
      footer={<>
        <span className="nt-foot-meta">Encounter {encNo(record.encounterNo)} · DOS {usDate(record.date)}</span>
        {signed
          ? <span className="clr-signed-flag"><span className="dot" />Signed by {note?.signedByName || 'MD'}</span>
          : <span className="clr-draft-flag">Yet to Sign</span>}
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose} disabled={busy}>Close</button>
        {canDownload && (
          <button className="btn ghost" onClick={download} disabled={busy} title="Download this record as a PDF">
            {busy ? <span className="spinner" /> : 'Download PDF'}
          </button>
        )}
        {canSign && !signed && (
          <button className="btn" onClick={sign} disabled={busy || loading} title="Approve & sign off for billing">
            {busy ? <span className="spinner" /> : 'Sign & finalize'}
          </button>
        )}
      </>}
    >
      {loading ? (
        <div className="table-empty" style={{ padding: 40 }}><span className="spinner dark" /> Loading note…</div>
      ) : !note ? (
        <div className="table-empty" style={{ padding: 40 }}>Note not found.</div>
      ) : (
        <NoteDocumentView note={note} meta={record} />
      )}
    </Modal>
  );
}
