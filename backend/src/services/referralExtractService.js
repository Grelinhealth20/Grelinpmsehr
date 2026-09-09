// ============================================================================
// DETERMINISTIC incoming-fax REFERRAL field extraction. Pure, rule-based (labels + regex) over the
// structured OCR (key/value pairs + text) from the PaddleOCR microservice (docExtractService.ocrExtractRaw).
// NO AI, NO mock, NO fabrication — every field is read verbatim from the scanned document and normalized;
// a field not present is left empty (never guessed). Same input → same output (deterministic).
//
// Handles referral FORMS and referral LETTERS: patient identity, referring provider/facility, reason,
// diagnosis (+ ICD-10 codes), requested specialty/service, urgency, and insurance.
// ============================================================================
import { ocrExtractRaw, ocrEnabled } from './docExtractService.js';
import { logger } from '../config/logger.js';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const titleCase = (s) => clean(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** Normalize a date token (MM/DD/YYYY, MM-DD-YY, YYYY-MM-DD, "Jan 2, 1950") → ISO YYYY-MM-DD, else ''. */
function normDate(raw) {
  const s = clean(raw);
  let m = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/); // YYYY-MM-DD
  if (m) return iso(m[1], m[2], m[3]);
  m = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/); // MM/DD/YYYY or MM/DD/YY
  if (m) { let y = m[3]; if (y.length === 2) y = (Number(y) > 30 ? '19' : '20') + y; return iso(y, m[1], m[2]); }
  m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m) { const mo = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[m[1].slice(0, 3).toLowerCase()]; return iso(m[3], mo, m[2]); }
  return '';
}
function iso(y, mo, d) {
  const Y = Number(y); const M = Number(mo); const D = Number(d);
  if (!(Y >= 1900 && Y <= 2100 && M >= 1 && M <= 12 && D >= 1 && D <= 31)) return '';
  return `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
}
/** Valid NPI = 10 digits passing the Luhn check with the 80840 prefix (CMS spec). Else ''. */
function normNpi(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 10) return '';
  const base = `80840${d.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < base.length; i += 1) { let n = Number(base[base.length - 1 - i]); if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  return ((10 - (sum % 10)) % 10) === Number(d[9]) ? d : '';
}
const normPhone = (raw) => { const d = String(raw || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? d : ''; };
const ICD_RE = /\b([A-TV-Z]\d[A-Z0-9](?:\.[A-Z0-9]{1,4})?)\b/g;

/** First KV pair whose key matches a label (optionally not matching `avoid`); returns trimmed value. */
function kvPick(kv, labelRe, avoid) {
  for (const p of kv || []) { const k = String(p.key || '').toLowerCase(); if (avoid && avoid.test(k)) continue; if (labelRe.test(k) && clean(p.value)) return clean(p.value); }
  return '';
}
/** "Label: value" (or "Label value") on a single text line; value stops at a column gap (2+ spaces on the
 *  RAW line — form fields are column-separated) or at a following inline label ("… DOB: …"). The raw line
 *  is used so the multi-space column gap survives (clean() would collapse it). */
function linePick(text, labelRe) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const m = rawLine.match(new RegExp(`(?:^|\\b)(?:${labelRe})\\s*[:#-]?\\s*(\\S.*)$`, 'i'));
    if (m && clean(m[1])) {
      const val = m[1].split(/\s{2,}/)[0]; // cut at the column gap first (raw), before whitespace-collapse
      return clean(val.split(/\b(?:dob|d\.o\.b|mrn|npi|ssn|phone|tel|fax|sex|gender|insurance|payer|diagnosis|member|subscriber|policy|group)\b\s*[:#]/i)[0]);
    }
  }
  return '';
}
/** Prefer the structured KV value; fall back to a labeled text line. */
const field = (kv, text, kvRe, lineRe, avoid) => kvPick(kv, kvRe, avoid) || linePick(text, lineRe);

const URGENT_RE = /\b(stat|emergent|emergency)\b/i;
const URGENT2_RE = /\b(urgent|asap|expedite|priority)\b/i;

/**
 * Parse referral fields from already-OCR'd { kv, text }. PURE + DETERMINISTIC (unit-testable without OCR).
 * Returns a structured object; empty strings for fields not found (never fabricated).
 */
export function parseReferralText({ kv = [], text = '' } = {}) {
  const rawName = field(kv, text, /patient|resident|member|pt\s*name|name of patient/, 'patient(?:\\s*name)?|resident(?:\\s*name)?|pt\\.?\\s*name|name of (?:patient|resident)', /provider|physician|doctor|referr|facility|guarantor|emergency|contact|pharmacy/);
  // Strip a trailing DOB/MRN/number/# accidentally glued onto the name line, but PRESERVE an internal
  // comma so a "Last, First" name survives intact (the downstream splitter needs both parts).
  let patientName = titleCase(String(rawName).replace(/\b(dob|d\.o\.b|mrn|ssn|age|sex)\b.*$/i, '').replace(/\s+\d.*$/, '').replace(/#.*$/, '').trim());
  // LETTER-STYLE fallback: referral letters have no "Patient:" label — the patient's name appears in prose
  // immediately BEFORE their date of birth, e.g. "referring Ms. Patricia Gomez (DOB 07/12/1958)". Anchor on
  // the following DOB (a strong, low-false-positive signal that the preceding name IS the patient). Only
  // used when no labeled name was found. Honorifics are dropped; 1-3 name tokens captured.
  if (!patientName) {
    const m = text.match(/\b(?:mr|mrs|ms|miss|mx|dr)\.?\s+([A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]*){0,2})\s*[(,]?\s*(?:dob|d\.?o\.?b|born|date of birth)\b/i)
      || text.match(/\b([A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]*){1,2})\s*\(\s*(?:dob|d\.?o\.?b|born)\b/i);
    if (m && m[1]) patientName = titleCase(m[1].replace(/\b(dob|mrn|age)\b.*$/i, '').trim());
  }
  const dob = normDate(field(kv, text, /d\.?o\.?b|date of birth|birth\s*date/, 'd\\.?o\\.?b\\.?|date of birth|birth\\s*date'));
  const mrn = clean(field(kv, text, /\bmrn\b|medical record|record\s*(?:no|number|#)|chart\s*(?:no|number|#)/, 'mrn|medical record(?:\\s*(?:no|number|#))?|chart\\s*(?:no|number|#)')).replace(/[^A-Za-z0-9-]/g, '').slice(0, 32);
  const sexRaw = field(kv, text, /^sex$|gender/, 'sex|gender').toLowerCase();
  const sex = /^m|male/.test(sexRaw) ? 'M' : /^f|female/.test(sexRaw) ? 'F' : '';
  const patientPhone = normPhone(field(kv, text, /patient.{0,8}(phone|tel)|home\s*(phone|tel)|^phone$|^tel/, 'patient\\s*(?:phone|telephone|tel)|home\\s*phone'));

  const referringProvider = titleCase(field(kv, text, /referring\s*(?:physician|provider|doctor|md|dr|clinician)|ordering\s*(?:physician|provider)|from\s*(?:physician|provider|dr)|\bpcp\b|requesting\s*(?:physician|provider)/, 'referring\\s*(?:physician|provider|doctor|md|dr|clinician)|ordering\\s*(?:physician|provider)|requesting\\s*(?:physician|provider)|\\bpcp\\b').replace(/\b(md|do|np|pa|dds|dpm)\b.*$/i, (m) => m.split(/\s/)[0]));
  const referringNpi = normNpi(field(kv, text, /npi/, 'npi(?:\\s*(?:no|number|#))?'));
  const referringOrg = titleCase(field(kv, text, /referring\s*(?:facility|clinic|practice|office|hospital|group)|from\s*(?:facility|clinic|practice)|facility\s*name|clinic\s*name|practice\s*name|sending\s*facility/, 'referring\\s*(?:facility|clinic|practice|office|hospital|group)|facility\\s*name|clinic\\s*name|practice\\s*name|sending\\s*facility'));
  const referringFax = normPhone(field(kv, text, /(?:referring|from|sender).{0,10}fax|^fax\b|fax\s*(?:no|number|#)/, '(?:referring|from|sender)\\s*fax|fax\\s*(?:no|number|#)?'));

  const reason = clean(field(kv, text, /reason for (?:referral|consult|visit)|referral reason|reason\b/, 'reason for (?:referral|consult(?:ation)?|visit)|referral reason')).slice(0, 500);
  const diagnosisText = clean(field(kv, text, /diagnos[ei]s|\bdx\b|impression|assessment|clinical\s*(?:info|indication)/, 'diagnos[ei]s|\\bdx\\b|impression|assessment|clinical\\s*(?:information|indication)')).slice(0, 500);
  // Specialty/service requested — from an explicit "Referred To/Service Requested/Consult to" field only
  // (NOT a bare "Specialty" word, which false-matches a form's "SPECIALTY REFERRAL FORM" title).
  const specialty = titleCase(field(kv, text, /referred\s*to|refer\s*to|service\s*requested|requested\s*(?:specialty|service)|consult(?:ation)?\s*(?:to|with)|type of (?:consult|referral)/, 'referred\\s*to|refer\\s*to|service\\s*requested|requested\\s*(?:specialty|service)|consult(?:ation)?\\s*(?:to|with)|type of (?:consult|referral)')).slice(0, 100);

  // ICD-10-CM codes anywhere in the diagnosis text or (fallback) the whole document.
  const icdSource = `${diagnosisText} ${reason}`.trim() || text;
  const icdCodes = [...new Set((icdSource.match(ICD_RE) || []).map((c) => c.toUpperCase()))].slice(0, 20);

  // Insurance: payer + member id (best-effort, deterministic labels).
  const insurancePayer = titleCase(field(kv, text, /insurance|payer|payor|health\s*plan|coverage|carrier/, 'insurance(?:\\s*(?:carrier|company|plan))?|payer|payor|health\\s*plan|coverage')).slice(0, 120);
  const memberId = clean(field(kv, text, /(?:member|subscriber|policy|insurance|plan)\s*(?:id|no|number|#)|\bid\s*(?:no|number|#)/, '(?:member|subscriber|policy|insurance)\\s*(?:id|no|number|#)')).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);

  // Urgency: STAT > urgent > routine (explicit words only; default routine, coder confirms).
  const hay = `${text}`.toLowerCase();
  const urgency = URGENT_RE.test(hay) ? 'stat' : URGENT2_RE.test(hay) ? 'urgent' : 'routine';

  const patient = { name: patientName, dob, mrn, sex, phone: patientPhone };
  const referring = { provider: referringProvider, npi: referringNpi, org: referringOrg, fax: referringFax };
  const referral = { reason, diagnosis: diagnosisText, icdCodes, specialty, urgency };
  const insurance = (insurancePayer || memberId) ? [{ payer: insurancePayer, memberId }] : [];

  // Confidence = how many of the core identity fields were found (transparency; never affects the values).
  const core = [patientName, dob, mrn, referringProvider || referringOrg, reason || diagnosisText];
  const found = core.filter(Boolean).length;
  return {
    patient, referring, referral, insurance,
    confidence: Math.round((found / core.length) * 100),
    fieldsFound: found,
    hasPatient: !!(patientName && (dob || mrn)),
  };
}

/**
 * DETERMINISTIC end-to-end: OCR the fax document, then parse referral fields. Real-time. Throws only if
 * OCR is unreachable/times out; a document with no recognizable fields returns an all-empty structure
 * (never fabricated). `raw` unused externally — kept internal.
 */
export async function extractReferralFax({ buffer, contentType = 'application/pdf', fileName = 'fax.pdf' }) {
  if (!ocrEnabled()) return null; // OCR not configured → caller keeps the fax + document, no fabrication
  const { kv, text } = await ocrExtractRaw({ buffer, contentType, fileName });
  const parsed = parseReferralText({ kv, text });
  logger.info({ fieldsFound: parsed.fieldsFound, confidence: parsed.confidence, hasPatient: parsed.hasPatient }, 'deterministic referral fax extraction complete');
  return { ...parsed, textLen: (text || '').length };
}
