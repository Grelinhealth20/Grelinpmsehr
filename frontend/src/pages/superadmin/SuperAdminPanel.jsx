import { useEffect, useMemo, useState } from 'react';
import AppHeader from '../../components/AppHeader.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import UserFormModal from './UserFormModal.jsx';
import ResetPasswordModal from './ResetPasswordModal.jsx';
import AccessControlModal from './AccessControlModal.jsx';
import FacilityModal from './FacilityModal.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useIdleTimeout } from '../../hooks/useIdleTimeout.js';
import { usersApi, facilitiesApi, toApiError } from '../../lib/api.js';
import AuditLogs from './AuditLogs.jsx';

const TABS = [
  { key: 'super', label: 'Super Admins', roles: ['super_admin', 'master_admin'], createRole: 'super_admin', createLabel: '+ Create Super Admin' },
  { key: 'provider', label: 'Providers', roles: ['provider'], createRole: 'provider', createLabel: '+ Create Provider' },
  { key: 'billing', label: 'Billing', roles: ['billing'], createRole: 'billing', createLabel: '+ Create Billing User' },
];

function StatusBadge({ status }) {
  const map = { active: 'Active', restricted: 'Restricted', disabled: 'Disabled' };
  return <span className={`badge ${status}`}><span className="dot" />{map[status] || status}</span>;
}

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '·';
}

