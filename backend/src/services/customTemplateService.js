import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';

/**
 * Provider-authored CUSTOM note templates. A template is an ordered list of headings (sections),
 * each free-form and optionally carrying checkboxes. Templates are STRUCTURE, not PHI, and are
 * OWNER-SCOPED: every query is filtered by owner_id, so a provider can only ever see, edit, or
 * delete their OWN templates — no cross-provider access. A note created from a template snapshots
 * the sections into the note's own content, so the record is self-contained and immutable.
 */

const MAX_SECTIONS = 60;

// Slug a provider-typed heading into a stable, safe section key. Canonical picks pass their known
// key through unchanged (so coding + document labels stay wired); a free-typed heading becomes a
// namespaced slug that can never collide with a built-in key.
export function headingKey(label, providedKey) {
  const k = String(providedKey || '').trim();
  if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(k)) return k; // canonical camelCase key — keep as-is
  const slug = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `custom_${slug || 'section'}`;
}

/** Normalize + validate the sections a client sent into the stored shape. Throws on bad input
 *  (surfaced to the caller — never silently dropped). */
export function normalizeSections(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error('A template needs at least one heading.');
  if (input.length > MAX_SECTIONS) throw new Error(`A template can have at most ${MAX_SECTIONS} headings.`);
  const seen = new Map(); // key → label (to distinguish an identical heading from a slug collision)
  const out = [];
  for (const s of input) {
    if (!s || typeof s !== 'object') throw new Error('Each heading must be an object.');
    if (s.label != null && typeof s.label !== 'string') throw new Error('A heading name must be text.');
    const label = String(s.label || '').trim();
    if (!label) throw new Error('Every heading needs a name.');
    if (label.length > 80) throw new Error('A heading name is too long (max 80 characters).');
    let key = headingKey(label, s.key);
    if (seen.has(key)) {
      if (seen.get(key) === label) continue; // truly identical heading → de-dupe
      // DISTINCT headings that slug to the same key: make the key unique so NEITHER is dropped.
      let n = 2;
      while (seen.has(`${key}-${n}`)) n += 1;
      key = `${key}-${n}`;
    }
    seen.set(key, label);
    const rowsNum = Number(s.rows);
    // Textarea-height hint (display only). A numeric value is CLAMPED into the valid 2–8 range
    // (so 99 -> 8, 1 -> 2) rather than reset; a non-numeric/absent value defaults to 3.
    const rows = Number.isFinite(rowsNum) ? Math.min(8, Math.max(2, Math.round(rowsNum))) : 3;
    const checks = Array.isArray(s.checks)
      ? [...new Set(s.checks.map((c) => String(c).trim()).filter(Boolean))].slice(0, 20)
      : null;
    out.push({
      key,
      label,
      prompt: String(s.prompt || '').trim().slice(0, 400),
      rows,
      ...(checks && checks.length ? { checks } : {}),
    });
  }
  if (!out.length) throw new Error('A template needs at least one heading.');
  return out;
}

const toTemplate = (r) => ({
  uuid: r.uuid,
  noteType: `custom:${r.uuid}`,
  label: r.name,
  category: r.category || 'Custom template',
  custom: true,
  sections: safeJson(r.sections),
  updatedAt: r.updated_at,
});
function safeJson(v) { if (Array.isArray(v)) return v; try { return JSON.parse(v) || []; } catch { return []; } }

/** All active custom templates owned by this provider (owner-scoped; newest first). */
export async function listCustomTemplates(ownerId) {
  const [rows] = await execute(
    'SELECT uuid, name, category, sections, updated_at FROM custom_note_templates WHERE owner_id = :o AND active = 1 ORDER BY updated_at DESC',
    { o: ownerId });
  return rows.map(toTemplate);
}

/** One template BY UUID, only if owned by this provider (else null — no cross-provider read). */
export async function getCustomTemplate(ownerId, uuid) {
  const [rows] = await execute(
    'SELECT uuid, name, category, sections, updated_at FROM custom_note_templates WHERE owner_id = :o AND uuid = :u AND active = 1 LIMIT 1',
    { o: ownerId, u: uuid });
  return rows.length ? toTemplate(rows[0]) : null;
}

/** Create a custom template owned by this provider. Returns the stored template. */
export async function createCustomTemplate(ownerId, { name, category, sections }) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('A template needs a name.');
  if (nm.length > 120) throw new Error('The template name is too long (max 120 characters).');
  const secs = normalizeSections(sections);
  const uuid = uuidv4();
  await execute(
    'INSERT INTO custom_note_templates (uuid, owner_id, name, category, sections) VALUES (:u, :o, :n, :c, :s)',
    { u: uuid, o: ownerId, n: nm, c: String(category || '').trim().slice(0, 160) || null, s: JSON.stringify(secs) });
  return getCustomTemplate(ownerId, uuid);
}

/** Update a template the provider owns (name/category/sections). Returns the template or null. */
export async function updateCustomTemplate(ownerId, uuid, { name, category, sections }) {
  const existing = await getCustomTemplate(ownerId, uuid);
  if (!existing) return null;
  const nm = name !== undefined ? String(name).trim() : existing.label;
  if (!nm) throw new Error('A template needs a name.');
  const secs = sections !== undefined ? normalizeSections(sections) : existing.sections;
  await execute(
    'UPDATE custom_note_templates SET name = :n, category = :c, sections = :s WHERE owner_id = :o AND uuid = :u',
    { n: nm.slice(0, 120), c: (category !== undefined ? String(category).trim().slice(0, 160) : existing.category) || null, s: JSON.stringify(secs), o: ownerId, u: uuid });
  return getCustomTemplate(ownerId, uuid);
}

/** Soft-delete a template the provider owns (existing notes are unaffected — they snapshot the sections). */
export async function deleteCustomTemplate(ownerId, uuid) {
  const [res] = await execute(
    'UPDATE custom_note_templates SET active = 0 WHERE owner_id = :o AND uuid = :u AND active = 1',
    { o: ownerId, u: uuid });
  return res.affectedRows > 0;
}
