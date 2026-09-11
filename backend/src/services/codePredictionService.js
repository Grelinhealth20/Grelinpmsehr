import { pool } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { searchSnomed, snomedToIcd10cm, snomedToIcd10cmBatch, snomedConceptsForIcd10cm, lookupCpt } from './terminologyService.js';
import { isBillableIcd, icdDescription } from './terminologyCache.js';
import { scrubClaim } from './codingService.js';

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
  dm2: 'type 2 diabetes mellitus', dm1: 'type 1 diabetes mellitus', dmii: 'type 2 diabetes mellitus',
  htn: 'hypertension', ckd: 'chronic kidney disease', esrd: 'end stage renal disease',
  aki: 'acute kidney injury', chf: 'heart failure', copd: 'chronic obstructive pulmonary disease',
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
  chf: 'heart failure', pna: 'pneumonia', afib: 'atrial fibrillation', htn: 'hypertension',
  // Acute cardiac / infection / HF-type abbreviations (single-token; expanded before the SNOMED match).
  stemi: 'st elevation myocardial infarction', nstemi: 'non st elevation myocardial infarction',
  mrsa: 'methicillin resistant staphylococcus aureus', mssa: 'methicillin susceptible staphylococcus aureus',
  hfref: 'heart failure with reduced ejection fraction', hfpef: 'heart failure with preserved ejection fraction',
  djd: 'degenerative joint disease', pud: 'peptic ulcer disease', gout: 'gout', bmi: 'body mass index',
  resp: 'respiratory', dka: 'diabetic ketoacidosis', hha: 'hyperosmolar hyperglycemia',
};
// Whole-PHRASE clinical synonyms — normalize documented wording to the term the SNOMED CT US edition uses,
// so a common provider phrasing resolves to the correct BILLABLE concept (deterministic, not fuzzy). Applied
// after abbreviation expansion, before the SNOMED search. Each maps to a real SNOMED-preferred term.
const PHRASE_SYN = [
  [/\bpressure injur(?:y|ies)\b/g, 'pressure ulcer'],          // NPUAP 2016 rename; ICD/SNOMED keep "pressure ulcer"
  [/\baortic stenosis\b/g, 'aortic valve stenosis'],
  [/\bmitral stenosis\b/g, 'mitral valve stenosis'],
  [/\baortic (?:regurgitation|insufficiency)\b/g, 'aortic valve regurgitation'],
  [/\bmitral (?:regurgitation|insufficiency)\b/g, 'mitral valve regurgitation'],
  [/\brepeated falls?\b/g, 'recurrent falls'],
  // Spelled-out shorthand that omits the trailing noun of the SNOMED-preferred term (the abbreviations
  // GERD/GAD expand WITH it and match, but the prose forms don't). The disease/disorder noun is implied
  // in clinical usage; lookahead avoids double-appending when it is already written.
  [/\bgastro[\s-]?esophageal reflux\b(?!\s+disease)/g, 'gastroesophageal reflux disease'],
  [/\bgeneralized anxiety\b(?!\s+disorder)/g, 'generalized anxiety disorder'],
  [/\blewy body dementia\b/g, 'dementia with lewy bodies'],
  [/\bckd\s?([1-5])\b/g, 'chronic kidney disease stage $1'],   // "CKD3" / "CKD 4" → staged
  [/\besrd\b/g, 'end stage renal disease'],
  // "end stage heart failure" (from CHF→heart failure) mis-scored to a CONGENITAL heart concept (Q24.9);
  // normalize to "congestive heart failure" → I50.9 (coder refines to I50.84). Runs AFTER the chf abbrev.
  [/\bend[\s-]?stage heart failure\b/g, 'congestive heart failure'],
];
// Negation / uncertainty cues — a problem carrying these is NOT coded as an active diagnosis.
// (Status words like "resolving/stable/improving" are NOT negation — those conditions are still active.)
// NOTE: "without" is deliberately NOT a negation cue — in ICD documentation it is a SPECIFIER
// ("spinal stenosis without neurogenic claudication", "diabetes without complication", "concussion
// without loss of consciousness") that identifies a POSITIVE, more-specific diagnosis. True negation is
// written "no / denies / negative for / no evidence of". Treating "without" as negation dropped valid,
// billable diagnoses.
const NEG = /\b(no|not|denies|denied|negative for|r\/o|rule out|ruled out|no evidence of|absence of|free of|unlikely|possible|probable|questionable|differential|history of|h\/o|hx of|status post|s\/p)\b/i;
// Status/qualifier words trimmed from the tail so the condition phrase matches SNOMED cleanly.
// Trailing clinical-status words that describe the COURSE of a problem, not its identity — stripped so
// the base condition matches ("Heart failure improved" → "Heart failure"). NOTE: code-changing modifiers
// (acute / chronic / "with exacerbation") are deliberately NOT here — they alter the ICD and must survive.
const STATUS_TAIL = /\b(stable|improving|improved|worsening|worsened|deteriorating|resolving|resolved|unchanged|unresolved|controlled|uncontrolled|well controlled|poorly controlled|ongoing|at goal|at baseline|baseline|new|old|likely|suspected)\b/gi;
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
  for (const [re, rep] of PHRASE_SYN) out = out.replace(re, rep); // normalize to SNOMED-preferred wording
  // "Type 2 diabetes" / bare "diabetes" is the common shorthand for "diabetes mellitus" — add the implied
  // word so the SNOMED coverage rule matches the concept (without it, "type 2 diabetes" fails to match
  // "Type 2 diabetes mellitus"). Not for "diabetes insipidus" (a different disease).
  if (/\bdiabetes\b/.test(out) && !/\b(mellitus|insipidus)\b/.test(out)) out = out.replace(/\bdiabetes\b/, 'diabetes mellitus');
  return out;
}

/**
 * Split a comma/"and" diagnosis LIST into individual problems so EVERY diagnosis is coded (multi-ICD),
 * not just the first. Only lines that contain a comma are treated as a list (so a comma-free combination
 * like "diabetes with CKD" or a single combined code like "nausea and vomiting" is left intact). A
 * combination connector ("with"/"due to"/"secondary to") is preserved WITHIN each fragment.
 */