export default function SuperAdminPanel() {
  const { user: me, logout } = useAuth();
  const toast = useToast();
  useIdleTimeout(logout, { minutes: 15 });

  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('super');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const isFacilities = tab === 'facilities';
  const isLogs = tab === 'logs';

  // Facilities state (loaded on demand when the Facilities tab is opened).
  const [facilities, setFacilities] = useState([]);
  const [facLoading, setFacLoading] = useState(false);
  const [facSearch, setFacSearch] = useState('');
  const [facModal, setFacModal] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const { data } = await usersApi.list();
      setAll(data.users);
    } catch (e) {
      toast.error(toApiError(e).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadFacilities() {
    setFacLoading(true);
    try {
      const { data } = await facilitiesApi.list();
      setFacilities(data.facilities || []);
    } catch (e) {
      toast.error(toApiError(e).message);
    } finally {
      setFacLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Facilities power the Facilities tab AND the audit-log facility filter.
    if ((isFacilities || isLogs) && facilities.length === 0) loadFacilities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFacilities, isLogs]);

  const counts = useMemo(() => {
    const c = {};
    for (const t of TABS) c[t.key] = all.filter((u) => t.roles.includes(u.role)).length;
    return c;
  }, [all]);

  const activeTab = TABS.find((t) => t.key === tab) || TABS[0];

  const stats = useMemo(() => {
    const scope = all.filter((u) => activeTab.roles.includes(u.role));
    return {
      total: scope.length,
      active: scope.filter((u) => u.status === 'active').length,
      restricted: scope.filter((u) => u.status === 'restricted').length,
      disabled: scope.filter((u) => u.status === 'disabled').length,
    };
  }, [all, activeTab]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all
      .filter((u) => activeTab.roles.includes(u.role))
      .filter((u) => !q || u.fullName?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q));
  }, [all, activeTab, search]);

  async function changeStatus(u, status) {
    try {
      await usersApi.setStatus(u.uuid, status);
      toast.success('Account status updated.');
      load();
    } catch (e) {
      toast.error(toApiError(e).message);
    }
  }

  async function deleteUser(u) {
    try {
      await usersApi.remove(u.uuid);
      toast.success('User deleted.');
      setModal(null);
      load();
    } catch (e) {
      toast.error(toApiError(e).message);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader module="Administration Panel" />

      <main className="admin-main">
        <div className="admin-head">
          <span className="admin-eyebrow">// {isLogs ? 'AUDIT & COMPLIANCE CONSOLE' : isFacilities ? 'FACILITY MANAGEMENT CONSOLE' : 'USER MANAGEMENT CONSOLE'}</span>
          <h1>{isLogs ? 'Audit Logs' : isFacilities ? 'Facilities' : 'User Management'}</h1>
          <p>{isLogs ? 'Monitor, filter, and download the activity trail across every account, role, and facility.' : isFacilities ? 'Manage facilities and provider assignments.' : 'Create and govern accounts across roles.'}</p>
        </div>

        {/* Centered role tabs */}
        <div className="sa-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`sa-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="sa-tab-count">{counts[t.key] ?? 0}</span>
            </button>
          ))}
          <button
            role="tab"
            aria-selected={isFacilities}
            className={`sa-tab ${isFacilities ? 'active' : ''}`}
            onClick={() => setTab('facilities')}
          >
            Facilities
            <span className="sa-tab-count">{facilities.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={isLogs}
            className={`sa-tab ${isLogs ? 'active' : ''}`}
            onClick={() => setTab('logs')}
          >
            Audit Logs
          </button>
        </div>

        {isLogs ? (
          <AuditLogs users={all} facilities={facilities} />
        ) : isFacilities ? (
          <FacilitiesView
            facilities={facilities}
            loading={facLoading}
            search={facSearch}
            setSearch={setFacSearch}
            onAdd={() => setFacModal({ type: 'add' })}
            onManage={(f) => setFacModal({ type: 'manage', facility: f })}
            onStatus={async (f, status) => { try { await facilitiesApi.setStatus(f.uuid, status); loadFacilities(); toast.success('Facility status updated.'); } catch (e) { toast.error(toApiError(e).message); } }}
            onDelete={(f) => setFacModal({ type: 'delete', facility: f })}
          />
        ) : (
        <>
        {/* KPI stat tiles */}
        <div className="sa-stats">
          <div className="sa-stat">
            <span className="sa-stat-k">Total {activeTab.label}</span>
            <span className="sa-stat-v">{stats.total}</span>
          </div>
          <div className="sa-stat">
            <span className="sa-stat-k">Active</span>
            <span className="sa-stat-v"><span className="sa-stat-dot active" />{stats.active}</span>
          </div>
          <div className="sa-stat">
            <span className="sa-stat-k">Restricted</span>
            <span className="sa-stat-v"><span className="sa-stat-dot restricted" />{stats.restricted}</span>
          </div>
          <div className="sa-stat">
            <span className="sa-stat-k">Disabled</span>
            <span className="sa-stat-v"><span className="sa-stat-dot disabled" />{stats.disabled}</span>
          </div>
        </div>

        {/* Toolbar */}
        <div className="sa-toolbar">
          <input className="input search" placeholder="Search name or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="spacer" />
          <button className="btn sm" onClick={() => setModal({ type: 'create' })}>{activeTab.createLabel}</button>
        </div>

        {/* Table */}
        <div className="card table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Access level</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="table-empty"><span className="spinner dark" /> Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className="table-empty">No {activeTab.label.toLowerCase()} yet.</td></tr>
                ) : (
                  rows.map((u) => {
                    const isSelf = u.uuid === me?.uuid;
                    const isMaster = u.role === 'master_admin';
                    const locked = isSelf || isMaster;
                    return (
                      <tr key={u.uuid}>
                        <td>
                          <div className="user-cell clickable" title="Manage access control" onClick={() => setModal({ type: 'access', user: u })}>
                            <div className="avatar">{initials(u.fullName)}</div>
                            <div className="stack">
                              <span className="user-name">{u.fullName}{isSelf && <span className="you">You</span>}{u.credentials?.map((c) => <span key={c} className="cred-pill">{c}</span>)}{u.specialty && <span className="spec-pill">{u.specialty.name}</span>}</span>
                              <span className="user-email">{u.email}</span>
                            </div>
                          </div>
                        </td>
                        <td><span className="badge role">{u.role.replace('_', ' ')}</span></td>
                        <td style={{ textTransform: 'capitalize', color: 'var(--c-ink-2)' }}>{u.accessLevel?.scope?.replace('_', ' ') || '—'}</td>
                        <td><StatusBadge status={u.status} /></td>
                        <td className="mono" style={{ color: 'var(--c-ink-2)', fontSize: 12 }}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}</td>
                        <td>
                          <div className="row-actions">
                            <button className="act" title="Edit user" onClick={() => setModal({ type: 'edit', user: u })}>Edit</button>
                            <button className="act" title="Access control" onClick={() => setModal({ type: 'access', user: u })}>Access</button>
                            <button className="act" title="Reset password" onClick={() => setModal({ type: 'reset', user: u })}>Reset</button>
                            {!locked && (u.status !== 'restricted'
                              ? <button className="act accent" title="Restrict access" onClick={() => changeStatus(u, 'restricted')}>Restrict</button>
                              : <button className="act" title="Remove restriction" onClick={() => changeStatus(u, 'active')}>Unrestrict</button>)}
                            {!locked && (u.status !== 'disabled'
                              ? <button className="act" title="Disable account" onClick={() => changeStatus(u, 'disabled')}>Disable</button>
                              : <button className="act" title="Enable account" onClick={() => changeStatus(u, 'active')}>Enable</button>)}
                            <button className="act danger" title="Delete user" disabled={locked} onClick={() => setModal({ type: 'delete', user: u })}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        </>
        )}
      </main>

      {facModal?.type === 'add' && (
        <FacilityModal onClose={() => setFacModal(null)} onSaved={loadFacilities} />
      )}
      {facModal?.type === 'manage' && (
        <FacilityModal facility={facModal.facility} onClose={() => setFacModal(null)} onSaved={loadFacilities} />
      )}
      {facModal?.type === 'delete' && (
        <ConfirmDialog
          title="Delete facility"
          message={`Delete ${facModal.facility.name}? Providers will be unassigned. This action is logged.`}
          confirmLabel="Delete facility"
          danger
          onConfirm={async () => { try { await facilitiesApi.remove(facModal.facility.uuid); setFacModal(null); toast.success('Facility deleted.'); loadFacilities(); } catch (e) { toast.error(toApiError(e).message); } }}
          onClose={() => setFacModal(null)}
        />
      )}

      {modal?.type === 'create' && (
        <UserFormModal mode="create" lockedRole={activeTab.createRole} onClose={() => setModal(null)} onSaved={(m) => { setModal(null); toast.success(m); load(); }} />
      )}
      {modal?.type === 'edit' && (
        <UserFormModal mode="edit" user={modal.user} onClose={() => setModal(null)} onSaved={(m) => { setModal(null); toast.success(m); load(); }} />
      )}
      {modal?.type === 'reset' && (
        <ResetPasswordModal user={modal.user} onClose={() => setModal(null)} onSaved={(m) => { setModal(null); toast.success(m); }} />
      )}
      {modal?.type === 'access' && (
        <AccessControlModal user={modal.user} onClose={() => setModal(null)} onSaved={(m) => { setModal(null); toast.success(m); load(); }} />
      )}
      {modal?.type === 'delete' && (
        <ConfirmDialog
          title="Delete user"
          message={`Permanently delete ${modal.user.email}? This action is logged and cannot be undone.`}
          confirmLabel="Delete user"
          danger
          onConfirm={() => deleteUser(modal.user)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

/** Facilities management view (NPPES-verified facility records + assignments). */
function FacilitiesView({ facilities, loading, search, setSearch, onAdd, onManage, onStatus, onDelete }) {
  const q = search.trim().toLowerCase();
  const rows = facilities.filter((f) => !q
    || f.name?.toLowerCase().includes(q)
    || f.npi?.includes(q)
    || f.city?.toLowerCase().includes(q));
  return (
    <>
      <div className="sa-stats">
        <div className="sa-stat"><span className="sa-stat-k">Total Facilities</span><span className="sa-stat-v">{facilities.length}</span></div>
        <div className="sa-stat"><span className="sa-stat-k">Active</span><span className="sa-stat-v"><span className="sa-stat-dot active" />{facilities.filter((f) => f.status === 'active').length}</span></div>
        <div className="sa-stat"><span className="sa-stat-k">Inactive</span><span className="sa-stat-v"><span className="sa-stat-dot disabled" />{facilities.filter((f) => f.status !== 'active').length}</span></div>
        <div className="sa-stat"><span className="sa-stat-k">Assigned members</span><span className="sa-stat-v">{facilities.reduce((n, f) => n + (f.providerCount || 0), 0)}</span></div>
      </div>

      <div className="sa-toolbar">
        <input className="input search" placeholder="Search facility name, NPI or city…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="spacer" />
        <button className="btn sm" onClick={onAdd}>+ Add Facility</button>
      </div>

      <div className="card table-card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Facility</th>
                <th>NPI</th>
                <th>Location</th>
                <th>Taxonomy</th>
                <th>Members</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="table-empty"><span className="spinner dark" /> Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="table-empty">{q ? 'No facilities match your search.' : 'No facilities yet. Add a facility from the NPPES registry.'}</td></tr>
              ) : (
                rows.map((f) => (
                  <tr key={f.uuid}>
                    <td>
                      <div className="fac-cell clickable" title="Manage facility" onClick={() => onManage(f)}>
                        <div className="fac-cell-ic" aria-hidden="true" />
                        <div className="stack">
                          <span className="user-name">{f.name}</span>
                          <span className="user-email">{f.address || '—'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="mono" style={{ color: 'var(--c-ink-2)', fontSize: 12 }}>{f.npi || '—'}</td>
                    <td style={{ color: 'var(--c-ink-2)' }}>{[f.city, f.state].filter(Boolean).join(', ') || '—'}</td>
                    <td style={{ color: 'var(--c-ink-2)', fontSize: 12.5 }}>{f.taxonomy || '—'}</td>
                    <td><span className="fac-count">{f.providerCount || 0}</span></td>
                    <td><span className={`badge ${f.status === 'active' ? 'active' : 'disabled'}`}><span className="dot" />{f.status === 'active' ? 'Active' : 'Inactive'}</span></td>
                    <td>
                      <div className="row-actions">
                        <button className="act" title="Manage & assign" onClick={() => onManage(f)}>Manage</button>
                        {f.status === 'active'
                          ? <button className="act accent" title="Deactivate" onClick={() => onStatus(f, 'inactive')}>Deactivate</button>
                          : <button className="act" title="Activate" onClick={() => onStatus(f, 'active')}>Activate</button>}
                        <button className="act danger" title="Delete facility" onClick={() => onDelete(f)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
