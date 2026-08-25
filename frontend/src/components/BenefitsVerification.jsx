import { useCallback, useEffect, useState } from 'react';
import { patientsApi, toApiError } from '../lib/api.js';
import { useToast } from './Toast.jsx';

/**
 * Benefits Verification — a clean, provider-focused view of a real-time eligibility
 * (X12 271) response. Leads with the answers a provider needs (is it active, what
 * will the patient owe), then plan/member facts and per-service detail on demand.
 * Every value comes from the actual payer 271 — no mock, no synthetic data. Strictly
 * patient-scoped; switching tabs never re-calls the payer.
 */

const INS_LABEL = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' };
const COMMON_PROCEDURES = [
  { code: '99306', desc: 'Initial nursing facility visit' },
  { code: '99308', desc: 'Subsequent SNF visit (expanded)' },
  { code: '99309', desc: 'Subsequent SNF visit (detailed)' },
  { code: '99310', desc: 'Subsequent SNF visit (complex)' },
  { code: '99315', desc: 'Nursing facility discharge' },
  { code: '99497', desc: 'Advance care planning' },
  { code: '90792', desc: 'Psychiatric diagnostic evaluation' },
  { code: '97110', desc: 'Therapeutic exercise (PT)' },
  { code: '97165', desc: 'Occupational therapy evaluation' },
  { code: '92507', desc: 'Speech/language treatment' },
  { code: '11042', desc: 'Wound debridement' },
  { code: '20610', desc: 'Major joint injection/aspiration' },
];

