import { pool, execute } from '../db/pool.js';
import { providerServiceLines } from './accessScope.js';

/**
 * Note-template REGISTRY (the separate DB table that governs Pain vs SNF templates).
 *
 * Every clinical note template belongs to a SERVICE LINE — 'snf' or 'pain'. The
 * registry (persisted in `note_templates`) is the single source of truth for which
 * templates a provider may use: a provider whose specialty is Pain Management sees
 * ONLY the Pain templates, an SNF provider sees ONLY the SNF templates, and the two
 * sets can never cross over. Access is enforced here on the server — the UI filter is
 * advisory. Notes themselves still live in `encounter_notes`, so every existing note
 * behaviour (draft/sign/amend, PDF/Word, pagination, isolation) is unchanged.
 */

// The canonical registry — kept in sync with the frontend note templates. `menuGroup`
// splits the picker into "Common" vs "More"; `sortOrder` orders within a group.
export const NOTE_TEMPLATE_REGISTRY = [
  // ---- SNF (Skilled Nursing Facility) ----
  ['hp_admission', 'snf', 'H&P / Admission Note', 'Initial Nursing Facility Care', '99304–99306', 'common', 10],
  ['progress', 'snf', 'Progress Note', 'Subsequent Nursing Facility Care', '99307–99310', 'common', 20],
  ['acute_visit', 'snf', 'Acute / Sick Visit Note', 'Subsequent Nursing Facility Care', '99307–99310', 'common', 30],
  ['regulatory', 'snf', 'Regulatory / Periodic Visit Note', 'Subsequent Nursing Facility Care', '99307–99310', 'common', 40],
  ['post_hospital', 'snf', 'Post-Hospital / Readmission Note', 'Initial or Subsequent (per circumstances)', '99304–99310', 'common', 50],
  ['wound_care', 'snf', 'Wound Care Note', 'Subsequent / Specialized service', '99307–99310', 'common', 60],
  ['discharge', 'snf', 'Discharge Summary', 'Nursing Facility Discharge', '99315–99316', 'common', 70],
  ['change_in_condition', 'snf', 'Change in Condition Note', 'Subsequent Nursing Facility Care', '99307–99310', 'more', 110],
  ['follow_up', 'snf', 'Follow-Up Note', 'Subsequent Nursing Facility Care', '99307–99310', 'more', 120],
  ['medication', 'snf', 'Medication Management Note', 'Subsequent Nursing Facility Care', '99307–99310', 'more', 130],
  ['lab_imaging', 'snf', 'Lab / Imaging Review Note', 'Subsequent / per service', '99307–99310', 'more', 140],
  ['procedure_note', 'snf', 'Procedure Note', 'Part B Procedure', 'Per procedure (11042–11047 · 20610 · 97597…)', 'more', 150],
  ['behavioral_health', 'snf', 'Behavioral Health / Psychiatric Note', 'Behavioral Health (Part B)', '90792 · 99307–99310 (+90833/90836)', 'more', 160],
  ['cognitive_care', 'snf', 'Cognitive Assessment & Care Planning', 'Cognitive Care Planning (Part B)', '99483', 'more', 170],
  ['advance_care', 'snf', 'Advance Care Planning Note', 'Separately reportable (ACP)', '99497–99498', 'more', 180],
  ['death', 'snf', 'Death / Expiration Note', 'As applicable', '—', 'more', 190],
  // ---- Pain Management ----
  ['pain_consult', 'pain', 'Initial Pain Consultation', 'Pain Management — Evaluation', '99204–99205 · 99244–99245', 'common', 10],
  ['pain_followup', 'pain', 'Pain Follow-Up Note', 'Pain Management — Subsequent', '99212–99215', 'common', 20],
  ['pain_med_mgmt', 'pain', 'Controlled Substance / Medication Management', 'Pain Management — Monitoring', '99213–99215', 'common', 30],
  ['pain_esi', 'pain', 'Epidural Steroid Injection', 'Pain Management — Interventional', '62321–62323 · 64479–64484', 'common', 40],
  ['pain_facet_mbb', 'pain', 'Facet Injection / Medial Branch Block', 'Pain Management — Interventional', '64490–64495', 'common', 50],
  ['pain_rfa', 'pain', 'Radiofrequency Ablation', 'Pain Management — Interventional', '64633–64636', 'common', 60],
  ['pain_si_joint', 'pain', 'Sacroiliac Joint Injection', 'Pain Management — Interventional', '27096 · 64451', 'more', 110],
  ['pain_tpi', 'pain', 'Trigger Point Injection', 'Pain Management — Interventional', '20552–20553', 'more', 120],
  ['pain_nerve_block', 'pain', 'Peripheral / Sympathetic Nerve Block', 'Pain Management — Interventional', '64400–64530', 'more', 130],
  ['pain_scs', 'pain', 'Neurostimulator — SCS / PNS (Trial / Implant)', 'Pain Management — Neuromodulation', '63650 · 63685 · 64555 · 64575', 'more', 140],
  ['pain_pump', 'pain', 'Intrathecal Pump — Trial / Implant / Refill', 'Pain Management — Neuromodulation', '62362 · 62367–62370 · 95990–95991', 'more', 141],
  ['pain_kypho', 'pain', 'Vertebral Augmentation (Kyphoplasty / Vertebroplasty)', 'Pain Management — Interventional', '22510–22515', 'more', 142],
  ['pain_joint', 'pain', 'Peripheral Joint / Bursa Injection', 'Pain Management — Interventional', '20600–20611', 'more', 143],
  ['pain_botox', 'pain', 'Botulinum Toxin Injection', 'Pain Management — Interventional', '64615 · 64642–64647', 'more', 144],
  ['pain_uds', 'pain', 'Urine Drug Screen / Toxicology Review', 'Pain Management — Monitoring', '80305–80307 (review)', 'more', 150],
  ['pain_discharge', 'pain', 'Pain Management Discharge / Transition', 'Pain Management — Transition', 'Transition of care', 'more', 160],
  // ---- TCM (Transitional Care Management) — CMS 99495 / 99496 ----
  // The TCM service is reported ONCE per 30-day period on the face-to-face visit; the other
  // notes document the CMS-required elements that support that single billed service.
  ['tcm_face_to_face', 'tcm', 'TCM Face-to-Face Visit', 'Transitional Care Management — face-to-face E/M (≤7d high · ≤14d moderate)', '99495 · 99496', 'common', 10],
  ['tcm_initial_contact', 'tcm', 'Initial Interactive Contact (≤ 2 business days)', 'TCM required element', 'Supports 99495 / 99496', 'common', 20],
  ['tcm_discharge_review', 'tcm', 'Discharge Information Review', 'TCM required element', 'Supports 99495 / 99496', 'common', 30],
  ['tcm_med_reconciliation', 'tcm', 'Medication Reconciliation (by F2F date)', 'TCM required element', 'Supports 99495 / 99496', 'common', 40],
  ['tcm_care_plan', 'tcm', 'Transitional Care Plan', 'Transitional Care Management', 'Supports 99495 / 99496', 'common', 50],
  ['tcm_non_face_to_face', 'tcm', 'Non-Face-to-Face Care Management', 'TCM clinical-staff services (30-day period)', 'Supports 99495 / 99496', 'more', 110],
  ['tcm_follow_up', 'tcm', 'Interim Follow-Up / Care Coordination', 'Transitional Care Management', 'Supports 99495 / 99496', 'more', 120],
  ['tcm_closeout', 'tcm', '30-Day Service Period Close-Out', 'Transitional Care Management', '99495 · 99496 (DOS = F2F)', 'more', 130],
];

