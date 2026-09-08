import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { auditApi, toApiError } from '../../lib/api.js';
import { NOTE_TYPES } from '../../lib/noteTemplates.js';
import { useToast } from '../../components/Toast.jsx';

/**
 * Super-admin activity log. Reads the immutable audit trail (server-side, super-admin only) and presents
 * it in PLAIN LANGUAGE — who did what, and when — as summary cards + a clean, aligned table with real
 * BACKEND pagination (exact totals at any scale). Grouped by tab (Notes, Sign-ins, Eligibility, roles).
 * Every value comes from the real audit_logs — nothing synthesized.
 */
const ROLE_LABEL = { master_admin: 'Master Admin', super_admin: 'Super Admin', provider: 'Provider', billing: 'Front Desk', system: 'System' };
const PAGE_SIZE = 25;

// action code → [plain sentence, tab, category glyph].
const ACTIONS = {
  'encounter.note.create': ['started a clinical note', 'notes', 'note'],
  'encounter.note.update': ['edited a clinical note', 'notes', 'note'],
  'encounter.note.sign': ['signed and finalized a clinical note', 'notes', 'sign'],
  'encounter.note.amend': ['amended a signed note', 'notes', 'amend'],
  'encounter.note.delete': ['deleted a draft note', 'notes', 'note'],
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
  'facility.flags': ['changed a facility’s features', 'records', 'facility'],
  'facility.fax_config': ['updated a facility’s referral fax settings', 'records', 'facility'],
  'referral.create': ['created a referral', 'records', 'doc'],
  'referral.update': ['updated a referral', 'records', 'doc'],
  'referral.delete': ['deleted a referral', 'records', 'doc'],
  'referral.fax.send': ['faxed a referral', 'records', 'doc'],
  'referral.fax.restore': ['retrieved a received fax document', 'records', 'doc'],
  'referral.attachment.add': ['enclosed a record in a referral', 'records', 'doc'],
  'referral.attachment.delete': ['removed a referral record', 'records', 'doc'],
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
  // Account status + MFA administration (Super Admin).
  'user.status.active': ['re-activated an account', 'records', 'user'],
  'user.status.restricted': ['restricted an account', 'records', 'user'],
  'user.status.disabled': ['disabled an account', 'records', 'user'],
  'user.mfa.enabled': ['required MFA for a user', 'records', 'pw'],
  'user.mfa.disabled': ['disabled MFA for a user', 'records', 'pw'],
  'user.mfa.reset': ['reset a user’s MFA enrollment', 'records', 'pw'],
  // Sign-in security events.
  'auth.mfa.enrolled': ['set up MFA (2FA)', 'signins', 'pw'],
  'auth.mfa.verified': ['passed MFA verification', 'signins', 'in'],
  'auth.mfa.recovery_used': ['signed in with an MFA recovery code', 'signins', 'lock'],
  'auth.refresh.reuse': ['triggered a session-token reuse alert', 'signins', 'lock'],
  // Break-glass emergency access (ONC (d)(6)).
  'patient.emergency_access.grant': ['granted emergency break-glass access', 'records', 'lock'],
  'patient.emergency_access.use': ['used emergency break-glass access', 'records', 'lock'],
  // Custom note templates + encounter documents + note codes.
  'encounter.customTemplate.create': ['created a custom note template', 'notes', 'note'],
  'encounter.customTemplate.update': ['updated a custom note template', 'notes', 'note'],
  'encounter.customTemplate.delete': ['deleted a custom note template', 'notes', 'note'],
  'encounter.customTemplate.aiDraft': ['drafted a note template with AI', 'notes', 'note'],
  'template.generate': ['generated a note template with AI', 'notes', 'note'],
  'encounter.document.upload': ['uploaded an encounter document', 'notes', 'doc'],
  'encounter.document.view': ['viewed an encounter document', 'notes', 'doc'],
  'encounter.document.delete': ['deleted an encounter document', 'notes', 'doc'],
  'encounter.note.codes': ['updated a note’s billing codes', 'notes', 'note'],
  // Referral generation + on-demand fax AI.
  'referral.generate': ['generated a referral letter', 'records', 'doc'],
  'referral.fax.ai': ['ran AI on a referral fax', 'records', 'doc'],
  'referral.fax.inbox_sync': ['synced the Fax.Plus inbox', 'records', 'doc'],
};

// Tabs → the backend filter they send (category for activity tabs, role for people tabs).
const TABS = [
  ['all', 'All activity', {}],
  ['notes', 'Notes', { category: 'notes' }],
  ['signins', 'Sign-ins', { category: 'signins' }],
  ['eligibility', 'Eligibility', { category: 'eligibility' }],
  ['providers', 'Providers', { role: 'provider' }],
  ['billing', 'Front Desk', { role: 'billing' }],
];

