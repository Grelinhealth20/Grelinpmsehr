import { useAuth } from './context/AuthContext.jsx';
import Brand from './components/Brand.jsx';
import Login from './pages/Login.jsx';
import ForcePasswordReset from './pages/ForcePasswordReset.jsx';
import SuperAdminPanel from './pages/superadmin/SuperAdminPanel.jsx';
import Workspace from './pages/Workspace.jsx';

const ADMIN_ROLES = new Set(['master_admin', 'super_admin']);

export default function App() {
  const { user, mustReset, loading } = useAuth();

  if (loading) {
    return (
      <div className="splash">
        <div className="splash-grid" aria-hidden="true" />
        <div className="splash-glow" aria-hidden="true" />
        <div className="splash-core" role="status" aria-live="polite">
          <div className="splash-logo"><Brand /></div>

          {/* Secure-aperture loader: a precise sweep ring around a lock mark */}
          <div className="sx-loader" aria-hidden="true">
            <span className="sx-track" />
            <span className="sx-sweep" />
            <span className="sx-orbit"><i /></span>
            <span className="sx-mark">
              <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="10.4" width="14" height="9.6" rx="2.3" />
                <path d="M8 10.4V7.6a4 4 0 0 1 8 0v2.8" />
                <circle cx="12" cy="15.2" r="1.15" fill="currentColor" stroke="none" />
              </svg>
            </span>
          </div>

          <div className="sx-status">Initializing secure workspace</div>

          {/* Segmented progress — establishes the encrypted, verified boot sequence */}
          <div className="sx-flow">
            <span className="sx-step" style={{ '--i': 0 }}><i />Encrypted channel</span>
            <span className="sx-seg" />
            <span className="sx-step" style={{ '--i': 1 }}><i />Verifying session</span>
            <span className="sx-seg" />
            <span className="sx-step" style={{ '--i': 2 }}><i />Loading workspace</span>
          </div>
        </div>
      </div>
    );
  }

  // Access is gated by auth state — no client-side routes to enumerate.
  if (!user) return <Login />;
  if (mustReset) return <ForcePasswordReset />;
  if (ADMIN_ROLES.has(user.role)) return <SuperAdminPanel />;
  return <Workspace />;
}
