import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { auditApi, toApiError } from '../../lib/api.js';
import { NOTE_TYPES } from '../../lib/noteTemplates.js';
import { useToast } from '../../components/Toast.jsx';

/**
 * Super-admin activity log. Reads the immutable audit trail (server-side, super-admin
 * only) and presents it in PLAIN LANGUAGE — who did what, and when — grouped into clear
 * tabs: Notes, Sign-ins, and Eligibility. No technical codes or identifiers are shown.
 * Every value comes from the real audit_logs — nothing synthesized.
 */
const ROLE_LABEL = { master_admin: 'Master Admin', super_admin: 'Super Admin', provider: 'Provider', billing: 'Front Desk', system: 'System' };

// action code → [plain sentence, tab, category]. The tab groups related activity;
// 'records' = patient/facility/user changes (shown under All activity).
const ACTIONS = {
  'encounter.note.create': ['started a clinical note', 'notes', 'note'],
  'encounter.note.update': ['edited a clinical note', 'notes', 'note'],
  'encounter.note.sign': ['signed and finalized a clinical note', 'notes', 'sign'],
  'encounter.note.amend': ['amended a signed note', 'notes', 'amend'],
  'encounter.note.download': ['downloaded a clinical note', 'notes', 'download'],
  'encounter.create': ['opened an encounter', 'notes', 'note'],
  'encounter.status.update': ['updated an encounter', 'notes', 'note'],

  'auth.login.success': ['signed in', 'signins', 'in'],
  'auth.login.failure': ['had a failed sign-in attempt', 'signins', 'fail'],
  'auth.logout': ['signed out', 'signins', 'out'],
  'auth.account.locked': ['was locked out after repeated failed attempts', 'signins', 'lock'],
  'auth.password.change': ['changed their password', 'signins', 'pw'],
  'user.password.admin_reset': ["reset a user's password", 'signins', 'pw'],

  'patient.eligibility.verify': ['verified insurance benefits', 'eligibility', 'elig'],
  'appointment.eligibility.verify': ['checked appointment eligibility', 'eligibility', 'elig'],

  'appointment.create': ['scheduled an appointment', 'records', 'appt'],
  'appointment.delete': ['cancelled an appointment', 'records', 'appt'],
  'facility.assign_provider': ['assigned a provider to a facility', 'records', 'facility'],
  'facility.create': ['added a facility', 'records', 'facility'],
  'facility.delete': ['removed a facility', 'records', 'facility'],
  'facility.status': ['changed a facility status', 'records', 'facility'],
  'facility.unassign_provider': ['removed a provider from a facility', 'records', 'facility'],
  'facility.update': ['updated a facility', 'records', 'facility'],
  'patient.benefits.download': ['downloaded a benefits summary', 'records', 'download'],
  'patient.create': ['added a patient', 'records', 'patient'],
  'patient.delete': ['removed a patient', 'records', 'patient'],
  'patient.document.delete': ['deleted a patient document', 'records', 'doc'],
  'patient.document.extract': ['scanned a patient document', 'records', 'doc'],
  'patient.document.upload': ['uploaded a patient document', 'records', 'doc'],
  'patient.document.view': ['viewed a patient document', 'records', 'doc'],
  'patient.extract.stateless': ['scanned a document', 'records', 'doc'],
  'patient.facesheet.download': ['downloaded a face sheet', 'records', 'download'],
  'patient.update': ['updated a patient', 'records', 'patient'],
  'patient.view': ['opened a patient record', 'records', 'patient'],
  'settings.update': ['updated system settings', 'records', 'system'],
  'specialty.create': ['added a specialty', 'records', 'system'],
  'user.create': ['created a user account', 'records', 'user'],
  'user.delete': ['removed a user account', 'records', 'user'],
  'user.set_facilities': ["updated a user's facilities", 'records', 'user'],
  'user.update': ['updated a user account', 'records', 'user'],
};

const TABS = [
  ['all', 'All activity'],
  ['notes', 'Notes'],
  ['signins', 'Sign-ins'],
  ['eligibility', 'Eligibility'],
  ['providers', 'Providers'],
  ['billing', 'Front Desk'],
];
// Role-based tabs show EVERYTHING that role did (sign-ins + all their activity).
const ROLE_TABS = { providers: 'provider', billing: 'billing' };

const info = (action) => ACTIONS[action] || [(action || '').replace(/[._]/g, ' '), 'records', 'system'];

