import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { referralsApi, facilitiesApi, toApiError } from '../../lib/api.js';
import TablePager from '../../components/TablePager.jsx';

const PER = 25;
const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', scheduled: 'Scheduled', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled', received: 'Received' };
const usDate = (s) => (s ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : '—');

/**
 * Super Admin referral governance — two views:
 *  • Oversight: every incoming/outgoing referral across ALL facilities (no scope) + fax delivery status.
 *  • Fax Numbers: per-facility incoming/outgoing Fax.Plus DID configuration + enable switch.
 */
export default function ReferralsAdmin() {
  const [view, setView] = useState('oversight');
  return (
    <div className="ref-admin">
      <div className="ref-admin-tabs">
        <button className={`ref-atab ${view === 'oversight' ? 'is-on' : ''}`} onClick={() => setView('oversight')}>Oversight</button>
        <button className={`ref-atab ${view === 'fax' ? 'is-on' : ''}`} onClick={() => setView('fax')}>Facility Settings</button>
        <button className={`ref-atab ${view === 'integration' ? 'is-on' : ''}`} onClick={() => setView('integration')}>Fax Integration</button>
      </div>
      {view === 'oversight' ? <Oversight /> : view === 'fax' ? <FacilityFaxConfig /> : <FaxIntegration />}
    </div>
  );
}

