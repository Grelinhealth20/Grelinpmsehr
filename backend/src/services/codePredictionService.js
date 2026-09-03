import { pool } from '../db/pool.js';
import { searchSnomed, snomedToIcd10cm, lookupCpt } from './terminologyService.js';
import { isBillableIcd, icdDescription } from './terminologyCache.js';

/**
 * DETERMINISTIC clinical code prediction from a provider's note (Stage 1: ICD-10-CM diagnoses).
 *
 * Practice-Fusion-style: the provider writes the note; on completion the diagnoses documented in
 * the Assessment/Plan (and Discharge Diagnoses / Chief Complaint) are auto-extracted and mapped to
 * BILLABLE ICD-10-CM — no manual search. Accuracy comes from grounding EVERY code in real CMS data:
 *   phrase → SNOMED CT US concept (full local edition; exact term first, else FULLTEXT synonyms)
 *          → OFFICIAL SNOMED→ICD-10-CM complex map (snomed_map_icd10cm; billable leaf, default rule).
 * This is the SAME mapping path the manual "add diagnosis" UI uses — just automated. No LLM, no
 * fabrication: a phrase that does not resolve to a billable ICD is returned as "unmatched" for the
 * coder, never guessed. The coder confirms/adjusts before signing (final-validation rule).
 */

const SCT_FSN = 900000000000003001; // Fully Specified Name description type (carries the semantic tag)

// Clinical abbreviations → full terms (expanded before search; boosts recall on clinician shorthand).
const ABBREV = {
  t2dm: 'type 2 diabetes mellitus', t1dm: 'type 1 diabetes mellitus', dm: 'diabetes mellitus',
  htn: 'hypertension', ckd: 'chronic kidney disease', esrd: 'end stage renal disease',
  aki: 'acute kidney injury', chf: 'congestive heart failure', copd: 'chronic obstructive pulmonary disease',
  cad: 'coronary artery disease', cva: 'cerebral infarction', tia: 'transient ischemic attack',
  mi: 'myocardial infarction', afib: 'atrial fibrillation', 'a-fib': 'atrial fibrillation', af: 'atrial fibrillation',
  uti: 'urinary tract infection', gerd: 'gastroesophageal reflux disease', dvt: 'deep vein thrombosis',
  pe: 'pulmonary embolism', pna: 'pneumonia', cap: 'community acquired pneumonia', bph: 'benign prostatic hyperplasia',
  pvd: 'peripheral vascular disease', pad: 'peripheral arterial disease', osa: 'obstructive sleep apnea',
  hld: 'hyperlipidemia', hf: 'heart failure', ra: 'rheumatoid arthritis', oa: 'osteoarthritis',
  gib: 'gastrointestinal hemorrhage',
  ams: 'altered mental status', gad: 'generalized anxiety disorder', ckd: 'chronic kidney disease',
  mdd: 'major depressive disorder', copd2: 'chronic obstructive pulmonary disease',
  cp: 'chest pain', sob: 'shortness of breath', dvt: 'deep vein thrombosis', tia: 'transient ischemic attack',
  chf: 'congestive heart failure', pna: 'pneumonia', afib: 'atrial fibrillation', htn: 'hypertension',
};
// Negation / uncertainty cues — a problem carrying these is NOT coded as an active diagnosis.
// (Status words like "resolving/stable/improving" are NOT negation — those conditions are still active.)
const NEG = /\b(no|not|denies|denied|negative for|without|r\/o|rule out|ruled out|no evidence of|absence of|free of|unlikely|possible|probable|questionable|differential|history of|h\/o|hx of|status post|s\/p)\b/i;
// Status/qualifier words trimmed from the tail so the condition phrase matches SNOMED cleanly.
const STATUS_TAIL = /\b(stable|improving|worsening|resolving|resolved|unchanged|controlled|uncontrolled|well controlled|poorly controlled|ongoing|at goal|new|old|likely|suspected)\b/gi;
// Grammatical stopwords for scoring — clinically significant words (acute, chronic, type, stage…) are kept.
const STOP = new Set(['the', 'a', 'an', 'of', 'with', 'and', 'due', 'to', 'on', 'in', 'for', 'his', 'her', 'their', 'patient', 'pt', 'by', 'from', 'or', 'at']);
// Tokens FULLTEXT can't require (its own stopwords + sub-min-length) — excluded from the search query
// but KEPT for overlap scoring, so "type 2" still distinguishes from "type 1".
const FT_UNUSABLE = new Set(['with', 'and', 'the', 'of', 'due', 'to', 'for', 'in', 'on', 'or', 'at', 'by', 'from', 'a', 'an']);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s./-]/g, ' ').replace(/\s+/g, ' ').trim();
// Hyphens split into separate tokens so "End-stage" matches "end stage", "Non-pressure" → "non pressure".
const scoreTokens = (s) => norm(s).split(/[\s-]+/).filter((w) => (w.length >= 2 || /^\d$/.test(w)) && !STOP.has(w));
const searchTokens = (s) => norm(s).split(/[\s-]+/).filter((w) => w.length >= 3 && !FT_UNUSABLE.has(w));

function expandAbbrev(phrase) {
  const words = norm(phrase).split(/\s+/).map((w) => ABBREV[w] || w);
  let out = words.join(' ');
  // "Type 2 diabetes" / bare "diabetes" is the common shorthand for "diabetes mellitus" — add the implied
  // word so the SNOMED coverage rule matches the concept (without it, "type 2 diabetes" fails to match
  // "Type 2 diabetes mellitus"). Not for "diabetes insipidus" (a different disease).
  if (/\bdiabetes\b/.test(out) && !/\b(mellitus|insipidus)\b/.test(out)) out = out.replace(/\bdiabetes\b/, 'diabetes mellitus');
  return out;
}

