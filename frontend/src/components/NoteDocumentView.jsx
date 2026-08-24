import { NOTE_TYPES, TEMPLATES } from '../lib/noteTemplates.js';
import { usDate, encNo } from './EncounterNotes.jsx';

const VITALS = [
  ['temp', 'Temp °F'], ['hr', 'HR bpm'], ['bp', 'BP'], ['rr', 'RR'],
  ['spo2', 'SpO₂ %'], ['weight', 'Wt lb'], ['pain', 'Pain'],
];

/**
 * Read-only, document-style rendering of a signed or draft clinical note — the
 * same layout used for a finalized record. Used by the Clinical Records viewer.
 */
export default function NoteDocumentView({ note, meta }) {
  if (!note) return null;
  const t = NOTE_TYPES[note.noteType] || {};
  const template = TEMPLATES[note.noteType] || [];
  const content = note.content || {};
  const vitals = content.vitals || {};
  const sections = content.sections || {};
  const rx = (content.prescriptions || []).filter((r) => r && r.drug);
  const signed = note.status === 'signed';
  const hasVitals = template.some((s) => s.key === 'vitals') && VITALS.some(([k]) => vitals[k]);

  return (
    <div className="nt-doc-scroll">
      <article className="nt-doc-page is-signed">
        <header className="nt-page-head">
          {meta?.facilityName && <div className="nt-page-fac">{meta.facilityName}</div>}
          <div className="nt-page-title">{t.label || note.noteType}</div>
          <div className="nt-page-meta">
            <span><b>Patient:</b> {meta?.patientName || '—'}</span>
            <span><b>MRN:</b> {meta?.mrn || '—'}</span>
            <span><b>Encounter ID:</b> {encNo(meta?.encounterNo)}</span>
            <span><b>Date of Service:</b> {usDate(meta?.date)}</span>
            <span><b>Rendering Provider:</b> {meta?.renderingProvider || '—'}</span>
          </div>
        </header>

        {hasVitals && (
          <section className="nt-sec">
            <h4 className="nt-sec-h">Vital Signs</h4>
            <div className="nt-sec-body"><p>{VITALS.map(([k, l]) => (vitals[k] ? `${l}: ${vitals[k]}` : null)).filter(Boolean).join('    ·    ')}</p></div>
          </section>
        )}

        {template.filter((s) => s.key !== 'vitals' && (sections[s.key] || '').trim()).map((s) => (
          <section className="nt-sec" key={s.key}>
            <h4 className="nt-sec-h">{s.label}</h4>
            <div className="nt-sec-body">
              {(sections[s.key]).split('\n').map((ln, i) => <p key={i}>{ln || ' '}</p>)}
            </div>
          </section>
        ))}

        {rx.length > 0 && (
          <section className="nt-sec">
            <h4 className="nt-sec-h">Prescriptions</h4>
            <table className="nt-rx-table">
              <thead><tr><th>Medication</th><th>Dose</th><th>Route</th><th>Frequency</th><th>Qty</th><th>Refills</th></tr></thead>
              <tbody>
                {rx.map((r, i) => (
                  <>
                    <tr key={i}>
                      <td className="nt-rx-drug">{r.drug}</td><td>{r.dose || '—'}</td><td>{r.route || '—'}</td>
                      <td>{r.frequency || '—'}</td><td>{r.quantity || '—'}</td><td>{r.refills || '—'}</td>
                    </tr>
                    {r.sig && <tr className="nt-rx-sigrow" key={`s${i}`}><td colSpan={6}>Sig: {r.sig}</td></tr>}
                  </>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {signed && (
          <footer className="nt-page-sign">
            <div className="nt-sign-line" />
            <div className="nt-sign-name">Electronically signed by {note.signedByName || 'Provider'}, MD</div>
            <div className="nt-sign-sub">Finalized and ready for billing.</div>
          </footer>
        )}
      </article>
    </div>
  );
}
