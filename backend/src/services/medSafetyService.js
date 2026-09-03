import { pool } from '../db/pool.js';
import { logger } from '../config/logger.js';

/**
 * Real-time medication-safety checks for the prescribing assist — fully LOCAL and DETERMINISTIC.
 * Every alert traces to REAL, loaded UMLS reference data (no external API at request time, no fuzzy
 * matching, no fabricated results):
 *
 *   1. Class-based allergy cross-check — the ingredient(s) parsed from the drug name → their drug
 *      classes in `rxnorm_drug_class` (precomputed from the official UMLS Metathesaurus: RXNORM
 *      rxcui↔CUI atoms + MED-RT `has_structural_class` relationships + WHO-ATC). A documented allergy
 *      matches (a) the drug NAME/ingredient by word-prefix ("sulfa"→"sulfamethoxazole") or (b) a real
 *      drug-class label by whole-word+plural ("penicillin"→MED-RT "Penicillins" / ATC "Penicillins with
 *      extended spectrum", "cephalosporin"→"Cephalosporins", "macrolide"→"Macrolides"). The MED-RT
 *      STRUCTURAL (chemical) class is the authoritative allergen class (amoxicillin→Penicillins).
 *   2. Duplicate / therapeutic duplication — same INGREDIENT on the note's list (exact), OR a different
 *      drug sharing the same ATC-4 chemical subgroup (two propionic-acid NSAIDs; two ACE-inhibitors).
 *      ATC-4 (not the broader chemical class) avoids false-flagging legit combos (metformin + glipizide).
 *
 * An ingredient with no class on file returns `classKnown:false` → the caller shows "class screening
 * could not be applied", never "safe". Full pairwise drug–drug interaction data needs a commercial
 * licence (First Databank / Medi-Span) and is intentionally out of scope, not approximated.
 */

// Allergen matching draws on the chemical/structural + ATC subgroup labels; duplication keys off ATC-4.
// ATC is the authoritative, complete backbone (rxcui↔CUI↔ATC, loaded from the official Metathesaurus);
// MED-RT structural/therapeutic class is additive where the CUI bridge resolves. Allergy matching uses
// all of them (extra real class labels only help catch an allergy; whole-word matching blocks false hits).
const ALLERGY_SYSTEMS = new Set(['ATC4', 'ATC3', 'MEDRT_STRUCT', 'MEDRT_THERA']);
const DISPLAY_ORDER = ['ATC4', 'MEDRT_STRUCT', 'MEDRT_THERA', 'ATC3'];
// Route-local ATC labels (a substance can also be classified for topical/vaginal/ophthalmic/etc. use):
// surfaced last for display, but they still count for allergy matching (allergy is route-independent).
const LOCAL_CLASS = /(vaginal|topical|cutaneous|dermatolog|ophthalmolog|ophthalmic|otolog|nasal|throat|stomatolog|dental|rectal|local|cardiac preparations)/i;
const isLocalClass = (label) => LOCAL_CLASS.test(label || '');

// Lay drug-class allergy terms → the WHO-ATC class code prefixes that define them. Patients document
// allergies in lay terms ("statin", "NSAID", "ACE inhibitor", "opioid") that do NOT appear verbatim in
// ATC/MED-RT class labels (e.g. statins are labelled "HMG CoA reductase inhibitors"). This is a
// terminology CROSSWALK (lay term → standard ATC class), not a fabricated cross-reactivity rule: a term
// fires only when the DRUG's own ATC code sits under the mapped class, so it is deterministic and cannot
// mis-hit by string coincidence (e.g. "statin"→C10AA never matches nystatin, whose ATC is A07AA/D01AA).
const LAY_CLASS = [
  { terms: ['statin', 'statins'], atc: ['C10AA', 'C10B'] },
  { terms: ['nsaid', 'nsaids'], atc: ['M01A'] },
  { terms: ['ace inhibitor', 'ace inhibitors', 'ace-inhibitor', 'acei'], atc: ['C09A', 'C09B'] },
  { terms: ['arb', 'arbs', 'angiotensin receptor blocker'], atc: ['C09C', 'C09D'] },
  { terms: ['beta blocker', 'beta blockers', 'beta-blocker'], atc: ['C07'] },
  { terms: ['ppi', 'ppis', 'proton pump inhibitor'], atc: ['A02BC'] },
  { terms: ['ssri', 'ssris'], atc: ['N06AB'] },
  { terms: ['snri', 'snris'], atc: ['N06AX'] },
  { terms: ['benzodiazepine', 'benzodiazepines', 'benzo'], atc: ['N05BA', 'N05CD'] },
  { terms: ['opioid', 'opioids', 'narcotic', 'narcotics'], atc: ['N02A'] },
  { terms: ['sulfonylurea', 'sulfonylureas'], atc: ['A10BB'] },
];

// The entire drug-class table (≈13k rows) is loaded into memory ONCE and indexed by ingredient, so
// every prescribing-safety check is instant and has NO request-time DB round-trip — production-grade
// for real-time prescribing. Refreshed on process restart (the class data changes only via an offline
// precompute). The load is Promise-guarded (concurrent first-calls share one load) and retryable.
let indexPromise = null;
const EMPTY_INFO = { has: false, allergyLabels: [], atc4: [], display: [] };