// Normalize one problem line → { text: condition head, full: line, negated } (or null if too short).
function parseProblemLine(rawLine) {
  // Strip problem-list markers ("#", "1.", "-", bullets), then normalize laterality shorthand
  // ("R."/"L."/"Rt"/"Lt"/"B/L" → right/left/bilateral) so "R. hip pain" parses as a real problem.
  let line = rawLine.replace(/^\s*#+\s*/, '').replace(/^\s*\d{1,2}[.)]\s*/, '').replace(/^\s*[-•*]\s*/, '').trim();
  line = line.replace(/\b[Rr]\.\s+/g, 'right ').replace(/\b[Ll]\.\s+/g, 'left ')
    .replace(/\b[Rr]t\.?\s+/g, 'right ').replace(/\b[Ll]t\.?\s+/g, 'left ').replace(/\bB\/L\b/gi, 'bilateral');
  if (line.length < 3) return null;
  // A problem marked RESOLVED / INACTIVE is not an active diagnosis and must NOT be billed (a resolved
  // COVID-19 or UTI stays in the chart but is not coded). "resolving" (ongoing) is active.
  const resolved = /\b(resolved|inactive)\b/i.test(line) && !/\bresolving\b/i.test(line);
  const negated = resolved || NEG.test(line);
  // Condition head: cut at the first separator, and at etiology connectors ("due to"/"secondary to"/
  // "from") — but NOT "with" (combination codes like "diabetes WITH CKD" are one concept).
  let head = line.split(/[:;.–—]|,\s|\s-\s/)[0];
  head = head.split(/\b(?:due to|secondary to|related to|from|attributed to)\b/i)[0].trim();
  head = head.replace(STATUS_TAIL, '').replace(/\s+/g, ' ').trim();
  if (head.length < 3) return null;
  return { text: head, full: line, negated };
}

// Pull EXPLICIT diagnosis enumerations out of narrative fields (HPI / admission reason), e.g.
// "active dx of Dementia, Parkinson's Disease, Hypertension and BPH". Only the list that follows an
// explicit active-diagnosis trigger is taken — NOT arbitrary prose — so a documented active problem
// stated only in the HPI (and omitted from the structured problem list) is still captured, without the
// over-coding risk of mining free text. Each item then runs through the same billable matcher.
function enumeratedDxLines(text) {
  const out = [];
  const trigger = /\b(?:active (?:dx|diagnos(?:is|es|tic))(?:\s+of)?|active (?:medical )?(?:problems?|dx)\s*(?:of|:|include[s]?)?|presents? with (?:an? )?active (?:dx|diagnos\w+)\s+of|diagnos(?:ed with|is of))\b[:\s]+/gi;
  let m;
  while ((m = trigger.exec(text)) !== null) {
    const tail = text.slice(m.index + m[0].length);
    const segment = tail.split(/[.\n;]/)[0]; // up to the sentence end
    if (!segment || segment.length > 220) continue; // guard against runaway prose
    for (const part of segment.split(/,|\band\b|&/i)) {
      const p = part.trim();
      if (p.length >= 3 && p.length <= 60) out.push(p);
    }
  }
  return out;
}

/** Extract candidate diagnosis phrases from the diagnosis-bearing sections. Each list item is one
 *  problem; the condition head is taken (before status/etiology). Negated items are flagged. */
export function extractProblemPhrases(content = {}, noteType = 'hp') {
  const sources = ['assessment', 'dischargeDiagnoses', 'chiefComplaint', 'reasonForVisit'];
  const seen = new Set();
  const items = [];
  const push = (parsed, section) => {
    if (!parsed) return;
    const dedupeKey = norm(parsed.text);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    // Keep the FULL line alongside the condition head: the head drives the general SNOMED match, while
    // the full line preserves etiology ("pain due to malignancy" → G89.3) the head-truncation drops.
    items.push({ text: parsed.text, full: parsed.full, negated: parsed.negated, section });
  };
  for (const key of sources) {
    const raw = content?.[key];
    if (!raw || typeof raw !== 'string') continue;
    const lines = raw.split(/\r?\n+/).flatMap((ln) => ln.split(/(?=\b\d{1,2}[.)]\s)/));
    for (const line of lines) push(parseProblemLine(line), key);
  }
  // Targeted: explicit "active dx of A, B, C" enumerations in the narrative (HPI / admission reason),
  // so a documented active diagnosis stated only there is not missed. Deduped against the structured list.
  for (const key of ['hpi', 'historyOfPresentIllness', 'subjective', 'admissionReason', 'reasonForAdmission']) {
    const raw = content?.[key];
    if (!raw || typeof raw !== 'string') continue;
    for (const dx of enumeratedDxLines(raw)) push(parseProblemLine(dx), key);
  }
  return items;
}

function overlapScore(phraseTokens, termTokens) {
  if (!phraseTokens.length) return 0;
  const set = new Set(termTokens);
  return phraseTokens.filter((t) => set.has(t)).length / phraseTokens.length;
}

/** Semantic tag from a concept's FSN, e.g. "disorder", "finding", "procedure" — for a batch of ids. */
async function fsnTags(conceptIds) {
  if (!conceptIds.length) return new Map();
  const [rows] = await pool.query(
    `SELECT concept_id, term FROM snomed_descriptions WHERE type_id = ? AND active = 1 AND concept_id IN (?)`,
    [SCT_FSN, conceptIds]);
  const map = new Map();
  for (const r of rows) { const m = /\(([^)]+)\)\s*$/.exec(r.term); if (m) map.set(String(r.concept_id), m[1].toLowerCase()); }
  return map;
}

/**
 * Exact-term SNOMED concept for a phrase — case- AND hyphen-insensitive (so "end stage renal
 * disease" matches the concept "End-stage renal disease"). A FULLTEXT prefilter keeps it fast, then
 * the hyphen/space-normalized term must equal the phrase exactly (no extra words).
 */
