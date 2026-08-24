import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { facilitiesApi, usersApi, toApiError } from '../../lib/api.js';

const BLANK = { npi: '', name: '', address: '', city: '', state: '', zip: '', phone: '', taxonomy: '' };
const initials = (n = '') => n.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '·';

/**
 * Add / manage a facility.
 *  - Add: search NPPES by NPI or name (auto-triggered) → verify the complete
 *    fetched details → save.
 *  - Manage: review the saved facility and assign / unassign providers (which
 *    governs each provider's billing facility and cross-facility isolation).
 */
export default function FacilityModal({ facility = null, onClose, onSaved }) {
  const toast = useToast();
  const editing = !!facility;
  const [uuid, setUuid] = useState(facility?.uuid || null);

  // --- NPPES lookup (add mode) ---
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [form, setForm] = useState(editing ? { ...BLANK, ...facility } : BLANK);
  const [verified, setVerified] = useState(editing); // a facility is chosen/verified
  const [saving, setSaving] = useState(false);

  // --- provider assignment (manage mode) ---
  const [providers, setProviders] = useState(facility?.providers || []);
  const [allProviders, setAllProviders] = useState([]);
  const [pickProvider, setPickProvider] = useState('');
  const debounce = useRef(null);

  // Providers AND billing users can be assigned to a facility.
  useEffect(() => {
    usersApi.list().then(({ data }) => setAllProviders(
      (data.users || []).filter((u) => ['provider', 'billing'].includes(u.role) && u.status === 'active'),
    )).catch(() => {});
  }, []);

  // Managing an existing facility: load its full record (assigned members).
  useEffect(() => {
    if (!editing || !uuid) return;
    facilitiesApi.get(uuid).then(({ data }) => {
      setForm({ ...BLANK, ...data.facility });
      setProviders(data.facility.providers || []);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-trigger the NPPES lookup once a name (≥3 chars) or a 10-digit NPI is typed.
  useEffect(() => {
    if (editing) return undefined;
    const t = term.trim();
    const digits = t.replace(/\D/g, '');
    const ready = digits.length === 10 || t.length >= 3;
    if (!ready) { setResults([]); setSearching(false); return undefined; }
    setSearching(true);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      try {
        const params = digits.length === 10 ? { npi: digits } : { q: t };
        const { data } = await facilitiesApi.nppes(params);
        setResults(data.results || []);
      } catch (e) { toast.error(toApiError(e).message); }
      finally { setSearching(false); }
    }, 400);
    return () => clearTimeout(debounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, editing]);

  function choose(r) {
    setForm({ npi: r.npi || '', name: r.name || '', address: r.address || '', city: r.city || '', state: r.state || '', zip: r.zip || '', phone: r.phone || '', taxonomy: r.taxonomy || '' });
    setResults([]);
    setVerified(true);
  }

  async function save() {
    if (!form.name.trim()) { toast.error('Facility name is required.'); return; }
    setSaving(true);
    try {
      if (uuid) {
        const { data } = await facilitiesApi.update(uuid, form);
        setProviders(data.facility.providers || providers);
        toast.success('Facility updated.');
        onSaved?.();
      } else {
        const { data } = await facilitiesApi.create({ ...form, source: 'nppes' });
        setUuid(data.facility.uuid);
        setProviders(data.facility.providers || []);
        toast.success(data.duplicate ? 'Facility already existed — opened for assignment.' : 'Facility saved.');
        onSaved?.();
      }
    } catch (e) { toast.error(toApiError(e).message); } finally { setSaving(false); }
  }

  async function assign() {
    if (!pickProvider || !uuid) return;
    try {
      const { data } = await facilitiesApi.assignProvider(uuid, pickProvider);
      setProviders(data.facility.providers || []);
      setPickProvider('');
      toast.success('Provider assigned.');
      onSaved?.();
    } catch (e) { toast.error(toApiError(e).message); }
  }

  async function unassign(providerUuid) {
    try {
      const { data } = await facilitiesApi.unassignProvider(uuid, providerUuid);
      setProviders(data.facility.providers || []);
      toast.success('Provider unassigned.');
      onSaved?.();
    } catch (e) { toast.error(toApiError(e).message); }
  }

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const assignedSet = useMemo(() => new Set(providers.map((p) => p.uuid)), [providers]);
  const available = allProviders.filter((p) => !assignedSet.has(p.uuid));

  return (
    <Modal
      title={editing ? 'Manage Facility' : uuid ? 'Assign Providers' : 'Add Facility'}
      width={720}
      onClose={onClose}
      footer={<>
        <span className="fac-foot">CMS NPPES registry · verified facility records</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose} disabled={saving}>Close</button>
        <button className="btn" onClick={save} disabled={saving || !verified}>
          {saving ? <span className="spinner" /> : uuid ? 'Save changes' : 'Verify & save'}
        </button>
      </>}
    >
      <div className="fac-modal">
        {!editing && !uuid && (
          <div className="fac-search">
            <label className="fac-lbl">Search the NPPES registry by facility name or NPI</label>
            <div className="fac-search-box">
              <span className="fac-search-ic" aria-hidden="true" />
              <input
                className="input"
                autoFocus
                placeholder="e.g. Ignite Medical Resort  ·  or a 10-digit NPI"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
              />
              {searching && <span className="spinner dark fac-search-spin" />}
            </div>
            {results.length > 0 && (
              <div className="fac-results">
                {results.map((r) => (
                  <button key={r.npi} type="button" className="fac-result" onClick={() => choose(r)}>
                    <span className="fac-result-main">
                      <span className="fac-result-name">{r.name}</span>
                      <span className="fac-result-sub">{[r.address, r.city, r.state, r.zip].filter(Boolean).join(', ')}</span>
                    </span>
                    <span className="fac-result-meta">
                      <span className="fac-result-npi">NPI {r.npi}</span>
                      {r.taxonomy && <span className="fac-result-tax">{r.taxonomy}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!searching && term.trim().length >= 3 && results.length === 0 && (
              <div className="fac-empty">No matching facilities found in the NPPES registry.</div>
            )}
          </div>
        )}

        {verified && (
          <div className="fac-verify">
            <div className="fac-verify-head">
              <span className="fac-badge">{form.npi ? 'NPPES verified' : 'Manual entry'}</span>
              <span className="fac-verify-title">Review the facility details</span>
            </div>
            <div className="fac-grid">
              <Fld label="Facility name" v={form.name} on={(v) => setF('name', v)} wide />
              <Fld label="NPI" v={form.npi} on={(v) => setF('npi', v)} />
              <Fld label="Taxonomy" v={form.taxonomy} on={(v) => setF('taxonomy', v)} />
              <Fld label="Address" v={form.address} on={(v) => setF('address', v)} wide />
              <Fld label="City" v={form.city} on={(v) => setF('city', v)} />
              <Fld label="State" v={form.state} on={(v) => setF('state', v)} />
              <Fld label="ZIP" v={form.zip} on={(v) => setF('zip', v)} />
              <Fld label="Phone" v={form.phone} on={(v) => setF('phone', v)} />
            </div>
          </div>
        )}

        {verified && (
          <div className="fac-assign">
            <div className="fac-assign-head">
              <span className="fac-verify-title">Assign providers &amp; billing users</span>
              <span className="fac-assign-hint">{uuid
                ? "An assigned member's facility becomes their patients' billing facility. Isolation is enforced per facility."
                : 'Save the facility first — then assign providers and billing users to it here.'}</span>
            </div>
            <div className="fac-assign-row">
              <select className="select" value={pickProvider} onChange={(e) => setPickProvider(e.target.value)} disabled={!uuid}>
                <option value="">{uuid ? 'Select a provider or billing user to assign…' : 'Save the facility to enable assignment…'}</option>
                {available.map((p) => (
                  <option key={p.uuid} value={p.uuid}>{p.fullName} · {p.role === 'billing' ? 'Billing' : 'Provider'}{p.credentials?.length ? ` (${p.credentials.join(', ')})` : ''}</option>
                ))}
              </select>
              <button className="btn sm" onClick={assign} disabled={!uuid || !pickProvider}>Assign</button>
            </div>
            {!uuid ? null : providers.length === 0 ? (
              <div className="fac-empty">No members assigned yet.</div>
            ) : (
              <div className="fac-prov-list">
                {providers.map((p) => (
                  <div key={p.uuid} className="fac-prov">
                    <span className="fac-prov-av">{initials(p.fullName)}</span>
                    <span className="fac-prov-nm">{p.fullName}<span className={`fac-role-pill ${p.role}`}>{p.role === 'billing' ? 'Billing' : 'Provider'}</span>{p.credentials?.map((c) => <span key={c} className="cred-pill">{c}</span>)}</span>
                    <span className="spacer" />
                    <button className="act danger" onClick={() => unassign(p.uuid)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Fld({ label, v, on, wide }) {
  return (
    <div className={`fac-fld ${wide ? 'fac-fld-wide' : ''}`}>
      <label>{label}</label>
      <input className="input" value={v || ''} onChange={(e) => on(e.target.value)} />
    </div>
  );
}