// Fast in-memory map: note_type -> service_line (the registry is small & static).
const SERVICE_BY_TYPE = new Map(NOTE_TEMPLATE_REGISTRY.map((r) => [r[0], r[1]]));

/**
 * Deterministic service line for a provider's specialty NAME. A specialty containing
 * the word "pain" → Pain Management; everything else → SNF (the default). Mirrors the
 * frontend exactly so the two never disagree.
 */
export function serviceForSpecialty(specialtyName) {
  const n = String(specialtyName || '');
  if (/\bpain\b/i.test(n)) return 'pain';
  if (/\btcm\b|transitional care/i.test(n)) return 'tcm';
  return 'snf';
}

/** Resolve a provider's PRIMARY service line (first of their assigned lines) — display only.
 *  Access decisions use the full set via providerServiceLines / providerCanUseNoteType. */
export async function providerServiceLine(providerId) {
  const lines = await providerServiceLines(providerId);
  return lines[0] || null; // no fallback — null when the provider has no specialty
}

// Re-export the authoritative multi-line resolver so callers have one template API surface.
export { providerServiceLines };

/** The service line a note type belongs to (null if unknown). */
export function serviceForNoteType(noteType) {
  return SERVICE_BY_TYPE.get(noteType) || null;
}

/** True iff this provider may create/edit a note of this type — i.e. the note type's
 *  service line is among the provider's granted specialties (multi-specialty aware). */