const info = (action) => ACTIONS[action] || [(action || '').replace(/[._]/g, ' '), 'records', 'system'];
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

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
  if (a.startsWith('referral') && m.specialty) return m.specialty;
  return null;
}

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
const outcomeOf = (e) => ((e.outcome === 'failure' || e.outcome === 'error') ? 'fail' : e.outcome === 'skipped' ? 'skip' : 'ok');
const OUTCOME_LABEL = { ok: 'Successful', fail: 'Unsuccessful', skip: 'No change' };

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
  const [data, setData] = useState({ entries: [], total: 0, page: 1, pageSize: PAGE_SIZE, summary: null, tabCounts: {} });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('all');
  const [page, setPage] = useState(1);
  const [f, setF] = useState({ actorUuid: '', facilityUuid: '', q: '', dateFrom: '', dateTo: '', outcome: '' });
  const [expanded, setExpanded] = useState(null);
  const tRef = useRef(null);
  const setFilter = (k, v) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };

  const buildParams = useCallback((p = page) => {
    const tabDef = TABS.find((t) => t[0] === tab)?.[2] || {};
    const params = { page: p, pageSize: PAGE_SIZE, ...tabDef };
    Object.entries(f).forEach(([k, v]) => { if (v) params[k] = v; });
    return params;
  }, [tab, f, page]);

  const load = useCallback(async (silent = false, p = page) => {
    if (!silent) setLoading(true);
    try {
      const { data: d } = await auditApi.list(buildParams(p));
      setData(d);
    } catch (e) { if (!silent) { toast.error(toApiError(e).message); setData((x) => ({ ...x, entries: [], total: 0 })); } }
    finally { if (!silent) setLoading(false); }
  }, [buildParams, page, toast]);

  // Debounced reload when tab/filters/page change.
  useEffect(() => { clearTimeout(tRef.current); tRef.current = setTimeout(() => load(false, page), 260); return () => clearTimeout(tRef.current); }, [tab, f, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real-time: silently refresh the current page every 15s so new events appear without a spinner.
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(true, page); }, 15000);
    return () => clearInterval(id);
  }, [load, page]);

  const accounts = useMemo(
    () => users.filter((u) => u.uuid).map((u) => [u.uuid, `${u.fullName || u.email} · ${ROLE_LABEL[u.role] || u.role}`]),
    [users],
  );
  const tabCounts = data.tabCounts || {};
  const summary = data.summary;
  const totalPages = Math.max(1, Math.ceil((data.total || 0) / PAGE_SIZE));

  const downloadCsv = async () => {
    try {
      const { data: d } = await auditApi.list({ ...buildParams(1), pageSize: 10000 });
      const cols = ['When', 'Person', 'Role', 'Facility', 'Activity', 'Details', 'Outcome', 'IP address'];
      const rows = (d.entries || []).map((e) => {
        const [phrase] = info(e.action);
        return [fmtFull(e.createdAt), e.actorName || e.actorEmail, ROLE_LABEL[e.actorRole] || e.actorRole || 'System',
          e.actorFacilities || '', cap(phrase), context(e) || '', OUTCOME_LABEL[outcomeOf(e)], e.ip || ''];
      });
      const csv = [cols, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { toast.error(toApiError(e).message); }
  };

  const from = data.total === 0 ? 0 : (data.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(data.total, data.page * PAGE_SIZE);

  return (
    <div className="al">
      {/* Summary cards — accurate aggregates over the current scope filters */}
      <div className="al-cards">
        <Card label="Total events" value={summary?.total} tone="brand" icon={ICON.system} />
        <Card label="Successful" value={summary?.successful} tone="good" icon={ICON.elig} />
        <Card label="Unsuccessful" value={summary?.unsuccessful} tone={summary?.unsuccessful ? 'bad' : 'muted'} icon={ICON.fail} />
        <Card label="Active people" value={summary?.people} tone="info" icon={ICON.user} />
      </div>

      <div className="al-tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`al-tab ${tab === k ? 'on' : ''}`}
            onClick={() => { setTab(k); setPage(1); setExpanded(null); }}>
            {l}<span className="al-tab-n">{(tabCounts[k] ?? 0).toLocaleString()}</span>
          </button>
        ))}
      </div>

      <div className="al-bar">
        <div className="al-search">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" /></svg>
          <input placeholder="Search activity…" value={f.q} onChange={(e) => setFilter('q', e.target.value)} />
        </div>
        <select className="select" value={f.actorUuid} onChange={(e) => setFilter('actorUuid', e.target.value)}><option value="">Everyone</option>{accounts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select className="select" value={f.facilityUuid} onChange={(e) => setFilter('facilityUuid', e.target.value)}><option value="">All facilities</option>{facilities.map((fa) => <option key={fa.uuid} value={fa.uuid}>{fa.name}</option>)}</select>
        <select className="select" value={f.outcome} onChange={(e) => setFilter('outcome', e.target.value)}><option value="">Any outcome</option><option value="success">Successful</option><option value="failure">Unsuccessful</option><option value="skipped">No change</option></select>
        <input className="input al-date" type="date" value={f.dateFrom} onChange={(e) => setFilter('dateFrom', e.target.value)} title="From date" />
        <span className="al-date-sep">→</span>
        <input className="input al-date" type="date" value={f.dateTo} onChange={(e) => setFilter('dateTo', e.target.value)} title="To date" />
        <span className="spacer" />
        {!loading && <span className="al-live" title="Updating in real time">Live</span>}
        <button className="btn ghost sm al-csv" onClick={downloadCsv} disabled={!data.total}>Export CSV</button>
      </div>

      <div className="al-tablewrap">
        <table className="al-table">
          <thead>
            <tr>
              <th className="al-th-when">When</th><th>Person</th><th>Role</th><th>Facility</th>
              <th>Activity</th><th>Details</th><th className="al-th-out">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="al-empty"><span className="spinner dark" /> Loading activity…</td></tr>
            ) : data.entries.length === 0 ? (
              <tr><td colSpan={7} className="al-empty">No activity matches these filters.</td></tr>
            ) : data.entries.map((e) => {
              const [phrase, , cat] = info(e.action);
              const ctx = context(e);
              const oc = outcomeOf(e);
              const open = expanded === e.uuid;
              return (
                <Fragment key={e.uuid}>
                  <tr className={`al-row ${open ? 'open' : ''}`} onClick={() => setExpanded(open ? null : e.uuid)}>
                    <td className="al-when" title={fmtFull(e.createdAt)}><span className="al-rel">{fmtRel(e.createdAt)}</span></td>
                    <td className="al-person"><span className="al-name">{e.actorName || e.actorEmail || 'A user'}</span>{e.actorName && e.actorEmail ? <span className="al-email">{e.actorEmail}</span> : null}</td>
                    <td><span className={`ale-role r-${e.actorRole || 'system'}`}>{ROLE_LABEL[e.actorRole] || e.actorRole || 'System'}</span></td>
                    <td className="al-fac">{e.actorFacilities || '—'}</td>
                    <td className="al-act"><span className="al-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={ICON[cat] || ICON.system} /></svg></span>{cap(phrase)}</td>
                    <td className="al-det">{ctx || '—'}</td>
                    <td><span className={`al-out ${oc}`}>{OUTCOME_LABEL[oc]}</span></td>
                  </tr>
                  {open && (
                    <tr className="al-detailrow">
                      <td colSpan={7}>
                        <div className="al-detailgrid">
                          <div><span>When</span>{fmtFull(e.createdAt)}</div>
                          <div><span>Person</span>{e.actorName ? `${e.actorName} · ${e.actorEmail}` : e.actorEmail || '—'}</div>
                          <div><span>Outcome</span>{OUTCOME_LABEL[oc]}</div>
                          {e.ip ? <div><span>IP address</span>{e.ip}</div> : null}
                          {ctx ? <div><span>Details</span>{ctx}</div> : null}
                          {e.entityType ? <div><span>Record</span>{e.entityType}</div> : null}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && data.total > 0 && (
        <div className="al-pager">
          <span className="al-range">Showing <b>{from.toLocaleString()}–{to.toLocaleString()}</b> of <b>{data.total.toLocaleString()}</b></span>
          <span className="spacer" />
          {totalPages > 1 && <Pager page={data.page} totalPages={totalPages} onGo={(n) => setPage(n)} />}
        </div>
      )}
    </div>
  );
}

function Card({ label, value, tone, icon }) {
  return (
    <div className={`al-card ${tone || ''}`}>
      <span className="al-card-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg></span>
      <span className="al-card-v">{value == null ? '—' : Number(value).toLocaleString()}</span>
      <span className="al-card-l">{label}</span>
    </div>
  );
}

function Pager({ page, totalPages, onGo }) {
  let lo = Math.max(1, page - 2), hi = Math.min(totalPages, page + 2);
  if (page <= 3) hi = Math.min(totalPages, 5);
  if (page >= totalPages - 2) lo = Math.max(1, totalPages - 4);
  const win = []; for (let i = lo; i <= hi; i += 1) win.push(i);
  const go = (n) => { const t = Math.min(totalPages, Math.max(1, n)); if (t !== page) onGo(t); };
  return (
    <div className="al-pager-nav">
      <button className="pgb" disabled={page <= 1} onClick={() => go(1)} title="First">«</button>
      <button className="pgb" disabled={page <= 1} onClick={() => go(page - 1)} title="Previous">‹</button>
      {lo > 1 && <span className="pg-ell">…</span>}
      {win.map((n) => <button key={n} className={`pgb ${n === page ? 'is-on' : ''}`} onClick={() => go(n)}>{n}</button>)}
      {hi < totalPages && <span className="pg-ell">…</span>}
      <button className="pgb" disabled={page >= totalPages} onClick={() => go(page + 1)} title="Next">›</button>
      <button className="pgb" disabled={page >= totalPages} onClick={() => go(totalPages)} title="Last">»</button>
    </div>
  );
}