// A friendly, PHI-safe bit of context from the entry's metadata (never an identifier).
function context(e) {
  const m = e.metadata || {};
  const a = e.action || '';
  if (a.includes('eligibility')) {
    const payer = m.payer || null;
    const st = m.status ? String(m.status).toLowerCase() : null;
    const stLabel = st === 'active' || st === 'activecoverage' ? 'Active coverage'
      : st === 'inactive' ? 'Inactive coverage' : st ? cap(st) : null;
    if (m.error || m.code) return payer ? `${payer} · no response from payer` : 'No response from payer';
    return [payer, stLabel].filter(Boolean).join(' · ') || null;
  }
  if (a.startsWith('encounter.note') && m.noteType) return NOTE_TYPES[m.noteType]?.label || null;
  if (a.startsWith('facility.') && m.name) return m.name;
  if (a === 'specialty.create' && m.name) return m.name;
  if (a === 'user.set_facilities' && typeof m.count === 'number') return `${m.count} ${m.count === 1 ? 'facility' : 'facilities'}`;
  if (a === 'user.create' && m.role) return ROLE_LABEL[m.role] || cap(m.role);
  return null;
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const fmtFull = (t) => { try { return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return t || ''; } };
function fmtRel(t) {
  try {
    const d = new Date(t), s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
    const days = Math.round(h / 24); if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}
const csvEscape = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// Category glyph — a clean single-line SVG, no color-coded clutter.
const ICON = {
  note: 'M6 3h8l4 4v14H6zM14 3v4h4', sign: 'M4 18l5-1 9-9-4-4-9 9zM13 5l4 4', amend: 'M4 18l5-1 9-9-4-4-9 9zM13 5l4 4',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14', in: 'M10 17l5-5-5-5M15 12H3M13 4h6v16h-6',
  out: 'M14 17l5-5-5-5M19 12H7M11 4H5v16h6', fail: 'M12 3l9 16H3zM12 9v5M12 17v.5', lock: 'M6 10V8a6 6 0 1112 0v2M5 10h14v11H5z',
  pw: 'M6 10V8a6 6 0 1112 0v2M5 10h14v11H5z', elig: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM9 12l2 2 4-4',
  appt: 'M4 5h16v16H4zM4 9h16M8 3v4M16 3v4', facility: 'M4 21V8l8-5 8 5v13M9 21v-6h6v6', patient: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 21a7 7 0 0114 0',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4', user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 21a7 7 0 0114 0', system: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2 1-2 4-2-1M5 12l-2 1 2 4 2-1',
};

export default function AuditLogs({ users = [], facilities = [] }) {
  const toast = useToast();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('all');
  const [f, setF] = useState({ actorUuid: '', facilityUuid: '', q: '', dateFrom: '', dateTo: '' });
  const [expanded, setExpanded] = useState(null);
  const tRef = useRef(null);

  const setFilter = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = { limit: 1000 };
      Object.entries(f).forEach(([k, v]) => { if (v) params[k] = v; });
      const { data } = await auditApi.list(params);
      setEntries(data.entries || []);
    } catch (e) { if (!silent) { toast.error(toApiError(e).message); setEntries([]); } }
    finally { if (!silent) setLoading(false); }
  }, [f, toast]);

  useEffect(() => { clearTimeout(tRef.current); tRef.current = setTimeout(load, 280); return () => clearTimeout(tRef.current); }, [load]);

  // Real-time: silently refresh the trail every 15s so newly-captured events appear
  // without a manual reload (no spinner flicker; expanded rows stay put by uuid).
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 15000);
    return () => clearInterval(id);
  }, [load]);

  const accounts = useMemo(
    () => users.filter((u) => u.uuid).map((u) => [u.uuid, `${u.fullName || u.email} · ${ROLE_LABEL[u.role] || u.role}`]),
    [users],
  );

  const counts = useMemo(() => {
    const c = { all: entries.length, notes: 0, signins: 0, eligibility: 0, providers: 0, billing: 0 };
    for (const e of entries) {
      const t = info(e.action)[1]; if (c[t] != null) c[t]++;
      if (e.actorRole === 'provider') c.providers++;
      if (e.actorRole === 'billing') c.billing++;
    }
    return c;
  }, [entries]);

  const shown = useMemo(() => {
    if (tab === 'all') return entries;
    if (ROLE_TABS[tab]) return entries.filter((e) => e.actorRole === ROLE_TABS[tab]);
    return entries.filter((e) => info(e.action)[1] === tab);
  }, [entries, tab]);

  const downloadCsv = () => {
    const cols = ['When', 'Person', 'Role', 'Facility', 'Activity', 'Details', 'Outcome', 'IP address'];
    const rows = shown.map((e) => {
      const [phrase] = info(e.action);
      return [fmtFull(e.createdAt), e.actorName || e.actorEmail, ROLE_LABEL[e.actorRole] || e.actorRole || 'System',
        e.actorFacilities || '', cap(phrase), context(e) || '',
        (e.outcome === 'failure' || e.outcome === 'error') ? 'Unsuccessful' : e.outcome === 'skipped' ? 'No change' : 'Successful', e.ip || ''];
    });
    const csv = [cols, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  const Entry = (e) => {
    const [phrase, , cat] = info(e.action);
    const ctx = context(e);
    const failed = e.outcome === 'failure' || e.outcome === 'error';
    const skipped = e.outcome === 'skipped';
    const open = expanded === e.uuid;
    return (
      <Fragment key={e.uuid}>
        <div className={`ale ${open ? 'open' : ''}`} onClick={() => setExpanded(open ? null : e.uuid)}>
          <span className={`ale-ic ${failed ? 'is-fail' : ''}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={ICON[cat] || ICON.system} /></svg>
          </span>
          <div className="ale-main">
            <div className="ale-line">
              <b>{e.actorName || e.actorEmail || 'A user'}</b> {phrase}{ctx ? <span className="ale-ctx"> — {ctx}</span> : null}
              {failed ? <span className="ale-fail">Unsuccessful</span> : null}
              {skipped ? <span className="ale-skip">No change</span> : null}
            </div>
            <div className="ale-sub">
              <span className={`ale-role r-${e.actorRole || 'system'}`}>{ROLE_LABEL[e.actorRole] || e.actorRole || 'System'}</span>
              {e.actorFacilities ? <span className="ale-dot">·</span> : null}{e.actorFacilities ? <span>{e.actorFacilities}</span> : null}
            </div>
          </div>
          <div className="ale-when" title={fmtFull(e.createdAt)}>
            <span className="ale-rel">{fmtRel(e.createdAt)}</span>
            <span className="ale-abs">{fmtFull(e.createdAt)}</span>
          </div>
        </div>
        {open ? (
          <div className="ale-detail">
            <div><span>When</span>{fmtFull(e.createdAt)}</div>
            <div><span>Person</span>{e.actorName ? `${e.actorName} · ${e.actorEmail}` : e.actorEmail || '—'}</div>
            <div><span>Outcome</span>{failed ? 'Unsuccessful' : skipped ? 'No change made' : 'Successful'}</div>
            {e.ip ? <div><span>IP address</span>{e.ip}</div> : null}
            {ctx ? <div><span>Details</span>{ctx}</div> : null}
          </div>
        ) : null}
      </Fragment>
    );
  };

  return (
    <div className="al">
      <div className="al-tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`al-tab ${tab === k ? 'on' : ''}`} onClick={() => { setTab(k); setExpanded(null); }}>
            {l}<span className="al-tab-n">{counts[k] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="al-bar">
        <div className="al-search">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" /></svg>
          <input placeholder="Search people or activity…" value={f.q} onChange={(e) => setFilter('q', e.target.value)} />
        </div>
        <select className="select" value={f.actorUuid} onChange={(e) => setFilter('actorUuid', e.target.value)}><option value="">Everyone</option>{accounts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select className="select" value={f.facilityUuid} onChange={(e) => setFilter('facilityUuid', e.target.value)}><option value="">All facilities</option>{facilities.map((fa) => <option key={fa.uuid} value={fa.uuid}>{fa.name}</option>)}</select>
        <input className="input al-date" type="date" value={f.dateFrom} onChange={(e) => setFilter('dateFrom', e.target.value)} title="From date" />
        <span className="al-date-sep">→</span>
        <input className="input al-date" type="date" value={f.dateTo} onChange={(e) => setFilter('dateTo', e.target.value)} title="To date" />
        <button className="btn ghost sm al-csv" onClick={downloadCsv} disabled={!shown.length}>Export</button>
      </div>

      <div className="al-count">
        {!loading ? <span className="al-live" title="Updating in real time">Live</span> : null}
        {loading ? 'Loading…' : `${shown.length.toLocaleString()} ${shown.length === 1 ? 'event' : 'events'}`}
        {entries.length >= 1000 ? ' · showing the latest 1,000 — narrow the dates for older activity' : ''}
      </div>

      <div className="al-list">
        {loading ? (
          <div className="al-empty"><span className="spinner dark" /> Loading activity…</div>
        ) : shown.length === 0 ? (
          <div className="al-empty">No activity to show here yet.</div>
        ) : shown.map(Entry)}
      </div>
    </div>
  );
}
