import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { facilitiesApi, toApiError } from '../../lib/api.js';

/**
 * Per-facility feature switches (super-admin only). Each facility can INDEPENDENTLY turn off
 * the coding engine (claims scrubbing) and real-time eligibility verification. Enforced
 * server-side — when a feature is off for a facility, its endpoints refuse and the EHR hides the
 * controls for patients at that facility. This UI just reflects and flips the flags.
 */
export default function SystemSettings() {
  const toast = useToast();
  const [facilities, setFacilities] = useState(null);
  const [busy, setBusy] = useState({}); // `${uuid}:${flag}` -> true

  const load = useCallback(async () => {
    try { const { data } = await facilitiesApi.list(); setFacilities(data.facilities || []); }
    catch (e) { toast.error(toApiError(e).message); setFacilities([]); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  async function toggle(fac, flag, next) {
    const key = `${fac.uuid}:${flag}`;
    if (busy[key]) return;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const { data } = await facilitiesApi.setFlags(fac.uuid, { [flag]: next });
      setFacilities((cur) => cur.map((f) => (f.uuid === fac.uuid ? { ...f, ...data.facility } : f)));
      const label = flag === 'codingEnabled' ? 'Coding engine' : 'Eligibility verification';
      toast.success(`${label} ${next ? 'enabled' : 'disabled'} for ${fac.name}.`);
    } catch (e) { toast.error(toApiError(e).message); }
    finally { setBusy((b) => ({ ...b, [key]: false })); }
  }

  const Switch = ({ fac, flag }) => {
    const on = fac[flag] !== false;
    const key = `${fac.uuid}:${flag}`;
    return (
      <div className="sysset-control">
        <span className={`sysset-state ${on ? 'on' : 'off'}`}>
          {busy[key] ? <span className="spinner dark" /> : <span className="dot" />}{on ? 'On' : 'Off'}
        </span>
        <label className="switch" title={`${on ? 'Disable' : 'Enable'} for ${fac.name}`}>
          <input type="checkbox" checked={on} disabled={!!busy[key]} onChange={(e) => toggle(fac, flag, e.target.checked)} />
          <span className="track" />
        </label>
      </div>
    );
  };

  return (
    <div className="sysset">
      <div className="sysset-head">
        <h2 className="sysset-h2">Feature Switches by Facility</h2>
        <p className="sysset-lede">
          Turn the coding engine (claims scrubbing) and real-time eligibility verification on or off
          for each facility independently. Changes take effect immediately and are enforced server-side.
        </p>
      </div>

      {facilities === null ? (
        <div className="sysset-card"><div className="sysset-row"><span className="spinner dark" />&nbsp; Loading facilities…</div></div>
      ) : facilities.length === 0 ? (
        <div className="sysset-card"><div className="sysset-row">No facilities yet. Add a facility to configure its features.</div></div>
      ) : (
        facilities.map((f) => (
          <div className="sysset-card" key={f.uuid}>
            <div className="sysset-fachdr">
              <span className="sysset-facname">{f.name}</span>
              <span className="sysset-facsub">{[f.city, f.state].filter(Boolean).join(', ')}{f.npi ? ` · NPI ${f.npi}` : ''}</span>
            </div>
            <div className="sysset-row">
              <div className="sysset-info">
                <span className="sysset-title">Coding engine</span>
                <span className="sysset-desc">Automatic coding &amp; claims scrubbing (NCCI, medical necessity, risk score) in the note editor. When off, the coding panel is hidden and the server refuses coding requests for this facility.</span>
              </div>
              <Switch fac={f} flag="codingEnabled" />
            </div>
            <div className="sysset-row">
              <div className="sysset-info">
                <span className="sysset-title">Eligibility verification</span>
                <span className="sysset-desc">Real-time insurance eligibility &amp; benefits (X12 270/271) on the Face Sheet and scheduler. When off, the Verify actions are hidden and the server rejects eligibility requests for this facility.</span>
              </div>
              <Switch fac={f} flag="eligibilityEnabled" />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
