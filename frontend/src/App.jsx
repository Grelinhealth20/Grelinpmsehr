import { useAuth } from './context/AuthContext.jsx';
import Brand from './components/Brand.jsx';
import Login from './pages/Login.jsx';
import ForcePasswordReset from './pages/ForcePasswordReset.jsx';
import MfaEnroll from './pages/MfaEnroll.jsx';
import MfaChallenge from './pages/MfaChallenge.jsx';
import SuperAdminPanel from './pages/superadmin/SuperAdminPanel.jsx';
import Workspace from './pages/Workspace.jsx';

const ADMIN_ROLES = new Set(['master_admin', 'super_admin']);

export default function App() {
  const { user, mustReset, mfaStage, loading } = useAuth();

  if (loading) {
    return (
      <div className="splash">
        <div className="splash-bg" aria-hidden="true"><span className="orb o1" /><span className="orb o2" /></div>
        <div className="splash-core" role="status" aria-live="polite">
          <div className="splash-logo"><Brand /></div>
          <div className="splash-loader">
            <span className="splash-ring" />
            <span className="splash-ring inner" />
            <span className="splash-core-dot" />
          </div>
          <div className="splash-status">
            <span className="splash-dot" />
            Initializing secure workspace
          </div>
          <div className="splash-bar"><span /></div>
        </div>
      </div>
    );
  }

  // Access is gated by auth state — no client-side routes to enumerate. Order matters: password
  // reset first, THEN MFA (enroll → challenge), before any workspace is reachable.
  if (!user) return <Login />;
  if (mustReset) return <ForcePasswordReset />;
  if (mfaStage === 'setup') return <MfaEnroll />;
  if (mfaStage === 'pending') return <MfaChallenge />;
  if (ADMIN_ROLES.has(user.role)) return <SuperAdminPanel />;
  return <Workspace />;
}