// ICD-description continuation vocabulary: a comma that introduces one of these is INTERNAL to a single
// diagnosis's official description ("Intervertebral disc disorders with radiculopathy, LUMBAR region",
// "Unilateral primary osteoarthritis, RIGHT knee", "Type 2 diabetes mellitus, WITHOUT complications") —
// NOT a list separator. A semicolon ALWAYS separates list items; a comma separates items ONLY when it is
// not followed by one of these site/laterality/episode/severity modifiers. Prevents over-splitting a
// pasted ICD description into a spurious fragment (which mis-coded to an unspecified code and dropped the
// real code when two fragments' site tails collided).
// Does the text IMMEDIATELY after a comma CONTINUE the preceding diagnosis (so the comma is intra-
// diagnosis, not a list boundary)? Anchored to the START of `rest` — a qualifier appearing LATER in the
// line must never suppress an earlier list comma (the bug that collapsed "anemia, HTN, CKD stage 3" into
// one phrase because "stage" appeared at the end). A GRADED qualifier ("stage 3", "type 2", "grade IV")
// continues the previous item ONLY when it is that item's trailing qualifier (nothing follows before the
// next separator); when a condition word follows ("stage 3 sacral ulcer", "type 2 diabetes") it is a NEW
// standalone item and the comma IS a boundary. Laterality/site words continue unless a condition noun
// follows them (so "…, right knee" stays but "…, right-sided heart failure" splits).
function commaContinuesDx(rest) {
  const r = String(rest || '').replace(/^(?:and\s+|&\s+)/i, '');
  if (/^(?:stage|type|grade|class|level|phase|category)\s*\w+\s*(?:[,;.)]|$)/i.test(r)) return true; // trailing graded qualifier
  if (/^(?:right|left|bilateral|unspecified|site|region|part|upper|lower|proximal|distal|initial|subsequent|sequela|episode|encounter|other|specified|nec|nos)\b/i.test(r)
    && !/\b(?:disease|injury|failure|ulcer|infection|fracture|pain|deficiency|disorder|syndrome|insufficiency|dementia)\b/i.test(r.split(/[,;]/)[0])) return true; // trailing site/laterality
  if (/^(?:in\s+remission|intractable|not\s+intractable|resolved|resolving|inactive|stable|improving|improved|worsening|worsened|unchanged|unresolved|ongoing|active|well[\s-]?controlled|poorly[\s-]?controlled|at\s+baseline|new\s+onset|unstageable|unstaged|deep\s+tissue)\b/i.test(r)) return true; // trailing status word
  return false;
}
function splitListLine(line) {
  const s = String(line || '');
  if (!/[,;]/.test(s)) return [s]; // not a list — keep combinations & combined codes whole
  // Semicolons always split; commas split only when NOT followed by an ICD-description continuation word
  // (so "condition, site (CODE)" stays one diagnosis while "dx1 (C1), dx2 (C2)" still splits into two).
  const parts = [];
  let buf = '';
  const re = /([;,])(\s*)/g; let last = 0; let m;
  while ((m = re.exec(s)) !== null) {
    const sep = m[1];
    const rest = s.slice(re.lastIndex);
    if (sep === ',' && commaContinuesDx(rest)) continue; // intra-description comma (anchored: later qualifier can't suppress an earlier list comma)
    buf += s.slice(last, m.index);
    parts.push(buf);
    buf = '';
    last = re.lastIndex;
  }
  buf += s.slice(last);
  parts.push(buf);
  return parts.map((x) => x.replace(/^(?:and\s+|&\s+)/i, '').trim()).filter((x) => x.length >= 3);
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
  // Cut at the first separator — but a period only counts as a boundary when it ENDS a sentence
  // (followed by whitespace or end), NEVER the decimal inside an ICD code (M54.17) or a value (5.5),
  // which previously truncated "...(M54.17)" to "...(M54" and killed the match.
  // Cut at hard separators (colon/semicolon/dash/sentence-period) first. A COMMA is a boundary ONLY when
  // what follows is NOT a code-changing continuation — so "Pressure ulcer of sacral region, stage 3",
  // "Chronic kidney disease, stage 4", and "Osteoarthritis, right knee" keep the site/stage/laterality in
  // the head for the SNOMED match (these DETERMINE the billable ICD), while trailing narrative after a
  // non-modifier comma ("CHF, admitted for diuresis") is still dropped.
  // Strip a leading SECTION-LABEL prefix ("A/P:", "Assessment:", "Plan:", "Impression:", "Dx:") so the
  // colon that follows it does not truncate the first diagnosis ("A/P: DM2 …" must code DM2, not "A/P").
  line = line.replace(/^\s*(?:a\s*\/?\s*p|assessment(?:\s+and\s+plan)?|plan|impression|dx|diagnos[ei]s|problems?(?:\s+list)?|active problems?|medical problems?)\s*[:.\-–)]\s*/i, '');
  let head = line.split(/[:;–—]|\s-\s|\.(?=\s|$)/)[0];
  {
    const re = /,\s/g; let m; let cut = -1;
    while ((m = re.exec(head)) !== null) {
      const rest = head.slice(re.lastIndex);
      if (!commaContinuesDx(rest)) { cut = m.index; break; } // non-continuation comma → real boundary (anchored)
    }
    if (cut >= 0) head = head.slice(0, cut);
  }
  head = head.split(/\b(?:due to|secondary to|related to|from|attributed to)\b/i)[0].trim();
  // Capture ANY explicit ICD-10-CM code the provider wrote on the line (with or without parens/label),
  // e.g. "Lumbar radiculopathy (M54.17)", "Heart failure improved I50.23". The provider's own code is
  // authoritative — carried through so predictDiagnosesFromNote can trust it directly (after validating
  // it against the billable dataset) rather than relying solely on the phrase→SNOMED match, which can
  // miss when a status word ("improved") or unusual phrasing derails the text search.
  const explicitIcdMatch = line.match(/\b([A-TV-Z]\d[A-Z0-9](?:\.[A-Z0-9]{1,4})?)\b/i);
  const explicitIcd = explicitIcdMatch ? explicitIcdMatch[1].toUpperCase() : null;
  // Drop a trailing inline ICD-10 annotation the provider wrote — "Lumbar radiculopathy (M54.17)" →
  // "Lumbar radiculopathy" — so the code text doesn't derail the SNOMED/description match. (The code is
  // still surfaced elsewhere; here we only clean the phrase used for matching.)
  head = head.replace(/\s*\((?:icd[- ]?10)?\s*[A-TV-Z]\d[A-Z0-9]{0,2}(?:\.[A-Z0-9]{1,4})?\)\s*$/i, '').trim();
  // Strip the generic "uncomplicated" specifier tail ("without complication(s)" / "without (acute)
  // exacerbation" / "uncomplicated") — it denotes the BASE/unspecified code (diabetes without
  // complication → E11.9, COPD without exacerbation → J44.9) and, left in, it derails the SNOMED
  // search toward complication concepts. NOTE: a SPECIFIC "without X" that changes the ICD code (e.g.
  // "spinal stenosis without neurogenic claudication" → M48.061) is NOT stripped — only these generic
  // uncomplicated markers are.
  head = head.replace(/\s+without\s+(acute\s+)?(complications?|exacerbation)\b.*$/i, '')
    .replace(/\buncomplicated\b/i, '').trim();
  head = head.replace(STATUS_TAIL, '').replace(/\s+/g, ' ').trim();
  if (head.length < 3) return null;
  return { text: head, full: line, negated, explicitIcd };
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

/**
 * Note content is persisted as `{ sections: { key: text }, checks, vitals, prescriptions, ... }`, but the
 * predictor's extractors read FLAT top-level keys (assessment / hpi / procedures / …). Surface the section
 * text at the top level so prediction works on real stored notes. Without this, every real record yielded
 * ZERO diagnoses (→ no medical-necessity linkage → coding denials). Idempotent; a note already flat is
 * returned unchanged. Reserved keys (checks/vitals/prescriptions/…) are preserved.
 */
export function withFlatSections(content = {}) {
  if (!content || typeof content !== 'object' || !content.sections || typeof content.sections !== 'object') return content || {};
  return { ...content, ...content.sections };
}

/** Extract candidate diagnosis phrases from the diagnosis-bearing sections. Each list item is one
 *  problem; the condition head is taken (before status/etiology). Negated items are flagged. */