async function exactConcept(phrase) {
  const target = norm(phrase).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  const words = target.split(' ').filter((w) => w.length >= 3 && !FT_UNUSABLE.has(w));
  if (!words.length) return [];
  const boolean = words.map((w) => `+${w}`).join(' ');
  const [rows] = await pool.query(
    `SELECT d.concept_id AS code, d.term AS name, d.us_preferred AS preferred
       FROM snomed_descriptions d JOIN snomed_concepts c ON c.id = d.concept_id
      WHERE d.active = 1 AND c.active = 1 AND MATCH(d.term) AGAINST(? IN BOOLEAN MODE)
        AND REPLACE(REPLACE(LOWER(d.term), '-', ' '), '  ', ' ') = ?
      ORDER BY d.us_preferred DESC, CHAR_LENGTH(d.term) LIMIT 5`, [boolean, target]);
  return rows.map((r) => ({ code: String(r.code), name: r.name, preferred: !!r.preferred }));
}

const DISORDER_TAGS = new Set(['disorder', 'finding', 'situation', 'event']);
const cover = (aTokens, bSet) => (aTokens.length ? aTokens.filter((t) => bSet.has(t)).length / aTokens.length : 0);

/** Is `code` a valid, billable ICD-10-CM leaf (submittable to a payer)? */
// isBillableIcd + icdDescription come from terminologyCache (complete ICD-10-CM billable set held in
// process memory — O(1) validation, no per-call remote round-trip). See terminologyCache.js.

/**
 * Curated ORGANISM/ETIOLOGY → ICD-10-CM rules. Fungal (Candida) infections are coded to their own
 * B37.x category by SITE, NOT to the generic site infection (a candidal UTI is B37.49, not N39.0) —
 * a rule a generic SNOMED match can't infer. Real ICD-10-CM; validated as billable before use.
 * Deterministic and extensible; mirrors how professional computer-assisted coding handles etiology.
 */
function etiologyIcd(phrase) {
  const t = norm(phrase);
  if (/\bcandid/.test(t)) {
    if (/\b(urinary|uti|urogenital|genitourinary|bladder|cystitis)\b/.test(t)) return { icd: 'B37.49', description: 'Other urogenital candidiasis' };
    if (/\b(oral|mouth|thrush|oropharyn)/.test(t)) return { icd: 'B37.0', description: 'Candidal stomatitis' };
    if (/\besophag/.test(t)) return { icd: 'B37.81', description: 'Candidal esophagitis' };
    if (/\b(vulvovagin|vagin|vulv)/.test(t)) return { icd: 'B37.3', description: 'Candidiasis of vulva and vagina' };
    if (/\b(skin|cutaneous|intertrigo|nail|onych)/.test(t)) return { icd: 'B37.2', description: 'Candidiasis of skin and nail' };
    if (/\b(sepsis|septic|blood|systemic|disseminat)/.test(t)) return { icd: 'B37.7', description: 'Candidal sepsis' };
    if (/\b(pneumon|lung|respiratory)/.test(t)) return { icd: 'B37.1', description: 'Pulmonary candidiasis' };
    return { icd: 'B37.9', description: 'Candidiasis, unspecified' };
  }
  // Seizure DISORDER / epilepsy is the chronic condition (G40.x), NOT the acute-convulsion symptom
  // R56.9 — a distinction a generic match gets wrong. A bare "seizure(s)" still maps to R56.9.
  if (/\b(seizure disorder|epilep)/.test(t) && !/status epilepticus/.test(t)) return { icd: 'G40.909', description: 'Epilepsy, unspecified, not intractable, without status epilepticus' };
  // Device/site infections coded to their own category.
  if (/(gastrostomy|g.?tube|peg.?tube|peg site)/.test(t) && /infect/.test(t)) return { icd: 'K94.22', description: 'Gastrostomy infection' };
  // Clostridioides (Clostridium) difficile enterocolitis — its own A04.7x category (recurrent vs not).
  if (/\b(c[-.\s]?diff\w*|clostrid\w*\s+difficile)\b/.test(t)) {
    return /recurren/.test(t)
      ? { icd: 'A04.71', description: 'Enterocolitis due to Clostridium difficile, recurrent' }
      : { icd: 'A04.72', description: 'Enterocolitis due to Clostridium difficile, not specified as recurrent' };
  }
  // Neoplasm-related pain (G89.3) — pain documented as due to malignancy / cancer / metastasis, NOT the
  // generic R52 "pain, unspecified". Needs the full problem line (etiology survives the "due to" split).
  if (/\bpain\b/.test(t) && /(malignan|cancer|neoplasm|tumou?r|metasta|oncolog)/.test(t)) {
    return { icd: 'G89.3', description: 'Neoplasm related pain (acute) (chronic)' };
  }
  // CHRONIC pain — the "chronic" qualifier is codeable to category G89.2x, NOT the unspecified R52. By
  // cause: trauma → G89.21, post-procedural → G89.28, "syndrome" → G89.4, otherwise "other chronic pain"
  // → G89.29. (Neoplasm-related chronic pain is already handled above.)
  if (/\bchronic pain\b/.test(t)) {
    if (/\b(trauma|injury|injuri|post.?traumatic)\b/.test(t)) return { icd: 'G89.21', description: 'Chronic pain due to trauma' };
    if (/(post.?op|post.?procedur|post.?surg)/.test(t)) return { icd: 'G89.28', description: 'Other chronic postprocedural pain' };
    if (/\bsyndrome\b/.test(t)) return { icd: 'G89.4', description: 'Chronic pain syndrome' };
    return { icd: 'G89.29', description: 'Other chronic pain' };
  }
  // Parkinson's disease (FY2024 restructure of G20). Bare "Parkinson's disease" must NOT be coded G20.A1,
  // which ASSERTS "without dyskinesia, without fluctuations" — specificity the note didn't document.
  // Default to G20.C (unspecified); only use the specific codes when dyskinesia / motor fluctuations are
  // documented. (Secondary / drug-induced parkinsonism is a different category and is left to the map.)
  if (/\bparkinson/.test(t) && !/(secondary|drug.?induced|vascular|atypical|plus)/.test(t)) {
    const dysk = /\bdyskines/.test(t);
    const fluct = /\bfluctuat|\bon.?off\b|wearing.?off|motor fluctuat/.test(t);
    if (dysk && fluct) return { icd: 'G20.B2', description: "Parkinson's disease with dyskinesia, with fluctuations" };
    if (dysk) return { icd: 'G20.B1', description: "Parkinson's disease with dyskinesia, without mention of fluctuations" };
    if (fluct) return { icd: 'G20.A2', description: "Parkinson's disease without dyskinesia, with fluctuations" };
    return { icd: 'G20.C', description: 'Parkinsonism, unspecified' };
  }
  // Protein(-calorie) malnutrition → E46 unspecified (NOT E40 Kwashiorkor, a specific edematous form the
  // generic match wrongly picks); severity qualifiers select E43 / E44.0 / E44.1.
  if (/\b(protein[\s-]?(calorie|energy)?\s*malnutrition|malnutrition)\b/.test(t)) {
    if (/\bsevere\b/.test(t)) return { icd: 'E43', description: 'Unspecified severe protein-calorie malnutrition' };
    if (/\bmoderate\b/.test(t)) return { icd: 'E44.0', description: 'Moderate protein-calorie malnutrition' };
    if (/\bmild\b/.test(t)) return { icd: 'E44.1', description: 'Mild protein-calorie malnutrition' };
    return { icd: 'E46', description: 'Unspecified protein-calorie malnutrition' };
  }
  return null;
}