function buildInfo(rows) {
  const allergyLabels = [...new Set(rows.filter((r) => ALLERGY_SYSTEMS.has(r.class_system)).map((r) => r.class_name.toLowerCase()))];
  const atc4 = [...new Set(rows.filter((r) => r.class_system === 'ATC4').map((r) => r.class_id))];
  const display = [];
  for (const sys of DISPLAY_ORDER) {
    for (const r of rows.filter((x) => x.class_system === sys)) if (!display.includes(r.class_name)) display.push(r.class_name);
  }
  display.sort((a, b) => (isLocalClass(a) ? 1 : 0) - (isLocalClass(b) ? 1 : 0));
  return { has: rows.length > 0, allergyLabels, atc4, display };
}

async function ensureIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const [rows] = await pool.query('SELECT ingredient, class_system, class_id, class_name FROM rxnorm_drug_class');
      const byIng = new Map();
      for (const r of rows) {
        const key = r.ingredient.toLowerCase();
        let g = byIng.get(key); if (!g) { g = []; byIng.set(key, g); }
        g.push(r);
      }
      const index = new Map();
      for (const [key, rs] of byIng) index.set(key, buildInfo(rs));
      logger.info({ ingredients: index.size, rows: rows.length }, 'medSafety: drug-class index loaded into memory');
      return index;
    })().catch((e) => { indexPromise = null; throw e; }); // clear on failure so the next call retries
  }
  return indexPromise;
}

const STRENGTH = /\b\d+(?:\.\d+)?\s*(?:MG|MCG|UG|NG|G|ML|UNT|UNIT|%|MEQ|MMOL|IU|BAU|AU|PNU|IR|SQCM|CELLS|MCI)\b/i;
const FORM_TAIL = /\s+(?:oral|injectable|topical|ophthalmic|otic|nasal|rectal|vaginal|inhalation|sublingual|buccal|transdermal|chewable|extended release|delayed release|prefilled|metered|auto-?injector|tablet|capsule|solution|suspension|syrup|elixir|cream|ointment|lotion|gel|patch|suppository|powder|granules?|lozenge|film|spray|drops?|aerosol|pack|kit)\b.*$/i;

const INERT = /^(inert ingredients?|placebo|inert|diluent)$/i;

