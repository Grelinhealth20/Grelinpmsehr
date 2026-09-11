import { useEffect, useMemo, useState } from 'react';
import { usDate } from '../../lib/dates.js';
import { reportsApi, usersApi, saveBlob, toApiError } from '../../lib/api.js';

/**
 * Super Admin · Payscale — group-wide, real-time provider compensation (master + super admin). Shows each
 * provider's pay for the selected bi-weekly / monthly period, filterable by facility and provider. Clean
 * and provider-focused (no technical jargon): Provider · Encounters · Pay. Pay is computed on the backend
 * from each provider's signed, payable procedures (CMS 2026 PFS) — no mock data.
 */
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

function buildPeriods(type, count = 6, ref = new Date()) {
  const out = [];
  if (type === 'biweekly') {
    const A = Date.UTC(2024, 0, 1); const P = 14 * 864e5;
    const t = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
    const idx = Math.floor((t - A) / P);
    for (let i = 0; i < count; i++) { const s = A + (idx - i) * P; const e = s + P; out.push({ label: `${usDate(ymd(s))} – ${usDate(ymd(e - 864e5))}`, from: ymd(s), to: ymd(e) }); }
  } else {
    for (let i = 0; i < count; i++) {
      const s = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - i, 1);
      const e = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - i + 1, 1);
      out.push({ label: new Date(s).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), from: ymd(s), to: ymd(e) });
    }
  }
  return out;
}

