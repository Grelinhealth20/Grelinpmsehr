import { useCallback, useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { appointmentsApi, toApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from './Toast.jsx';

/**
 * Appointment eligibility & benefits popup — a clean, enterprise view of the
 * real-time 271 for one appointment: coverage status, and basic benefits
 * (copay / deductible / coinsurance / OOP) for Individual and Family coverage
 * levels. All data is the actual payer response (no mock).
 */

const STATUS = {
  active: { label: 'Active Coverage', cls: 'active' },
  inactive: { label: 'Inactive', cls: 'inactive' },
  pending: { label: 'Pending', cls: 'pending' },
  error: { label: 'Payer unavailable — recheck', cls: 'pending' },
};
const val = (v) => (v == null || v === '' ? '—' : v);
const fmtDate = (d) => { if (!d) return '—'; const [y, m, day] = String(d).slice(0, 10).split('-'); return y ? `${m}/${day}/${y}` : d; };

export default function AppointmentEligibilityModal({ appointment, onClose, onChanged }) {
  const toast = useToast();
  const { eligibilityEnabled } = useAuth();
  const [check, setCheck] = useState(undefined); // undefined = loading, null = none
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { const { data } = await appointmentsApi.eligibility(appointment.uuid); setCheck(data.check || null); }
    catch { setCheck(null); }
  }, [appointment.uuid]);
  useEffect(() => { load(); }, [load]);

  const verify = async () => {
    setErr(''); setBusy(true);
    try {
      await appointmentsApi.verifyEligibility(appointment.uuid);
      toast.success('Eligibility verified.');
      await load();
      onChanged?.();
    } catch (e) {
      const a = toApiError(e);
      setErr(a.code === 'STEDI_DISABLED' ? 'Eligibility service is not configured.' : a.message);
    } finally { setBusy(false); }
  };

  const s = check?.summary;
  const cl = s?.coverageLevels;
  const st = s ? (STATUS[s.status] || { label: s.statusLabel || 'Unknown', cls: 'pending' }) : null;
  const loading = check === undefined || busy;

  return (
    <Modal
      title="Eligibility & Benefits"
      width={560}
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose}>Close</button>
          {/* Opening never calls the payer — benefits are read from storage. This button
              is the ONLY trigger: a deliberate manual re-verify (subtle when benefits
              already exist, prominent to retry after a payer outage or first check). */}
          {check !== undefined && (eligibilityEnabled ? (
            <button className={`btn ${check && check.status !== 'error' ? 'ghost' : ''}`} onClick={verify} disabled={busy}>
              {busy ? 'Verifying…' : (check?.status === 'error' ? 'Retry verification' : check ? 'Re-verify' : 'Verify now')}
            </button>
          ) : (
            <span className="bx-disabled-note" style={{ margin: 0 }}>Eligibility verification is disabled by your administrator.</span>
          ))}
        </>
      )}
    >
      {loading ? (
        <div className="aeg-loading">
          <div className="aeg-orbit"><span /><span /><span /></div>
          <div className="aeg-scan"><i /></div>
          <p className="aeg-loading-t">Contacting the payer network…</p>
          <p className="aeg-loading-s">Checking eligibility &amp; benefits</p>
        </div>
      ) : !check ? (
        <div className="aeg-empty">
          <p>No eligibility on file for this appointment.</p>
          <p className="muted">Run a real-time check against the payer for {appointment.title || 'this appointment'}.</p>
          {err && <div className="aeg-err">{err}</div>}
        </div>
      ) : (
        <div className="aeg">
          <div className={`aeg-banner ${st.cls}`}>
            <span className={`aeg-pill ${st.cls}`}><span className="dot" />{st.label}</span>
            <span className="aeg-plan">{s.plan?.name || s.payer?.name || 'Coverage'}</span>
            {s.plan?.type && <span className="aeg-type">{s.plan.type}</span>}
          </div>

          {s.status === 'error' ? (
            <div className="aeg-err">The payer’s system was temporarily unavailable, so benefits couldn’t be returned. This does <b>not</b> mean the patient is uninsured — click <b>Re-verify</b> to try again.</div>
          ) : s.requestedProcedures?.length > 0 && (
            <div className="aeg-proc">For CPT {s.requestedProcedures.map((p) => `${p.code} · ${p.label}`).join(', ')}</div>
          )}

          <div className="aeg-table-wrap">
            <table className="aeg-table">
              <thead><tr><th /><th>Individual</th><th>Family</th></tr></thead>
              <tbody>
                <tr><td>Copay</td><td>{val(cl?.individual?.copay)}</td><td>{val(cl?.family?.copay)}</td></tr>
                <tr><td>Deductible</td><td>{val(cl?.individual?.deductible)}</td><td>{val(cl?.family?.deductible)}</td></tr>
                <tr><td>Coinsurance</td><td>{val(cl?.individual?.coinsurance)}</td><td>{val(cl?.family?.coinsurance)}</td></tr>
                <tr><td>Out-of-pocket max</td><td>{val(cl?.individual?.oopMax)}</td><td>{val(cl?.family?.oopMax)}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="aeg-meta">
            <div><span>Member</span><b>{val(s.member?.name)}</b></div>
            <div><span>Member ID</span><b>{val(s.member?.memberId)}</b></div>
            <div><span>Date of service</span><b>{fmtDate(check.serviceDate)}</b></div>
            <div><span>Payer</span><b>{val(s.payer?.name)}{s.payer?.id ? ` · ${s.payer.id}` : ''}</b></div>
          </div>

          {err && <div className="aeg-err">{err}</div>}
          <div className="aeg-foot">
            <span>Verified {check.verifiedAt ? new Date(check.verifiedAt).toLocaleString() : '—'}</span>
            <span className="aeg-live"><i />Real-time payer response</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