/** Relevance-ranked SNOMED search (natural mode) — returns candidates that share terms with the
 *  phrase WITHOUT requiring every word, so combination concepts (e.g. "CKD due to type 2 diabetes")
 *  surface even when the note wording differs. Precision is enforced later by the coverage rule. */
async function broaderSearch(query, limit = 30) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  const [rows] = await pool.query(
    `SELECT d.concept_id AS code, d.term AS name, d.us_preferred AS preferred,
            MATCH(d.term) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
       FROM snomed_descriptions d JOIN snomed_concepts c ON c.id = d.concept_id
      WHERE d.active = 1 AND c.active = 1 AND MATCH(d.term) AGAINST(? IN NATURAL LANGUAGE MODE)
      ORDER BY score DESC LIMIT ?`, [q, q, limit]);
  const seen = new Set(); const out = [];
  for (const r of rows) { const code = String(r.code); if (seen.has(code)) continue; seen.add(code); out.push({ code, name: r.name, preferred: !!r.preferred }); }
  return out;
}

/**
 * Resolve ONE phrase to a billable ICD-10-CM via SNOMED. Returns the best match or null.
 * A candidate concept must be ALMOST FULLY EXPLAINED by the note phrase (so we never invent
 * specifics the provider didn't document, e.g. a CKD stage), and is ranked by how COMPLETELY it
 * captures the phrase (so a combination code beats its two separate parts). Only billable leaf
 * codes in the official map are accepted.
 */
// Bounded in-process memo of phrase → match. The same problem phrases recur constantly across notes
// (hypertension, type 2 diabetes, …); memoizing the resolved match skips the remote SNOMED round-trips
// entirely on repeats. Deterministic (same phrase → same code), bounded to avoid unbounded growth.
const PHRASE_MEMO = new Map();
const PHRASE_MEMO_MAX = 5000;

export async function matchIcdForPhrase(phrase, fullLine) {
  const expanded = expandAbbrev(phrase);
  const pTokens = scoreTokens(expanded);
  if (!pTokens.length) return null;
  // Key includes the full line so etiology-bearing lines ("pain due to malignancy") don't collide with a
  // bare head ("pain") in the memo.
  const memoKey = `${norm(fullLine || '')}§${pTokens.slice().sort().join(' ')}`;
  if (PHRASE_MEMO.has(memoKey)) return PHRASE_MEMO.get(memoKey);
  const result = await resolveIcdForPhrase(phrase, expanded, pTokens, fullLine);
  if (PHRASE_MEMO.size >= PHRASE_MEMO_MAX) PHRASE_MEMO.delete(PHRASE_MEMO.keys().next().value);
  PHRASE_MEMO.set(memoKey, result);
  return result;
}

async function resolveIcdForPhrase(phrase, expanded, pTokens, fullLine) {
  const pSet = new Set(pTokens);

  // Organism/etiology-specific coding first (e.g. candidal UTI → B37.49), validated as billable. The full
  // line is used so etiology after "due to"/"secondary to" (dropped from the head) is still seen.
  const et = etiologyIcd(fullLine || phrase);
  if (et && await isBillableIcd(et.icd)) {
    const desc = (await icdDescription(et.icd)) || et.description; // authoritative dataset description
    return { icd: et.icd, description: desc, snomedCode: null, snomedTerm: desc, contextDependent: false };
  }

  const query = searchTokens(expanded).join(' ') || norm(expanded);
  const [exact, fuzzy, broad] = await Promise.all([
    exactConcept(expanded), searchSnomed(query, { pageSize: 12 }), broaderSearch(query, 30),
  ]);
  const byCode = new Map();
  for (const c of [...exact, ...fuzzy, ...broad]) if (!byCode.has(c.code)) byCode.set(c.code, c);
  const candidates = [...byCode.values()];
  if (!candidates.length) return null;

  const tags = await fsnTags(candidates.map((c) => c.code));
  const exactCodes = new Set(exact.map((c) => c.code));
  const ranked = candidates
    .map((c) => {
      const cTok = scoreTokens(c.name);
      const conceptCovered = cover(cTok, pSet);   // is the concept explained by the phrase?
      const phraseCovered = cover(pTokens, new Set(cTok)); // how much of the phrase it captures
      return { c, conceptCovered, phraseCovered, exact: exactCodes.has(c.code), disorder: DISORDER_TAGS.has(tags.get(c.code)) };
    })
    // The concept must be almost entirely supported by the note (don't add unstated specifics),
    // and must capture the main clinical terms of the phrase.
    .filter((r) => r.conceptCovered >= 0.85 && r.phraseCovered >= 0.5)
    .sort((a, b) => Number(b.exact) - Number(a.exact)
      || b.phraseCovered - a.phraseCovered
      || b.conceptCovered - a.conceptCovered
      || Number(b.disorder) - Number(a.disorder)
      || a.c.name.length - b.c.name.length);

  for (const { c } of ranked.slice(0, 10)) {
    const map = await snomedToIcd10cm(c.code); // eslint-disable-line no-await-in-loop
    if (map.primary && map.primary.billable) {
      return { icd: map.primary.icd, description: map.primary.description, snomedCode: c.code,
        snomedTerm: c.name, contextDependent: !!map.primary.contextDependent };
    }
  }
  return null;
}

