import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { facilitiesApi, settingsApi, toApiError } from '../../lib/api.js';

/**
 * Per-facility feature switches (super-admin only). Each facility can INDEPENDENTLY turn off
 * the SNOMED CT (claims scrubbing) and real-time eligibility verification. Enforced
 * server-side — when a feature is off for a facility, its endpoints refuse and the EHR hides the
 * controls for patients at that facility. This UI just reflects and flips the flags.
 *
 * Also hosts PLATFORM-WIDE settings (app_settings, not per-facility) — currently the NPP Medicare
 * payment differential, which scales non-physician-practitioner payscale value to 85% of the
 * physician fee schedule when enabled. Off by default; enforced server-side at pay computation.
 */
export default function SystemSettings() {
  const toast = useToast();
  const [facilities, setFacilities] = useState(null);
  const [busy, setBusy] = useState({}); // `${uuid}:${flag}` -> true
  const [platform, setPlatform] = useState(null); // global app_settings
  const [platBusy, setPlatBusy] = useState({});    // `${key}` -> true

  const load = useCallback(async () => {
    try { const { data } = await facilitiesApi.list(); setFacilities(data.facilities || []); }
    catch (e) { toast.error(toApiError(e).message); setFacilities([]); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const loadPlatform = useCallback(async () => {
    try { const { data } = await settingsApi.get(); setPlatform(data.settings || data || {}); }
    catch (e) { toast.error(toApiError(e).message); setPlatform({}); }
  }, [toast]);
  useEffect(() => { loadPlatform(); }, [loadPlatform]);

  async function togglePlatform(key, next) {
    if (platBusy[key]) return;
    setPlatBusy((b) => ({ ...b, [key]: true }));
    try {
      const { data } = await settingsApi.update({ [key]: next });
      setPlatform((cur) => ({ ...(cur || {}), ...(data.settings || { [key]: next }) }));
      const label = key === 'nppMedicareDifferential' ? 'NPP Medicare payment differential' : key;
      toast.success(`${label} ${next ? 'enabled' : 'disabled'}.`);
    } catch (e) { toast.error(toApiError(e).message); }
    finally { setPlatBusy((b) => ({ ...b, [key]: false })); }
  }

  async function toggle(fac, flag, next) {
    const key = `${fac.uuid}:${flag}`;
    if (busy[key]) return;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const { data } = await facilitiesApi.setFlags(fac.uuid, { [flag]: next });
      setFacilities((cur) => cur.map((f) => (f.uuid === fac.uuid ? { ...f, ...data.facility } : f)));
      const label = flag === 'codingEnabled' ? 'SNOMED CT'
        : flag === 'autoCreatePatients' ? 'Automatic patient creation from faxes'
          : 'Eligibility verification';
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

  const PlatformSwitch = ({ settingKey }) => {
    const on = !!(platform && platform[settingKey] === true);
    return (
      <div className="sysset-control">
        <span className={`sysset-state ${on ? 'on' : 'off'}`}>
          {platBusy[settingKey] ? <span className="spinner dark" /> : <span className="dot" />}{on ? 'On' : 'Off'}
        </span>
        <label className="switch" title={on ? 'Disable' : 'Enable'}>
          <input type="checkbox" checked={on} disabled={!!platBusy[settingKey] || platform === null}
            onChange={(e) => togglePlatform(settingKey, e.target.checked)} />
          <span className="track" />
        </label>
      </div>
    );
  };

  return (
    <div className="sysset">
      <div className="sysset-head">
        <h2 className="sysset-h2">Platform Settings</h2>
        <p className="sysset-lede">
          Organization-wide payscale &amp; compliance controls. These apply across every facility and take
          effect immediately for all pay calculations and reports; enforced server-side.
        </p>
      </div>

      <div className="sysset-card">
        <div className="sysset-row">
          <div className="sysset-info">
            <span className="sysset-title">NPP Medicare payment differential (85%)</span>
            <span className="sysset-desc">
              When on, work rendered and billed under a non-physician practitioner&apos;s own NPI (NP, PA, CNS, CRNA, CNM)
              is valued at 85% of the physician fee schedule across the payscale and RVU reports — matching CMS&apos;s NPP
              payment differential. Physician (MD/DO) pay is never changed, and Work RVUs and the 60/40 split are preserved
              on the adjusted value. Leave off for groups billing NPP work incident-to or split/shared (reimbursed at 100%).
              Off by default.
            </span>
          </div>
          <PlatformSwitch settingKey="nppMedicareDifferential" />
        </div>
      </div>

      <div className="sysset-head">
        <h2 className="sysset-h2">Feature Switches by Facility</h2>
        <p className="sysset-lede">
          Turn the SNOMED CT (claims scrubbing) and real-time eligibility verification on or off
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
                <span className="sysset-title">SNOMED CT</span>
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
            <div className="sysset-row">
              <div className="sysset-info">
                <span className="sysset-title">Automatic patient creation from faxes</span>
                <span className="sysset-desc">When an incoming referral fax to this facility&apos;s number has no matching chart, deterministically create the patient from the extracted demographics and file the document to that chart. When off, unmatched inbound faxes stay unlinked in the intake queue for manual review (existing-chart matching is unaffected).</span>
              </div>
              <Switch fac={f} flag="autoCreatePatients" />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
