import { useEffect, useMemo, useState } from 'react';
import AppHeader from '../components/AppHeader.jsx';
import EhrSystem from './EhrSystem.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useIdleTimeout } from '../hooks/useIdleTimeout.js';
import { loadNoteDefs } from '../components/EncounterNotes.jsx';

/**
 * Provider / Billing workspace shell.
 *
 * Two blank systems, each on its own route:
 *   - EHR System      →  /ehr
 *   - Billing Module  →  /billing-module   (formerly "PMS System")
 *
 * Both are intentionally empty, ready for their modules. Routing is done with
 * the History API (no router dependency); the gateway serves index.html for any
 * path, so a hard refresh on /ehr or /billing-module still works.
 *
 *  - Providers land on /ehr by default.
 *  - Billing users land on /billing-module by default.
 *  - The header shows the current system and, for every OTHER system the user is
 *    granted via Access Control (ehr.access / pms.access), an "Access" button
 *    that navigates to that system's route.
 */
const SYSTEMS = {
  ehr: { key: 'ehr', label: 'EHR System', path: '/ehr' },
  pms: { key: 'pms', label: 'Billing Module', path: '/billing-module' },
};
const PATH_TO_KEY = { '/ehr': 'ehr', '/billing-module': 'pms' };

function keyFromPath() {
  return PATH_TO_KEY[(window.location.pathname || '').toLowerCase()] || null;
}

export default function Workspace() {
  const { user, logout } = useAuth();
  useIdleTimeout(logout, { minutes: 15 });

  // Warm the note-type templates cache as soon as the workspace loads, so the
  // "New encounter" dropdown and note editor never wait on a cold request.
  useEffect(() => { loadNoteDefs().catch(() => { /* retried on first real use */ }); }, []);

  const perms = user?.accessLevel?.permissions || {};
  const homeKey = user?.role === 'billing' ? 'pms' : 'ehr';
  const canEhr = user?.role === 'provider' || !!perms.ehr?.access;
  const canPms = user?.role === 'billing' || !!perms.pms?.access;

  const systems = useMemo(() => {
    const list = [];
    if (canEhr) list.push(SYSTEMS.ehr);
    if (canPms) list.push(SYSTEMS.pms);
    return list.length ? list : [SYSTEMS[homeKey]]; // always at least the home system
  }, [canEhr, canPms, homeKey]);

  const accessibleKeys = useMemo(() => new Set(systems.map((s) => s.key)), [systems]);

  const [active, setActive] = useState(() => {
    const fromPath = keyFromPath();
    if (fromPath && accessibleKeys.has(fromPath)) return fromPath;
    return accessibleKeys.has(homeKey) ? homeKey : systems[0].key;
  });

  // Keep the URL in sync with the active system (default landing + guard against
  // navigating to a system the user isn't granted).
  useEffect(() => {
    if (!accessibleKeys.has(active)) {
      setActive(accessibleKeys.has(homeKey) ? homeKey : systems[0].key);
      return;
    }
    const desired = SYSTEMS[active].path;
    if ((window.location.pathname || '').toLowerCase() !== desired) {
      window.history.replaceState({}, '', desired);
    }
  }, [active, accessibleKeys, homeKey, systems]);

  // Browser back/forward navigation.
  useEffect(() => {
    const onPop = () => {
      const k = keyFromPath();
      if (k && accessibleKeys.has(k)) setActive(k);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [accessibleKeys]);

  const switchTo = (key) => {
    if (!accessibleKeys.has(key) || key === active) return;
    window.history.pushState({}, '', SYSTEMS[key].path);
    setActive(key);
  };

  return (
    <div className="app-shell">
      {/* The system switcher lives in the EHR sidebar. The billing module has no
          sidebar, so the header keeps the switcher there to avoid a dead-end. */}
      <AppHeader systems={systems} active={active} onSwitch={switchTo} switcher={active !== 'ehr'} />
      {active === 'ehr' ? (
        <EhrSystem systems={systems} active={active} onSwitch={switchTo} />
      ) : (
        /* Billing Module — intentionally blank, reserved for its modules. */
        <main className="pms-canvas" data-system={active} />
      )}
    </div>
  );
}
