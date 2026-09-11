import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { facilitiesApi, usersApi, toApiError } from '../../lib/api.js';

const BLANK = { npi: '', name: '', facilityCode: '', address: '', city: '', state: '', zip: '', phone: '', fax: '', taxonomy: '', taxonomyCode: '', taxId: '', authorizedOfficial: '', enumerationDate: '', mailingAddress: '', nppesStatus: '', logo: '' };
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
  const { user } = useAuth();
  const isMaster = user?.role === 'master_admin';
  const editing = !!facility;
  const [uuid, setUuid] = useState(facility?.uuid || null);

  // --- MASTER-only Danger Zone: complete facility data wipe ---
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeName, setWipeName] = useState('');
  const [wipeAlsoDelete, setWipeAlsoDelete] = useState(false);
  const [wiping, setWiping] = useState(false);

  // --- NPPES lookup (add mode) ---
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [form, setForm] = useState(editing ? { ...BLANK, ...facility } : BLANK);
  const [verified, setVerified] = useState(editing); // a facility is chosen/verified
  // Manual entry: the admin fills the facility details by hand instead of picking an
  // NPPES record. Governs the saved `source` ('manual' vs 'nppes') and the review badge.
  const [manual, setManual] = useState(editing ? facility?.source === 'manual' : false);
  const [saving, setSaving] = useState(false);
  // Logo: null = unchanged, a data URI = new upload, '' = remove. The existing logo
  // (form.logo) is an inline data URI for display only (served by getFacility from the
  // facility's S3 object) and is never sent back.
  const [logoData, setLogoData] = useState(null);

  function onLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image file (PNG, JPG, SVG…).'); return; }
    if (file.size > 500 * 1024) { toast.error('Logo must be under 500 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => setLogoData(reader.result);
    reader.readAsDataURL(file);
  }
  const logoSrc = logoData !== null ? (logoData || null) : (form.logo || null);

  // --- provider assignment (manage mode) ---
  const [providers, setProviders] = useState(facility?.providers || []);
  const [allProviders, setAllProviders] = useState([]);
  const [pickProvider, setPickProvider] = useState('');
  const [provSearch, setProvSearch] = useState('');
  const debounce = useRef(null);

  // Providers AND billing users can be assigned. SERVER-searched (paginated) so this scales to thousands
  // of providers — type to narrow; we fetch a bounded page of active provider/billing matches.
  useEffect(() => {
    const t = setTimeout(() => {
      usersApi.list({ roles: 'provider,billing', status: 'active', q: provSearch.trim(), page: 1, pageSize: 50 })
        .then(({ data }) => setAllProviders(data.users || []))
        .catch((e) => toast.error(toApiError(e).message));
    }, provSearch ? 250 : 0);
    return () => clearTimeout(t);
  }, [provSearch, toast]);

  // Managing an existing facility: load its full record (assigned members).
  useEffect(() => {
    if (!editing || !uuid) return;
    facilitiesApi.get(uuid).then(({ data }) => {
      setForm({ ...BLANK, ...data.facility });
      setProviders(data.facility.providers || []);
    }).catch((e) => toast.error(toApiError(e).message));
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
    // Tax ID (EIN) is not in NPPES — preserve any manually entered value.
    setForm((f) => ({ ...f, npi: r.npi || '', name: r.name || '', address: r.address || '', city: r.city || '', state: r.state || '', zip: r.zip || '', phone: r.phone || '', fax: r.fax || '', taxonomy: r.taxonomy || '', taxonomyCode: r.taxonomyCode || '', authorizedOfficial: r.authorizedOfficial || '', enumerationDate: r.enumerationDate || '', mailingAddress: r.mailingAddress || '', nppesStatus: r.nppesStatus || r.status || '' }));
    setResults([]);
    setManual(false);
    setVerified(true);
  }

  // Switch to manual entry: a super/master admin types the facility details by hand
  // (e.g. a facility not yet in the NPPES registry, or one without an NPI).
  function startManual() {
    setForm(BLANK);
    setResults([]);
    setTerm('');
    setManual(true);
    setVerified(true);
  }

  async function save() {
    if (!form.name.trim()) { toast.error('Facility name is required.'); return; }
    const npiTrim = (form.npi || '').trim();
    if (npiTrim && !/^\d{10}$/.test(npiTrim)) {
      toast.error('NPI must be exactly 10 digits (or leave it blank for a manual facility).'); return;
    }
    setSaving(true);
    try {
      const { logo: _display, ...rest } = form; // drop the display-only signed URL
      const payload = { ...rest };
      if (logoData !== null) payload.logo = logoData; // new upload (data URI) or '' to clear
      if (uuid) {
        const { data } = await facilitiesApi.update(uuid, payload);
        setForm((f) => ({ ...f, logo: data.facility.logo || '' }));
        setLogoData(null);
        setProviders(data.facility.providers || providers);
        toast.success('Facility updated.');
        onSaved?.();
      } else {
        const { data } = await facilitiesApi.create({ ...payload, source: manual ? 'manual' : 'nppes' });
        setUuid(data.facility.uuid);
        setForm((f) => ({ ...f, logo: data.facility.logo || '' }));
        setLogoData(null);
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

  // MASTER-ONLY: permanently wipe ALL of this facility's data. Requires the exact facility name typed
  // back (defense against a mis-click). Shows the deletion summary and closes on success.
  async function doWipe() {
    if (!uuid) return;
    if (wipeName.trim().toLowerCase() !== String(form.name || '').trim().toLowerCase()) {
      toast.error('The typed name does not match the facility name.'); return;
    }
    setWiping(true);
    try {
      const { data } = await facilitiesApi.masterWipe(uuid, { confirmName: wipeName.trim(), deleteFacility: wipeAlsoDelete });
      toast.success(`Facility wiped — ${data.patients} patients, ${data.encounters} encounters, ${data.appointments} appointments, ${data.referrals} referrals, ${data.auditLogs} audit rows, ${data.s3ObjectsDeleted ?? 0} files. Providers: ${data.providersDeleted} removed, ${data.providersUnlinked} unlinked.`);
      onSaved?.();
      onClose?.();
    } catch (e) { toast.error(toApiError(e).message); } finally { setWiping(false); }
  }

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const assignedSet = useMemo(() => new Set(providers.map((p) => p.uuid)), [providers]);
  const available = allProviders.filter((p) => !assignedSet.has(p.uuid));
  const wipeArmed = wipeName.trim().toLowerCase() === String(form.name || '').trim().toLowerCase() && wipeName.trim().length > 0;

  return (
    <Modal
      title={editing ? 'Manage Facility' : uuid ? 'Assign Providers' : 'Add Facility'}
      width={720}
      onClose={onClose}
      footer={<>
        <span className="fac-foot">{manual ? 'Manual entry · admin-entered facility record' : 'CMS NPPES registry · verified facility records'}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose} disabled={saving}>Close</button>
        <button className="btn" onClick={save} disabled={saving || !verified}>
          {saving ? <span className="spinner" /> : uuid ? 'Save changes' : manual ? 'Create facility' : 'Verify & save'}
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
            {!manual && (
              <div className="fac-manual-cta">
                <span className="fac-manual-sep">Not in the registry, or no NPI?</span>
                <button type="button" className="btn ghost sm" onClick={startManual}>Enter facility details manually</button>
              </div>
            )}
          </div>
        )}

        {verified && (
          <div className="fac-verify">
            <div className="fac-verify-head">
              <span className={`fac-badge${manual ? ' manual' : ''}`}>{manual ? 'Manual entry' : 'NPPES verified'}</span>
              <span className="fac-verify-title">{manual ? 'Enter the facility details' : 'Review the facility details'}</span>
            </div>
            <div className="fac-logo">
              <div className="fac-logo-preview">
                {logoSrc ? <img src={logoSrc} alt="Facility logo" /> : <span className="fac-logo-ph">{initials(form.name)}</span>}
              </div>
              <div className="fac-logo-side">
                <span className="fac-logo-title">Facility logo</span>
                <span className="fac-logo-hint">PNG, JPG, SVG or WEBP · under 500 KB · stored in the facility's secure folder.</span>
                <div className="fac-logo-actions">
                  <label className="btn ghost sm">
                    {logoSrc ? 'Change logo' : 'Upload logo'}
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" hidden onChange={onLogoFile} />
                  </label>
                  {logoSrc ? <button type="button" className="act danger" onClick={() => setLogoData('')}>Remove</button> : null}
                </div>
              </div>
            </div>
            <div className="fac-grid">
              <Fld label="Facility name" v={form.name} on={(v) => setF('name', v)} wide />
              <Fld label="Facility Code (MRN / Encounter ID prefix)" v={form.facilityCode} on={(v) => setF('facilityCode', v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))} hint="2–8 letters/numbers. Used as the prefix for this facility’s MRNs and Encounter IDs. Auto-generated from the name if left blank." />
              <Fld label="NPI" v={form.npi} on={(v) => setF('npi', v)} />
              <Fld label="Tax ID (EIN)" v={form.taxId} on={(v) => setF('taxId', v)} />
              <Fld label="Taxonomy" v={form.taxonomy} on={(v) => setF('taxonomy', v)} wide />
              <Fld label="Address" v={form.address} on={(v) => setF('address', v)} wide />
              <Fld label="City" v={form.city} on={(v) => setF('city', v)} />
              <Fld label="State" v={form.state} on={(v) => setF('state', v)} />
              <Fld label="ZIP" v={form.zip} on={(v) => setF('zip', v)} />
              <Fld label="Phone" v={form.phone} on={(v) => setF('phone', v)} />
              <Fld label="Fax" v={form.fax} on={(v) => setF('fax', v)} />
              <Fld label="Taxonomy code" v={form.taxonomyCode} on={(v) => setF('taxonomyCode', v)} />
              <Fld label="NPPES status" v={form.nppesStatus} on={(v) => setF('nppesStatus', v)} />
              <Fld label="Enumeration date" v={form.enumerationDate} on={(v) => setF('enumerationDate', v)} />
              <Fld label="Authorized official" v={form.authorizedOfficial} on={(v) => setF('authorizedOfficial', v)} wide />
              <Fld label="Mailing address" v={form.mailingAddress} on={(v) => setF('mailingAddress', v)} wide />
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
            {uuid && (
              <input className="input" style={{ marginBottom: 8 }} placeholder="Search providers by name to assign…"
                value={provSearch} onChange={(e) => setProvSearch(e.target.value)} autoComplete="off" spellCheck={false} />
            )}
            <div className="fac-assign-row">
              <select className="select" value={pickProvider} onChange={(e) => setPickProvider(e.target.value)} disabled={!uuid}>
                <option value="">{uuid ? (available.length ? 'Select a provider or billing user to assign…' : 'No matches — refine the search…') : 'Save the facility to enable assignment…'}</option>
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

        {/* MASTER-ONLY Danger Zone — complete facility data wipe. */}
        {isMaster && editing && uuid && (
          <div className="fac-danger">
            <div className="fac-danger-head">
              <span className="fac-danger-title">Danger Zone — Master delete</span>
              <span className="fac-danger-hint">
                Permanently and irreversibly wipes ALL of this facility's data: every patient, chart,
                encounter, note, appointment, referral, and document (database + secure file storage),
                plus this facility's audit trail. Providers who serve only this facility are removed;
                providers shared with other facilities are only unlinked. Nothing in any other facility
                is touched.
              </span>
            </div>
            {!wipeOpen ? (
              <button type="button" className="btn danger" onClick={() => setWipeOpen(true)}>
                Wipe all facility data…
              </button>
            ) : (
              <div className="fac-danger-confirm">
                <label className="fac-lbl">
                  Type the facility name <b>{form.name}</b> to confirm:
                </label>
                <input
                  className="input"
                  value={wipeName}
                  onChange={(e) => setWipeName(e.target.value)}
                  placeholder={form.name}
                  autoComplete="off"
                  spellCheck={false}
                />
                <label className="fac-danger-check">
                  <input type="checkbox" checked={wipeAlsoDelete} onChange={(e) => setWipeAlsoDelete(e.target.checked)} />
                  Also delete the facility record itself (not just its data)
                </label>
                <div className="fac-danger-actions">
                  <button type="button" className="btn ghost" onClick={() => { setWipeOpen(false); setWipeName(''); setWipeAlsoDelete(false); }} disabled={wiping}>
                    Cancel
                  </button>
                  <button type="button" className="btn danger" onClick={doWipe} disabled={!wipeArmed || wiping}>
                    {wiping ? <span className="spinner" /> : 'Permanently wipe this facility'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Fld({ label, v, on, wide, hint }) {
  return (
    <div className={`fac-fld ${wide ? 'fac-fld-wide' : ''}`}>
      <label>{label}</label>
      <input className="input" value={v || ''} onChange={(e) => on(e.target.value)} />
      {hint ? <span className="fac-fld-hint">{hint}</span> : null}
    </div>
  );
}
