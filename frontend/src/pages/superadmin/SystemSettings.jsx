import { useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { settingsApi, toApiError } from '../../lib/api.js';

/**
 * System-wide feature flags (super-admin only). Currently: enable/disable real-time
 * eligibility verification across the EHR. The toggle is enforced server-side — when
 * off, every eligibility endpoint refuses the payer call — this UI just reflects and
 * flips the flag.
 */
export default function SystemSettings() {
  const { settings, setSettings, refreshSettings } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const eligibilityEnabled = settings?.eligibilityEnabled !== false;

  async function setEligibility(next) {
    if (saving || next === eligibilityEnabled) return;
    setSaving(true);
    try {
      const { data } = await settingsApi.update({ eligibilityEnabled: next });
      setSettings((s) => ({ ...s, ...(data.settings || { eligibilityEnabled: next }) }));
      await refreshSettings();
      toast.success(`Eligibility verification ${next ? 'enabled' : 'disabled'} across the EHR.`);
    } catch (e) {
      toast.error(toApiError(e).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sysset">
      <div className="sysset-card">
        <div className="sysset-row">
          <div className="sysset-info">
            <span className="sysset-title">Eligibility Verification</span>
            <span className="sysset-desc">
              Real-time insurance eligibility &amp; benefits checks (X12 270/271) across the EHR —
              patient Face Sheet and appointment scheduler. When disabled, the Verify actions are
              hidden and the server rejects every eligibility request.
            </span>
          </div>
          <div className="sysset-control">
            <span className={`sysset-state ${eligibilityEnabled ? 'on' : 'off'}`}>
              {saving ? <span className="spinner dark" /> : <span className="dot" />}
              {eligibilityEnabled ? 'Enabled' : 'Disabled'}
            </span>
            <label className="switch" title={eligibilityEnabled ? 'Disable eligibility verification' : 'Enable eligibility verification'}>
              <input
                type="checkbox"
                checked={eligibilityEnabled}
                disabled={saving}
                onChange={(e) => setEligibility(e.target.checked)}
              />
              <span className="track" />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
