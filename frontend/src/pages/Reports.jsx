import { useEffect, useState } from 'react';
import { reportsApi, saveBlob, toApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Reports — individual-provider focused, real-time. Shows ONLY the logged-in provider's own data (the
 * server scopes every query to the authenticated provider — no cross-provider leakage). Two parts:
 *   1. Practice summary — encounters, encounter types, signed / unsigned notes, patients visited.
 *   2. Payscale — what THIS provider is paid, bi-weekly & monthly, from their signed payable procedures.
 * Deliberately simplified for the provider: only their own pay is shown (no group split / RVU internals).
 */
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function Reports() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [periodType, setPeriodType] = useState('monthly');
  const [periods, setPeriods] = useState([]);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(null);
  const [statement, setStatement] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    reportsApi.summary().then(({ data }) => setSummary(data)).catch((e) => setErr(toApiError(e).message));
  }, []);

  useEffect(() => {
    setLoading(true);
    reportsApi.payPeriods({ periodType, count: 6 })
      .then(({ data }) => { setPeriods(data.periods || []); setSelected(0); })
      .catch((e) => setErr(toApiError(e).message))
      .finally(() => setLoading(false));
  }, [periodType]);

  const period = periods[selected];
  useEffect(() => {
    if (!period) { setDetail(null); setStatement(null); return; }
    reportsApi.payscale({ from: period.from, to: period.to, includePaid: 1 })
      .then(({ data }) => setDetail(data))
      .catch((e) => setErr(toApiError(e).message));
    if (periodType === 'monthly') {
      const [y, m] = period.from.split('-'); // period.from = 'YYYY-MM-01'
      reportsApi.statement({ year: Number(y), month: Number(m) })
        .then(({ data }) => setStatement(data))
        .catch((e) => setErr(toApiError(e).message));
    } else {
      setStatement(null);
    }
  }, [period?.from, period?.to, periodType]);

  const [dling, setDling] = useState('');
  async function download(kind) {
    try {
      setDling(kind);
      const params = period ? { from: period.from, to: period.to } : {};
      const res = kind === 'encounters' ? await reportsApi.downloadEncounters(params) : await reportsApi.downloadBilling(params);
      saveBlob(res, `${kind}_${period?.from || 'all'}.xlsx`);
    } catch (e) { setErr(toApiError(e).message); } finally { setDling(''); }
  }

  const cards = summary ? [
    { label: 'Total encounters', value: summary.totalEncounters },
    { label: 'Patients visited', value: summary.patientsVisited },
    { label: 'Signed notes', value: summary.signedNotes, tone: 'good' },
    { label: 'Unsigned notes', value: summary.unsignedNotes, tone: summary.unsignedNotes > 0 ? 'warn' : undefined },
  ] : [];
  const typeLabel = (t) => (t || 'unspecified').replace(/^(pi|pain|tcm)_/, (m) => m.toUpperCase().replace('_', ' ')).replace(/_/g, ' ');

  return (
    <section className="ehr-reports" aria-label="Reports">
      <header className="ehr-reports-head">
        <h1 className="ehr-reports-title">Reports</h1>
        <span className="ehr-reports-sub">{user?.fullName ? `${user.fullName} · ` : ''}your practice &amp; pay</span>
      </header>

      <div className="ehr-reports-body">
        {err && <div className="rep-error">{err}</div>}

        {/* Practice summary */}
        <div className="rep-cards">
          {cards.map((c) => (
            <div key={c.label} className={`rep-card ${c.tone || ''}`}>
              <span className="rep-card-value">{Number(c.value).toLocaleString('en-US')}</span>
              <span className="rep-card-label">{c.label}</span>
            </div>
          ))}
        </div>

        {summary?.encounterTypes?.length > 0 && (
          <div className="rep-types">
            <span className="rep-types-lbl">Encounter types</span>
            <div className="rep-chips">
              {summary.encounterTypes.slice(0, 12).map((t) => (
                <span key={t.type} className="rep-chip">{typeLabel(t.type)}<b>{t.count}</b></span>
              ))}
            </div>
          </div>
        )}

        {/* Payscale — the provider's own pay only */}
        <div className="rep-pay">
          <div className="rep-pay-head">
            <h2 className="rep-pay-title">Payscale</h2>
            <div className="rep-toggle" role="tablist" aria-label="Pay cadence">
              {['biweekly', 'monthly'].map((p) => (
                <button key={p} type="button" role="tab" aria-selected={periodType === p}
                  className={`rep-toggle-btn ${periodType === p ? 'active' : ''}`} onClick={() => setPeriodType(p)}>
                  {p === 'biweekly' ? 'Bi-weekly' : 'Monthly'}
                </button>
              ))}
            </div>
          </div>

          <div className="rep-downloads">
            <span className="rep-dl-lbl">Download (Excel):</span>
            <button type="button" className="btn ghost sm" disabled={dling === 'encounters'} onClick={() => download('encounters')}>{dling === 'encounters' ? 'Preparing…' : 'Visit / Encounters'}</button>
            <button type="button" className="btn ghost sm" disabled={dling === 'billing'} onClick={() => download('billing')}>{dling === 'billing' ? 'Preparing…' : 'Billing report'}</button>
          </div>

          {periods.length > 0 && (
            <div className="rep-period">
              <select className="select rep-period-sel" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
                {periods.map((p, i) => <option key={p.from} value={i}>{p.label}</option>)}
              </select>
              {period && (
                <div className="rep-pay-hero">
                  <span className="rep-pay-hero-num">{money(period.providerPay)}</span>
                  <span className="rep-pay-hero-lbl">
                    Your pay · {period.label}
                    {period.finalized
                      ? <span className="rep-paid-badge" title="This pay period is finalized and locked.">🔒 Paid</span>
                      : <span className="rep-open-badge" title="Not yet finalized — this figure is live and may change.">Live</span>}
                  </span>
                </div>
              )}
            </div>
          )}

          {loading && <div className="rep-muted">Loading…</div>}
          {!loading && periods.length === 0 && <div className="rep-muted">No signed encounters in this window yet.</div>}

          {/* Monthly statement — Month · Week · Procedure Code · POS · Encounters · Provider Pay */}
          {periodType === 'monthly' && statement?.rows?.length > 0 && (
            <div className="rep-stmt">
              <span className="rep-types-lbl">{statement.label} · statement</span>
              <div className="rep-table-wrap">
                <table className="rep-table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Week</th>
                      <th>Procedure code</th>
                      <th>Place of service</th>
                      <th className="r">Encounters</th>
                      <th className="r">Provider pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.rows.map((r, i) => (
                      <tr key={`${r.week}|${r.code}|${r.placeOfService}|${i}`}>
                        <td>{statement.label}</td>
                        <td>Week {r.week}</td>
                        <td><span className="mono">{r.code}{r.modifier ? `-${r.modifier}` : ''}</span>{r.description ? <span className="rep-desc"> {r.description}</span> : ''}</td>
                        <td className="rep-pos">{r.placeOfService}</td>
                        <td className="r strong">{r.encounters}</td>
                        <td className="r strong">{money(r.pay)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="4" className="r">Total — {statement.label}</td>
                      <td className="r strong">{statement.totalEncounters}</td>
                      <td className="r strong">{money(statement.totalPay)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Bi-weekly breakdown — Period · Procedure code · POS · Encounters · Provider pay */}
          {periodType === 'biweekly' && detail?.lines?.length > 0 && (
            <div className="rep-stmt">
              <span className="rep-types-lbl">{period?.label} · statement</span>
              <div className="rep-table-wrap">
                <table className="rep-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Procedure code</th>
                      <th>Place of service</th>
                      <th className="r">Encounters</th>
                      <th className="r">Provider pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((l) => (
                      <tr key={`${l.code}|${l.placeOfService}`}>
                        <td>{period?.label}</td>
                        <td><span className="mono">{l.code}{l.modifier ? `-${l.modifier}` : ''}</span>{l.description ? <span className="rep-desc"> {l.description}</span> : ''}</td>
                        <td className="rep-pos">{l.placeOfService}</td>
                        <td className="r strong">{l.encounters}</td>
                        <td className="r strong">{money(l.providerPay)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="3" className="r">Total — {period?.label}</td>
                      <td className="r strong">{detail.lines.reduce((s, l) => s + l.encounters, 0)}</td>
                      <td className="r strong">{money(detail.providerPay)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Period history — pay only */}
          {periods.length > 0 && (
            <div className="rep-history">
              <span className="rep-types-lbl">{periodType === 'biweekly' ? 'Bi-weekly' : 'Monthly'} history</span>
              <div className="rep-table-wrap">
                <table className="rep-table">
                  <thead><tr><th>Period</th><th>Status</th><th className="r">Pay</th></tr></thead>
                  <tbody>
                    {periods.map((p, i) => (
                      <tr key={p.from} className={i === selected ? 'sel' : ''} onClick={() => setSelected(i)} style={{ cursor: 'pointer' }}>
                        <td>{p.label}</td>
                        <td>{p.finalized ? <span className="rep-paid-badge">🔒 Paid</span> : <span className="rep-open-badge">Live</span>}</td>
                        <td className="r strong">{money(p.providerPay)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="rep-foot">Based on your signed, payable procedures — CMS 2026 Physician Fee Schedule, Central Florida. Medicare-allowed basis, before sequestration.</p>
        </div>
      </div>
    </section>
  );
}
