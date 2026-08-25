import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { auditApi, toApiError } from '../../lib/api.js';
import { useToast } from '../../components/Toast.jsx';

/**
 * Super-admin audit log console. Reads the immutable audit trail (server-side,
 * super-admin only), grouped/filtered by account, role, and facility, with CSV
 * download. Every value comes from the real audit_logs — nothing synthesized.
 */
const ROLE_LABEL = { master_admin: 'Master Admin', super_admin: 'Super Admin', provider: 'Provider', billing: 'Billing', system: 'System' };
const ROLE_OPTS = [['', 'All roles'], ['provider', 'Providers'], ['billing', 'Billing'], ['super_admin', 'Super Admins'], ['master_admin', 'Master Admins']];
const GROUP_OPTS = [['none', 'No grouping'], ['account', 'By account'], ['facility', 'By facility'], ['role', 'By role']];

const fmtTime = (t) => { try { return new Date(t).toLocaleString(); } catch { return t || ''; } };
const actionLabel = (a) => (a || '').replace(/[._]/g, ' ');
const csvEscape = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export default function AuditLogs({ users = [], facilities = [] }) {
  const toast = useToast();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState({ role: '', actorUuid: '', facilityUuid: '', q: '', dateFrom: '', dateTo: '' });
  const [groupBy, setGroupBy] = useState('none');
  const [expanded, setExpanded] = useState(null);
  const tRef = useRef(null);

  const setFilter = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: 1000 };
      Object.entries(f).forEach(([k, v]) => { if (v) params[k] = v; });
      const { data } = await auditApi.list(params);
      setEntries(data.entries || []);
    } catch (e) { toast.error(toApiError(e).message); setEntries([]); }
    finally { setLoading(false); }
  }, [f, toast]);

  useEffect(() => { clearTimeout(tRef.current); tRef.current = setTimeout(load, 280); return () => clearTimeout(tRef.current); }, [load]);

  const accounts = useMemo(
    () => users.filter((u) => u.uuid).map((u) => [u.uuid, `${u.fullName || u.email} · ${ROLE_LABEL[u.role] || u.role}`]),
    [users],
  );

  const groups = useMemo(() => {
    if (groupBy === 'none') return null;
    const map = new Map();
    for (const e of entries) {
      const key = groupBy === 'account' ? (e.actorName ? `${e.actorName} · ${e.actorEmail}` : e.actorEmail)
        : groupBy === 'facility' ? (e.actorFacilities || 'No facility assigned')
        : (ROLE_LABEL[e.actorRole] || e.actorRole || 'System');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [entries, groupBy]);

  const downloadCsv = () => {
    const cols = ['Time', 'Account', 'Email', 'Role', 'Facilities', 'Action', 'Entity type', 'Entity id', 'Outcome', 'IP', 'Details'];
    const rows = entries.map((e) => [
      fmtTime(e.createdAt), e.actorName || '', e.actorEmail, ROLE_LABEL[e.actorRole] || e.actorRole || '',
      e.actorFacilities || '', e.action, e.entityType || '', e.entityId || '', e.outcome, e.ip || '',
      e.metadata ? JSON.stringify(e.metadata) : '',
    ]);
    const csv = [cols, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  const Row = (e) => (
    <Fragment key={e.uuid}>
      <tr className={`al-row ${expanded === e.uuid ? 'open' : ''} ${e.metadata ? 'has-meta' : ''}`} onClick={() => e.metadata && setExpanded(expanded === e.uuid ? null : e.uuid)}>
        <td className="al-time">{fmtTime(e.createdAt)}</td>
        <td><div className="al-actor"><span className="al-actor-nm">{e.actorName || e.actorEmail}</span>{e.actorName ? <span className="al-actor-em">{e.actorEmail}</span> : null}</div></td>
        <td><span className={`al-role r-${e.actorRole || 'system'}`}>{ROLE_LABEL[e.actorRole] || e.actorRole || 'System'}</span></td>
        <td className="al-fac">{e.actorFacilities || ''}</td>
        <td className="al-action">{actionLabel(e.action)}</td>
        <td className="al-entity">{e.entityType || ''}{e.entityId ? <span className="al-eid">{e.entityId}</span> : null}</td>
        <td><span className={`al-out ${e.outcome}`}>{e.outcome}</span></td>
        <td className="al-ip">{e.ip || ''}</td>
      </tr>
      {expanded === e.uuid && e.metadata ? (
        <tr className="al-meta-row"><td colSpan={8}><pre className="al-meta">{JSON.stringify(e.metadata, null, 2)}</pre></td></tr>
      ) : null}
    </Fragment>
  );

  return (
    <div className="al">
      <div className="al-bar">
        <div className="al-filters">
          <select className="select" value={f.role} onChange={(e) => setFilter('role', e.target.value)}>{ROLE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="select" value={f.actorUuid} onChange={(e) => setFilter('actorUuid', e.target.value)}><option value="">All accounts</option>{accounts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="select" value={f.facilityUuid} onChange={(e) => setFilter('facilityUuid', e.target.value)}><option value="">All facilities</option>{facilities.map((fa) => <option key={fa.uuid} value={fa.uuid}>{fa.name}</option>)}</select>
          <input className="input" placeholder="Action or entity…" value={f.q} onChange={(e) => setFilter('q', e.target.value)} />
          <input className="input" type="date" value={f.dateFrom} onChange={(e) => setFilter('dateFrom', e.target.value)} title="From date" />
          <input className="input" type="date" value={f.dateTo} onChange={(e) => setFilter('dateTo', e.target.value)} title="To date" />
        </div>
        <div className="al-actions">
          <div className="al-group"><span>Group</span>
            <select className="select" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{GROUP_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <button className="btn ghost sm" onClick={downloadCsv} disabled={!entries.length}>↓ Download CSV</button>
        </div>
      </div>

      <div className="al-count">{loading ? 'Loading…' : `${entries.length.toLocaleString()} event${entries.length === 1 ? '' : 's'}`}{entries.length >= 1000 ? ' · showing latest 1,000 — narrow the filters for more' : ''}</div>

      <div className="card table-card">
        <div className="table-wrap">
          <table className="table al-table">
            <thead><tr><th>Time</th><th>Account</th><th>Role</th><th>Facility</th><th>Action</th><th>Entity</th><th>Outcome</th><th>IP</th></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="table-empty"><span className="spinner dark" /> Loading audit trail…</td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={8} className="table-empty">No log entries match these filters.</td></tr>
              ) : groups ? (
                groups.map(([key, list]) => (
                  <Fragment key={`g-${key}`}>
                    <tr className="al-grp"><td colSpan={8}><span className="al-grp-k">{key}</span><span className="al-grp-n">{list.length} event{list.length === 1 ? '' : 's'}</span></td></tr>
                    {list.map(Row)}
                  </Fragment>
                ))
              ) : entries.map(Row)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
