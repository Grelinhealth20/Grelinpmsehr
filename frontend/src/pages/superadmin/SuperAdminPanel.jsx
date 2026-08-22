import { useEffect, useMemo, useState } from 'react';
import AppHeader from '../../components/AppHeader.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import UserFormModal from './UserFormModal.jsx';
import ResetPasswordModal from './ResetPasswordModal.jsx';
import AccessControlModal from './AccessControlModal.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useIdleTimeout } from '../../hooks/useIdleTimeout.js';
import { usersApi, toApiError } from '../../lib/api.js';

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

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const c = {};
    for (const t of TABS) c[t.key] = all.filter((u) => t.roles.includes(u.role)).length;
    return c;
  }, [all]);

  const activeTab = TABS.find((t) => t.key === tab);

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
          <span className="admin-eyebrow">// USER MANAGEMENT CONSOLE</span>
          <h1>User Management</h1>
          <p>Create and govern accounts across roles.</p>
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
        </div>

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
      </main>

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
