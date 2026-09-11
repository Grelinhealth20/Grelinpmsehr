/**
 * Canonical US date formatting for the UI — ALWAYS mm/dd/yyyy (zero-padded). Date-only ISO values are
 * formatted from the string to avoid a timezone shift (a DOS of 2026-07-05 must never render as 07/04).
 */
export function usDate(value) {
  if (value == null || value === '') return '—';
  const iso = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO date or datetime → take the date part
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/** mm/dd/yyyy, h:mm AM/PM — for timestamps (last login, finalized-at, audit time). */
export function usDateTime(value) {
  if (value == null || value === '') return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return usDate(value);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${mm}/${dd}/${d.getFullYear()} ${time}`;
}
