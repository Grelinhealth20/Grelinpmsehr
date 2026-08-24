import { useCallback, useEffect, useState } from 'react';
import { patientsApi, toApiError } from '../lib/api.js';
import { useToast } from './Toast.jsx';

/**
 * Benefits Verification — provider view of a real-time eligibility (X12 271)
 * response, tuned for a SNF Part B physician. Reads the LATEST verification per
 * insurance policy (server-normalized; strictly patient-scoped) and lets the
 * provider record a new payer response. No synthetic/mock data — everything shown
 * comes from an actual payer 271.
 */

const INS_LABEL = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' };
// Common SNF Part B procedures for the picker (mirrors backend procedureStc.js).
const COMMON_PROCEDURES = [
  { code: '99306', desc: 'Initial nursing facility visit' },
  { code: '99308', desc: 'Subsequent SNF visit (expanded)' },
  { code: '99309', desc: 'Subsequent SNF visit (detailed)' },
  { code: '99310', desc: 'Subsequent SNF visit (complex)' },
  { code: '99315', desc: 'Nursing facility discharge' },
  { code: '99497', desc: 'Advance care planning' },
  { code: '99483', desc: 'Cognitive assessment & care plan' },
  { code: '90792', desc: 'Psychiatric diagnostic evaluation' },
  { code: '97110', desc: 'Therapeutic exercise (PT)' },
  { code: '97530', desc: 'Therapeutic activities (PT)' },
  { code: '97165', desc: 'Occupational therapy evaluation' },
  { code: '92507', desc: 'Speech/language treatment' },
  { code: '11042', desc: 'Wound debridement' },
  { code: '20610', desc: 'Major joint injection/aspiration' },
];
const money = (v) => v || '—';
const parseNum = (s) => { const n = Number(String(s ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  if (!y) return d;
  return `${m}/${day}/${y}`;
};

function StatusPill({ status, label }) {
  const s = status === 'active' ? 'active' : status === 'inactive' ? 'inactive' : 'pending';
  return <span className={`ev-pill ${s}`}><span className="dot" />{label || (s === 'active' ? 'Active Coverage' : 'Inactive')}</span>;
}

function Meter({ met, total }) {
  const m = parseNum(met); const t = parseNum(total);
  if (m === null || t === null || t <= 0) return null;
  const pctMet = Math.max(0, Math.min(100, Math.round((m / t) * 100)));
  return <div className="ev-meter"><span style={{ width: `${pctMet}%` }} /></div>;
}

function AmountBlock({ title, data }) {
  if (!data) return null;
  return (
    <div className="ev-amt">
      <div className="ev-amt-h">{title}</div>
      <div className="ev-amt-grid">
        <div><span className="k">Annual</span><span className="v">{money(data.annual)}</span></div>
        <div><span className="k">Met (YTD)</span><span className="v">{money(data.met)}</span></div>
        <div><span className="k">Remaining</span><span className="v strong">{money(data.remaining)}</span></div>
      </div>
      <Meter met={data.met} total={data.annual} />
      {data.network && <div className="ev-amt-net">{data.network}</div>}
    </div>
  );
}

const KIND_CLASS = { coinsurance: 'coins', copay: 'copay', deductible: 'ded', oop: 'oop', active: 'act', noncovered: 'nc', limitation: 'lim' };

function ServiceCard({ svc, procCodes }) {
  const [open, setOpen] = useState(false);
  const shown = open ? svc.items : svc.items.slice(0, 4);
  return (
    <div className={`ev-svc${procCodes?.length ? ' targeted' : ''}`}>
      <button type="button" className="ev-svc-h" onClick={() => setOpen((o) => !o)}>
        <span className="ev-svc-name">{svc.name}</span>
        {procCodes?.length > 0 && <span className="ev-proc-badge">CPT {procCodes.join(', ')}</span>}
        {svc.active && <span className="ev-chip on">Active</span>}
        <span className="spacer" />
        <span className="ev-svc-count">{svc.items.length} benefit{svc.items.length === 1 ? '' : 's'}</span>
        <svg className={`ev-caret ${open ? 'up' : ''}`} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div className="ev-svc-items">
        {shown.map((it, i) => (
          <div className="ev-item" key={i}>
            <span className={`ev-kind ${KIND_CLASS[it.kind] || ''}`}>{it.label}</span>
            <span className="ev-val">{it.value || '—'}</span>
            {it.per && <span className="ev-per">{it.per}</span>}
            {it.network && <span className={`ev-net ${it.network === 'In-network' ? 'in' : 'out'}`}>{it.network}</span>}
            {it.note && <span className="ev-note">{it.note}</span>}
          </div>
        ))}
        {!open && svc.items.length > 4 && (
          <button type="button" className="ev-more" onClick={() => setOpen(true)}>+ {svc.items.length - 4} more</button>
        )}
      </div>
    </div>
  );
}

function VerificationDetail({ s, verifiedAt }) {
  const [showRaw, setShowRaw] = useState(false);
  const plan = s.plan || {};
  const m = s.member || {};
  const planEnded = plan.end && plan.end < new Date().toISOString().slice(0, 10);
  return (
    <div className="ev-detail">
      <div className={`ev-banner ${s.status}`}>
        <div className="ev-banner-main">
          <StatusPill status={s.status} label={s.statusLabel} />
          <span className="ev-plan-name">{plan.name || s.payer?.name || 'Coverage'}</span>
          {plan.type && <span className="ev-plan-type">{plan.type}</span>}
        </div>
        <div className="ev-banner-dates">
          {plan.begin && <span>Effective {fmtDate(plan.begin)}</span>}
          {plan.end && <span className={planEnded ? 'warn' : ''}>{planEnded ? 'Ended' : 'Through'} {fmtDate(plan.end)}</span>}
          {plan.serviceDate && <span>DOS {fmtDate(plan.serviceDate)}</span>}
        </div>
      </div>

      {s.requestedProcedures?.length > 0 && (
        <div className="ev-reqproc">
          <strong>Procedure-specific check:</strong>{' '}
          {s.requestedProcedures.map((p) => `${p.code} → ${p.label}`).join(', ')} — see the matching service category below.
          {s.unmappedProcedures?.length > 0 && <span className="ev-reqproc-warn"> (no STC mapping for {s.unmappedProcedures.join(', ')})</span>}
        </div>
      )}

      {s.visitCost && (
        <div className="ev-visit">
          <div className="ev-visit-h">Physician visit — patient responsibility</div>
          <div className="ev-visit-row">
            {s.visitCost.coinsurance && <div className="ev-visit-cell"><span className="k">Coinsurance</span><span className="v">{s.visitCost.coinsurance}</span></div>}
            {s.visitCost.copay && <div className="ev-visit-cell"><span className="k">Copay</span><span className="v">{s.visitCost.copay}</span></div>}
            {s.visitCost.deductibleRemaining != null && <div className="ev-visit-cell"><span className="k">Deductible left</span><span className="v">{s.visitCost.deductibleRemaining}</span></div>}
          </div>
          <div className="ev-visit-note">{s.visitCost.note}</div>
        </div>
      )}

      {(s.financial?.deductible || s.financial?.oop) && (
        <div className="ev-amts">
          <AmountBlock title="Deductible" data={s.financial.deductible} />
          <AmountBlock title="Out-of-pocket maximum" data={s.financial.oop} />
        </div>
      )}

      <div className="ev-facts">
        <div><span className="k">Member</span><span className="v">{m.name || '—'}</span></div>
        <div><span className="k">Member ID</span><span className="v">{m.memberId || '—'}</span></div>
        {m.mbi && <div><span className="k">MBI / HIC</span><span className="v">{m.mbi}</span></div>}
        {m.dob && <div><span className="k">DOB</span><span className="v">{fmtDate(m.dob)}</span></div>}
        {m.group && <div><span className="k">Group</span><span className="v">{m.group}{m.groupDescription ? ` · ${m.groupDescription}` : ''}</span></div>}
        <div><span className="k">Payer</span><span className="v">{s.payer?.name || '—'}{s.payer?.id ? ` · ${s.payer.id}` : ''}</span></div>
        {s.pcp && <div className="wide"><span className="k">PCP</span><span className="v">{s.pcp.name}{s.pcp.phone ? ` · ${s.pcp.phone}` : ''}{s.pcp.address ? ` · ${s.pcp.address}` : ''}</span></div>}
      </div>

      {s.services?.length > 0 && (() => {
        // Map each service (by its STC) back to the procedure code(s) that targeted it,
        // so the returned benefit is labelled with the CPT the provider entered.
        const stcToProc = {};
        (s.requestedProcedures || []).forEach((p) => { (stcToProc[p.stc] = stcToProc[p.stc] || []).push(p.code); });
        return (
          <div className="ev-svcs">
            <div className="ev-sub-h">Coverage by service</div>
            {s.services.map((svc) => <ServiceCard key={svc.code} svc={svc} procCodes={stcToProc[svc.code]} />)}
          </div>
        );
      })()}

      {s.limitations?.length > 0 && (
        <div className="ev-lims">
          <div className="ev-sub-h">Limitations</div>
          {s.limitations.map((l, i) => (
            <div className="ev-lim-row" key={i}><span className="s">{l.service}</span><span className="v">{l.value}</span>{l.note && <span className="n">{l.note}</span>}</div>
          ))}
        </div>
      )}

      {(s.messages?.length > 0 || s.disclaimer) && (
        <details className="ev-extra">
          <summary>Payer messages &amp; disclaimer</summary>
          {s.messages?.map((mm, i) => <p key={i} className="ev-msg">{mm}</p>)}
          {s.disclaimer && <p className="ev-disc">{s.disclaimer}</p>}
        </details>
      )}

      <div className="ev-foot">
        <span>Verified {verifiedAt ? new Date(verifiedAt).toLocaleString() : '—'}</span>
        {s.traceId && <span>Trace {s.traceId}</span>}
      </div>
    </div>
  );
}

function VerifyPanel({ patientUuid, policyIndex, hasExisting, onDone, onPatientUpdated }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const run = async () => {
    setNotice('');
    setBusy(true);
    try {
      const { data } = await patientsApi.verifyEligibility(patientUuid, { policyIndex });
      if (data?.skipped === 'duplicate_this_month') {
        toast.info('Already verified this month — showing the existing result.');
      } else {
        toast.success('Eligibility verified — Face Sheet & insurance updated.');
      }
      if (data?.patient && onPatientUpdated) onPatientUpdated(data.patient);
      onDone();
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'STEDI_DISABLED') setNotice('Eligibility service is not configured yet. Add STEDI_API_KEY in the backend .env, then retry.');
      else setNotice(err.message);
      toast.error(err.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="ev-verify">
      <button type="button" className="btn primary sm ev-verify-btn" onClick={run} disabled={busy}>
        {busy ? 'Verifying…' : hasExisting ? 'Re-verify eligibility' : 'Verify eligibility now'}
      </button>
      {notice && <div className="ev-verify-note">{notice}</div>}
    </div>
  );
}

function ProcedureCheck({ patientUuid, policyIndex, onDone, onPatientUpdated }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    try {
      const { data } = await patientsApi.verifyEligibility(patientUuid, { policyIndex, procedureCodes: [c] });
      const req = (data?.check?.summary?.requestedProcedures) || [];
      const m = req.find((r) => r.code === c);
      toast.success(m ? `Checked ${c} — ${m.label} benefits below.` : `Checked ${c}.`);
      if (data?.patient && onPatientUpdated) onPatientUpdated(data.patient);
      onDone();
    } catch (e) { toast.error(toApiError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="ev-proc">
      <span className="ev-proc-label">Procedure-specific</span>
      <input
        className="ev-proc-input" list="ev-cpt-list" value={code}
        placeholder="CPT / HCPCS (e.g. 97110)"
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
      />
      <datalist id="ev-cpt-list">
        {COMMON_PROCEDURES.map((p) => <option key={p.code} value={p.code}>{`${p.code} — ${p.desc}`}</option>)}
      </datalist>
      <button type="button" className="btn ghost sm" onClick={run} disabled={busy || !code.trim()}>
        {busy ? 'Checking…' : 'Check procedure'}
      </button>
    </div>
  );
}

export default function BenefitsVerification({ patientUuid, insurance, onPatientUpdated }) {
  const [byPolicy, setByPolicy] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!patientUuid) return;
    setLoading(true);
    try {
      const { data } = await patientsApi.listEligibility(patientUuid);
      const map = {};
      (data.checks || []).forEach((c) => { map[c.policyIndex] = c; });
      setByPolicy(map);
    } catch { setByPolicy({}); }
    finally { setLoading(false); }
  }, [patientUuid]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="fs-empty" style={{ padding: '14px 0' }}>Loading verified benefits…</div>;

  return (
    <div className="ev-wrap">
      {insurance.map((ins, i) => {
        const check = byPolicy[i];
        const s = check?.summary;
        return (
          <div className="ev-policy" key={i}>
            <div className="ev-policy-h">
              <span className={`fs-ins-rank r-${ins.type || 'primary'}`}>{INS_LABEL[ins.type] || `Policy ${i + 1}`}</span>
              <span className="ev-policy-payer">{ins.payer || 'Payer not set'}{ins.memberId ? ` · ${ins.memberId}` : ''}</span>
              <span className="spacer" />
              {s ? <StatusPill status={s.status} label={s.statusLabel} /> : <span className="ev-pill none"><span className="dot" />Not verified</span>}
            </div>
            {s
              ? <VerificationDetail s={s} verifiedAt={check.verifiedAt} />
              : <div className="ev-none">Not verified yet. Run a real-time check to pull plan status, deductible, out-of-pocket, and per-service benefits directly from the payer.</div>}
            <VerifyPanel patientUuid={patientUuid} policyIndex={i} hasExisting={!!s} onDone={load} onPatientUpdated={onPatientUpdated} />
            <ProcedureCheck patientUuid={patientUuid} policyIndex={i} onDone={load} onPatientUpdated={onPatientUpdated} />
          </div>
        );
      })}
    </div>
  );
}
