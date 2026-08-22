import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { lookupFacility, nppesEnabled } from './nppesService.js';

/**
 * Open-source extractor: talks to the Python OCR microservice (PP-StructureV2 +
 * docTR), then maps its structured OCR (key/value pairs + text) into the
 * `{ demographics, insurance, facility, confidence }` suggestion shape used by
 * the patient face sheet. All medical field logic + validation lives here (one
 * place), so the Python service stays a generic structured-OCR provider.
 * AWS Textract is NOT used — extraction is fully open-source.
 *
 * Human-in-the-loop: results are suggestions only, never auto-committed.
 */
export const ocrEnabled = () => !!config.ocr.serviceUrl;

/* ---- shared normalizers --------------------------------------------------- */
function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
function cleanName(s) { return String(s || '').replace(/[^A-Za-z',.\- ]/g, '').replace(/\s+/g, ' ').trim(); }
function parseName(full) {
  const src = cleanName(full);
  if (!src) return {};
  let firstName = '', lastName = '';
  if (src.includes(',')) {
    const [l, rest] = src.split(',');
    firstName = ((rest || '').trim().split(/\s+/)[0] || '').replace(/\.$/, '');
    lastName = (l || '').trim();
  } else {
    const toks = src.split(/\s+/);
    if (toks.length >= 2) { firstName = toks[0]; lastName = toks[toks.length - 1]; }
    else firstName = src;
  }
  return { firstName: titleCase(firstName), lastName: titleCase(lastName) };
}
function parseAddress(full) {
  const s = String(full || '').trim();
  if (!s) return {};
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  const out = {};
  if (parts[0]) out.address = titleCase(parts[0]);
  if (parts[1]) out.city = titleCase(parts[1]);
  const tail = parts.slice(2).join(' ');
  const sm = tail.match(/\b([A-Za-z]{2})\b/);
  if (sm) out.state = sm[1].toUpperCase();
  const zm = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zm) out.zip = zm[1];
  return out;
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function normDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) { let y = m[3]; if (y.length === 2) y = (Number(y) > 40 ? '19' : '20') + y; return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
  m = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return '';
}
function normGender(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/^m|male/.test(s)) return 'male';
  if (/^f|female/.test(s)) return 'female';
  if (s.startsWith('o')) return 'other';
  return '';
}
/** Strip any HTML tags/entities from a value so no markup reaches a form field. */
function stripHtml(v) {
  return typeof v === 'string'
    ? v.replace(/<[^>]*>/g, '').replace(/&(nbsp|amp|lt|gt|quot|apos|#\d+);/gi, ' ').replace(/\s+/g, ' ').trim()
    : v;
}
function sanitizeObj(obj) { for (const k of Object.keys(obj)) obj[k] = stripHtml(obj[k]); return obj; }

const NON_INS = /^(patient liability|self\s?pay|private( pay)?|coins(urance)?|none|n\/?a|unknown|null|-+)$/i;
// Broader noise test for the secondary payer line (may be a longer phrase).
const NON_INS_CONTAINS = /coins|patient liability|self\s?pay|private|deductible|^null$/i;
const cleanPayer = (p) => { const s = String(p || '').trim(); return NON_INS.test(s) ? '' : s; };

/* ---- PCC "ADMISSION RECORD" face-sheet text parser ------------------------
 * PointClickCare face sheets render as a label/value grid; PP-OCR returns the
 * text in reading order, so we anchor on the section labels and pull the values
 * directly. This is the primary path for face sheets; generic KV is a fallback.
 */
function between(T, startRe, endRe) {
  const s = T.search(startRe);
  if (s < 0) return '';
  const rest = T.slice(s);
  const e = rest.slice(1).search(endRe);
  return e < 0 ? rest : rest.slice(0, e + 1);
}

function parsePCC(text) {
  const T = text.replace(/\r/g, '');
  const demographics = {};
  const insurance = [];

  // --- Name: first "Last, First" between the Resident Name label and address.
  const nameWin = between(T, /resident name/i, /previous (address|phone)/i) || T;
  const nm = nameWin.match(/^\s*([A-Z][A-Za-z'’.\-]+),\s+([A-Z][A-Za-z'’.\- ]+?)\s*$/m);
  if (nm) { const p = parseName(`${nm[1]}, ${nm[2]}`); if (p.firstName) demographics.firstName = p.firstName; if (p.lastName) demographics.lastName = p.lastName; }

  // --- DOB + Sex: values follow the "Sex ... Birthdate" label block.
  const afterSex = T.slice(Math.max(0, T.search(/\bSex\b/i)));
  const dm = afterSex.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
  const dob = dm ? normDate(dm[1]) : '';
  if (dob) demographics.dob = dob;
  const gm = afterSex.match(/^\s*(m|male|f|female)\s*$/im);
  const gender = gm ? normGender(gm[1]) : '';
  demographics.gender = gender || 'unknown';

  // --- SSN: unique ###-##-#### pattern.
  const sm = T.match(/\b(\d{3}-\d{2}-\d{4})\b/);
  if (sm) demographics.ssn = sm[1];

  // --- Address: first single-line "street, city, ST, zip".
  const am = T.match(/\d{1,6}\s+[A-Za-z0-9.\-# ]+,\s*[A-Za-z .]+,\s*[A-Z]{2},?\s*\d{5}(?:-\d{4})?/);
  if (am) {
    const a = parseAddress(am[0]);
    if (a.address) demographics.address = a.address;
    if (a.city) demographics.city = a.city;
    if (a.state) demographics.state = a.state;
    if (a.zip) demographics.zip = a.zip;
  }

  // --- Phone: patient phone lives between the address and the Sex block.
  const phoneWin = between(T, /previous address/i, /\bSex\b/i) || '';
  const pm = phoneWin.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
  if (pm) demographics.phone = pm[0].trim();

  // --- Insurance: PAYER INFORMATION block lists payer tiers with inline values.
  const blk = between(T, /payer information/i, /other information/i) || '';
  for (const ins of parsePayers(blk)) insurance.push(ins);

  // Medicare Beneficiary ID (MBI): patient-level Medicare identifier — attach it
  // to the Medicare payer row (or primary), never fabricated.
  const mbi = parseMBI(T);
  if (mbi) {
    const medRow = insurance.find((x) => /medicare/i.test(x.payer));
    if (medRow) medRow.mbi = mbi;
    else if (insurance.length) insurance[0].mbi = mbi;
    else insurance.push({ type: 'primary', payer: 'Medicare', memberId: '', group: '', planType: '', mbi });
  }

  const facility = parseFacility(T);

  return { demographics, insurance, facility };
}

/** Medicare Beneficiary Identifier — 11 chars, starts digit + letter (CMS
 * format). Anchored near the "Beneficiary ID" label; normalized to uppercase. */
function parseMBI(T) {
  const region = between(T, /beneficiary id/i, /payer information/i) || T;
  const m = region.match(/\b([0-9][A-Za-z][A-Za-z0-9]{9})\b/);
  return m ? m[1].toUpperCase() : '';
}

/** SNF facility details: name + address from the header, admit date / room /
 * resident # from the RESIDENT INFORMATION block. Only anchored, validated
 * values — never positional guesses. */
function parseFacility(T) {
  const fac = {};
  const head = between(T, /admission record/i, /resident information/i) || '';
  const headLines = head.split('\n').map((s) => s.trim()).filter(Boolean);

  // Facility name: first real line after "ADMISSION RECORD" (skip dates/timestamps).
  for (const ln of headLines) {
    if (/^admission record$/i.test(ln)) continue;
    if (/\d{1,2}[:/]\d/.test(ln) || /^[A-Za-z]{3,}\.?\s+\d{1,2},?\s+\d{4}/.test(ln)) continue;
    fac.facilityName = ln;
    break;
  }
  // Facility address: "City, ST zip" line + the street line above it.
  const cityLine = head.match(/^([A-Za-z .'\-]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?\s*$/m);
  if (cityLine) {
    fac.city = titleCase(cityLine[1].trim());
    fac.state = cityLine[2];
    fac.zip = cityLine[3];
    const ci = headLines.findIndex((l) => l === cityLine[0].trim());
    if (ci > 0 && /\d/.test(headLines[ci - 1])) fac.address = titleCase(headLines[ci - 1]);
  }

  // RESIDENT INFORMATION block: admit date, room/bed, resident #.
  const win = between(T, /resident information/i, /previous (address|phone)/i) || '';
  const dm = win.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
  if (dm) fac.admitDate = normDate(dm[1]);
  const rm = win.match(/\b(\d{2,4}-[A-Z0-9]{1,4})\b/);
  if (rm) fac.room = rm[1];
  const wl = win.split('\n').map((s) => s.trim()).filter(Boolean);
  const last = wl[wl.length - 1];
  if (last && /^[A-Za-z0-9\-]{3,15}$/.test(last) && !/\//.test(last) && last !== fac.room) fac.residentId = last;

  return fac;
}

/** Extract every real payer tier (primary/secondary/…) from the PAYER block,
 * with its member id + group, dropping cost-sharing/noise rows. */
function parsePayers(blk) {
  const markers = [];
  const re = /(primary|second(?:ary)?|third|fourth|fifth)\s*payer\s+([^\n]+)/gi;
  let m;
  while ((m = re.exec(blk))) markers.push({ idx: m.index, name: m[2].trim() });
  const rows = [];
  for (let i = 0; i < markers.length; i++) {
    const seg = blk.slice(markers[i].idx, i + 1 < markers.length ? markers[i + 1].idx : undefined);
    const name = cleanPayer(markers[i].name);
    if (!name || NON_INS_CONTAINS.test(markers[i].name)) continue;
    // Value must sit on the SAME line as its label (never spill onto the next).
    const idm = seg.match(/(?:policy|medicaid|medicare)\s*#[ \t]*:?[ \t]*([A-Za-z0-9]+)/i);
    const memberId = idm && !/^null$/i.test(idm[1]) ? idm[1] : '';
    const gm = seg.match(/group\s*#[ \t]*:?[ \t]*([A-Za-z0-9]+)/i);
    const group = gm && !/^null$/i.test(gm[1]) ? gm[1] : '';
    rows.push({ payer: name, memberId, group });
  }
  const seen = new Set();
  const tiers = ['primary', 'secondary', 'tertiary'];
  const out = [];
  for (const r of rows) {
    const k = r.payer.toLowerCase();
    if (seen.has(k) || out.length >= tiers.length) continue; // schema allows 3 tiers
    seen.add(k);
    out.push({ type: tiers[out.length], payer: r.payer, memberId: r.memberId, group: r.group, planType: '', mbi: '' });
  }
  return out;
}

/* ---- KV / text field extraction ------------------------------------------ */
/** Flatten all pages' KV pairs + build one big text blob for regex fallback. */
function flatten(pages) {
  const kv = [];
  let text = '';
  for (const p of pages || []) {
    for (const pair of p.kv || []) kv.push({ key: String(pair.key || '').trim(), value: String(pair.value || '').trim(), conf: Number(pair.conf || 0) });
    if (p.text) text += (text ? '\n' : '') + p.text;
  }
  return { kv, text };
}

/** First KV whose key matches any of the label regexes (and passes an optional guard). */
function pick(kv, labels, { avoid } = {}) {
  for (const { key, value, conf } of kv) {
    const k = key.toLowerCase();
    if (avoid && avoid.test(k)) continue;
    if (labels.some((rx) => rx.test(k)) && value) return { value, conf };
  }
  return { value: '', conf: 0 };
}

/* ---- CONTACTS table (geometric row/column reconstruction) ----------------
 * The CONTACTS section is a table (Name | Contact Type | Relationship | Address
 * | Phone/Email). OCR flattens it, so we rebuild rows from the line bounding
 * boxes: columns are located from the header positions (dynamic, not fixed),
 * each person NAME anchors a contact, and its relationship/phone/email are read
 * from the same row band. The patient themselves ("Self") is excluded.
 */
const KNOWN_REL = /\b(spouse|wife|husband|son|daughter|sister|brother|mother|father|parent|guardian|friend|nephew|niece|aunt|uncle|grandson|granddaughter|grandchild|cousin|partner|caregiver|self|next of kin|significant other)\b/i;

function isPersonName(t) { return /^[A-Za-z][A-Za-z'’.\-]+,\s+[A-Za-z]/.test(String(t).trim()); }
function fmtPhone(t) { const m = String(t || '').match(/(\d{3})\D*(\d{3})\D*(\d{4})/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : ''; }
function emailIn(t) { const m = String(t || '').match(/[\w.\-]+@[\w.\-]+\.\w{2,}/); return m ? m[0] : ''; }
const cx = (b) => (b[0] + b[2]) / 2;

function parseContacts(pages, demographics = {}) {
  const page = (pages || []).find((p) => (p.ppLines || []).some((l) => l.text.trim().toUpperCase() === 'CONTACTS'));
  if (!page) return [];
  const lines = page.ppLines || [];
  const hdr = lines.find((l) => l.text.trim().toUpperCase() === 'CONTACTS');
  const cy = hdr.box[1];
  const endLine = lines.filter((l) => l.box[1] > cy + 20).find((l) => /diagnosis information|care providers|payer information|other information/i.test(l.text));
  const ey = endLine ? endLine.box[1] : Infinity;

  // Locate column x-centres from the header row (just below "CONTACTS").
  const cols = [];
  for (const [key, lab] of [['name', 'Name'], ['type', 'Contact Type'], ['rel', 'Relationship'], ['addr', 'Address'], ['phone', 'Phone/?Email|Phone']]) {
    const h = lines.find((l) => l.box[1] > cy && l.box[1] < cy + 55 && new RegExp(`^(${lab})$`, 'i').test(l.text.trim()));
    if (h) cols.push({ key, x: cx(h.box) });
  }
  if (cols.length < 3) return []; // not enough structure to be accurate
  const colOf = (l) => cols.reduce((best, c) => (Math.abs(cx(l.box) - c.x) < Math.abs(cx(l.box) - best.x) ? c : best), cols[0]).key;

  const isHeader = (t) => /^(name|contact type|relationship|address|phone\/?email|phone)$/i.test(t.trim());
  const content = lines.filter((l) => l.box[1] > cy + 20 && l.box[1] < ey && l.text.trim() && !isHeader(l.text));
  const names = content.filter((l) => colOf(l) === 'name' && isPersonName(l.text)).sort((a, b) => a.box[1] - b.box[1]);
  if (!names.length) return [];

  const pLast = (demographics.lastName || '').toLowerCase();
  const pFirst = (demographics.firstName || '').toLowerCase();
  const out = [];
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    const y0 = names[i].box[1] - 14;
    const y1 = i + 1 < names.length ? names[i + 1].box[1] - 14 : ey;
    const band = content.filter((l) => l.box[1] >= y0 && l.box[1] < y1);
    const col = (k) => band.filter((l) => colOf(l) === k).map((l) => l.text.trim());
    const nm = parseName(names[i].text);
    const relRaw = col('rel').find((t) => KNOWN_REL.test(t)) || col('rel')[0] || '';
    const phoneLine = col('phone').find((t) => /\d{3}\D*\d{3}\D*\d{4}/.test(t)) || '';
    const email = emailIn(col('phone').find((t) => /@/.test(t)) || band.map((l) => l.text).find((t) => /@/.test(t)) || '');
    const isSelf = /^self$/i.test(relRaw.trim()) || (nm.firstName.toLowerCase() === pFirst && nm.lastName.toLowerCase() === pLast && pFirst);
    if (isSelf) continue;
    const name = `${nm.firstName} ${nm.lastName}`.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const contact = { name };
    if (relRaw && KNOWN_REL.test(relRaw)) contact.relationship = titleCase((relRaw.match(KNOWN_REL) || [''])[0]);
    else if (relRaw && !/emergency|responsible|guardian|party|financial/i.test(relRaw)) contact.relationship = titleCase(relRaw);
    const phone = fmtPhone(phoneLine);
    if (phone) contact.phone = phone;
    if (email) contact.email = email;
    out.push(contact);
  }
  return out.slice(0, 6);
}

/** Value directly beneath a label, in the same column — used for "Admitted From"
 * / "Admission Location" whose values sit under the label in the grid. Returns
 * '' when nothing valid is beneath (never a neighbouring field's value). */
function valueBelowLabel(lines, labelRe, { maxDy = 42, xtol = 95 } = {}) {
  const lab = lines.find((l) => labelRe.test(l.text.trim()));
  if (!lab) return '';
  const lx = cx(lab.box);
  const looksLikeField = (t) => /(#|\bid\b|beneficiary|number|\bssn\b|security|medicaid|medicare|birth place|citizenship|maiden|managed)/i.test(t);
  const v = lines
    .filter((l) => l !== lab && l.box[1] > lab.box[1] + 8 && l.box[1] < lab.box[1] + maxDy && Math.abs(cx(l.box) - lx) < xtol && l.text.trim())
    .sort((a, b) => a.box[1] - b.box[1])[0];
  if (!v) return '';
  const t = v.text.trim();
  return looksLikeField(t) ? '' : t;
}

/** SNF facility fields that live under labels in the RESIDENT INFORMATION grid. */
function parseFacilityGeo(pages) {
  const page = (pages || []).find((p) => (p.ppLines || []).some((l) => /admitted from/i.test(l.text)));
  if (!page) return {};
  const lines = page.ppLines || [];
  const out = {};
  const from = valueBelowLabel(lines, /^admitted from$/i);
  const loc = valueBelowLabel(lines, /^admission location$/i);
  if (from) out.admittedFrom = titleCase(from);
  if (loc) out.admissionLocation = loc.replace(/^[-\s]+/, '').trim();
  return out;
}

/**
 * Build suggestions ONLY from the deterministic PCC face-sheet parse — no
 * generic guessing, no fabricated fallbacks. If a document is not a recognizable
 * PCC face sheet, we return nothing rather than inventing values (the provider
 * fills it in manually). Every returned field was located by an anchored pattern
 * and format-validated.
 */
function toSuggestions({ text }) {
  const isPCC = /resident information|payer information|admission record/i.test(text);
  if (!isPCC) return { demographics: {}, insurance: [], facility: {}, confidence: {} };
  const { demographics, insurance, facility } = parsePCC(text);
  // Guarantee no markup ever reaches a form field (defense-in-depth).
  sanitizeObj(demographics); sanitizeObj(facility); insurance.forEach(sanitizeObj);
  const confidence = {};
  Object.keys(demographics).forEach((k) => { confidence[k] = 90; });
  Object.keys(facility).forEach((k) => { confidence[`facility_${k}`] = 90; });
  insurance.forEach((_, i) => { confidence[`insurance${i}`] = 90; });
  return { demographics, insurance, facility, confidence };
}

/**
 * Automatic SNF facility enrichment: use the extracted facility NAME (+ the best
 * available city/state) to look up the official NPI + address in the NPPES
 * registry. Fills only fields the face sheet did NOT provide — never overrides
 * document data — and only when the registry match is unambiguous.
 */
async function enrichFacilityFromRegistry(suggestions) {
  try {
    if (!nppesEnabled()) return;
    const fac = suggestions.facility;
    if (!fac || !fac.facilityName) return;
    const reg = await lookupFacility({
      name: fac.facilityName,
      city: fac.city || suggestions.demographics?.city || '',
      state: fac.state || suggestions.demographics?.state || '',
    });
    if (!reg) return;
    for (const [k, v] of Object.entries(reg)) {
      if (v && !String(fac[k] || '').trim()) fac[k] = v;
    }
    sanitizeObj(fac);
    Object.keys(fac).forEach((k) => { suggestions.confidence[`facility_${k}`] = suggestions.confidence[`facility_${k}`] || 92; });
  } catch (e) {
    logger.warn({ err: e.message }, 'NPPES facility enrichment skipped');
  }
}

/* ---- HTTP call to the OCR microservice ----------------------------------- */
export async function extractDocument({ buffer, contentType, fileName }) {
  if (!config.ocr.serviceUrl) throw Object.assign(new Error('Document extraction is not configured.'), { status: 503, code: 'OCR_DISABLED' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ocr.timeoutMs);
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), fileName || 'document');
    const headers = {};
    if (config.ocr.apiKey) headers['X-OCR-Key'] = config.ocr.apiKey;

    const resp = await fetch(`${config.ocr.serviceUrl.replace(/\/$/, '')}/extract`, {
      method: 'POST', body: form, headers, signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw Object.assign(new Error(`OCR service error (${resp.status}). ${detail.slice(0, 200)}`), { status: resp.status === 415 ? 400 : 502, code: 'OCR_UPSTREAM' });
    }
    const data = await resp.json();
    const pages = data.pages || [];
    const suggestions = toSuggestions(flatten(pages));
    // Facility fields that need geometry (values sit under their labels).
    const facGeo = parseFacilityGeo(pages);
    for (const [k, v] of Object.entries(facGeo)) { if (v && !suggestions.facility[k]) suggestions.facility[k] = v; }
    sanitizeObj(suggestions.facility);
    suggestions.emergencyContacts = parseContacts(pages, suggestions.demographics);
    suggestions.emergencyContacts.forEach(sanitizeObj);
    await enrichFacilityFromRegistry(suggestions);
    return suggestions;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Extraction timed out — try a clearer scan.'), { status: 504, code: 'EXTRACT_TIMEOUT' });
    if (!e.status) logger.error({ err: e.message }, 'OCR extraction error');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