export function extractProblemPhrases(rawContent = {}, noteType = 'hp') {
  const content = withFlatSections(rawContent);
  // Diagnosis-bearing sections across ALL service lines: SNF (assessment/…), Pain (pnDiagnoses),
  // PI (piDiagnoses/piComplaints). PLUS any section key that names diagnoses (…Diagnoses/…Diagnosis)
  // so a new template's diagnosis section is picked up automatically — dynamic, not hard-coded per type.
  const explicit = ['assessment', 'dischargeDiagnoses', 'chiefComplaint', 'reasonForVisit',
    'pnDiagnoses', 'piDiagnoses', 'piComplaints'];
  const sources = [...new Set([...explicit, ...Object.keys(content).filter((k) => /diagnos[ei]s$/i.test(k))])];
  const seen = new Set();
  const items = [];
  const push = (parsed, section) => {
    if (!parsed) return;
    // Dedupe on the condition head PLUS the provider's explicit code: two problems that share a head but
    // carry DIFFERENT codes are DIFFERENT diagnoses and must both survive — e.g. "Osteoarthritis, right
    // knee (M17.11)" + "left knee (M17.12)", or a single-episode (F32.9) vs recurrent (F33.1) MDD. When
    // the same head repeats with the SAME (or no) code it is a true duplicate and is dropped; any residual
    // same-code duplication is still collapsed later by usedIcd in predictDiagnosesFromNote.
    const dedupeKey = norm(parsed.text) + (parsed.explicitIcd ? `#${parsed.explicitIcd}` : '');
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    // Keep the FULL line alongside the condition head: the head drives the general SNOMED match, while
    // the full line preserves etiology ("pain due to malignancy" → G89.3) the head-truncation drops.
    items.push({ text: parsed.text, full: parsed.full, negated: parsed.negated, explicitIcd: parsed.explicitIcd, section });
  };
  for (const key of sources) {
    const raw = content?.[key];
    if (!raw || typeof raw !== 'string') continue;
    const lines = raw.split(/\r?\n+/)
      // Split a RUN-ON numbered list ("1. Dx one. 2. Dx two.") onto its items — but ONLY at a real item
      // boundary (start of the segment, or right after a sentence period/semicolon), NEVER a qualifier
      // number that is part of the diagnosis and DETERMINES the code ("stage 3", "type 2", "grade 4").
      // "3." in "sacral pressure ulcer, stage 3." is preceded by a letter+space, so it is not a boundary;
      // "2." after "…stage 3. " is preceded by ". ", so it correctly starts the next item.
      // Split before an enumeration marker "N." / "N)" UNLESS the number is a code-changing qualifier value
      // ("stage 3", "type 2", "grade 4"). This handles BOTH run-on lists that use periods ("...HF. 2. DM.")
      // AND space-only lists ("...respiratory failure 2. aspiration pneumonia 3. dysphagia"), while never
      // splitting "stage 3." mid-diagnosis. (A decimal like "9.2" isn't matched — no space after the dot.)
      // ALSO split before a HASH problem-marker "#1"/"#2" — providers write inline problem lists as
      // "#1 HTN #2 CAP #3 CKD". The "#" is unambiguous (never a "stage 3"-style qualifier), so it needs no
      // qualifier lookbehind; without this the whole "#1 … #2 …" line collapses into one unmatched phrase.
      .flatMap((ln) => ln.split(/(?<!(?:stage|type|grade|class|level|phase|category|factor|gcs)\s)(?=\b\d{1,2}[.)]\s)|(?=#\d{1,2}\b)/i))
      // ALSO split an UNNUMBERED multi-sentence problem list ("…insulin use. Chronic constipation. Also
      // COPD.") — providers list problems as separate sentences without numbers, and without this only the
      // first sentence's head survived (parseProblemLine cuts its head at the first ". "), silently dropping
      // the rest. Split only at a sentence period FOLLOWED by a capitalized/#-marked new clause and PRECEDED
      // by a letter or ")" — so a decimal ("5.5"), an ICD code ("M54.16"), or "stage 3." (digit before the
      // dot) is never split. Can only ADD segments (each matched independently) — never fabricates a code.
      .flatMap((ln) => ln.split(/(?<=[A-Za-z)])\.\s+(?=[A-Z#])/))
      .map((s) => s.replace(/^\s*#?\s*\d{1,2}[.)]?\s+/, '').trim()) // strip a leading "1." / "2)" / "#1" / "#2 " list marker
      .filter(Boolean)
      .flatMap(splitListLine);                          // split a comma/"and" diagnosis LIST into items
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
// Non-discriminating anatomical/structural filler words removed from a SNOMED FSN before the
// "concept explained by the phrase" coverage test — so a verbose FSN ("Herniation of nucleus pulposus
// of cervical intervertebral disc") isn't rejected against a concise clinical phrase ("cervical disc
// herniation"). These words never carry the DISTINGUISHING clinical meaning of a diagnosis.
const CONCEPT_FILLER = new Set(['joint', 'region', 'area', 'structure', 'nucleus', 'pulposus',
  'intervertebral', 'co', 'occurrent', 'body', 'part', 'multiple', 'site']);
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
  // Concussion (brain) — bare "concussion" is ambiguous in SNOMED (tooth/cataract/cornea rank first),
  // so map the head-injury sense explicitly, EXCLUDING the dental/ocular senses. Default S06.0X0A
  // (without loss of consciousness, initial encounter); documented LOC/encounter refine it. The 7th
  // character defaults to initial (A) and is flagged for the coder to confirm.
  if (/\bconcussion\b/.test(t) && !/(tooth|dental|cataract|cornea|ocular|eye|tympan|ear)/.test(t)) {
    const enc = /\bsequela|late effect\b/.test(t) ? 'S' : /\b(subsequent|follow.?up|healing)\b/.test(t) ? 'D' : 'A';
    if (/\bloss of consciousness\b|\bloc\b/.test(t) && !/(without|no loss|denies)/.test(t)) return { icd: `S06.0X9${enc}`, description: 'Concussion with loss of consciousness of unspecified duration' };
    return { icd: `S06.0X0${enc}`, description: 'Concussion without loss of consciousness' };
  }
  // Post-traumatic headache — a specific G44.3 category, not the generic R51 headache. Intractable vs
  // not, acute vs chronic per the documentation.
  if (/post.?traumatic headache|post.?concussi\w* headache/.test(t)) {
    const intractable = /\bintractable\b/.test(t);
    if (/\bacute\b/.test(t)) return { icd: intractable ? 'G44.311' : 'G44.319', description: 'Acute post-traumatic headache' };
    if (/\bchronic\b/.test(t)) return { icd: intractable ? 'G44.321' : 'G44.329', description: 'Chronic post-traumatic headache' };
    return { icd: intractable ? 'G44.301' : 'G44.309', description: 'Post-traumatic headache, unspecified' };
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
  let result = await resolveIcdForPhrase(phrase, expanded, pTokens, fullLine);
  // PARENTHETICAL FALLBACK. Providers append a parenthetical qualifier constantly ("Systolic heart
  // failure (HFrEF)", "COPD (emphysema)", "Type 2 DM (poorly controlled)"). When that parenthetical
  // does not itself resolve, the whole phrase would otherwise drop to unmatched. Retry WITHOUT losing
  // information: first FOLD the parenthetical inline (preserves "(stage 3)"/"(left)"/severity), then —
  // only if still unresolved — DROP it entirely. This can only convert unmatched→matched; it never
  // overrides or degrades a match the full phrase already produced.
  // QUALIFIER-NOISE RECOVERY. When the base phrase does not resolve, retry with progressively more of the
  // NON-diagnostic qualifier noise removed — parenthetical, then spinal-level designators (L5-S1, C5-C6),
  // then standalone laterality. Ordered MOST-PRESERVING first so specificity is kept when possible (e.g.
  // "Lumbar radiculopathy L5-S1, left" fails whole but resolves to M54.16 once the level token is dropped,
  // keeping laterality). Deterministic (pure ordered regex transforms) and strictly ADDITIVE — it fires
  // ONLY on an otherwise-unmatched phrase, so it can only convert unmatched→matched (prevents silent data
  // loss of a documented diagnosis) and never overrides or degrades a match the full phrase produced.
  if (!result) {
    // spinal level like L5-S1 / C5 / T12 / L4-L5 — but NOT "T2DM"/"L2" glued to letters (negative lookahead)
    const SPINE = /\b[CTLS]\d{1,2}(?:\s*[-/]\s*[CTLS]?\d{1,2})?(?![A-Za-z0-9])/gi;
    const LAT = /\b(?:left|right|bilateral|lt|rt|b\/l)\b/gi;
    const clean = (s) => s.replace(/\s*,\s*(?=,|$)/g, '').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
    const alts = [];
    if (/\([^)]*\)/.test(phrase)) {
      alts.push(clean(phrase.replace(/[()]/g, ' ')));            // fold parenthetical inline (keep "(stage 3)")
      alts.push(clean(phrase.replace(/\s*\([^)]*\)/g, ' ')));    // drop the parenthetical entirely
    }
    alts.push(clean(phrase.replace(SPINE, ' ')));                // drop spinal-level noise, KEEP laterality
    alts.push(clean(phrase.replace(SPINE, ' ').replace(LAT, ' '))); // last resort: drop level AND laterality
    const tried = new Set([norm(phrase)]);
    for (const alt of alts) {
      const na = norm(alt);
      if (!alt || tried.has(na)) continue; tried.add(na);
      const altExp = expandAbbrev(alt);
      const altTok = scoreTokens(altExp);
      if (!altTok.length) continue;
      result = await resolveIcdForPhrase(alt, altExp, altTok, fullLine || phrase);
      if (result) break;
    }
  }
  if (PHRASE_MEMO.size >= PHRASE_MEMO_MAX) PHRASE_MEMO.delete(PHRASE_MEMO.keys().next().value);
  PHRASE_MEMO.set(memoKey, result);
  return result;
}

/**
 * 7TH-CHARACTER BILLABILITY UPGRADE. Injury / external-cause / some musculoskeletal ICD-10-CM codes
 * (chapters S, T, and select M/O) are NOT billable at the base — they require a 7th character for the
 * encounter (A = initial, D = subsequent, S = sequela). The SNOMED→ICD map returns the base (e.g.
 * S13.4 "Sprain of cervical spine"), which fails the billable check and is dropped — the #1 accuracy
 * gap for Personal-Injury / MVA and Pain practices. This resolves the SAME code to its billable leaf
 * by ADDING the encounter character (never inventing clinical specificity): among the code's billable
 * descendants that differ only by the 7th character, it picks the LEAST-specific / placeholder-padded
 * one (most 'X', then unspecified). The encounter character is read from the note ("initial"/
 * "subsequent"/"sequela"/"healing"), defaulting to A (initial) — the coder confirms. Fully data-driven
 * against icd10cm_valid (no hard-coded code lists).
 */
async function upgradeToBillableSeventh(icd, contextText) {
  // The SNOMED→ICD map marks a missing 7th character with a trailing '?' ("episode of care information
  // needed") and pads positions 5-6 with 'X' placeholders (e.g. S16.1XX?). Strip the '?' and trailing
  // X placeholders to recover the injury BASE, then resolve to the real billable leaf below.
  const dotless = String(icd || '').replace(/\./g, '').toUpperCase().replace(/[?X]+$/, '');
  if (dotless.length < 3 || dotless.length >= 7) return null; // already a full 7-char code, or too short
  const dottedPrefix = dotless.length > 3 ? `${dotless.slice(0, 3)}.${dotless.slice(3)}` : dotless;
  const [kids] = await pool.query('SELECT code FROM icd10cm_valid WHERE code LIKE ? ORDER BY code', [`${dottedPrefix}%`]);
  if (!kids.length) return null;
  const t = String(contextText || '').toLowerCase();
  const seventh = /\bsequela|late effect\b/.test(t) ? 'S'
    : /\b(subsequent|follow.?up|routine healing|healing|aftercare|recovery)\b/.test(t) ? 'D' : 'A';
  // Only children that are full 7-character codes ending in the desired encounter character AND that
  // share this exact base (so we add the encounter char to THIS injury, not a sibling injury).
  const cands = kids.map((r) => r.code.toUpperCase())
    .filter((c) => c.replace('.', '').length === 7 && c.endsWith(seventh) && c.replace('.', '').startsWith(dotless));
  if (!cands.length) return null;
  // Prefer the least-specific leaf: most 'X' placeholders in chars 4-6, then unspecified (higher digit).
  const xCount = (c) => { let n = 0; for (const ch of c.replace('.', '').slice(3, 6)) if (ch === 'X') n += 1; return n; };
  cands.sort((a, b) => xCount(b) - xCount(a) || b.localeCompare(a));
  return { icd: cands[0], seventh };
}

// DOCUMENTED-SPECIFICITY UPGRADE. The SNOMED match sometimes lands on a GENERIC concept whose ICD map is
// the "site/qualifier unspecified" leaf even though the note documents the specific axis — e.g. "lumbar
// spondylosis" → M47.819 (site unspecified) when "lumbar" is documented (→ M47.816), or "acute respiratory
// failure WITH HYPOXIA" → J96.00 (→ J96.01). This upgrades ONLY an unspecified leaf to the sibling billable
// leaf whose OFFICIAL DESCRIPTION contains the DOCUMENTED axis — fully data-driven against icd10cm_valid
// (no hard-coded digit maps), scoped to dorsopathies (region axis) and respiratory failure (hypoxia/
// hypercapnia axis), and only when EXACTLY ONE sibling matches. It can only raise specificity to a value
// the provider actually documented; it never invents specificity and never overrides a specific code.
async function upgradeToDocumentedSpecificity(icd, text) {
  const code = String(icd || '').toUpperCase();
  if (!/^M(4\d|5[0-4])/.test(code) && !/^J96/.test(code)) return null;
  if (code.replace('.', '').length < 5) return null;      // need a subclassification leaf to have siblings
  const desc = (await icdDescription(code)) || '';
  if (!/unspecified/i.test(desc)) return null;            // only ever upgrade an UNSPECIFIED leaf
  const t = String(text || '').toLowerCase();
  let token = null;
  if (/^M/.test(code)) {
    token = /\blumbosacral\b/.test(t) ? 'lumbosacral' : /\bthoracolumbar\b/.test(t) ? 'thoracolumbar'
      : /\bcervicothoracic\b/.test(t) ? 'cervicothoracic' : /\blumbar\b/.test(t) ? 'lumbar'
      : /\bcervical\b/.test(t) ? 'cervical' : /\bthoracic\b/.test(t) ? 'thoracic'
      : /\bsacrococcygeal\b/.test(t) ? 'sacrococcygeal' : /\bsacral\b/.test(t) ? 'sacral' : null;
  } else { // J96 respiratory failure
    token = /hypercapni|hypercarbi/.test(t) ? 'hypercapnia' : /hypox/.test(t) ? 'hypoxia' : null;
  }
  if (!token) return null;
  const [kids] = await pool.query('SELECT code, description FROM icd10cm_valid WHERE code LIKE ?', [`${code.slice(0, -1)}%`]);
  const matches = kids.filter((k) => k.code.toUpperCase() !== code && new RegExp(`\\b${token}`, 'i').test(k.description || ''));
  if (matches.length !== 1) return null;                  // require an unambiguous single specific sibling
  return { icd: matches[0].code.toUpperCase(), description: matches[0].description };
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
      const cTokFull = scoreTokens(c.name);
      // For the "is the concept explained by the phrase?" test, ignore non-discriminating anatomical
      // filler words (joint, region, nucleus pulposus, intervertebral, …). A provider writes "cervical
      // disc herniation"; SNOMED's FSN is "Herniation of nucleus pulposus of cervical intervertebral
      // disc" — the extra words are elaboration, not unstated clinical specificity, so they must not
      // cause the (billable, correct) match to be rejected. phraseCovered still uses the FULL token set,
      // so the phrase's own words are always credited.
      const cTokCore = cTokFull.filter((t) => !CONCEPT_FILLER.has(t));
      const conceptCovered = cover(cTokCore.length ? cTokCore : cTokFull, pSet);
      const phraseCovered = cover(pTokens, new Set(cTokFull)); // how much of the phrase it captures
      return { c, conceptCovered, phraseCovered, exact: exactCodes.has(c.code), disorder: DISORDER_TAGS.has(tags.get(c.code)) };
    })
    // The concept must be almost entirely supported by the note (don't add unstated specifics),
    // and must capture the main clinical terms of the phrase. Relaxation: when the provider's ENTIRE
    // phrase is contained in the concept name (phraseCovered = 1.0), a single extra elaborating word is
    // acceptable (conceptCovered ≥ 0.7) — e.g. "cervical facet syndrome" ⊂ "Facet syndrome of cervical
    // spine". This never over-generalizes: a bare phrase against a more-specific concept still scores
    // well under 0.7 on the concept side and is rejected.
    .filter((r) => (r.conceptCovered >= 0.85 || (r.phraseCovered >= 0.999 && r.conceptCovered >= 0.7)) && r.phraseCovered >= 0.5)
    .sort((a, b) => Number(b.exact) - Number(a.exact)
      || b.phraseCovered - a.phraseCovered
      || b.conceptCovered - a.conceptCovered
      || Number(b.disorder) - Number(a.disorder)
      || a.c.name.length - b.c.name.length);

  // Resolve the SNOMED→ICD map for the top candidates CONCURRENTLY (was a sequential await-in-loop of up
  // to 10 remote round-trips per phrase — the dominant latency cost). Fetching them in one parallel batch
  // and then folding IN RANK ORDER preserves the exact same deterministic result (first billable primary
  // in rank order wins; else the best-ranked non-billable becomes the 7th-char-completion base).
  const top = ranked.slice(0, 10);
  // ONE batched map query for all top candidates (was up to 10 sequential/parallel single lookups — the
  // dominant multi-problem real-time cost). Folded back in RANK ORDER → identical deterministic result.
  const mapById = await snomedToIcd10cmBatch(top.map(({ c }) => c.code));
  const maps = top.map(({ c }) => mapById.get(String(c.code)) || { primary: null, candidates: [] });
  let seventhFallback = null; // best non-billable injury/7th-char base seen, to complete if nothing billable
  for (let i = 0; i < top.length; i += 1) {
    const c = top[i].c;
    const map = maps[i];
    if (!map.primary) continue;
    if (map.primary.billable) {
      let icd = map.primary.icd; let description = map.primary.description;
      // Best-effort specificity enrichment: raise an unspecified leaf to the documented axis. Wrapped so a
      // transient DB error NEVER drops the already-validated base code — worst case the base (correct, less
      // specific) code stands. Enrichment only; not a degraded/mock fallback.
      try {
        const spec = await upgradeToDocumentedSpecificity(icd, fullLine || phrase);
        if (spec) { icd = spec.icd; description = spec.description; }
      } catch (e) { logger.warn({ err: e?.message, icd }, 'specificity-upgrade enrichment failed — keeping validated base code'); } // logged, not silent; base code preserved (no data loss)
      return { icd, description, snomedCode: c.code, snomedTerm: c.name, contextDependent: !!map.primary.contextDependent };
    }
    // Remember the FIRST (best-ranked) non-billable mapped code as a 7th-character-completion candidate.
    if (!seventhFallback) seventhFallback = { icd: map.primary.icd, c };
  }
  // No billable primary — if the best candidate is an injury/7th-character code, COMPLETE it (add the
  // encounter character) rather than dropping the diagnosis. This is code COMPLETION of the same code,
  // not a guess: it is flagged contextDependent so the coder confirms the encounter type (A/D/S).
  if (seventhFallback) {
    const up = await upgradeToBillableSeventh(seventhFallback.icd, fullLine || phrase);
    if (up) {
      const desc = (await icdDescription(up.icd)) || seventhFallback.c.name;
      return { icd: up.icd, description: desc, snomedCode: seventhFallback.c.code, snomedTerm: seventhFallback.c.name,
        contextDependent: true, encounterChar: up.seventh };
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
  office: {
    // Office / outpatient POS (11, 19/22 outpatient hospital, 49/50/71/72 clinics, 20 urgent care): the
    // 2021-revised families — NEW 99202-99205 (15/30/45/60 min), ESTABLISHED 99212-99215 (10/20/30/40).
    // Anchoring the family to the POS (not the SNF template) prevents a POS-vs-code mismatch DENIAL.
    hp: { kind: 'office-new', codes: ['99202', '99203', '99204', '99205'], times: [15, 30, 45, 60], label: 'Office/outpatient visit, new patient' },
    soap: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
    progress: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
    acuteChange: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
    hospice: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
    // No office DISCHARGE E/M — a discharge template at an office POS gets no auto E/M (coder assigns).
  },
  inpatient: {
    // Hospital inpatient / observation (POS 21 / 51 / 61) — 2023-merged families: initial 99221-99223
    // (40/55/75 min), subsequent 99231-99233 (25/35/50 min), discharge 99238-99239 (≤30 / >30 min).
    hp: { kind: 'initial', codes: ['99221', '99222', '99223'], times: [40, 55, 75], label: 'Initial hospital inpatient/observation care' },
    soap: { kind: 'ip-sub', codes: ['99231', '99232', '99233'], times: [25, 35, 50], label: 'Subsequent hospital inpatient/observation care' },
    progress: { kind: 'ip-sub', codes: ['99231', '99232', '99233'], times: [25, 35, 50], label: 'Subsequent hospital inpatient/observation care' },
    acuteChange: { kind: 'ip-sub', codes: ['99231', '99232', '99233'], times: [25, 35, 50], label: 'Subsequent hospital inpatient/observation care' },
    hospice: { kind: 'ip-sub', codes: ['99231', '99232', '99233'], times: [25, 35, 50], label: 'Subsequent hospital inpatient/observation care' },
    discharge: { kind: 'discharge', codes: ['99238', '99239'], times: [0, 31], label: 'Hospital inpatient/observation discharge day management' },
  },
  ed: {
    // Emergency department (POS 23) — 99281-99285, MDM-only (NO time-based leveling; times omitted).
    hp: { kind: 'ed', codes: ['99281', '99282', '99283', '99284', '99285'], times: null, label: 'Emergency department visit' },
    soap: { kind: 'ed', codes: ['99281', '99282', '99283', '99284', '99285'], times: null, label: 'Emergency department visit' },
    progress: { kind: 'ed', codes: ['99281', '99282', '99283', '99284', '99285'], times: null, label: 'Emergency department visit' },
    acuteChange: { kind: 'ed', codes: ['99281', '99282', '99283', '99284', '99285'], times: null, label: 'Emergency department visit' },
  },
  // NOTE: 'acp' (Advance Care Planning, 99497/98 — time-based) and 'telehealth' (an attestation addendum)
  // are deliberately ABSENT — they are NOT standalone E/M visits, so no E/M code is auto-suggested for
  // them (no silent fallback to a subsequent-visit code); their coding is assigned separately.
};

// Office / outpatient E/M (POS 11) for Pain Management and Personal-Injury visit note types — the
// 2021-revised families: NEW patient 99202-99205 (time 15/30/45/60) and ESTABLISHED 99212-99215
// (time 10/20/30/40; 99211 is a nurse-only visit, deliberately excluded from physician auto-suggest).
// Keyed by note_type. ONLY genuine standalone E/M VISITS are listed here — interventional procedures,
// imaging/lab orders, determinations, narratives, forms, letters, and attestations are NOT standalone
// E/M and correctly get NO auto E/M code (the coder assigns the procedure/other code, and the live
// scrub validates). Under-suggesting is the compliance-safe direction.
const OFFICE_EM = {
  pi_initial: { kind: 'office-new', codes: ['99202', '99203', '99204', '99205'], times: [15, 30, 45, 60], label: 'Office/outpatient visit, new patient' },
  pain_initial: { kind: 'office-new', codes: ['99202', '99203', '99204', '99205'], times: [15, 30, 45, 60], label: 'Office/outpatient visit, new patient' },
  pi_soap: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
  pi_reexam: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
  pain_followup: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
  pain_controlled: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
  pain_reeval: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient' },
  pain_telehealth: { kind: 'office-est', codes: ['99212', '99213', '99214', '99215'], times: [10, 20, 30, 40], label: 'Office/outpatient visit, established patient (telehealth)' },
};
// Care setting → 'nf' (Skilled/Nursing Facility) or 'home' (home / assisted living / domiciliary). The
// AUTHORITATIVE source is the facility's Place of Service (passed in); text detection is the fallback.
// Default is 'nf' (the primary SNF use case); explicit home/residence signals switch to 'home'.
function detectSetting(content = {}, posHint) {
  const pos = String(posHint || '').trim();
  // An EXPLICIT Place of Service is AUTHORITATIVE — the E/M family must match it or the payer denies the
  // line (POS-vs-code edit). Map each POS to its E/M setting; a POS with no auto-E/M family (inpatient 21,
  // ER 23, telehealth, ambulatory surgical 24, …) returns 'other' so NO E/M is suggested (the coder
  // assigns the setting-correct code) rather than a MISMATCHED nursing-facility code that would deny.
  if (pos) {
    if (['31', '32'].includes(pos)) return 'nf';                               // skilled/nursing facility
    if (['12', '13', '14', '33'].includes(pos)) return 'home';                 // home / assisted living / group home / custodial
    if (['11', '19', '22', '49', '50', '71', '72', '20'].includes(pos)) return 'office'; // office / outpatient / clinic / urgent care
    if (['21', '51', '61'].includes(pos)) return 'inpatient';                  // hospital inpatient / psych / rehab
    if (pos === '23') return 'ed';                                             // emergency department
    if (['nf', 'home', 'office', 'inpatient', 'ed'].includes(posHint)) return posHint;
    if (/^\d{1,2}$/.test(pos)) return 'other';                                 // explicit but unmapped POS → no auto E/M (denial-safe)
  }
  // No POS provided → detect the setting from the note text; default to nf (the primary SNF use case).
  const t = Object.values(content).filter((v) => typeof v === 'string').join('  ').toLowerCase();
  if (/\b(skilled nursing|nursing facility|nursing home|\bsnf\b|long[\s-]?term care facility)\b/.test(t)) return 'nf';
  if (/\b(office|clinic|outpatient)\b/.test(t) && !/\b(nursing|snf|facility|home)\b/.test(t)) return 'office';
  if (/\b(assisted living|\balf\b|memory care|residential care|domiciliary|rest home|group home|board and care|adult family home)\b/.test(t)
      || /(visit\s+(was\s+)?(done|conducted|performed|seen)[^.]{0,30}\b(at|in)\s+(the\s+)?(patient'?s?\s+)?home|home visit|seen at home)/.test(t)) return 'home';
  return 'nf';
}
function pickFamily(setting, noteType) {
  // PI/Pain office E/M visits are outpatient services — always the office family, independent of the
  // SNF/home setting detection (which only applies to the SNF note types).
  if (OFFICE_EM[noteType]) return OFFICE_EM[noteType];
  // An explicit but unmapped POS ('other' — inpatient, ER, ASC, telehealth POS, …): suggest NO E/M so a
  // mismatched (denial-causing) code is never emitted; the coder assigns the setting-correct E/M.
  if (setting === 'other') return null;
  const bySetting = EM_FAMILIES[setting] || EM_FAMILIES.nf;
  // No fallback: a note type with no E/M family (acp / telehealth / PI-Pain non-visit types) returns
  // null so NO E/M code is invented.
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
  // Clinical reasoning for THIS visit lives in the assessment/plan/diagnoses/MDM/complaint sections —
  // scope acuity detection there (deliberately EXCLUDING the HPI/history narrative, which would inflate
  // the level with past events). Match those sections by NAME PATTERN so it works across every service
  // line dynamically: SNF (assessment/plan), Pain (pnDiagnoses/pnPlan/pnResponse), PI (piDiagnoses/
  // piPlanWork/piCausation) — no per-note-type hard-coding, and a new template's plan/assessment section
  // is picked up automatically. (HPI-type keys like pnPainStory / piMechanism don't match, by design.)
  const ACUITY_KEY = /assess|plan|diagnos|impression|\bmdm\b|subjective|objective|complaint|causation|response|reeval|decompensat|disposition/i;
  const acuityText = Object.keys(content)
    .filter((k) => ACUITY_KEY.test(k))
    .map((k) => content[k])
    .filter((v) => typeof v === 'string')
    .join('  ').toLowerCase();
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
  if (fam.kind === 'home-new' || fam.kind === 'office-new') { // 4-code new-patient family (home 99341-45 / office 99202-05)
    const idx = highSig ? 3 : (problemCount <= 1 && !modSig) ? 1 : 2;
    return { idx, basis: `MDM proxy — ${highSig ? 'high acuity' : (problemCount <= 1 && !modSig) ? 'low' : 'moderate'} (${setLabel}) — coder confirms` };
  }
  if (fam.kind === 'ip-sub') { // subsequent hospital inpatient/obs: 99231/99232/99233 (3 codes)
    const idx = highSig ? 2 : modSig ? 1 : 0;
    return { idx, basis: `MDM proxy — ${highSig ? 'unstable/significant complication (high)' : modSig ? 'responding inadequately / minor complication (moderate)' : 'stable, recovering (low)'} (${setLabel}) — coder confirms` };
  }
  if (fam.kind === 'ed') { // emergency department: 99281-99285 (MDM-driven, 5 codes)
    const idx = highSig ? 4 : modSig ? 3 : 2;
    return { idx, basis: `MDM proxy — ${highSig ? 'high complexity / threat to life' : modSig ? 'moderate complexity' : 'low-moderate complexity'} (${setLabel}) — coder confirms` };
  }
  // Subsequent NF / established home: floor at LOW for stable chronic care; escalate on documented acuity.
  if (highSig) return { idx: 3, basis: `MDM proxy — documented instability / threat to life (high, ${setLabel}) — coder confirms` };
  if (modSig) return { idx: 2, basis: `MDM proxy — documented acuity/active problem (moderate, ${problemCount} problems, ${setLabel}) — coder confirms` };
  return { idx: 1, basis: `MDM proxy — ${problemCount} stable chronic problem${problemCount === 1 ? '' : 's'}, no acuity documented (low, ${setLabel}) — coder confirms` };
}

/**
 * Total length of the DOCUMENTED clinical narrative (non-whitespace), across every clinical section —
 * excluding the billing / attestation / signature scaffolding. Used to tell a BLANK note (nothing written)
 * from a documented one, so the E/M level is only ever predicted from real documentation.
 */
function clinicalTextLength(content = {}) {
  let n = 0;
  for (const [k, v] of Object.entries(content || {})) {
    if (/billing|attest|signature|signed/i.test(k)) continue; // not clinical documentation
    if (typeof v === 'string') n += v.replace(/\s+/g, '').length;
  }
  return n;
}

export function predictEM(content = {}, noteType = 'hp', problemCount = 0, posHint) {
  content = content || {}; // a note row with NULL content must not crash prediction (default only catches undefined)
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
  if (!fam) return { cpt: null, description: null, units: 1, modifiers: '', basis: 'No standalone E/M charge auto-suggested for this note type — assign the appropriate code(s) (e.g. procedure, order, or letter) in the coding panel; the live scrub validates before signing.', confirm: true, addOn: null };
  // BLANK / undocumented note → predict NO E/M code. The level is derived from the documented content
  // (total time and/or medical decision-making); with nothing written there is no basis, so inventing the
  // low default (e.g. 99308) would be a static, unsupported code. This mirrors diagnosis prediction, which
  // also yields nothing on an empty note. The E/M appears once the visit is documented and rises with
  // documented acuity/time — fully dynamic, never a fixed code on a blank template.
  if (documentedMinutes(content) == null && problemCount === 0 && clinicalTextLength(content) < 12) {
    return { cpt: null, description: fam.label, units: 1, modifiers: '', basis: 'Document the visit — the E/M level is predicted from the note (medical decision-making and/or total time).', confirm: true, addOn: null };
  }
  const minutes = documentedMinutes(content);
  let idx = 0; let basis; let confirm = false;
  if (fam.kind === 'discharge') {
    idx = (minutes != null && minutes > 30) ? 1 : 0;
    basis = minutes != null ? `documented time ${minutes} min` : 'default (30 min or less)';
    confirm = minutes == null;
  } else {
    // Level by the HIGHER of the two CMS-permitted criteria — MDM proxy AND documented total time — since
    // a provider may select the E/M level on EITHER (2021 AMA/CMS). Using time alone (as before) under-
    // coded when MDM supported a higher level; using MDM alone ignored a longer documented visit. Both are
    // legitimate, documented, defensible criteria, so code to whichever supports the higher level; always
    // confirm (E/M leveling is provider-attested). Under-coding is only avoided WITHIN documented support.
    const em = mdmProxyLevel(content, problemCount, fam);
    idx = em.idx; basis = em.basis;
    // Time-based leveling applies only when the family HAS time thresholds (ED is MDM-only → times null).
    if (minutes != null && Array.isArray(fam.times) && fam.times.length) {
      let timeIdx = 0; for (let i = 0; i < fam.times.length; i += 1) if (minutes >= fam.times[i]) timeIdx = i;
      if (timeIdx > idx) { idx = timeIdx; basis = `documented total time ${minutes} min (time-based; MDM proxy supports ${fam.codes[em.idx]})`; }
      else if (timeIdx === idx) basis = `${em.basis}; corroborated by documented time ${minutes} min`;
      else basis = `${em.basis} (documented time ${minutes} min alone supports only ${fam.codes[timeIdx]}; MDM level used)`;
    }
    confirm = true;
  }
  // Safety clamp — the selected level index can NEVER exceed the family's code list (guards a 3-code family
  // against a 4-code MDM index, so an undefined CPT is impossible).
  idx = Math.max(0, Math.min(idx, fam.codes.length - 1));
  // Hospice ATTENDING visit → modifier GV (attending physician, not employed by the hospice, care
  // related to the terminal condition). Coder confirms GV vs GW (services unrelated to the terminal dx).
  // A pain-management TELEHEALTH visit → modifier 95 (synchronous audio-video); coder confirms POS 10/02.
  const modifiers = noteType === 'hospice' ? 'GV' : noteType === 'pain_telehealth' ? '95' : '';
  return { cpt: fam.codes[idx], description: fam.label, units: 1, modifiers, basis, confirm: confirm || noteType === 'hospice' || noteType === 'pain_telehealth', addOn: null };
}

/**
 * FULL deterministic coding prediction for a note → { diagnoses, procedures, modifiers, unmatched }.
 * Stage 1 diagnoses (billable ICD-10-CM) + Stage 2 visit charge (E/M). Modifiers stay conservative:
 * an E/M alone needs none, so they are left to the live claim-scrub, which flags modifier 25 etc.
 * Everything is a SUGGESTION the coder confirms before the note is signed.
 */
/**
 * DETERMINISTIC interventional-procedure CPT prediction from a PROCEDURE note. Every mapping is a real
 * CMS/AMA CPT for a well-defined, unambiguously-documented interventional pain/PI procedure — validated
 * against the cpt_codes dataset before emission (an unrecognized code is dropped, never guessed). The
 * spinal REGION (cervical/thoracic vs lumbar/sacral) and LATERALITY (left/right/bilateral → LT/RT/50)
 * are read from the documentation; level COUNT selects the base + add-on code. Everything is
 * confirm=true (the coder verifies level count, laterality, and imaging before billing). Procedures
 * that are not clearly documented are NOT coded here — they are left for the coder (no fabrication).
 */
const detectLateralityMod = (t) => (/\bbilateral(ly)?\b|\bboth sides?\b/.test(t) ? '50'
  : /\bleft\b|\bl\.\s|\(l\)/.test(t) && /\bright\b|\br\.\s|\(r\)/.test(t) ? '50'
    : /\bleft\b|\bl\.\s|\(l\)/.test(t) ? 'LT' : /\bright\b|\br\.\s|\(r\)/.test(t) ? 'RT' : '');
// cervical/thoracic (C/T) vs lumbar/sacral (L/S) region for spine procedures.
const spineRegionCT = (t) => /\b(cervical|thoracic|c[3-7]\b|t\d{1,2}\b|neck)\b/.test(t) && !/\b(lumbar|sacral|l[1-5]\b|s1\b|low back)\b/.test(t);
const levelCount = (t) => { const m = t.match(/\b(one|two|three|four|1|2|3|4)[\s-]*level/); if (!m) return 1; const w = { one: 1, two: 2, three: 3, four: 4 }; return w[m[1]] || Number(m[1]) || 1; };

export function predictProcedures(content = {}) {
  const flat = withFlatSections(content);
  const t = Object.values(flat).filter((v) => typeof v === 'string').join('  ').toLowerCase();
  if (!t.trim()) return [];
  const out = [];
  const seen = new Set();
  const emit = (cpt, modifiers, extra) => { const k = `${cpt}|${modifiers || ''}`; if (seen.has(k)) return; seen.add(k); out.push({ cpt, units: 1, modifiers: modifiers || '', confirm: true, ...extra }); };
  const procText = Object.keys(flat).filter((k) => /procedure/i.test(k))
    .map((k) => flat[k]).filter((v) => typeof v === 'string').join('  ').toLowerCase();

  // Detection over a text SEGMENT. `scoped` = the segment is procedure-designated (a procedure clause), so a
  // joint NAME + "injection" is unambiguous even without the word "joint"; when NOT scoped (the whole note),
  // a joint injection still requires an explicit joint-context word so a "knee OA" DIAGNOSIS never fires a
  // CPT. Laterality (LT/RT/50), spine region, and level are all read from the SAME segment — so two
  // procedures documented on DIFFERENT sides each get their own modifier (a LEFT TFESI is never mis-billed 50).
  const detect = (dt, scoped) => {
    const latMod = detectLateralityMod(dt);
    const ct = spineRegionCT(dt);
    const push = (cpt, extra = {}) => emit(cpt, extra.modifiers ?? latMod, extra);
    // TFESI (imaging-inclusive). TFESI/SNRB alone suffice; spelled-out forms need an action word.
    const tfesiHit = /\btfesi\b|\bsnrb\b/.test(dt)
      || ((/transforaminal|selective nerve root block/.test(dt)) && /(epidural|steroid|injection|inject|block|nerve root|\besi\b)/.test(dt));
    if (tfesiHit) {
      const n = Math.min(levelCount(dt), 6);
      push(ct ? '64479' : '64483', { basis: `transforaminal epidural, ${ct ? 'cervical/thoracic' : 'lumbar/sacral'}, first level` });
      if (n >= 2) push(ct ? '64480' : '64484', { units: n - 1, basis: `transforaminal epidural, each additional level (${n - 1} additional)` }); // add-on — REQUIRES its primary; never billed alone
    } else if (/(interlaminar|caudal|epidural steroid|\besi\b)/.test(dt) && /(epidural|steroid|injection|block|\besi\b)/.test(dt)) {
      push(ct ? '62321' : '62323', { basis: `interlaminar/caudal epidural steroid, ${ct ? 'cervical/thoracic' : 'lumbar/sacral'}` });
    }
    // Facet joint injection / medial branch block. Paravertebral facet CPTs are per-level with DISTINCT
    // codes: lumbar 64493 (1st) + 64494 (2nd) + 64495 (3rd & any additional); cervical 64490/64491/64492.
    // The add-on codes REQUIRE the primary — previously n≥2 emitted only the add-on (64494) alone, which
    // denies as an add-on without its base. Emit the primary, then each documented additional level.
    if (/(facet|medial branch|zygapophyseal|paravertebral|\bmbb\b)/.test(dt) && /(injection|block|\bmbb\b|inject)/.test(dt) && !/(radiofrequency|\brfa\b|ablation|neurotomy)/.test(dt)) {
      const n = Math.min(levelCount(dt), 3);
      const codes = ct ? ['64490', '64491', '64492'] : ['64493', '64494', '64495'];
      push(codes[0], { basis: `paravertebral facet joint injection/MBB, ${ct ? 'cervical/thoracic' : 'lumbar/sacral'}, first level` });
      if (n >= 2) push(codes[1], { basis: `paravertebral facet joint injection/MBB, second level` });
      if (n >= 3) push(codes[2], { basis: `paravertebral facet joint injection/MBB, third and any additional level(s)` });
    }
    // RFA / neurotomy of facet nerves — lumbar 64635 (1st) + 64636 (each additional, units); cervical
    // 64633 + 64634. The add-on was never emitted for multi-level, under-coding the claim.
    if (/(radiofrequency|\brfa\b|\brfn\b|neurotomy|ablation|rhizotomy)/.test(dt) && /(facet|medial branch|paravertebral|zygapophyseal)/.test(dt)) {
      const n = Math.min(levelCount(dt), 6);
      push(ct ? '64633' : '64635', { basis: `radiofrequency ablation of paravertebral facet nerve, ${ct ? 'cervical/thoracic' : 'lumbar/sacral'}, first level` });
      if (n >= 2) push(ct ? '64634' : '64636', { units: n - 1, basis: `radiofrequency ablation of paravertebral facet nerve, each additional level (${n - 1} additional)` });
    }
    // Sacroiliac (SI) joint: RFA vs injection.
    if (/(sacroiliac|\bsi joint\b|si-joint)/.test(dt)) {
      if (/(radiofrequency|\brfa\b|ablation|neurotomy)/.test(dt)) push('64625', { basis: 'radiofrequency ablation, SI joint nerves (imaging-inclusive)' });
      else if (/(injection|inject|block|arthrogram)/.test(dt)) push('27096', { basis: 'sacroiliac joint injection with imaging guidance' });
    }
    // Trigger point injection(s) — CPT is driven by muscle COUNT (20552 = 1-2 muscles, 20553 = 3+), no
    // laterality. Extract the count robustly: "x3 muscles", "x 3", "3 muscles", "three muscles" — the old
    // \b3\b failed on "x3" (no word boundary between x and 3) and under-coded 3-muscle TPIs to 20552.
    if (/\btpi\b/.test(dt) || (/trigger point/.test(dt) && /(injection|inject)/.test(dt))) {
      const NW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
      const cm = dt.match(/x\s*(\d{1,2})|(\d{1,2})\s*(?:muscle|site|trigger|tp)/) || dt.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b[^.]{0,20}(?:muscle|site)/);
      let n = null;
      if (cm) { const g = (cm[1] || cm[2] || '').toLowerCase(); n = NW[g] != null ? NW[g] : parseInt(g, 10); }
      else if (/\bmultiple muscles?\b/.test(dt)) n = 3;
      const three = Number.isInteger(n) && n >= 3;
      emit(three ? '20553' : '20552', '', { basis: `trigger point injection, ${three ? '3 or more' : '1-2'} muscle(s)` });
    }
    // Peripheral joint/bursa injection (size by joint). A specific joint name is unambiguous within a
    // procedure clause (scoped); on the whole note, an explicit joint-context word is required.
    const jointCtx = /(joint|bursa|arthrocentesis|aspiration|intra[\s-]?articular|interphalangeal|metacarpophalangeal|glenohumeral|acromioclavicular|\btmj\b|temporomandibular|subacromial|trochanteric|\bmcp\b|\bpip\b|\bdip\b)/.test(dt);
    const jointPart = scoped && /(injection|inject|aspiration|arthrocentesis)/.test(dt) && /\b(knee|shoulder|hip|elbow|wrist|ankle)\b/.test(dt);
    if ((/(injection|inject|aspiration|arthrocentesis)/.test(dt) && jointCtx) || jointPart) {
      if (/\b(knee|shoulder|hip|glenohumeral|trochanteric|subacromial)\b/.test(dt)) push('20610', { basis: 'major joint/bursa injection or aspiration (knee/shoulder/hip)' });
      else if (/\b(elbow|wrist|ankle|acromioclavicular|\btmj\b|temporomandibular)\b/.test(dt)) push('20605', { basis: 'intermediate joint/bursa injection or aspiration' });
      else if (/\b(finger|toe|interphalangeal|metacarpophalangeal|\bmcp\b|\bpip\b|\bdip\b)\b/.test(dt)) push('20600', { basis: 'small joint/bursa injection or aspiration' });
    }
    // ---- SNF / bedside procedures (physician-performed, Part B) ----------------------------------------
    const isNail = /\b(?:toe|finger)?nails?\b|onychomycos|mycotic nail/.test(dt);
    const negProc = /\bno (?:wound |sharp |surgical )?debride|without debride|debridement (?:was )?(?:not|deferred)|dressing change only|no procedure performed/.test(dt);
    // WOUND DEBRIDEMENT — deepest tissue removed drives the CPT: bone → 11044, muscle/fascia → 11043,
    // subcutaneous → 11042; non-excisional/selective → 97597. Size drives add-ons (coder confirms).
    if (!negProc && !isNail && /\bdebride(?:ment|d|s)?\b/.test(dt) && /(wound|ulcer|pressure|eschar|slough|necroti|devitaliz|granulat|soft tissue|subcutaneous|subcut|subq|\bskin\b|dermis|epiderm|muscle|fascia|bone)/.test(dt)) {
      if (/\bbone\b/.test(dt)) push('11044', { basis: 'surgical debridement to BONE (11045-11047 per additional 20 sq cm) — confirm depth & size', modifiers: '' });
      else if (/(muscle|fascia)/.test(dt)) push('11043', { basis: 'surgical debridement of MUSCLE/FASCIA (11046 per additional 20 sq cm) — confirm depth & size', modifiers: '' });
      else if (/(subcutaneous|subcut|subq|full[\s-]?thickness|excisional)/.test(dt)) push('11042', { basis: 'surgical debridement of SUBCUTANEOUS tissue (11045 per additional 20 sq cm) — confirm depth & size', modifiers: '' });
      else push('97597', { basis: 'selective (non-excisional) debridement of devitalized tissue, first 20 sq cm (97598 per additional 20 sq cm) — confirm size', modifiers: '' });
    }
    // NAIL DEBRIDEMENT — 11720 (1-5 nails) / 11721 (6 or more).
    if (!negProc && isNail && /(debride|mycotic|onychomycos|dystrophic|trim)/.test(dt)) {
      const many = /\b(6|7|8|9|10|11|12|six|seven|eight|nine|ten)\b[^.]{0,18}nail|all\s+(?:ten|10)\s+nails|multiple nails|\ball nails\b/.test(dt);
      push(many ? '11721' : '11720', { basis: `debridement of nail(s), ${many ? '6 or more' : '1 to 5'} — confirm count`, modifiers: '' });
    }
    // CERUMEN removal (impacted, requiring instrumentation) — 69210 (±50 bilateral).
    if (/\bcerumen\b|impacted (?:ear ?)?wax|earwax/.test(dt) && /(remov|disimpact|curette|irrigat|instrument)/.test(dt)) {
      push('69210', { basis: 'removal of impacted cerumen requiring instrumentation, unilateral (add -50 if bilateral)', modifiers: /\bbilateral\b|both ears/.test(dt) ? '50' : latMod });
    }
  };

  // A procedure section is detected PER CLAUSE (split on ; / sentence / newline / "and also") so each
  // procedure gets its OWN laterality/region/level and a diagnosis never contaminates a procedure. With no
  // procedure section, the whole note is one unscoped segment (joint injections then need an explicit
  // joint-context word). Commas are NOT split points (they occur inside one procedure: "L4-L5, left").
  if (procText.trim()) {
    const clauses = procText.split(/;|\.\s+|\n|\band also\b|\balso\b/).map((s) => s.trim()).filter((s) => s.length > 2);
    for (const c of (clauses.length ? clauses : [procText])) detect(c, true);
  } else {
    detect(t, false);
  }
  return out;
}

export async function predictEncounterCoding(content = {}, { noteType = 'hp', pos } = {}) {
  content = content || {}; // NULL note content must never crash the coding prediction
  // Surface section text to the flat keys the extractors (diagnoses, E/M, procedures) read — real notes
  // store text under content.sections, so without this the whole prediction ran on empty input.
  content = withFlatSections(content);
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
  // Interventional procedures documented in the note (injections, blocks, RFA, joint injections) —
  // real CMS CPTs with region/laterality, each validated against the dataset by emit() and deduped
  // against the E/M line. Confirm=true so the coder verifies level count, laterality, and imaging.
  const emitted = new Set(procedures.map((p) => p.cpt));
  for (const pr of predictProcedures(content)) {
    if (emitted.has(pr.cpt)) continue;
    emitted.add(pr.cpt);
    await emit(pr.cpt, pr.units, pr.modifiers, pr.basis, pr.confirm, null);
  }
  // PROACTIVE denial-avoidance: scrub the predicted codes against the full CMS edit set (NCCI, ICD
  // billability/edits, LCD/Article medical necessity via mcd_* + article_coverage_*, modifier validity)
  // so LCD/medical-necessity and coding problems surface AT DOCUMENTATION TIME — before sign-off — with
  // the covered diagnoses the provider should document. Scoped to First Coast (FL) like the live scrub.
  let denialRisks = []; let denialSummary = { errors: 0, warnings: 0, info: 0 };
  if (procedures.length || diagnoses.length) {
    const scrub = await scrubClaim({
      lines: procedures.map((p) => ({ cpt: p.cpt, units: p.units, modifiers: p.modifiers })),
      diagnoses: diagnoses.map((d) => d.icd), jurisdiction: 'FL',
    });
    denialRisks = scrub.findings; denialSummary = scrub.summary;
  }
  return { diagnoses, procedures, modifiers: [], unmatched, denialRisks, denialSummary };
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

  // CKD documented in the narrative but not captured as a standalone N18 code (e.g. embedded in a
  // "diabetes WITH chronic kidney disease stage 3" line). Per ICD-10-CM the CKD STAGE (N18.-) must be
  // coded IN ADDITION to any diabetic/hypertensive CKD combination — add the documented stage so it is
  // never lost, which also enables the hypertensive-CKD combination below.
  // Detect CKD even in the abbreviated no-space form "CKD4"/"CKD3a" (\bckd\b alone fails there because a
  // digit follows with no word boundary), so the stage code is co-reported for "T2DM with CKD4" too.
  const ckdDocumented = hasText(/chronic kidney disease|\bckd\b|\bckd\s?(?:3a|3b|[1-5])/) || esrd;
  if (ckdDocumented && !hasCode(/^N18\./)) {
    const sm = text.match(/(?:stage|ckd)\s*(3a|3b|[1-5])/);
    const stageCode = esrd ? 'N18.6'
      : sm ? ({ 1: 'N18.1', 2: 'N18.2', 3: 'N18.30', '3a': 'N18.31', '3b': 'N18.32', 4: 'N18.4', 5: 'N18.5' }[sm[1]] || 'N18.9')
        : 'N18.9';
    await add(stageCode, 'Chronic kidney disease', 'CKD stage');
  }
  const hasCKDnow = hasCode(/^N18\./);

  // Diabetes combination codes (assume the "with" relationship per ICD-10-CM guidelines).
  if (hasDM2 && hasCKDnow) {
    if (!(await upgrade(/^E11\.9$|^E11\.65$/, 'E11.22', 'Type 2 diabetes mellitus with diabetic chronic kidney disease', 'DM + CKD'))) {
      await add('E11.22', 'Type 2 diabetes mellitus with diabetic chronic kidney disease', 'DM + CKD');
    }
  }
  if (hasDM2 && hasPAD) await add('E11.51', 'Type 2 diabetes mellitus with diabetic peripheral angiopathy without gangrene', 'DM + PAD');
  // Add the UNSPECIFIED diabetic-complication combo ONLY when no MORE-SPECIFIC sibling is already coded —
  // otherwise "DM with diabetic polyneuropathy" (E11.42) would carry a redundant E11.40, and a specific
  // retinopathy (E11.311/E11.321/…) a redundant E11.319. The specific code from the phrase match stands.
  if (hasDM2 && hasText(/neuropath/) && !hasCode(/^E11\.4[1-9]$/)) await add('E11.40', 'Type 2 diabetes mellitus with diabetic neuropathy, unspecified', 'DM + neuropathy');
  if (hasDM2 && hasText(/retinopath/) && !hasCode(/^E11\.3[123][1-9]$/)) await add('E11.319', 'Type 2 diabetes mellitus with unspecified diabetic retinopathy without macular edema', 'DM + retinopathy');

  // Hypertensive chronic kidney disease (combination — ICD-10-CM PRESUMES the HTN↔CKD relationship).
  if (out.some((d) => d.icd === 'I10') && hasCKDnow) {
    await upgrade(/^I10$/, esrd ? 'I12.0' : 'I12.9',
      esrd ? 'Hypertensive chronic kidney disease with stage 5 CKD or end stage renal disease'
        : 'Hypertensive chronic kidney disease with stage 1 through stage 4 CKD, or unspecified CKD', 'HTN + CKD');
  }
  // Hypertensive HEART disease with heart failure (ICD-10-CM I.C.9.a.1). Unlike HTN+CKD, the relationship
  // is NOT presumed — it must be STATED or IMPLIED ("hypertensive heart disease", "hypertensive", "heart
  // failure DUE TO hypertension") or already coded (any I11.-). When it is: report I11.0 (upgrading a bare
  // I10 or an I11.9-without-HF), AND ALWAYS report the heart-failure TYPE additionally (I50.-, defaulting to
  // I50.9). Absent a stated relationship, HTN and HF are coded SEPARATELY (I10 + I50.-) — never presumed.
  const hfDocumented = hasCode(/^I50\./) || hasText(/heart failure|congestive heart|\bchf\b|\bhfref\b|\bhfpef\b/);
  const htnHeartStated = hasCode(/^I11\./) || hasText(/hypertensive heart|(?:heart (?:disease|failure)|\bchf\b|\bhf\b) (?:due to|secondary to|from|related to|attributed to) hypertension/);
  if (hfDocumented && htnHeartStated) {
    if (!(await upgrade(/^I10$|^I11\.9$/, 'I11.0', 'Hypertensive heart disease with heart failure', 'HTN + HF'))) {
      await add('I11.0', 'Hypertensive heart disease with heart failure', 'HTN + HF');
    }
    if (!hasCode(/^I50\./)) await add('I50.9', 'Heart failure, unspecified', 'HF type reported with I11.0');
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

/**
 * Resolve an ICD the PROVIDER wrote explicitly on a problem line. The provider's own code is
 * authoritative for billing intent, so we trust it — but ONLY after validating it against the billable
 * ICD-10-CM dataset (isBillableIcd), so a typo or a non-leaf category is never emitted. The description
 * always comes from the official dataset (never the free-text). The SNOMED CT ID is attached from the
 * official SNOMED→ICD reverse map: preferring the source concept whose term best overlaps the provider's
 * phrase, but ALWAYS attaching one when the code has any mapped concept (every concept the reverse map
 * returns officially maps TO this ICD, so it is a valid SNOMED representation of the code — a 0-overlap
 * phrase is no reason to drop it). Only a code with NO reverse-map entry leaves snomedCode null.
 * Returns a match object identical in shape to matchIcdForPhrase's, or null if the code isn't billable.
 */
async function resolveExplicitIcd(icd, phrase) {
  if (!icd || !(await isBillableIcd(icd))) return null;
  const description = (await icdDescription(icd)) || phrase;
  let snomedCode = null;
  let snomedTerm = null;
  try {
    const concepts = await snomedConceptsForIcd10cm(icd);
    if (concepts.length) {
      const pTokens = scoreTokens(phrase);
      const pSet = new Set(pTokens);
      // Rank by how well the concept term is explained by the phrase and vice-versa (prefer the concept
      // closest to the provider's wording), but attach the best available regardless of overlap.
      const ranked = concepts
        .map((c) => {
          const cTokens = scoreTokens(c.snomedTerm || '');
          const score = cover(cTokens, pSet) + cover(pTokens, new Set(cTokens));
          return { c, score };
        })
        .sort((a, b) => b.score - a.score || String(a.c.snomedCode).localeCompare(String(b.c.snomedCode)));
      // Best phrase-overlap when there is one; otherwise the reverse map's preferred concept (concepts[0],
      // us-preferred/shortest from the query order) — authoritative for the code, never an unrelated one.
      const pick = (ranked[0] && ranked[0].score > 0) ? ranked[0].c : concepts[0];
      if (pick) { snomedCode = pick.snomedCode; snomedTerm = pick.snomedTerm || description; }
    }
  } catch { /* best-effort SNOMED enrichment only — code + description are already authoritative */ }
  return { icd: icd.toUpperCase(), description, snomedCode, snomedTerm, contextDependent: false, explicit: true };
}

/** Predict billable ICD-10-CM diagnoses for a note → { diagnoses:[...], unmatched:[...] }. */
export async function predictDiagnosesFromNote(content = {}, { noteType = 'hp' } = {}) {
  content = content || {}; // NULL note content must never crash diagnosis prediction
  content = withFlatSections(content); // real notes store text under .sections; flatten so linkage sees it too
  const items = extractProblemPhrases(content, noteType);
  const diagnoses = [];
  const unmatched = [];
  const usedIcd = new Set();
  // Match every active problem CONCURRENTLY (each is an independent remote SNOMED lookup); then fold the
  // results back IN NOTE ORDER so the primary diagnosis and de-duplication stay deterministic. In
  // parallel, resolve any ICD the provider wrote explicitly (authoritative, dataset-validated).
  const active = items.filter((i) => !i.negated);
  // FAST PATH: when the provider wrote an explicit ICD code, resolve it authoritatively (in-memory
  // billable validation + one small reverse-map query) and SKIP the expensive SNOMED text search for that
  // problem entirely — the explicit code wins regardless, so running the search would be wasted latency.
  // The (heavy) text search runs ONLY for problems with no resolving explicit code. This is what makes
  // coded notes fast enough for real-time, high-volume prediction; prose-only phrases still fall through
  // to the full deterministic matcher (memoized across records).
  const explicitMatches = await Promise.all(active.map((i) => (i.explicitIcd ? resolveExplicitIcd(i.explicitIcd, i.text) : null)));
  const matches = await Promise.all(active.map((i, k) => (explicitMatches[k] ? null : matchIcdForPhrase(i.text, i.full))));
  for (let k = 0; k < active.length; k += 1) {
    const item = active[k];
    // Explicit provider code (fast path) is authoritative; otherwise use the deterministic text match.
    const m = explicitMatches[k] || matches[k];
    if (!m) { unmatched.push(item.text); continue; }
    if (usedIcd.has(m.icd)) continue;
    usedIcd.add(m.icd);
    diagnoses.push({ icd: m.icd, description: m.description, snomedCode: m.snomedCode, snomedTerm: m.snomedTerm,
      primary: diagnoses.length === 0, contextDependent: m.contextDependent, sourcePhrase: item.text });
  }
  const linked = await applyLinkage(diagnoses, content);
  return { diagnoses: linked, unmatched };
}