/**
 * DETERMINISTIC Evaluation & Management (visit charge) prediction.
 * The care SETTING + note type set the CPT family; the LEVEL is chosen from the documented total time
 * using the current CMS time thresholds, else an MDM proxy (problem count + acuity), flagged for the
 * coder. Setting matters: a Skilled/Nursing Facility (POS 31/32) bills 99304-99310; a home or residence
 * — which includes Assisted Living (POS 13), domiciliary/rest home (POS 33), and the patient's home
 * (POS 12) — bills the home-or-residence family 99341-99350 (2023 revision; 99343 was deleted).
 */
const EM_FAMILIES = {
  nf: {
    hp: { kind: 'initial', codes: ['99304', '99305', '99306'], times: [25, 35, 45], label: 'Initial nursing facility care' },
    soap: { kind: 'subsequent', codes: ['99307', '99308', '99309', '99310'], times: [10, 15, 30, 45], label: 'Subsequent nursing facility care' },
    progress: { kind: 'subsequent', codes: ['99307', '99308', '99309', '99310'], times: [10, 15, 30, 45], label: 'Subsequent nursing facility care' },
    // Acute-change and hospice-attending visits are both reported as SUBSEQUENT nursing-facility care.
    acuteChange: { kind: 'subsequent', codes: ['99307', '99308', '99309', '99310'], times: [10, 15, 30, 45], label: 'Subsequent nursing facility care' },
    hospice: { kind: 'subsequent', codes: ['99307', '99308', '99309', '99310'], times: [10, 15, 30, 45], label: 'Subsequent nursing facility care' },
    discharge: { kind: 'discharge', codes: ['99315', '99316'], times: [0, 31], label: 'Nursing facility discharge day management' },
  },
  home: {
    hp: { kind: 'home-new', codes: ['99341', '99342', '99344', '99345'], times: [15, 30, 60, 75], label: 'Home or residence visit, new patient' },
    soap: { kind: 'home-est', codes: ['99347', '99348', '99349', '99350'], times: [20, 30, 40, 60], label: 'Home or residence visit, established patient' },
    progress: { kind: 'home-est', codes: ['99347', '99348', '99349', '99350'], times: [20, 30, 40, 60], label: 'Home or residence visit, established patient' },
    acuteChange: { kind: 'home-est', codes: ['99347', '99348', '99349', '99350'], times: [20, 30, 40, 60], label: 'Home or residence visit, established patient' },
    hospice: { kind: 'home-est', codes: ['99347', '99348', '99349', '99350'], times: [20, 30, 40, 60], label: 'Home or residence visit, established patient' },
    discharge: { kind: 'home-est', codes: ['99347', '99348', '99349', '99350'], times: [20, 30, 40, 60], label: 'Home or residence visit, established patient' },
  },
  // NOTE: 'acp' (Advance Care Planning, 99497/98 — time-based) and 'telehealth' (an attestation addendum)
  // are deliberately ABSENT — they are NOT standalone E/M visits, so no E/M code is auto-suggested for
  // them (no silent fallback to a subsequent-visit code); their coding is assigned separately.
};
// Care setting → 'nf' (Skilled/Nursing Facility) or 'home' (home / assisted living / domiciliary). The
// AUTHORITATIVE source is the facility's Place of Service (passed in); text detection is the fallback.
// Default is 'nf' (the primary SNF use case); explicit home/residence signals switch to 'home'.
function detectSetting(content = {}, posHint) {
  const pos = String(posHint || '').trim();
  if (['31', '32'].includes(pos)) return 'nf';
  if (['12', '13', '14', '33'].includes(pos)) return 'home';
  if (posHint === 'nf' || posHint === 'home') return posHint;
  const t = Object.values(content).filter((v) => typeof v === 'string').join('  ').toLowerCase();
  if (/\b(skilled nursing|nursing facility|nursing home|\bsnf\b|long[\s-]?term care facility)\b/.test(t)) return 'nf';
  if (/\b(assisted living|\balf\b|memory care|residential care|domiciliary|rest home|group home|board and care|adult family home)\b/.test(t)
      || /(visit\s+(was\s+)?(done|conducted|performed|seen)[^.]{0,30}\b(at|in)\s+(the\s+)?(patient'?s?\s+)?home|home visit|seen at home)/.test(t)) return 'home';
  return 'nf';
}
function pickFamily(setting, noteType) {
  const bySetting = EM_FAMILIES[setting] || EM_FAMILIES.nf;
  // No fallback: a note type with no E/M family (acp / telehealth) returns null so NO E/M code is invented.
  return bySetting[noteType] || null;
}
function documentedMinutes(content = {}) {
  const text = Object.values(content).filter((v) => typeof v === 'string').join('  ');
  // "35 minutes", "total time 40 min", "spent 30 minutes" — take the largest plausible value.
  const nums = [...text.matchAll(/(\d{1,3})\s*(?:minutes|minute|mins|min)\b/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 300);
  return nums.length ? Math.max(...nums) : null;
}
/**
 * MDM-proxy E/M level when no total time is documented, per the current AMA/CMS "Number & Complexity
 * of Problems Addressed" element. Returns { idx, basis } into the note's CPT family. Acuity of THIS
 * visit — not raw problem count — drives the level, and the default is compliance-safe (low):
 *   • SUBSEQUENT NF (99307/08/09/10): stable chronic care → 99308 (low); documented acuity
 *     (exacerbation/progression, acute systemic illness, new/undiagnosed problem, hospital transfer)
 *     → 99309 (moderate); documented instability / threat to life → 99310 (high).
 *   • INITIAL NF (99304/05/06): comprehensive by nature → 99305 (moderate) default; acuity → 99306.
 * Acuity signals are matched against the assessment / plan / subjective text so a stable maintenance
 * note is not pushed up by an incidental word. The coder confirms and can raise the level.
 */
function mdmProxyLevel(content = {}, problemCount = 0, fam) {
  // Clinical reasoning for THIS visit lives in assessment/plan/subjective — scope acuity detection there
  // (avoids historical narrative in the HPI inflating the level).
  const acuityText = [content.assessment, content.plan, content.subjective, content.objective, content.mdm,
    content.chiefComplaint].filter((v) => typeof v === 'string').join('  ').toLowerCase();
  // HIGH is reserved for genuine instability / threat to life — NOT a documented-but-managed acute
  // illness (professional coders level a managed acute respiratory failure at 99309 moderate, not high).
  const highSig = /(threat to life|life.?threaten|hemodynamic instab|septic shock|respiratory arrest|cardiac arrest|status epilepticus|code (blue|status)|rapid response|icu transfer|impending (respiratory|cardiac|arrest|herniation)|actively dying|comfort care transition)/.test(acuityText);
  const modSig = /(exacerbat|decompensat|worsening|progress(ion|ing)|acute (respiratory|hypoxic|hypercapnic|kidney|renal) (injury|failure)|\baki\b|\bsepsis\b|septic\b|newly diagnosed|new onset|new (problem|diagnosis)|poorly controlled|uncontrolled|acutely|admitted to (the )?hospital|transferr?ed to (the )?(hospital|er|emergency)|sent to (the )?(er|emergency|hospital)|acute (illness|complicated))/.test(acuityText);
  const setLabel = fam.label;
  // Initial / new-patient visits are comprehensive by nature → default MODERATE, escalate to high on acuity.
  if (fam.kind === 'initial') { // NF initial: 99304/05/06 (3 codes)
    const idx = highSig ? 2 : (problemCount <= 1 && !modSig) ? 0 : 1;
    return { idx, basis: `MDM proxy — ${highSig ? 'high acuity' : (problemCount <= 1 && !modSig) ? 'straightforward/low' : 'moderate'} (${setLabel}) — coder confirms` };
  }
  if (fam.kind === 'home-new') { // Home new patient: 99341/42/44/45 (4 codes, 99343 deleted)
    const idx = highSig ? 3 : (problemCount <= 1 && !modSig) ? 1 : 2;
    return { idx, basis: `MDM proxy — ${highSig ? 'high acuity' : (problemCount <= 1 && !modSig) ? 'low' : 'moderate'} (${setLabel}) — coder confirms` };
  }
  // Subsequent NF / established home: floor at LOW for stable chronic care; escalate on documented acuity.
  if (highSig) return { idx: 3, basis: `MDM proxy — documented instability / threat to life (high, ${setLabel}) — coder confirms` };
  if (modSig) return { idx: 2, basis: `MDM proxy — documented acuity/active problem (moderate, ${problemCount} problems, ${setLabel}) — coder confirms` };
  return { idx: 1, basis: `MDM proxy — ${problemCount} stable chronic problem${problemCount === 1 ? '' : 's'}, no acuity documented (low, ${setLabel}) — coder confirms` };
}

export function predictEM(content = {}, noteType = 'hp', problemCount = 0, posHint) {
  // Advance Care Planning is its OWN time-based service — CPT 99497 (first 30 min, face-to-face) plus
  // +99498 for each additional 30 min — NOT a subsequent-visit E/M. Per CMS: 99497 is reportable once
  // ≥16 min of ACP counseling is documented (midpoint of the first 30), and each 99498 once the next
  // block passes its midpoint (≥46, ≥76 …). Reported alone or alongside a same-day E/M.
  if (noteType === 'acp') {
    const minutes = documentedMinutes(content);
    if (minutes == null) return { cpt: null, description: 'Advance care planning', units: 1, modifiers: '', basis: 'ACP face-to-face time not documented — enter minutes to code 99497 (+99498 per additional 30 min)', confirm: true, addOn: null };
    if (minutes < 16) return { cpt: null, description: 'Advance care planning', units: 1, modifiers: '', basis: `Only ${minutes} min documented — ACP 99497 requires ≥16 min face-to-face`, confirm: true, addOn: null };
    const addl = minutes >= 46 ? Math.floor((minutes - 46) / 30) + 1 : 0;
    return { cpt: '99497', description: 'Advance care planning, first 30 minutes', units: 1, modifiers: '', basis: `documented time ${minutes} min`, confirm: false, addOn: addl > 0 ? { cpt: '99498', units: addl, description: 'Advance care planning, each additional 30 minutes' } : null };
  }
  const setting = detectSetting(content, posHint);
  const fam = pickFamily(setting, noteType);
  // Note types with no E/M family (telehealth attestation) get NO auto E/M code — a telehealth note is an
  // addendum to a visit (POS 02/10 + modifier 95), not a standalone charge. Return an explicit "no charge".
  if (!fam) return { cpt: null, description: null, units: 1, modifiers: '', basis: 'No standalone E/M for this note type — coding assigned separately (e.g. telehealth is an addendum)', confirm: true, addOn: null };
  const minutes = documentedMinutes(content);
  let idx = 0; let basis; let confirm = false;
  if (fam.kind === 'discharge') {
    idx = (minutes != null && minutes > 30) ? 1 : 0;
    basis = minutes != null ? `documented time ${minutes} min` : 'default (30 min or less)';
    confirm = minutes == null;
  } else if (minutes != null) {
    for (let i = 0; i < fam.times.length; i += 1) if (minutes >= fam.times[i]) idx = i;
    basis = `documented time ${minutes} min`;
  } else {
    // No documented time → MDM proxy per the current AMA/CMS "Number & Complexity of Problems Addressed"
    // table. The discriminator is the ACUITY of THIS visit, not raw problem count: a monthly SNF visit
    // for multiple STABLE chronic illnesses is LOW (professional coders level these at 99308, POS 32),
    // and we escalate to MODERATE only when the note documents current acuity (exacerbation / progression,
    // an acute systemic illness, a new/undiagnosed problem, or a hospital transfer), and to HIGH for
    // documented instability or a threat to life. Under-coding is the compliance-safe direction — over-
    // coding E/M is the #1 audit risk — and the coder confirms and can raise the level when supported.
    const em = mdmProxyLevel(content, problemCount, fam);
    idx = em.idx; basis = em.basis; confirm = true;
  }
  // Hospice ATTENDING visit → modifier GV (attending physician, not employed by the hospice, care
  // related to the terminal condition). Coder confirms GV vs GW (services unrelated to the terminal dx).
  const modifiers = noteType === 'hospice' ? 'GV' : '';
  return { cpt: fam.codes[idx], description: fam.label, units: 1, modifiers, basis, confirm: confirm || noteType === 'hospice', addOn: null };
}

/**
 * FULL deterministic coding prediction for a note → { diagnoses, procedures, modifiers, unmatched }.
 * Stage 1 diagnoses (billable ICD-10-CM) + Stage 2 visit charge (E/M). Modifiers stay conservative:
 * an E/M alone needs none, so they are left to the live claim-scrub, which flags modifier 25 etc.
 * Everything is a SUGGESTION the coder confirms before the note is signed.
 */
export async function predictEncounterCoding(content = {}, { noteType = 'hp', pos } = {}) {
  const { diagnoses, unmatched } = await predictDiagnosesFromNote(content, { noteType });
  // `pos` is the facility Place of Service (authoritative when provided); otherwise the setting is
  // detected from the note text so an Assisted-Living / home visit bills the home-or-residence family.
  const em = predictEM(content, noteType, diagnoses.length, pos);
  const procedures = [];
  // Every predicted CPT is VALIDATED against the real cpt_codes dataset and its description is pulled
  // FROM the dataset (dynamic + authoritative — never a standalone hard-coded code/label). A code the
  // rules select that is not in the dataset is surfaced as unmatched, never emitted unvalidated.
  const emit = async (cpt, units, modifiers, basis, confirm, fallbackDesc) => {
    if (!cpt) return;
    const info = await lookupCpt(cpt);
    if (!info) { unmatched.push(`CPT ${cpt} (not found in CPT dataset — verify manually)`); return; }
    procedures.push({ cpt: info.code, description: info.medium || info.short || info.long || fallbackDesc, units, modifiers, basis, confirm });
  };
  await emit(em.cpt, em.units, em.modifiers, em.basis, em.confirm, em.description);
  if (em.addOn) await emit(em.addOn.cpt, em.addOn.units, '', 'ACP — each additional 30 minutes (documented time)', true, em.addOn.description);
  return { diagnoses, procedures, modifiers: [], unmatched };
}

/**
 * Apply ICD-10-CM COMBINATION-CODE conventions + STATUS Z-codes — the linking a professional coder
 * performs (deterministic, guideline-based, billable-validated):
 *  • Diabetes "with" a complication assumes causality (ICD-10 Alphabetic Index): DM + CKD → E11.22,
 *    DM + peripheral angiopathy → E11.51, DM + neuropathy → E11.40 (base DM upgraded).
 *  • Hypertension + CKD → I12.x (I12.0 for ESRD/stage-5, else I12.9), replacing I10.
 *  • Hypertension + heart failure → I11.0.
 *  • Documented status → Z-codes: dialysis → Z99.2, amputation → Z89.5x/6x, long-term insulin/
 *    anticoagulant → Z79.4 / Z79.01.
 */
async function applyLinkage(diagnoses, content) {
  const out = [...diagnoses];
  const text = Object.values(content || {}).filter((v) => typeof v === 'string').join('  ').toLowerCase();
  const hasCode = (re) => out.some((d) => re.test(d.icd));
  const hasText = (re) => re.test(text);
  // Descriptions are sourced from the official ICD-10-CM dataset (icdDescription) so the text is
  // authoritative and never a drifting hard-coded string; the passed description is only a fallback.
  const add = async (icd, description, linkage) => {
    if (out.some((d) => d.icd === icd)) return;
    if (!(await isBillableIcd(icd))) return;
    const official = (await icdDescription(icd)) || description;
    out.push({ icd, description: official, snomedCode: null, snomedTerm: official, primary: false, linkage });
  };
  const upgrade = async (fromRe, icd, description, linkage) => {
    const row = out.find((d) => fromRe.test(d.icd));
    if (row && await isBillableIcd(icd)) {
      row.icd = icd; row.description = (await icdDescription(icd)) || description; row.linkage = linkage; return true;
    }
    return false;
  };

  const hasDM2 = hasCode(/^E11\./);
  const hasCKD = hasCode(/^N18\./);
  const esrd = out.some((d) => d.icd === 'N18.6') || hasText(/\besrd\b|end.?stage renal/);
  const hasPAD = hasCode(/^I70\.|^I73\.9$/) || hasText(/peripheral (arterial|vascular) disease|\bpad\b|peripheral angiopath/);
  const hasHF = hasCode(/^I50\./);

  // Diabetes combination codes (assume the "with" relationship per ICD-10-CM guidelines).
  if (hasDM2 && hasCKD) {
    if (!(await upgrade(/^E11\.9$|^E11\.65$/, 'E11.22', 'Type 2 diabetes mellitus with diabetic chronic kidney disease', 'DM + CKD'))) {
      await add('E11.22', 'Type 2 diabetes mellitus with diabetic chronic kidney disease', 'DM + CKD');
    }
  }
  if (hasDM2 && hasPAD) await add('E11.51', 'Type 2 diabetes mellitus with diabetic peripheral angiopathy without gangrene', 'DM + PAD');
  if (hasDM2 && hasText(/neuropath/)) await add('E11.40', 'Type 2 diabetes mellitus with diabetic neuropathy, unspecified', 'DM + neuropathy');
  if (hasDM2 && hasText(/retinopath/)) await add('E11.319', 'Type 2 diabetes mellitus with unspecified diabetic retinopathy without macular edema', 'DM + retinopathy');

  // Hypertensive chronic kidney disease (combination), then hypertensive heart disease.
  if (out.some((d) => d.icd === 'I10') && hasCKD) {
    await upgrade(/^I10$/, esrd ? 'I12.0' : 'I12.9',
      esrd ? 'Hypertensive chronic kidney disease with stage 5 CKD or end stage renal disease'
        : 'Hypertensive chronic kidney disease with stage 1 through stage 4 CKD, or unspecified CKD', 'HTN + CKD');
  } else if (out.some((d) => d.icd === 'I10') && hasHF
      && hasText(/hypertensive heart|heart (disease|failure) due to hypertension|hypertension.*hypertensive/)) {
    // Unlike HTN+CKD, ICD-10-CM does NOT presume a HTN→heart-failure relationship — it must be stated
    // ("hypertensive heart disease" / "due to hypertension"). Absent that, code I10 and I50.- separately.
    // When combined, I50.- is still reported additionally to specify the heart-failure type.
    await upgrade(/^I10$/, 'I11.0', 'Hypertensive heart disease with heart failure', 'HTN + HF (documented)');
  }

  // ESRD documented → the CKD stage code is N18.6 (coded IN ADDITION to any hypertensive/diabetic combo).
  if (esrd) {
    if (!(await upgrade(/^N18\.(9|[1-5])$/, 'N18.6', 'End stage renal disease', 'ESRD'))) {
      await add('N18.6', 'End stage renal disease', 'ESRD');
    }
  }

  // Status / long-term-use Z-codes from documented status.
  if (hasText(/hemodialysis|dialysis|\bon hd\b/)) await add('Z99.2', 'Dependence on renal dialysis', 'on dialysis');
  if (hasText(/gastrostomy|\bg.?tube\b|\bpeg tube\b|tube feeding/)) await add('Z93.1', 'Gastrostomy status', 'gastrostomy');
  // Long-term insulin: documented long-term use, OR insulin named in a diabetic patient's regimen.
  if (hasText(/long.?term.*insulin|on insulin|insulin dependent/) || (hasDM2 && hasText(/\binsulin\b/))) {
    await add('Z79.4', 'Long term (current) use of insulin', 'insulin');
  }
  if (hasText(/eliquis|apixaban|warfarin|coumadin|xarelto|rivaroxaban|anticoagulant|anticoagulation|blood thinner/)) await add('Z79.01', 'Long term (current) use of anticoagulants', 'anticoagulant');
  // Long-term opioid therapy (scheduled opioid named in the regimen).
  if (hasText(/\b(fentanyl|hydrocodone|oxycodone|oxycontin|morphine|hydromorphone|methadone|tramadol|opioid|opiate)\b/)) {
    await add('Z79.891', 'Long term (current) use of opiate analgesic', 'long-term opioid');
  }
  if (hasText(/below.?the.?knee amputation|below.?knee amputation|\bbka\b/)) {
    const left = hasText(/left (below|bka)|\bl bka\b|left lower|left leg/);
    const right = hasText(/right (below|bka)|\br bka\b|right lower|right leg/);
    await add(left ? 'Z89.512' : right ? 'Z89.511' : 'Z89.519', 'Acquired absence of leg below knee', 's/p amputation');
  } else if (hasText(/above.?the.?knee amputation|above.?knee amputation|\baka\b/)) {
    const left = hasText(/left (above|aka)|left leg/); const right = hasText(/right (above|aka)|right leg/);
    await add(left ? 'Z89.612' : right ? 'Z89.611' : 'Z89.619', 'Acquired absence of leg above knee', 's/p amputation');
  }
  return out;
}

/** Predict billable ICD-10-CM diagnoses for a note → { diagnoses:[...], unmatched:[...] }. */
export async function predictDiagnosesFromNote(content = {}, { noteType = 'hp' } = {}) {
  const items = extractProblemPhrases(content, noteType);
  const diagnoses = [];
  const unmatched = [];
  const usedIcd = new Set();
  // Match every active problem CONCURRENTLY (each is an independent remote SNOMED lookup); then fold the
  // results back IN NOTE ORDER so the primary diagnosis and de-duplication stay deterministic.
  const active = items.filter((i) => !i.negated);
  const matches = await Promise.all(active.map((i) => matchIcdForPhrase(i.text, i.full)));
  for (let k = 0; k < active.length; k += 1) {
    const item = active[k];
    const m = matches[k];
    if (!m) { unmatched.push(item.text); continue; }
    if (usedIcd.has(m.icd)) continue;
    usedIcd.add(m.icd);
    diagnoses.push({ icd: m.icd, description: m.description, snomedCode: m.snomedCode, snomedTerm: m.snomedTerm,
      primary: diagnoses.length === 0, contextDependent: m.contextDependent, sourcePhrase: item.text });
  }
  const linked = await applyLinkage(diagnoses, content);
  return { diagnoses: linked, unmatched };
}