export default function PayscaleAdmin({ facilities = [], role = '' }) {
  const [providers, setProviders] = useState([]);
  const [facilityUuid, setFacilityUuid] = useState('');
  const [providerUuid, setProviderUuid] = useState('');
  const [periodType, setPeriodType] = useState('monthly');
  const [selected, setSelected] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [snapshots, setSnapshots] = useState([]);   // finalized (locked) periods
  const [locking, setLocking] = useState(false);
  const [reload, setReload] = useState(0);           // bump to re-fetch after a lock/reopen
  const isMaster = role === 'master_admin';

  const periods = useMemo(() => buildPeriods(periodType, 6), [periodType]);
  const period = periods[selected] || periods[0];

  // Is the selected period locked (finalized)? Matched on exact from/to (and provider, when filtered).
  const lockedSnaps = useMemo(
    () => snapshots.filter((s) => s.from === period?.from && s.to === period?.to),
    [snapshots, period?.from, period?.to],
  );
  const isLocked = lockedSnaps.length > 0;
  const lockedAt = isLocked ? lockedSnaps[0].finalizedAt : null;

  // Provider filter options (active providers/billers).
  useEffect(() => {
    usersApi.list({ roles: 'provider,billing', status: 'active', page: 1, pageSize: 200 })
      .then(({ data }) => setProviders(data.users || []))
      .catch((e) => setErr(toApiError(e).message));
  }, []);

  // Real-time fetch on any filter/period change. `adminPayscale` returns OUTSTANDING (unpaid) pay — any
  // period already finalized is served from its locked snapshot list below, never re-counted here.
  useEffect(() => {
    if (!period) return;
    setLoading(true); setErr('');
    reportsApi.adminPayscale({ facility: facilityUuid || undefined, provider: providerUuid || undefined, from: period.from, to: period.to })
      .then(({ data }) => setData(data))
      .catch((e) => setErr(toApiError(e).message))
      .finally(() => setLoading(false));
  }, [facilityUuid, providerUuid, period?.from, period?.to, reload]);

  // Finalized (locked) snapshots for the visible window, so the selected period shows its lock state.
  useEffect(() => {
    if (!periods.length) return;
    const oldest = periods[periods.length - 1]?.from; const newest = periods[0]?.to;
    reportsApi.finalizedSnapshots({ from: oldest, to: newest, provider: providerUuid || undefined })
      .then(({ data }) => setSnapshots(data.snapshots || []))
      .catch(() => setSnapshots([]));
  }, [periodType, providerUuid, reload]);

  async function finalize() {
    if (!period) return;
    const scope = providerUuid ? 'the selected provider' : facilityUuid ? 'every provider in this facility' : 'every provider';
    if (!window.confirm(`Lock ${period.label} for ${scope}? This finalizes pay and marks these encounters as PAID so they can never appear on a later paycheck.`)) return;
    try {
      setLocking(true); setErr('');
      await reportsApi.finalizePeriod({
        from: period.from, to: period.to, periodType,
        facility: facilityUuid || undefined, provider: providerUuid || undefined,
      });
      setReload((n) => n + 1);
    } catch (e) { setErr(toApiError(e).message); } finally { setLocking(false); }
  }

  async function reopen() {
    if (!isMaster || !lockedSnaps.length) return;
    if (!window.confirm(`Reopen ${period.label}? This unlocks the period and returns its encounters to payable. Master admin only.`)) return;
    try {
      setLocking(true); setErr('');
      for (const s of lockedSnaps) await reportsApi.reopenPeriod(s.uuid);
      setReload((n) => n + 1);
    } catch (e) { setErr(toApiError(e).message); } finally { setLocking(false); }
  }

  // Display source: a LOCKED period is shown from its immutable snapshots (the amounts actually paid); an
  // OPEN period is shown from the live outstanding computation.
  const rows = isLocked
    ? lockedSnaps.map((s) => ({ providerUuid: s.providerUuid, name: s.provider, providerType: null, encounters: null, providerPay: s.providerPay }))
    : (data?.providers || []);
  const totalPay = isLocked ? lockedSnaps.reduce((sum, s) => sum + Number(s.providerPay || 0), 0) : (data?.totalPay || 0);
  const providerCount = isLocked ? lockedSnaps.length : (data?.providerCount ?? 0);
  const totalEncounters = isLocked ? null : (data?.totalEncounters ?? 0);

  const [dling, setDling] = useState('');
  async function download(kind) {
    try {
      setDling(kind);
      const params = { facility: facilityUuid || undefined, provider: providerUuid || undefined, from: period?.from, to: period?.to };
      const res = kind === 'encounters' ? await reportsApi.adminDownloadEncounters(params) : await reportsApi.adminDownloadBilling(params);
      saveBlob(res, `${kind}_${period?.from || 'all'}.xlsx`);
    } catch (e) { setErr(toApiError(e).message); } finally { setDling(''); }
  }

  return (
    <div className="pay-admin">
      <div className="pay-admin-head">
        <div>
          <h2 className="pay-admin-title">Provider Payscale</h2>
          <span className="pay-admin-sub">Central Florida · what each provider is paid, {periodType === 'biweekly' ? 'bi-weekly' : 'monthly'} · real-time</span>
        </div>
        <div className="rep-toggle" role="tablist" aria-label="Pay cadence">
          {['biweekly', 'monthly'].map((p) => (
            <button key={p} type="button" role="tab" aria-selected={periodType === p}
              className={`rep-toggle-btn ${periodType === p ? 'active' : ''}`} onClick={() => { setPeriodType(p); setSelected(0); }}>
              {p === 'biweekly' ? 'Bi-weekly' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>

      <div className="pay-admin-filters">
        <label className="pay-fld"><span>Period</span>
          <select className="select" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {periods.map((p, i) => <option key={p.from} value={i}>{p.label}</option>)}
          </select>
        </label>
        <label className="pay-fld"><span>Facility</span>
          <select className="select" value={facilityUuid} onChange={(e) => setFacilityUuid(e.target.value)}>
            <option value="">All facilities</option>
            {facilities.map((f) => <option key={f.uuid} value={f.uuid}>{f.name}</option>)}
          </select>
        </label>
        <label className="pay-fld"><span>Provider</span>
          <select className="select" value={providerUuid} onChange={(e) => setProviderUuid(e.target.value)}>
            <option value="">All providers</option>
            {providers.map((p) => <option key={p.uuid} value={p.uuid}>{p.fullName}{p.credentials?.length ? ` (${p.credentials.join(', ')})` : ''}</option>)}
          </select>
        </label>
        <div className="pay-fld"><span>Download (Excel)</span>
          <div className="pay-dl">
            <button type="button" className="btn ghost sm" disabled={dling === 'encounters'} onClick={() => download('encounters')}>{dling === 'encounters' ? 'Preparing…' : 'Visit / Encounters'}</button>
            <button type="button" className="btn ghost sm" disabled={dling === 'billing'} onClick={() => download('billing')}>{dling === 'billing' ? 'Preparing…' : 'Billing report'}</button>
          </div>
        </div>
      </div>

      <div className={`pay-lockbar ${isLocked ? 'locked' : ''}`}>
        <div className="pay-lock-status">
          {isLocked ? (
            <>
              <span className="pay-lock-badge">🔒 Paid &amp; locked</span>
              <span className="pay-lock-sub">{period?.label} was finalized{lockedAt ? ` on ${usDate(lockedAt)}` : ''}. These encounters are marked paid and won’t appear on any later paycheck.</span>
            </>
          ) : (
            <>
              <span className="pay-lock-badge open">Open period</span>
              <span className="pay-lock-sub">{period?.label} is not yet finalized. Pay shown is live and may change until you lock it.</span>
            </>
          )}
        </div>
        <div className="pay-lock-actions">
          {!isLocked && <button type="button" className="btn primary sm" disabled={locking || loading} onClick={finalize}>{locking ? 'Locking…' : 'Finalize &amp; lock this period'}</button>}
          {isLocked && isMaster && <button type="button" className="btn ghost sm" disabled={locking} onClick={reopen}>{locking ? 'Reopening…' : 'Reopen period'}</button>}
          {isLocked && !isMaster && <span className="pay-lock-note">Only a master admin can reopen a locked period.</span>}
        </div>
      </div>

      {err && <div className="rep-error">{err}</div>}

      <div className="pay-admin-cards">
        <div className="rep-card"><span className="rep-card-value">{providerCount}</span><span className="rep-card-label">Providers paid</span></div>
        <div className="rep-card"><span className="rep-card-value">{totalEncounters == null ? '—' : totalEncounters}</span><span className="rep-card-label">Encounters</span></div>
        <div className="rep-card good"><span className="rep-card-value">{money(totalPay)}</span><span className="rep-card-label">Total pay ({period?.label})</span></div>
      </div>

      <div className="rep-table-wrap">
        <table className="rep-table">
          <thead><tr><th>Provider</th><th>Type</th><th className="r">Encounters</th><th className="r">Pay</th></tr></thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="4" className="rep-muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan="4" className="rep-muted">{isLocked ? 'This period is locked with no paid encounters.' : 'No signed encounters for this selection.'}</td></tr>
            ) : rows.map((p) => (
              <tr key={p.providerUuid}>
                <td className="strong">{p.name}</td>
                <td className="pay-type">{p.providerType === 'npp' ? 'NPP' : p.providerType === 'physician' ? 'Physician' : '—'}</td>
                <td className="r">{p.encounters == null ? '—' : p.encounters}</td>
                <td className="r strong">{money(p.providerPay)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && <tfoot><tr><td colSpan="3" className="r">Total — {period?.label}</td><td className="r strong">{money(totalPay)}</td></tr></tfoot>}
        </table>
      </div>
      <p className="rep-foot">Pay is each provider's own signed, payable procedures for the period — CMS 2026 Physician Fee Schedule, Central Florida. Real-time; no estimates.</p>
    </div>
  );
}
