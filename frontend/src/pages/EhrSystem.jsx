import { useEffect, useState } from 'react';
import AppointmentScheduler from './AppointmentScheduler.jsx';
import Encounter from './Encounter.jsx';

const CalendarIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
    <path d="M3 9h18M8 3v3M16 3v3" />
    <path d="M12 12.5v4M10 14.5h4" />
  </svg>
);
// Stethoscope — the provider-focused symbol for a clinical encounter.
const EncounterIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3" />
    <path d="M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4" />
    <circle cx="20" cy="10" r="2" />
  </svg>
);

const NAV = [
  { key: 'appointment', label: 'Appointment', icon: CalendarIcon },
  { key: 'encounter', label: 'Patients & Encounters', icon: EncounterIcon },
];

/**
 * EHR System shell — futuristic dark retractable sidebar (the one dark surface),
 * with a light, enterprise content area. First sidebar item is Appointment,
 * which opens the synced appointment scheduler.
 */
export default function EhrSystem() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('gh.ehr.sidebar') === '1'; } catch { return false; }
  });
  const [view, setView] = useState('appointment');

  useEffect(() => {
    try { localStorage.setItem('gh.ehr.sidebar', collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  return (
    <div className={`ehr-layout ${collapsed ? 'is-collapsed' : ''}`}>
      <aside className="ehr-sidebar" aria-label="EHR navigation">
        <div className="ehr-side-top">
          <span className="ehr-side-brand">EHR System</span>
          <button
            type="button"
            className="ehr-side-toggle"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={collapsed}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <span className="ehr-chevron" aria-hidden="true" />
          </button>
        </div>

        <nav className="ehr-nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`ehr-nav-item ${view === n.key ? 'active' : ''}`}
              onClick={() => setView(n.key)}
              title={collapsed ? n.label : undefined}
              aria-current={view === n.key ? 'page' : undefined}
            >
              <span className="ehr-nav-ic">{n.icon}</span>
              <span className="ehr-nav-label">{n.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="ehr-content ehr-content--flush" data-view={view}>
        {view === 'appointment' && <AppointmentScheduler />}
        {view === 'encounter' && <Encounter />}
      </main>
    </div>
  );
}