function Oversight() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [direction, setDirection] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [fax, setFax] = useState(null);
  const [recon, setRecon] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const first = useRef(true);

  async function loadStats() { try { const { data } = await referralsApi.adminStats(); setStats(data.referrals); setFax(data.fax); setRecon(data.reconciler); } catch { /* non-fatal */ } }
  // Pull the Fax.Plus inbox directly (safety net for any received fax a webhook missed).
  async function syncInbox() {
    setSyncing(true);
    try {
      const { data } = await referralsApi.adminPollInbox();
      const rc = data.reconcile || {};
      const healed = rc.selfHeal?.healed || 0; const settled = rc.outbound?.updated || 0;
      const extra = [healed ? `${healed} document${healed > 1 ? 's' : ''} recovered` : '', settled ? `${settled} status update${settled > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
      toast.success(`Reconciled — ${data.ingested} new, ${data.existing} already on file${extra ? ` · ${extra}` : ''}.`);
      loadStats(); load(page, direction, search);
    }
    catch (e) { toast.error(toApiError(e).message); } finally { setSyncing(false); }
  }
  async function load(p = 1, dir = direction, q = search) {
    setLoading(true);
    try { const { data } = await referralsApi.adminList({ direction: dir, q: q.trim(), page: p, pageSize: PER }); setRows(data.referrals || []); setTotal(data.total || 0); setPage(data.page || p); }
    catch (e) { toast.error(toApiError(e).message); } finally { setLoading(false); }
  }
  useEffect(() => { loadStats(); }, []);
  useEffect(() => {
    const d = first.current ? 0 : 280; first.current = false;
    const t = setTimeout(() => load(1, direction, search), d);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, search]);

  const totalPages = Math.max(1, Math.ceil(total / PER));

  return (
    <>
      {/* Fax integration health */}
      <div className="ref-admin-fax">
        <span className={`ref-fax-pill ${fax?.enabled ? 'ok' : fax?.configured ? 'warn' : 'off'}`}>
          Fax.Plus: {fax?.enabled ? 'Active' : fax?.configured ? 'Configured — authorize to activate' : 'Not configured'}
        </span>
        {fax?.outgoingNumber && <span className="ref-admin-num">Platform Out {fax.outgoingNumber}</span>}
        {fax?.incomingNumber && <span className="ref-admin-num">Platform In {fax.incomingNumber}</span>}
        <span className="ref-admin-num">{fax?.hasWebhookSecret ? 'Webhook ✓' : 'Webhook —'}</span>
        {fax?.enabled && (
          <span className="ref-admin-num" title={recon?.active ? `Automatic safety-net reconcile every ${Math.round((recon.intervalMs || 0) / 60000)} min — no missed faxes` : 'Auto-reconcile inactive'}>
            {recon?.active ? `Auto-reconcile ✓ (${Math.round((recon.intervalMs || 0) / 60000)}m)` : 'Auto-reconcile —'}
          </span>
        )}
        <span className="spacer" />
        <button className="btn ghost sm" onClick={syncInbox} disabled={syncing || !fax?.enabled} title={fax?.enabled ? 'Reconcile now — pull received faxes, recover any unstored documents, settle sent-fax statuses' : 'Activate Fax.Plus to enable reconcile'}>
          {syncing ? <span className="spinner dark" /> : 'Reconcile Now'}
        </button>
      </div>

      {/* KPI row */}
      <div className="ref-admin-kpis">
        <Kpi label="Outgoing" value={stats?.outgoing?.total ?? '—'} />
        <Kpi label="Incoming" value={stats?.incoming?.total ?? '—'} />
        <Kpi label="Faxed" value={stats?.faxed ?? '—'} />
        <Kpi label="Fax Failures" value={stats?.failed ?? '—'} tone={stats?.failed ? 'bad' : ''} />
      </div>

      <div className="ref-admin-bar">
        <div className="ref-seg sm">
          {['', 'outgoing', 'incoming'].map((d) => (
            <button key={d || 'all'} className={`ref-seg-btn ${direction === d ? 'is-on' : ''}`} onClick={() => setDirection(d)}>{d ? (d === 'outgoing' ? 'Outgoing' : 'Incoming') : 'All'}</button>
          ))}
        </div>
        <span className="spacer" />
        <input className="input ref-search" placeholder="Search patient, specialty, referral #…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="ref-table-wrap">
        <table className="ref-table">
          <thead>
            <tr>
              <th>Referral #</th><th>Date</th><th>Facility</th><th>Rendering Provider</th><th>Patient</th>
              <th>Dir</th><th>Specialty</th><th>Status</th><th>Fax</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="ref-empty"><span className="spinner dark" /> Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="ref-empty">No referrals found.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.uuid}>
                <td className="ref-no">{r.referralNo}</td>
                <td>{usDate(r.referralDate)}</td>
                <td>{r.facilityName || '—'}</td>
                <td>{r.owner || '—'}</td>
                <td><span className="ref-pt-name">{r.patient?.name || '—'}</span>{r.patient?.mrn && <span className="ref-pt-mrn">{r.patient.mrn}</span>}</td>
                <td>{r.direction === 'outgoing' ? '↗ Out' : '↘ In'}</td>
                <td>{r.specialty}</td>
                <td><span className={`ref-status ${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                <td>{r.fax?.status ? <span className="ref-fax-tag">{r.fax.status}{r.fax.hasDocument ? ' 📄' : ''}</span> : (r.fax?.error ? <span className="ref-fax-tag err">error</span> : '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && totalPages > 1 && (
        <div className="ref-pager">
          <span className="ref-pager-lbl">Page {page} of {totalPages} · {total} total</span>
          <span className="spacer" />
          <button className="pager-btn" disabled={page <= 1} onClick={() => load(page - 1)}>‹ Prev</button>
          <button className="pager-btn" disabled={page >= totalPages} onClick={() => load(page + 1)}>Next ›</button>
        </div>
      )}
    </>
  );
}

/**
 * Facility-specific fax number configuration. Each facility gets its own INCOMING DID (routes received
 * referrals to that facility) and OUTGOING number (outbound referrals are sent from it). There is NO
 * fallback: a facility with no outgoing number configured cannot send referral faxes (it fails loud
 * server-side). The platform numbers are shown only as reference to assign. The incoming DID is unique
 * per facility. Also toggles the Referrals feature + Faxing on/off for the facility.
 */
const FAX_PER = 25;
function FacilityFaxConfig() {
  const toast = useToast();
  const [platform, setPlatform] = useState({ incomingNumber: null, outgoingNumber: null });
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState('');
  const firstFax = useRef(true);

  // Server-side paginated (facilities name/NPI/city are plaintext → searchable in SQL).
  async function load(p = page, query = q) {
    setLoading(true);
    try {
      const { data } = await facilitiesApi.faxConfig({ page: p, pageSize: FAX_PER, q: query.trim() });
      setPlatform(data.platformNumbers || {});
      setRows((data.facilities || []).map((f) => ({ ...f, _in: f.incomingNumber || '', _out: f.outgoingNumber || '', _en: f.enabled !== false, _re: f.referralsEnabled !== false })));
      setTotal(data.total || 0); setPage(data.page || p);
    } catch (e) { toast.error(toApiError(e).message); } finally { setLoading(false); }
  }
  useEffect(() => {
    const d = firstFax.current ? 0 : 280; firstFax.current = false;
    const t = setTimeout(() => load(1, q), d);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const patch = (uuid, key, val) => setRows((rs) => rs.map((r) => (r.uuid === uuid ? { ...r, [key]: val } : r)));
  const dirty = (r) => (r._in || '') !== (r.incomingNumber || '') || (r._out || '') !== (r.outgoingNumber || '') || r._en !== (r.enabled !== false) || r._re !== (r.referralsEnabled !== false);

  async function save(r) {
    setSaving(r.uuid);
    try {
      const { data } = await facilitiesApi.setFaxConfig(r.uuid, { incomingNumber: r._in.trim(), outgoingNumber: r._out.trim(), enabled: r._en, referralsEnabled: r._re });
      const f = data.facility;
      setRows((rs) => rs.map((x) => (x.uuid === r.uuid ? { ...x, ...f, _in: f.incomingNumber || '', _out: f.outgoingNumber || '', _en: f.enabled !== false, _re: f.referralsEnabled !== false } : x)));
      toast.success(`Saved for ${r.name}.`);
    } catch (e) { toast.error(toApiError(e).message); } finally { setSaving(''); }
  }

  const list = rows; // server already filtered + paginated

  return (
    <div className="ref-faxcfg">
      <div className="ref-faxcfg-head">
        <div>
          <h3>Facility Referral Settings</h3>
          <p><b>Referrals</b> enables or disables the entire Referral Management feature for a facility’s providers (disabling hides it from their EHR). <b>Faxing</b> and the incoming/outgoing numbers control fax send/receive for that facility. A facility with no outgoing number configured cannot send referral faxes — there is no shared fallback number.</p>
        </div>
        <div className="ref-faxcfg-def">
          <span>Platform Fax.Plus numbers (assign as needed)</span>
          <b>In {platform.incomingNumber || '—'}</b>
          <b>Out {platform.outgoingNumber || '—'}</b>
        </div>
      </div>

      <div className="ref-admin-bar">
        <span className="spacer" />
        <input className="input ref-search" placeholder="Search facility or NPI…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="ref-table-wrap">
        <table className="ref-table ref-faxcfg-table">
          <thead>
            <tr><th>Facility</th><th>Providers</th><th>Referrals</th><th>Incoming fax (receives)</th><th>Outgoing fax (sends from)</th><th>Faxing</th><th></th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="ref-empty"><span className="spinner dark" /> Loading…</td></tr>
            ) : list.length === 0 ? (
              <tr><td colSpan={7} className="ref-empty">No facilities found.</td></tr>
            ) : list.map((r) => (
              <tr key={r.uuid} className={`${r.status !== 'active' ? 'is-inactive' : ''} ${!r._re ? 'ref-feat-off' : ''}`}>
                <td>
                  <span className="ref-pt-name">{r.name}</span>
                  {r.npi && <span className="ref-pt-mrn">NPI {r.npi}</span>}
                  {r.status !== 'active' && <span className="ref-pt-mrn">Inactive</span>}
                </td>
                <td>{r.providerCount ?? 0}</td>
                <td>
                  <label className="ref-switch" title={r._re ? 'Referrals enabled for this facility' : 'Referrals disabled for this facility'}>
                    <input type="checkbox" checked={r._re} onChange={(e) => patch(r.uuid, '_re', e.target.checked)} />
                    <span className="ref-switch-track"><span className="ref-switch-thumb" /></span>
                  </label>
                </td>
                <td><input className="input ref-fax-in" placeholder="+1…" value={r._in} onChange={(e) => patch(r.uuid, '_in', e.target.value)} disabled={!r._re} /></td>
                <td><input className="input ref-fax-in" placeholder="+1…" value={r._out} onChange={(e) => patch(r.uuid, '_out', e.target.value)} disabled={!r._re} /></td>
                <td>
                  <label className="ref-switch" title={r._en ? 'Faxing enabled' : 'Faxing disabled'}>
                    <input type="checkbox" checked={r._en} onChange={(e) => patch(r.uuid, '_en', e.target.checked)} disabled={!r._re} />
                    <span className="ref-switch-track"><span className="ref-switch-thumb" /></span>
                  </label>
                </td>
                <td>
                  <button className="btn sm primary" disabled={!dirty(r) || saving === r.uuid} onClick={() => save(r)}>
                    {saving === r.uuid ? 'Saving…' : 'Save'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && total > 0 && <TablePager page={page} total={total} pageSize={FAX_PER} onGo={(n) => load(n, q)} />}
    </div>
  );
}

function Kpi({ label, value, tone }) {
  return (
    <div className={`ref-kpi ${tone || ''}`}>
      <span className="ref-kpi-v">{value}</span>
      <span className="ref-kpi-l">{label}</span>
    </div>
  );
}

/**
 * Fax.Plus live activation — completes the one-time OAuth entirely in the UI so no one hand-edits .env.
 * Step 1 opens the consent page; Step 2 exchanges the pasted code for a refresh token, which the server
 * persists ENCRYPTED and verifies live. Also manages the inbound webhook secret and deactivation. The
 * page never sees the refresh token — only the resulting non-secret status flags.
 */
function FaxIntegration() {
  const toast = useToast();
  const [st, setSt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [pat, setPat] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const [whUrl, setWhUrl] = useState(`${window.location.origin}/api/fax/webhook`);
  const [whEps, setWhEps] = useState(null);
  const [ai, setAi] = useState(null);

  async function loadStatus() {
    setLoading(true);
    try { const { data } = await referralsApi.faxStatus(); setSt(data); }
    catch (e) { toast.error(toApiError(e).message); } finally { setLoading(false); }
  }
  async function loadWebhooks() {
    try { const { data } = await referralsApi.faxListWebhooks(); setWhEps(data.endpoints || []); } catch { /* non-fatal */ }
  }
  useEffect(() => { loadStatus(); }, []);
  useEffect(() => { if (st?.enabled) { loadWebhooks(); referralsApi.faxAiStatus().then(({ data }) => setAi(data)).catch(() => setAi(null)); } }, [st?.enabled]);

  async function registerWebhook() {
    const url = whUrl.trim();
    if (!/^https:\/\/.+/i.test(url)) { toast.error('Enter a public HTTPS URL (https://your-host/api/fax/webhook).'); return; }
    setBusy('wh');
    try { const { data } = await referralsApi.faxRegisterWebhook(url); setWhEps(data.endpoints || []); toast.success(data.created ? 'Webhook endpoint registered — instant inbound is on.' : 'That webhook endpoint is already registered.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(''); }
  }
  async function removeWebhook(id) {
    setBusy(`whx-${id}`);
    try { const { data } = await referralsApi.faxDeleteWebhook(id); setWhEps(data.endpoints || []); toast.success('Webhook endpoint removed.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(''); }
  }

  async function openAuth() {
    setBusy('auth');
    try { const { data } = await referralsApi.faxAuthorizeUrl(); window.open(data.url, '_blank', 'noopener,noreferrer'); toast.success('Authorization page opened — approve, then paste the code below.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(''); }
  }
  async function activate() {
    if (!code.trim()) { toast.error('Paste the authorization code first.'); return; }
    setBusy('activate');
    try { const { data } = await referralsApi.faxActivate(code.trim()); setSt(data.status); setCode(''); toast.success('Fax.Plus activated — live sending is now enabled.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(''); }
  }
  async function activatePat() {
    if (!pat.trim()) { toast.error('Paste your Personal Access Token first.'); return; }
    setBusy('pat');
    try { const { data } = await referralsApi.faxSetPersonalToken(pat.trim()); setSt(data.status); setPat(''); toast.success('Fax.Plus activated via Personal Access Token — live now.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(''); }
  }
  async function saveSecret() {
    setBusy('secret');
    try { const { data } = await referralsApi.faxSetWebhookSecret(secret.trim()); setSt(data.status); setSecret(''); toast.success(secret.trim() ? 'Webhook secret saved.' : 'Webhook secret cleared.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(''); }
  }
  async function deactivate() {
    setBusy('deactivate');
    try { const { data } = await referralsApi.faxDeactivate(); setSt(data.status); setConfirmOff(false); toast.success('Fax.Plus deactivated.'); }
    catch (e) { toast.error(toApiError(e).message); } finally { setBusy(''); }
  }

  if (loading) return <div className="ref-empty"><span className="spinner dark" /> Loading integration…</div>;
  const state = st?.enabled ? 'ok' : st?.configured ? 'warn' : 'off';
  const stateLabel = st?.enabled ? 'Active — live sending & receiving' : st?.configured ? 'Configured — authorize to activate' : 'Not configured';

  return (
    <div className="fax-integ">
      <div className="fax-integ-status">
        <span className={`ref-fax-pill ${state}`}>Fax.Plus: {stateLabel}</span>
        {st?.enabled && ai && (
          <span className={`ref-fax-pill ${ai.available ? 'ok' : 'off'}`} title="Fax.Plus AI (OCR + field extraction) is a paid account add-on">
            AI: {ai.available ? `on · ${ai.remaining} credits` : 'not enabled on account'}
          </span>
        )}
        <span className="spacer" />
        <button className="btn ghost sm" onClick={loadStatus} disabled={!!busy}>Refresh</button>
      </div>

      {!st?.configured && (
        <div className="fax-integ-note warn">
          Fax.Plus client credentials aren’t set. Add <code>FAXPLUS_CLIENT_ID</code> / <code>FAXPLUS_CLIENT_SECRET</code> to the server <code>.env</code> and restart, then return here to authorize.
        </div>
      )}

      {/* RECOMMENDED: direct-API Personal Access Token (works when the OAuth app isn't usable). */}
      <div className="fax-step done" style={{ borderColor: 'var(--c-dark-blue)' }}>
        <div className="fax-step-h"><span className="fax-step-n">★</span><span>Activate with a Personal Access Token (recommended)</span>{st?.authMode === 'personal_access_token' && <span className="fax-step-ok">✓ active</span>}</div>
        <p className="fax-step-p">Direct API — no login redirect. In the Fax.Plus console open <strong>Settings → API → Personal Access Tokens</strong>, click <strong>Generate Token</strong> (scope <code>all</code> or the fax scopes), copy it, and paste it here. It’s stored encrypted and verified live against your account.</p>
        <div className="fax-step-row">
          <input className="input" type="password" placeholder="Paste Personal Access Token…" value={pat} onChange={(e) => setPat(e.target.value)} autoComplete="off" spellCheck={false} />
          <button className="btn accent" onClick={activatePat} disabled={busy === 'pat' || !pat.trim()}>{busy === 'pat' ? <span className="spinner" /> : 'Activate'}</button>
        </div>
      </div>

      {st?.configured && (
        <div className="fax-integ-steps">
          <div className="fax-integ-note" style={{ background: 'transparent', border: 0, padding: '4px 0', color: 'var(--c-ink-3)' }}>Or use the OAuth2 authorization-code flow:</div>
          <div className={`fax-step ${st?.enabled ? 'done' : ''}`}>
            <div className="fax-step-h"><span className="fax-step-n">1</span><span>Authorize the account</span>{st?.enabled && <span className="fax-step-ok">✓ token on file</span>}</div>
            <p className="fax-step-p">Open the Fax.Plus consent page and approve access. You’ll be redirected to a URL containing <code>?code=…</code> — copy that code.</p>
            <button className="btn ghost" onClick={openAuth} disabled={busy === 'auth'}>{busy === 'auth' ? <span className="spinner dark" /> : 'Open authorization page ↗'}</button>
          </div>

          <div className="fax-step">
            <div className="fax-step-h"><span className="fax-step-n">2</span><span>{st?.enabled ? 'Re-activate (optional)' : 'Activate with the code'}</span></div>
            <p className="fax-step-p">Paste the <code>code</code> from the redirect URL. The server exchanges it for a refresh token, stores it encrypted, and verifies it live — no restart needed.</p>
            <div className="fax-step-row">
              <input className="input" placeholder="Paste authorization code…" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
              <button className="btn accent" onClick={activate} disabled={busy === 'activate' || !code.trim()}>{busy === 'activate' ? <span className="spinner" /> : 'Activate'}</button>
            </div>
          </div>

          <div className="fax-step">
            <div className="fax-step-h"><span className="fax-step-n">3</span><span>Inbound webhook — instant receiving</span>{whEps && whEps.length > 0 && <span className="fax-step-ok">✓ {whEps.length} registered</span>}</div>
            <p className="fax-step-p">Register your public <strong>HTTPS</strong> endpoint so Fax.Plus pushes received faxes instantly (subscribes to <code>fax_received</code> + <code>fax_sent</code>). Until this is set, inbound is still fetched automatically every few minutes — nothing is missed. The URL must be reachable from the internet over HTTPS.</p>
            <div className="fax-step-row">
              <input className="input" placeholder="https://your-host/api/fax/webhook" value={whUrl} onChange={(e) => setWhUrl(e.target.value)} autoComplete="off" spellCheck={false} />
              <button className="btn accent" onClick={registerWebhook} disabled={busy === 'wh'}>{busy === 'wh' ? <span className="spinner" /> : 'Register'}</button>
            </div>
            {whEps && whEps.length > 0 && (
              <ul className="fax-wh-list">
                {whEps.map((e) => (
                  <li key={e.id || e.url} className="fax-wh-item">
                    <span className="fax-wh-url">{e.url}</span>
                    <span className="fax-wh-ev">{(e.filter_types || e.filterTypes || []).join(', ')}</span>
                    <button className="btn ghost sm" onClick={() => removeWebhook(e.id || e.ep_id)} disabled={busy === `whx-${e.id || e.ep_id}`}>{busy === `whx-${e.id || e.ep_id}` ? <span className="spinner dark" /> : 'Remove'}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="fax-step">
            <div className="fax-step-h"><span className="fax-step-n">3b</span><span>Webhook signing secret</span>{st?.hasWebhookSecret && <span className="fax-step-ok">✓ set</span>}</div>
            <p className="fax-step-p">Required to verify inbound webhooks. The API can’t return it, so copy it from the Fax.Plus dashboard: <strong>Settings → Integrations → Webhooks → your endpoint → Advanced → Signing Secret</strong> (<code>whsec_…</code>), then paste it here.</p>
            <div className="fax-step-row">
              <input className="input" type="password" placeholder={st?.hasWebhookSecret ? 'Replace webhook secret…' : 'whsec_…'} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
              <button className="btn ghost" onClick={saveSecret} disabled={busy === 'secret'}>{busy === 'secret' ? <span className="spinner dark" /> : 'Save'}</button>
            </div>
          </div>

          {st?.enabled && (
            <div className="fax-step danger-zone">
              <div className="fax-step-h"><span>Deactivate</span></div>
              <p className="fax-step-p">Clears the stored refresh token and turns off live sending/receiving until re-authorized.</p>
              {confirmOff ? (
                <div className="fax-step-row">
                  <span className="fax-integ-note danger" style={{ margin: 0, flex: 1 }}>This turns off live faxing. Confirm?</span>
                  <button className="btn ghost" onClick={() => setConfirmOff(false)} disabled={busy === 'deactivate'}>Cancel</button>
                  <button className="btn danger" onClick={deactivate} disabled={busy === 'deactivate'}>{busy === 'deactivate' ? <span className="spinner" /> : 'Deactivate'}</button>
                </div>
              ) : (
                <button className="btn danger sm" onClick={() => setConfirmOff(true)}>Deactivate Fax.Plus</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
