import { pool } from '../db/pool.js';
import { searchSnomed, snomedToIcd10cm } from './terminologyService.js';

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
  gib: 'gastrointestinal hemorrhage', uti_prophylaxis: 'x',
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
const scoreTokens = (s) => norm(s).split(/\s+/).filter((w) => (w.length >= 2 || /^\d$/.test(w)) && !STOP.has(w));
const searchTokens = (s) => norm(s).split(/\s+/).filter((w) => w.length >= 3 && !FT_UNUSABLE.has(w));

function expandAbbrev(phrase) {
  const words = norm(phrase).split(/\s+/).map((w) => ABBREV[w] || w);
  return words.join(' ');
}

/** Extract candidate diagnosis phrases from the diagnosis-bearing sections. Each list item is one
 *  problem; the condition head is taken (before status/etiology). Negated items are flagged. */
export function extractProblemPhrases(content = {}, noteType = 'hp') {
  const sources = ['assessment', 'dischargeDiagnoses', 'chiefComplaint', 'reasonForVisit'];
  const seen = new Set();
  const items = [];
  for (const key of sources) {
    const raw = content?.[key];
    if (!raw || typeof raw !== 'string') continue;
    const lines = raw.split(/\r?\n+/).flatMap((ln) => ln.split(/(?=\b\d{1,2}[.)]\s)/));
    for (let line of lines) {
      line = line.replace(/^\s*\d{1,2}[.)]\s*/, '').replace(/^\s*[-•*]\s*/, '').trim();
      if (line.length < 3) continue;
      const negated = NEG.test(line);
      // Condition head: cut at the first separator, and at etiology connectors ("due to"/"secondary
      // to"/"from") — but NOT "with" (combination codes like "diabetes WITH CKD" are one concept).
      let head = line.split(/[:;.–—]|,\s|\s-\s/)[0];
      head = head.split(/\b(?:due to|secondary to|related to|from|attributed to)\b/i)[0].trim();
      head = head.replace(STATUS_TAIL, '').replace(/\s+/g, ' ').trim();
      if (head.length < 3) continue;
      const dedupeKey = norm(head);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push({ text: head, negated, section: key });
    }
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

/** Exact-term SNOMED concept for a phrase (case-insensitive), preferring an active clinical concept. */
async function exactConcept(phrase) {
  const [rows] = await pool.query(
    `SELECT d.concept_id AS code, d.term AS name, d.us_preferred AS preferred
       FROM snomed_descriptions d JOIN snomed_concepts c ON c.id = d.concept_id
      WHERE d.active = 1 AND c.active = 1 AND d.term = ?
      ORDER BY d.us_preferred DESC, CHAR_LENGTH(d.term) LIMIT 5`, [norm(phrase)]);
  return rows.map((r) => ({ code: String(r.code), name: r.name, preferred: !!r.preferred }));
}

const DISORDER_TAGS = new Set(['disorder', 'finding', 'situation', 'event']);
const cover = (aTokens, bSet) => (aTokens.length ? aTokens.filter((t) => bSet.has(t)).length / aTokens.length : 0);

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
export async function matchIcdForPhrase(phrase) {
  const expanded = expandAbbrev(phrase);
  const pTokens = scoreTokens(expanded);
  if (!pTokens.length) return null;
  const pSet = new Set(pTokens);

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
 * DETERMINISTIC Evaluation & Management (visit charge) prediction for SNF Part B.
 * The note type sets the CPT family; the LEVEL is chosen from the documented total time using CMS
 * 2023 nursing-facility time thresholds. When no time is documented, the level is estimated from the
 * number of active problems (medical-decision-making proxy) and flagged for the coder to confirm.
 */
const EM_FAMILY = {
  hp: { codes: ['99304', '99305', '99306'], times: [25, 35, 45], label: 'Initial nursing facility care' },
  soap: { codes: ['99307', '99308', '99309', '99310'], times: [10, 15, 30, 45], label: 'Subsequent nursing facility care' },
  progress: { codes: ['99307', '99308', '99309', '99310'], times: [10, 15, 30, 45], label: 'Subsequent nursing facility care' },
  discharge: { codes: ['99315', '99316'], times: [0, 31], label: 'Nursing facility discharge day management' },
};
function documentedMinutes(content = {}) {
  const text = Object.values(content).filter((v) => typeof v === 'string').join('  ');
  // "35 minutes", "total time 40 min", "spent 30 minutes" — take the largest plausible value.
  const nums = [...text.matchAll(/(\d{1,3})\s*(?:minutes|minute|mins|min)\b/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 300);
  return nums.length ? Math.max(...nums) : null;
}
export function predictEM(content = {}, noteType = 'hp', problemCount = 0) {
  const fam = EM_FAMILY[noteType] || EM_FAMILY.soap;
  const minutes = documentedMinutes(content);
  let idx = 0; let basis; let confirm = false;
  if (noteType === 'discharge') {
    idx = (minutes != null && minutes > 30) ? 1 : 0;
    basis = minutes != null ? `documented time ${minutes} min` : 'default (30 min or less)';
    confirm = minutes == null;
  } else if (minutes != null) {
    for (let i = 0; i < fam.times.length; i += 1) if (minutes >= fam.times[i]) idx = i;
    basis = `documented time ${minutes} min`;
  } else {
    const last = fam.codes.length - 1;
    idx = problemCount >= 4 ? last : problemCount >= 2 ? Math.min(last, 1) : 0;
    basis = `medical-decision-making proxy (${problemCount} active problem${problemCount === 1 ? '' : 's'})`;
    confirm = true; // no time documented → coder confirms the level
  }
  return { cpt: fam.codes[idx], description: fam.label, units: 1, modifiers: '', basis, confirm };
}

/**
 * FULL deterministic coding prediction for a note → { diagnoses, procedures, modifiers, unmatched }.
 * Stage 1 diagnoses (billable ICD-10-CM) + Stage 2 visit charge (E/M). Modifiers stay conservative:
 * an E/M alone needs none, so they are left to the live claim-scrub, which flags modifier 25 etc.
 * Everything is a SUGGESTION the coder confirms before the note is signed.
 */
export async function predictEncounterCoding(content = {}, { noteType = 'hp' } = {}) {
  const { diagnoses, unmatched } = await predictDiagnosesFromNote(content, { noteType });
  const em = predictEM(content, noteType, diagnoses.length);
  const procedures = em.cpt ? [{ cpt: em.cpt, description: em.description, units: em.units, modifiers: em.modifiers, basis: em.basis, confirm: em.confirm }] : [];
  return { diagnoses, procedures, modifiers: [], unmatched };
}

/** Predict billable ICD-10-CM diagnoses for a note → { diagnoses:[...], unmatched:[...] }. */
export async function predictDiagnosesFromNote(content = {}, { noteType = 'hp' } = {}) {
  const items = extractProblemPhrases(content, noteType);
  const diagnoses = [];
  const unmatched = [];
  const usedIcd = new Set();
  for (const item of items) {
    if (item.negated) continue;
    const m = await matchIcdForPhrase(item.text); // eslint-disable-line no-await-in-loop
    if (!m) { unmatched.push(item.text); continue; }
    if (usedIcd.has(m.icd)) continue;
    usedIcd.add(m.icd);
    diagnoses.push({ icd: m.icd, description: m.description, snomedCode: m.snomedCode, snomedTerm: m.snomedTerm,
      primary: diagnoses.length === 0, contextDependent: m.contextDependent, sourcePhrase: item.text });
  }
  return { diagnoses, unmatched };
}