const usToday = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`; };
const usToIso = (s) => {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const mo = +m[1]; const da = +m[2];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
};
const fmtDate = (d) => {
  const m = String(d || '').slice(0, 10).split('-');
  return m.length === 3 ? `${m[1]}/${m[2]}/${m[0]}` : (d || '');
};
const KIND_CLASS = { coinsurance: 'coins', copay: 'copay', deductible: 'ded', oop: 'oop', active: 'act', inactive: 'nc', noncovered: 'nc', limitation: 'lim' };
const STATUS = { active: { cls: 'active', label: 'Active' }, inactive: { cls: 'inactive', label: 'Inactive' }, error: { cls: 'pending', label: 'Recheck' } };

/* -------- Small pieces -------------------------------------------------- */
function StatusBadge({ status, label }) {
  const st = STATUS[status] || STATUS.error;
  return <span className={`bx-status ${st.cls}`}><span className="bx-status-dot" />{label || st.label}</span>;
}

const MONEY_KIND = new Set(['copay', 'deductible', 'oop']);
const NET_ORDER = ['In-network', 'Out-of-network', 'General'];
const NET_LABEL = { 'In-network': 'In-Network', 'Out-of-network': 'Out-of-Network', General: 'Not specified' };

/**
 * All benefits for one service, grouped strictly under In-Network / Out-of-Network
 * exactly as the payer returned them. Each row is a raw 271 benefit — nothing rolled
 * up, nothing computed. Money-type rows with no amount show $0.00; everything else is
 * the payer's own value (blank only for non-money rows the payer left empty).
 */
function NetworkGroups({ svc }) {
  if (!svc || !svc.items.length) return <div className="bx-empty">No detail returned for this service.</div>;
  const groups = { 'In-network': [], 'Out-of-network': [], General: [] };
  svc.items.forEach((it) => {
    const k = it.network === 'In-network' ? 'In-network' : it.network === 'Out-of-network' ? 'Out-of-network' : 'General';
    groups[k].push(it);
  });
  const shown = NET_ORDER.filter((k) => groups[k].length);
  return (
    <div className="nx">
      {shown.map((k) => (
        <div className={`nx-grp ${k === 'In-network' ? 'in' : k === 'Out-of-network' ? 'out' : 'gen'}`} key={k}>
          <div className="nx-grp-h">
            <span className="nx-grp-tag">{NET_LABEL[k]}</span>
            <span className="nx-grp-n">{groups[k].length} benefit{groups[k].length === 1 ? '' : 's'}</span>
          </div>
          <div className="bx-tbl-wrap">
            <table className="bx-tbl">
              <thead><tr><th>Type</th><th>Coverage level</th><th>Coverage</th><th>Benefit</th></tr></thead>
              <tbody>
                {groups[k].map((it, i) => {
                  const benefit = [];
                  if (it.insuranceType) benefit.push(['Insurance type', it.insuranceType]);
                  if (it.planCoverage) benefit.push(['Plan coverage', it.planCoverage]);
                  (it.messages || []).forEach((mm) => benefit.push([null, mm]));
                  if (!benefit.length && it.note) benefit.push([null, it.note]);
                  const cov = it.value ? `${it.value}${it.per ? ` ${it.per}` : ''}` : (MONEY_KIND.has(it.kind) ? '$0.00' : '');
                  return (
                    <tr key={i}>
                      <td><span className={`bx-tag ${KIND_CLASS[it.kind] || ''}`}>{it.label}</span></td>
                      <td className="bx-td-lvl">{it.coverageLevel || ''}</td>
                      <td className="bx-td-cov">{cov}</td>
                      <td>{benefit.length ? (
                        <ul className="bx-td-msgs">{benefit.map(([kk, v], j) => <li key={j}>{kk ? <b>{kk}: </b> : null}{v}</li>)}</ul>
                      ) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------- The verified benefits view ------------------------------------ */
function BenefitsView({ s, verifiedAt }) {
  const [tab, setTab] = useState('plan');
  const plan = s.plan || {};
  const m = s.member || {};
  const services = s.services || [];
  const planSvc = services.find((x) => x.code === '30');
  const otherSvcs = services.filter((x) => x.code !== '30');
  const [selCode, setSelCode] = useState(otherSvcs[0]?.code || '');
  const selSvc = otherSvcs.find((x) => x.code === selCode) || otherSvcs[0] || null;

  // Procedure-specific: the CPT/HCPCS the provider checked → its matched service's
  // benefits (the payer's own service for that procedure's category). Purely additive
  // — the plan/service tabs below are unchanged.
  const procs = s.requestedProcedures || [];
  const procMatched = procs.map((p) => ({ proc: p, svc: services.find((x) => x.code === p.stc) || null }));

  // Compact member/plan facts — only fields present.
  const facts = [
    ['Member', m.name], ['Member ID', m.memberId], m.mbi && ['MBI / HIC', m.mbi],
    m.dob && ['Date of birth', fmtDate(m.dob)],
    m.group && ['Group', `${m.group}${m.groupDescription ? ` · ${m.groupDescription}` : ''}`],
    plan.type && ['Plan type', plan.type],
    s.payer?.name && ['Payer', `${s.payer.name}${s.payer.id ? ` · ${s.payer.id}` : ''}`],
    s.pcp?.name && ['Primary care provider', s.pcp.name],
  ].filter(Boolean);

  return (
    <div className="bx-view">
      {/* Coverage header */}
      <div className={`bx-head ${s.status}`}>
        <StatusBadge status={s.status} label={s.statusLabel} />
        <div className="bx-head-plan">
          <span className="bx-head-nm">{plan.name || s.payer?.name || 'Coverage'}</span>
          <span className="bx-head-meta">
            {[plan.type, plan.begin ? `Eff ${fmtDate(plan.begin)}` : null, plan.serviceDate ? `DOS ${fmtDate(plan.serviceDate)}` : null].filter(Boolean).join('  ·  ')}
          </span>
        </div>
      </div>

      {/* Member & plan facts */}
      {facts.length > 0 && (
        <div className="bx-info">
          {facts.map(([k, v]) => <div className="bx-info-i" key={k}><span className="bx-info-k">{k}</span><span className="bx-info-v">{v}</span></div>)}
        </div>
      )}

      {/* Procedure-specific benefits (only when a CPT/HCPCS was checked) */}
      {procMatched.length > 0 && (
        <div className="bx-proc">
          <div className="bx-proc-h">Procedure-specific benefits</div>
          {procMatched.map(({ proc, svc }, i) => (
            <div className="bx-proc-item" key={i}>
              <div className="bx-proc-tag"><b>{proc.code}</b>{proc.label ? ` · ${proc.label}` : ''}{svc ? ` → ${svc.name}` : ''}</div>
              {svc ? <NetworkGroups svc={svc} /> : <div className="bx-empty">The payer returned no procedure-specific benefits for this service.</div>}
            </div>
          ))}
          {s.unmappedProcedures?.length > 0 && (
            <div className="bx-proc-warn">No service mapping for {s.unmappedProcedures.join(', ')} — showing plan coverage below.</div>
          )}
        </div>
      )}

      {/* Detail tabs — both grouped under In-Network / Out-of-Network */}
      <div className="bx-tabs">
        <button type="button" className={`bx-tab ${tab === 'plan' ? 'on' : ''}`} onClick={() => setTab('plan')}>Plan coverage</button>
        <button type="button" className={`bx-tab ${tab === 'service' ? 'on' : ''}`} onClick={() => setTab('service')}>Service benefits</button>
      </div>

      {tab === 'plan' ? (
        <NetworkGroups svc={planSvc} />
      ) : (
        otherSvcs.length ? (
          <div className="bx-svc">
            <div className="bx-select">
              <select value={selSvc?.code || ''} onChange={(e) => setSelCode(e.target.value)}>
                {otherSvcs.map((sv) => <option key={sv.code} value={sv.code}>{sv.name}</option>)}
              </select>
              <svg className="bx-select-c" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </div>
            <NetworkGroups svc={selSvc} />
          </div>
        ) : <div className="bx-empty">No service-specific benefits returned. See Plan coverage.</div>
      )}

      {(s.messages?.length > 0 || s.disclaimer) && (
        <details className="bx-extra">
          <summary>Payer messages</summary>
          {s.messages?.map((mm, i) => <p key={i}>{mm}</p>)}
          {s.disclaimer ? <p className="bx-disc">{s.disclaimer}</p> : null}
        </details>
      )}
      <div className="bx-foot"><span className="bx-foot-dot" />Verified {verifiedAt ? new Date(verifiedAt).toLocaleString() : ''}{s.traceId ? ` · Ref ${s.traceId}` : ''}</div>
    </div>
  );
}

/* -------- Actions (DOS + verify + procedure) ---------------------------- */
function VerifyPanel({ patientUuid, policyIndex, hasExisting, dos, onDone, onPatientUpdated }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const run = async () => {
    setNotice(''); setBusy(true);
    try {
      const { data } = await patientsApi.verifyEligibility(patientUuid, { policyIndex, dateOfService: dos || undefined });
      toast.success('Eligibility verified.');
      if (data?.patient && onPatientUpdated) onPatientUpdated(data.patient);
      onDone();
    } catch (e) {
      const err = toApiError(e);
      setNotice(err.code === 'STEDI_DISABLED' ? 'Eligibility service is not configured yet.' : err.message);
      toast.error(err.message);
    } finally { setBusy(false); }
  };
  return (
    <div className="bx-verify">
      <button type="button" className="btn sm" onClick={run} disabled={busy}>{busy ? 'Verifying…' : hasExisting ? 'Re-verify' : 'Verify eligibility'}</button>
      {notice ? <div className="bx-notice">{notice}</div> : null}
    </div>
  );
}

function ProcedureCheck({ patientUuid, policyIndex, dos, onDone, onPatientUpdated }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    try {
      const { data } = await patientsApi.verifyEligibility(patientUuid, { policyIndex, procedureCodes: [c], dateOfService: dos || undefined });
      const req = (data?.check?.summary?.requestedProcedures) || [];
      const mm = req.find((r) => r.code === c);
      toast.success(mm ? `Checked ${c} — ${mm.label}.` : `Checked ${c}.`);
      if (data?.patient && onPatientUpdated) onPatientUpdated(data.patient);
      onDone();
    } catch (e) { toast.error(toApiError(e).message); } finally { setBusy(false); }
  };
  return (
    <div className="bx-proc">
      <input className="input" list="bx-cpt" value={code} placeholder="CPT / HCPCS" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run(); }} />
      <datalist id="bx-cpt">{COMMON_PROCEDURES.map((p) => <option key={p.code} value={p.code}>{`${p.code} — ${p.desc}`}</option>)}</datalist>
      <button type="button" className="btn ghost sm" onClick={run} disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Check procedure'}</button>
    </div>
  );
}

function PolicyActions({ patientUuid, policyIndex, hasExisting, onDone, onPatientUpdated }) {
  const [dos, setDos] = useState(usToday());
  const iso = usToIso(dos);
  const bad = dos.trim().length > 0 && !iso;
  return (
    <div className="bx-actions">
      <div className="bx-dos">
        <label>Date of service</label>
        <input type="text" inputMode="numeric" className={`input ${bad ? 'bx-dos-bad' : ''}`} placeholder="mm/dd/yyyy" maxLength={10} value={dos} onChange={(e) => setDos(e.target.value)} />
      </div>
      <VerifyPanel patientUuid={patientUuid} policyIndex={policyIndex} hasExisting={hasExisting} dos={iso} onDone={onDone} onPatientUpdated={onPatientUpdated} />
      <ProcedureCheck patientUuid={patientUuid} policyIndex={policyIndex} dos={iso} onDone={onDone} onPatientUpdated={onPatientUpdated} />
    </div>
  );
}

/* -------- Main ---------------------------------------------------------- */
export default function BenefitsVerification({ patientUuid, insurance, onPatientUpdated }) {
  const toast = useToast();
  const [byPolicy, setByPolicy] = useState({});
  const [loading, setLoading] = useState(true);
  const [dlPolicy, setDlPolicy] = useState(null);

  // Download THIS policy's verified benefits as a branded PDF.
  async function downloadBenefits(i, payer) {
    setDlPolicy(i);
    try {
      await patientsApi.downloadBenefits(patientUuid, i, `benefits-${(payer || 'policy').replace(/[^\w]+/g, '_')}.pdf`);
    } catch (err) { toast.error(toApiError(err).message); } finally { setDlPolicy(null); }
  }

  const load = useCallback(async () => {
    if (!patientUuid) return;
    setLoading(true);
    try {
      const { data } = await patientsApi.listEligibility(patientUuid);
      const map = {};
      (data.checks || []).forEach((c) => { map[c.policyIndex] = c; });
      setByPolicy(map);
    } catch { setByPolicy({}); } finally { setLoading(false); }
  }, [patientUuid]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="bx-loading">Loading verified benefits…</div>;

  return (
    <div className="bx-wrap">
      {insurance.map((ins, i) => {
        const check = byPolicy[i];
        const s = check?.summary;
        return (
          <div className="bx-policy" key={i}>
            <div className="bx-policy-h">
              <span className={`fs-ins-rank r-${ins.type || 'primary'}`}>{INS_LABEL[ins.type] || `Policy ${i + 1}`}</span>
              <div className="bx-policy-id">
                <span className="bx-policy-nm">{ins.payer || 'Payer not set'}</span>
                <span className="bx-policy-sub">{ins.memberId ? `Member ${ins.memberId}` : 'No member ID'}{ins.payerId ? `  ·  Payer ID ${ins.payerId}` : ''}</span>
              </div>
              <span className="spacer" />
              {s ? <StatusBadge status={s.status} label={s.statusLabel} /> : <span className="bx-status none"><span className="bx-status-dot" />Not verified</span>}
              {s && (
                <button
                  className="act"
                  style={{ marginLeft: 10 }}
                  onClick={() => downloadBenefits(i, ins.payer)}
                  disabled={dlPolicy === i}
                  title="Download this policy's benefits as a PDF"
                >
                  {dlPolicy === i ? <span className="spinner dark" /> : 'Download'}
                </button>
              )}
            </div>
            {s ? <BenefitsView s={s} verifiedAt={check.verifiedAt} /> : (
              <div className="bx-none">Not verified yet. Run a real-time check to pull plan status, copay, coinsurance, deductible, out-of-pocket, and per-service benefits directly from the payer.</div>
            )}
            <PolicyActions patientUuid={patientUuid} policyIndex={i} hasExisting={!!s} onDone={load} onPatientUpdated={onPatientUpdated} />
          </div>
        );
      })}
    </div>
  );
}