/** Ingredient candidates from one "ingredient strength [/ ingredient strength] form" string. */
function extractIngredients(str) {
  let s = String(str || '').replace(/\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\s*\d+(?:\.\d+)?\s*(?:%|ML)\s+/i, '');   // strip leading fill volume / concentration ("0.9 % ")
  const out = [];
  for (const seg of s.split('/')) {
    const m = seg.match(STRENGTH);
    let ing = (m ? seg.slice(0, m.index) : seg).replace(FORM_TAIL, '').trim();
    ing = ing.replace(/[.,;:]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (ing && ing.length >= 3 && !INERT.test(ing) && !out.includes(ing)) out.push(ing);
  }
  return out;
}

/** Extract clean lowercase ingredient candidate(s) from an RxNorm/product/pack/free-text drug name. */
export function ingredientsFromName(name) {
  const raw = String(name || '');
  // Pack — "{ N (drug strength form) / M (…) } Pack": parse each parenthesized component, drop inert fillers.
  if (raw.includes('{')) {
    const out = []; const re = /\(([^()]*)\)/g; let m;
    while ((m = re.exec(raw))) for (const ing of extractIngredients(m[1])) if (!out.includes(ing)) out.push(ing);
    if (out.length) return out;
  }
  const out = extractIngredients(raw.replace(/\{[^}]*\}/g, ' '));
  if (!out.length) {
    const f = raw.replace(/\[.*?\]/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (f) out.push(f);
  }
  return out;
}

/** Legacy single-ingredient helper kept for callers/tests. */
export function ingredientOf(name) { return ingredientsFromName(name)[0] || String(name || '').trim().toLowerCase(); }

/** Drug-class info for one ingredient — instant in-memory lookup from the preloaded index. */
async function classInfoForIngredient(ingredient) {
  const index = await ensureIndex();
  return index.get(ingredient.toLowerCase()) || EMPTY_INFO;
}

/**
 * Run the safety checks for a drug about to be prescribed.
 * @param {{ name:string, rxcui?:string, allergies?:string, currentDrugs?:string[] }} params
 */
export async function checkRxSafety({ name, rxcui = '', allergies = '', currentDrugs = [] }) {
  // Defensive input bounding — never crash on malformed/oversized input (real drug names < ~300 chars,
  // allergy lists modest; unbounded strings would blow up regex construction). Coercion, not fabrication.
  name = String(name == null ? '' : name).slice(0, 500);
  allergies = String(allergies == null ? '' : allergies).slice(0, 2000);
  const ingredients = ingredientsFromName(name);
  const infos = await Promise.all(ingredients.map(classInfoForIngredient));
  const classKnown = infos.some((i) => i.has);

  const classLabels = [...new Set(infos.flatMap((i) => i.display))];
  const allAtc4 = new Set(infos.flatMap((i) => i.atc4));
  const classHay = [...new Set(infos.flatMap((i) => i.allergyLabels))];
  const nameHay = `${name} ${ingredients.join(' ')}`.toLowerCase();

  const allergyTerms = String(allergies || '')
    .split(/[,;\n/|]+|\band\b/i)
    .map((t) => t.replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 -]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase())
    .flatMap((t) => [t, ...t.split(' ')])
    .map((t) => t.trim())
    // length 4..40: real allergen/class terms are short; the upper bound also blocks a pathological
    // long token from being compiled into an oversized regex. The stop-list drops noise words AND generic
    // word-FRAGMENTS that appear inside unrelated ATC class labels (e.g. "beta" from "beta blocker" would
    // otherwise whole-word-match "BETA-lactam antibacterials" → false penicillin alert). Multi-word lay
    // classes ("beta blocker", "proton pump inhibitor") are recognised as whole phrases by LAY_CLASS, so
    // dropping their fragments here loses nothing. A genuinely hyphenated allergen like "beta-lactam"
    // survives (it is a single token, never space-split).
    .filter((t) => t.length >= 4 && t.length <= 40 && !/^(nkda|none|known|no|reviewed|emr|environmental|latex|drug|drugs|food|foods|allergy|allergies|reaction|rash|hives|itching|swelling|nausea|intolerance|seasonal|the|and|beta|alpha|blocker|blockers|channel|channels|acid|agent|agents|receptor|receptors|inhibitor|inhibitors|antagonist|antagonists|agonist|agonists|calcium|sodium|potassium|selective|systemic|other|plain|modifying|proton|pump)$/.test(t));

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inName = (t) => new RegExp(`\\b${esc(t)}`, 'i').test(nameHay);
  const classRe = (t) => new RegExp(`\\b${esc(t)}(?:s|es)?\\b`, 'i');   // whole-word + plural, never a loose substring
  const inClass = (t) => classHay.some((lbl) => classRe(t).test(lbl));
  const allergyAlerts = [];
  const seen = new Set();
  for (const t of allergyTerms) {
    if (seen.has(t)) continue; seen.add(t);
    if (inName(t)) {
      allergyAlerts.push(`Documented allergy “${t}” — this drug is or contains ${t}.`);
    } else if (inClass(t)) {
      const hit = classLabels.find((lbl) => classRe(t).test(lbl)) || 'the same drug class';
      allergyAlerts.push(`Documented allergy “${t}” — this drug belongs to ${hit} (${t}-class cross-reactivity).`);
    }
  }
  // Lay-term class allergies (statin/NSAID/ACE inhibitor/opioid/…) — fire only when the drug's own ATC
  // class matches the mapped code, so 3-char lay terms (PPI/ARB) work without a length-filter and there
  // are no string-coincidence false hits. Checked against the raw allergies text (whole-word).
  const allergyText = allergies.toLowerCase();
  for (const lay of LAY_CLASS) {
    if (!lay.atc.some((pre) => [...allAtc4].some((c) => c.startsWith(pre)))) continue;
    const hit = lay.terms.find((term) => new RegExp(`\\b${esc(term)}\\b`, 'i').test(allergyText));
    if (hit && !seen.has(`lay:${lay.terms[0]}`)) {
      seen.add(`lay:${lay.terms[0]}`);
      allergyAlerts.push(`Documented allergy “${hit}” — this drug is a ${lay.terms[0]} (same drug class).`);
    }
  }

  const duplicates = [];
  const dupSeen = new Set();
  for (const raw of (Array.isArray(currentDrugs) ? currentDrugs : [])) {
    const d = String(raw == null ? '' : raw).slice(0, 500);   // elements may be non-strings — coerce safely
    if (!d || d.toLowerCase() === name.toLowerCase()) continue;
    const dIngs = ingredientsFromName(d);
    if (dIngs.some((di) => ingredients.includes(di))) {
      if (!dupSeen.has(`i:${d}`)) { duplicates.push(`Duplicate therapy — already prescribing ${d} (same ingredient).`); dupSeen.add(`i:${d}`); }
      continue;
    }
    if (allAtc4.size) {
      const dInfo = await Promise.all(dIngs.map(classInfoForIngredient));
      const dAtc4 = new Set(dInfo.flatMap((i) => i.atc4));
      const shared = [...dAtc4].find((c) => allAtc4.has(c));
      if (shared && !dupSeen.has(`c:${d}`)) {
        const cls = infos.flatMap((i) => i.display).find(Boolean) || 'the same drug class';
        duplicates.push(`Therapeutic duplication — ${d} is the same drug class (${cls}).`);
        dupSeen.add(`c:${d}`);
      }
    }
  }

  return {
    drug: name,
    ingredient: ingredients[0] || '',
    ingredients,
    rxcui: String(rxcui || ''),
    classes: classLabels,
    allergyAlerts,
    duplicates,
    classKnown,
    dataAvailable: true,
    source: 'UMLS MED-RT structural class + WHO ATC (local, deterministic)',
  };
}