export async function providerCanUseNoteType(providerId, noteType) {
  const typeLine = serviceForNoteType(noteType);
  if (!typeLine) return false;
  const lines = await providerServiceLines(providerId);
  return lines.includes(typeLine);
}

// Pre-built, per-service-line template lists (immutable static reference data). Built
// ONCE at module load from the registry so the hot path (every note-picker open,
// potentially thousands of concurrent providers) is served from MEMORY with zero DB
// round-trips. The note_templates DB table remains the durable/seeded source of truth;
// it and this const are populated from the SAME registry, so they never disagree.
const TEMPLATES_BY_LINE = (() => {
  const by = { snf: [], pain: [], tcm: [] };
  for (const r of NOTE_TEMPLATE_REGISTRY) {
    by[r[1]].push({ noteType: r[0], serviceLine: r[1], label: r[2], category: r[3], cpt: r[4], menuGroup: r[5], sortOrder: r[6] });
  }
  for (const k of Object.keys(by)) {
    by[k].sort((a, b) => (Number(b.menuGroup === 'common') - Number(a.menuGroup === 'common')) || a.sortOrder - b.sortOrder);
    Object.freeze(by[k]);
  }
  return by;
})();

/**
 * Templates available to a service line, ordered for the picker. Served from the
 * in-memory registry (no DB query) — a fresh array copy per call so a caller can never
 * mutate the shared list (no cross-request leakage of the reference data).
 */
export function listTemplatesForServiceLine(serviceLine) {
  const line = ['snf', 'pain', 'tcm'].includes(serviceLine) ? serviceLine : 'snf';
  return (TEMPLATES_BY_LINE[line] || []).map((t) => ({ ...t }));
}

/**
 * Templates available across a SET of service lines (a multi-specialty provider) — the
 * de-duplicated UNION, ordered common-first then by sort order. Fresh copies (no shared
 * reference). A provider granted SNFs + Pain sees both lines' templates in one picker.
 */
export function listTemplatesForServiceLines(lines) {
  const set = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
  // NO FALLBACK: an empty set (provider with no specialty) yields NO templates.
  const wanted = [...new Set(set)];
  const seen = new Set();
  const out = [];
  for (const line of wanted) {
    for (const t of listTemplatesForServiceLine(line)) {
      if (seen.has(t.noteType)) continue;
      seen.add(t.noteType);
      out.push(t);
    }
  }
  // Common group first, then by the registry sort order — stable across lines.
  out.sort((a, b) => (Number(b.menuGroup === 'common') - Number(a.menuGroup === 'common')) || a.sortOrder - b.sortOrder);
  return out;
}

/** Idempotently seed/refresh the registry table (called on migration/boot). */
export async function seedNoteTemplates() {
  await pool.query(
    `INSERT INTO note_templates (note_type, service_line, label, category, cpt, menu_group, sort_order, active)
       VALUES ?
     ON DUPLICATE KEY UPDATE
       service_line = VALUES(service_line), label = VALUES(label), category = VALUES(category),
       cpt = VALUES(cpt), menu_group = VALUES(menu_group), sort_order = VALUES(sort_order), active = 1`,
    [NOTE_TEMPLATE_REGISTRY.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], 1])],
  );
  return NOTE_TEMPLATE_REGISTRY.length;
}
