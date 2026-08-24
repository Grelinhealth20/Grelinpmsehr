import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '·';
}

/**
 * Futuristic enterprise application header. Used across the workspace and admin
 * surfaces. The logout is a deliberate two-step flow (confirm popover) so a
 * secure session is never ended by an accidental click.
 *
 * Pass `module` for a static label (admin panel), OR `systems` + `active` +
 * `onSwitch` to render a system switcher that only lists the systems the user
 * may enter (derived from their Access Control grants). The switcher both shows
 * the current system and lets the user navigate to any other granted system.
 */
export default function AppHeader({ module = 'PMS System', systems = null, active = null, onSwitch = null, switcher = false }) {
  const { user, logout } = useAuth();
  const hasSwitcher = Array.isArray(systems) && systems.length > 0;
  const currentLabel = hasSwitcher ? (systems.find((s) => s.key === active)?.label || module) : module;
  const [open, setOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const k = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, []);

  async function confirmLogout() {
    setEnding(true);
    await logout();
  }

  return (
    <header className="gh-header">
      <div className="gh-left">
        <img className="gh-logo" src="/Grelin_logo.png" alt="Grelin Health" />
        <span className="gh-div" />
        <span className="gh-module"><span className="live" />{currentLabel}</span>
      </div>

      <div className="gh-right">
        {switcher && hasSwitcher &&
          systems
            .filter((s) => s.key !== active)
            .map((s) => (
              <button
                key={s.key}
                type="button"
                className="gh-access-btn"
                title={`Go to ${s.label}`}
                onClick={() => onSwitch?.(s.key)}
              >
                <span className="gh-access-ic" aria-hidden="true" />
                Access {s.label}
              </button>
            ))}

        <div className="gh-account" ref={ref}>
          <button type="button" className={`gh-profile ${open ? 'is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}>
            <span className="gh-avatar">{initials(user?.fullName)}</span>
            <span className="gh-user">
              <span className="nm">{user?.fullName}</span>
              <span className="rl">{user?.role?.replace('_', ' ')}</span>
            </span>
          </button>

          <button type="button" className={`gh-logout ${open ? 'is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label="Log out">
            <span className="gh-logout-label">Log out</span>
            <span className="gh-power-badge"><span className="gh-power" aria-hidden="true" /></span>
          </button>

          {open && (
            <div className="gh-pop" role="dialog" aria-label="Confirm log out">
              <div className="gh-pop-ic"><span className="gh-power gh-power-lg" aria-hidden="true" /></div>
              <h4>End secure session?</h4>
              <p>You’ll be signed out of the Grelin Health workspace on this device.</p>
              <div className="gh-pop-acts">
                <button className="btn ghost sm" onClick={() => setOpen(false)} disabled={ending}>Cancel</button>
                <button className="btn sm" onClick={confirmLogout} disabled={ending}>
                  {ending ? <span className="spinner" /> : 'Log out'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
