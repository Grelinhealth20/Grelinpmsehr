import { pool } from '../db/pool.js';

/**
 * Real coding / claim-edit logic backed entirely by the CMS/AMA reference datasets loaded into
 * the DB (NCCI PTP/MUE, ICD age-sex & specificity edits, LCD/Article coverage, PDPM clinical
 * categories, CMS-HCC map, MPFS RVU). No fabricated rules — every check is a lookup against the
 * authoritative tables. Callers pass real claim data; findings cite the source table/row.
 */

const CURRENT_FY = 2026; // SNF fiscal year for PDPM lookups (FY runs Oct 1 – Sep 30)

// ICD tables are inconsistent: some store dotted (A18.14), some dotless (B9735). Try both forms.
function icdVariants(code) {
  const raw = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return [];
  const dotless = raw.replace(/\./g, '');
  const dotted = dotless.length > 3 ? `${dotless.slice(0, 3)}.${dotless.slice(3)}` : dotless;
  return [...new Set([raw, dotted, dotless])];
}
const norm = (c) => String(c || '').trim().toUpperCase();

/** PDPM clinical category for an ICD-10 primary/active diagnosis (per fiscal year). */
export async function lookupPdpm(icd, fy = CURRENT_FY) {
  const [rows] = await pool.query(
    'SELECT code, description, default_clinical_category, major_procedure_category, clinical_category_pt_ot, clinical_category_slp FROM pdpm_icd_codes WHERE fiscal_year = ? AND code IN (?) LIMIT 1',
    [fy, icdVariants(icd)]);
  const r = rows[0];
  if (!r) return null;
  return {
    code: r.code,
    description: r.description,
    primaryCategory: r.default_clinical_category,
    majorProcedureCategory: r.major_procedure_category,
    ptOtCategory: r.clinical_category_pt_ot,
    slpCategory: r.clinical_category_slp,
    // "Return To Provider" = not an acceptable SNF PDPM primary diagnosis.
    acceptablePrimary: (r.default_clinical_category || '').toLowerCase() !== 'return to provider',
  };
}

/** CMS-HCC categories a diagnosis maps to (risk-adjustment identification). */
export async function lookupHcc(icd, model = null) {
  const [rows] = await pool.query(
    `SELECT icd_code, model, hcc_category FROM icd_hcc_map WHERE icd_code IN (?) ${model ? 'AND model = ?' : ''}`,
    model ? [icdVariants(icd), model] : [icdVariants(icd)]);
  return rows.map((r) => ({ icd: r.icd_code, model: r.model, hcc: r.hcc_category }));
}

/** MPFS payment estimate for a HCPCS/CPT code. Real formula; GPCIs default to 1.0 (national). */
export async function estimatePayment(hcpcs, { workGpci = 1, peGpci = 1, mpGpci = 1, facility = false, modifier = '' } = {}, year = 2026) {
  const [rows] = await pool.query(
    'SELECT hcpcs, description, status_code, work_rvu, nonfac_pe_rvu, fac_pe_rvu, mp_rvu, conv_factor FROM mpfs_rvu WHERE year = ? AND hcpcs = ? AND modifier = ? LIMIT 1',
    [year, norm(hcpcs), modifier]);
  const r = rows[0];
  if (!r) return null;
  const pe = facility ? Number(r.fac_pe_rvu) : Number(r.nonfac_pe_rvu);
  const totalRvu = Number(r.work_rvu) * workGpci + pe * peGpci + Number(r.mp_rvu) * mpGpci;
  const cf = Number(r.conv_factor);
  return {
    hcpcs: r.hcpcs, description: r.description, statusCode: r.status_code,
    workRvu: Number(r.work_rvu), peRvu: pe, mpRvu: Number(r.mp_rvu), conversionFactor: cf,
    totalRvu: Number(totalRvu.toFixed(4)),
    allowedAmount: Number((totalRvu * cf).toFixed(2)),
    setting: facility ? 'facility' : 'non-facility',
  };
}

// ---- Claim scrubbing --------------------------------------------------------------------------

async function ncciPtpFindings(codes) {
  const findings = [];
  if (codes.length < 2) return findings;
  // Check every unordered pair in both column1/column2 orientations.
  const [rows] = await pool.query(
    'SELECT column1, column2, modifier_indicator FROM ncci_ptp WHERE column1 IN (?) AND column2 IN (?)',
    [codes, codes]);
  for (const r of rows) {
    if (r.column1 === r.column2) continue;
    findings.push({
      type: 'NCCI_PTP',
      severity: r.modifier_indicator === 0 ? 'error' : 'warning',
      column1: r.column1, column2: r.column2, modifierIndicator: r.modifier_indicator,
      message: r.modifier_indicator === 0
        ? `${r.column2} is bundled into ${r.column1} and cannot be billed together (no modifier override).`
        : r.modifier_indicator === 1
          ? `${r.column2} is bundled into ${r.column1}; separately payable only with an appropriate NCCI-associated modifier — 59, or the more specific XE/XS/XP/XU, on ${r.column2} when the services are truly distinct.`
          : `${r.column2}/${r.column1} PTP edit is inactive (indicator 9).`,
      source: 'ncci_ptp',
    });
  }
  return findings;
}

/**
 * CMS modifier guidance (deterministic): an E/M billed on the same claim as a MINOR procedure
 * (global 000/010) needs modifier 25 if it was a significant, separately identifiable service.
 * Suggestion only (the coder confirms medical documentation) — never an error.
 */
async function modifierFindings(lines) {
  const findings = [];
  const codes = [...new Set(lines.map((l) => norm(l.cpt)).filter(Boolean))];
  if (codes.length < 2) return findings;
  const em = codes.filter((c) => /^99\d{3}$/.test(c) && Number(c) >= 99202 && Number(c) <= 99499);
  if (!em.length) return findings;
  const [rows] = await pool.query(
    "SELECT hcpcs FROM mpfs_rvu WHERE year=2026 AND modifier='' AND hcpcs IN (?) AND global_days IN ('000','010')", [codes]);
  const minor = rows.map((r) => r.hcpcs).filter((p) => !em.includes(p));
  if (!minor.length) return findings;
  const emCode = em[0];
  const already = lines.some((l) => norm(l.cpt) === emCode && /\b25\b/.test(l.modifiers || ''));
  if (already) return findings;
  findings.push({ type: 'MODIFIER_25', severity: 'warning', code: emCode, suggestedModifier: '25',
    message: `E/M ${emCode} is billed with a minor procedure (${minor.join(', ')}) — append modifier 25 to ${emCode} if it was a significant, separately identifiable E/M service, or it may be denied as bundled.`,
    source: 'mpfs global period + CMS modifier 25 rule' });
  return findings;
}

async function mueFindings(lines) {
  const findings = [];
  const codes = lines.map((l) => norm(l.cpt)).filter(Boolean);
  if (!codes.length) return findings;
  const [rows] = await pool.query('SELECT code, mue_value, mai FROM ncci_mue WHERE code IN (?)', [codes]);
  const mue = new Map(rows.map((r) => [r.code, r]));
  for (const l of lines) {
    const m = mue.get(norm(l.cpt));
    const units = Number(l.units || 1);
    if (m && units > Number(m.mue_value)) {
      findings.push({
        type: 'NCCI_MUE', severity: 'error', code: norm(l.cpt), units, mueValue: Number(m.mue_value), mai: m.mai,
        message: `Units billed (${units}) exceed the MUE of ${m.mue_value} for ${norm(l.cpt)} (MAI ${m.mai}).`,
        source: 'ncci_mue',
      });
    }
  }
  return findings;
}

/**
 * NCCI add-on-code (AOC) edits: an add-on CPT may only be billed WITH an appropriate primary
 * code on the same claim. edit_type 1 = a specific primary from the listed set is required;
 * 2 = any primary (wildcard 'CCCCC'); 3 = advisory (MAC may allow others). Real ncci_aoc data.
 */
async function aocFindings(codes) {
  const findings = [];
  if (codes.length < 1) return findings;
  const [rows] = await pool.query(
    'SELECT addon_code, primary_code, edit_type FROM ncci_aoc WHERE addon_code IN (?)', [codes]);
  if (!rows.length) return findings;
  const byAddon = new Map();
  for (const r of rows) {
    if (!byAddon.has(r.addon_code)) byAddon.set(r.addon_code, { editType: r.edit_type, primaries: new Set() });
    byAddon.get(r.addon_code).primaries.add(r.primary_code);
  }
  for (const [addon, { editType, primaries }] of byAddon) {
    const others = codes.filter((c) => c !== addon);
    const ok = primaries.has('CCCCC') ? others.length > 0 : others.some((c) => primaries.has(c));
    if (ok) continue;
    const list = [...primaries].filter((p) => p !== 'CCCCC').slice(0, 8).join(', ');
    findings.push({ type: 'NCCI_AOC', severity: editType === 3 ? 'warning' : 'error', code: addon, editType,
      message: editType === 2
        ? `Add-on code ${addon} requires a primary procedure on the same claim — none is present.`
        : `Add-on code ${addon} cannot be billed without an appropriate primary code${list ? ` (e.g. ${list})` : ''} — none is present on the claim.`,
      source: 'ncci_aoc' });
  }
  return findings;
}

/**
 * POA (Present On Admission) reporting is a UB-04 INPATIENT concept, not a Part B professional
 * edit. We surface it as informational only: which submitted diagnoses are POA-exempt, relevant
 * if this encounter also feeds an inpatient claim. Real icd_poa_exempt list; never a Part B denial.
 */
async function poaFindings(dxList) {
  const findings = [];
  const variants = [...new Set(dxList.flatMap(icdVariants))];
  if (!variants.length) return findings;
  const [rows] = await pool.query('SELECT DISTINCT code FROM icd_poa_exempt WHERE code IN (?)', [variants]);
  for (const r of rows) {
    findings.push({ type: 'ICD_POA_EXEMPT', severity: 'info', code: r.code,
      message: `${r.code} is on the CMS POA-exempt list (informational — POA reporting applies to inpatient/UB-04 claims, not Part B professional claims).`,
      source: 'icd_poa_exempt' });
  }
  return findings;
}

// ICD-10-CM Excludes1 ("NOT CODED HERE") bundling — two conditions that per CMS can NEVER be
// reported together on the same claim. Loaded once from icd_instructional_notes and cached.
let _excludes1 = null;
async function getExcludes1() {
  if (_excludes1) return _excludes1;
  const [rows] = await pool.query(
    `SELECT applies_kind, applies_a, applies_b, target_kind, target_a, target_b, target_text
       FROM icd_instructional_notes WHERE note_type = 'excludes1' AND applies_a IS NOT NULL AND target_a IS NOT NULL`);
  _excludes1 = rows;
  return rows;
}
const cat3 = (c) => String(c || '').replace('.', '').slice(0, 3);
function icdInEntry(dx, kind, a, b) {
  const code = String(dx).replace('.', ''); const A = String(a || '').replace('.', ''); const B = String(b || '').replace('.', '');
  if (!A) return false;
  if (kind === 'r') { const c = cat3(dx); return c >= A.slice(0, 3) && c <= (B || A).slice(0, 3); }
  return code === A || code.startsWith(A); // point: the code itself or a more specific child
}
async function excludes1Findings(dxList) {
  const findings = [];
  const dxs = [...new Set(dxList.map(norm).filter(Boolean))];
  if (dxs.length < 2) return findings;
  const rules = await getExcludes1();
  const seen = new Set();
  for (const r of rules) {
    const appliesHits = dxs.filter((d) => icdInEntry(d, r.applies_kind, r.applies_a, r.applies_b));
    if (!appliesHits.length) continue;
    const targetHits = dxs.filter((d) => icdInEntry(d, r.target_kind, r.target_a, r.target_b));
    for (const a of appliesHits) {
      for (const t of targetHits) {
        if (a === t) continue;
        // Conservative: require at least one side to be a specific point code to avoid broad
        // range↔range false positives; those are surfaced as a softer warning.
        const pointInvolved = r.applies_kind !== 'r' || r.target_kind !== 'r';
        const key = [a, t].sort().join('|');
        if (seen.has(key)) continue; seen.add(key);
        findings.push({ type: 'ICD_EXCLUDES1', severity: pointInvolved ? 'error' : 'warning', code: a, conflictsWith: t,
          message: `ICD-10 Excludes1: ${a} and ${t} cannot be reported together on the same claim per CMS${r.target_text ? ` (${r.target_text})` : ''}.`,
          source: 'icd_instructional_notes' });
      }
    }
  }
  return findings;
}

async function ageSexFindings(dxList, patient) {
  const findings = [];
  if (!patient || (patient.age == null && !patient.sex)) return findings;
  for (const dx of dxList) {
    const [rows] = await pool.query(
      'SELECT code, allowed_sex, min_age, max_age FROM icd_age_sex_edits WHERE code IN (?) LIMIT 1', [icdVariants(dx)]);
    const r = rows[0]; if (!r) continue;
    if (r.allowed_sex && patient.sex && norm(patient.sex)[0] !== norm(r.allowed_sex)[0]) {
      findings.push({ type: 'ICD_SEX_EDIT', severity: 'error', code: r.code, allowedSex: r.allowed_sex,
        message: `${r.code} is restricted to sex ${r.allowed_sex}; patient sex is ${patient.sex}.`, source: 'icd_age_sex_edits' });
    }
    if (patient.age != null && r.min_age != null && r.max_age != null && (patient.age < r.min_age || patient.age > r.max_age)) {
      findings.push({ type: 'ICD_AGE_EDIT', severity: 'warning', code: r.code, ageRange: [r.min_age, r.max_age], patientAge: patient.age,
        message: `${r.code} expects age ${r.min_age}-${r.max_age}; patient age is ${patient.age}.`, source: 'icd_age_sex_edits' });
    }
  }
  return findings;
}

/**
 * Billability: every submitted diagnosis must be a valid-for-submission LEAF ICD-10-CM code.
 * A category/header (e.g. N18.3, E11) is rejected by payers — flag it and suggest billable children.
 * Uses the current icd10cm_valid set, so no false positives on valid leaf codes.
 */
async function icdBillableFindings(dxList) {
  const findings = [];
  const dxs = [...new Set(dxList.map(norm).filter(Boolean))];
  if (!dxs.length) return findings;
  const [valid] = await pool.query('SELECT code FROM icd10cm_valid WHERE code IN (?)', [dxs]);
  const billable = new Set(valid.map((r) => r.code));
  for (const dx of dxs) {
    if (billable.has(dx)) continue;
    const dotted = dx.includes('.') ? dx : (dx.length > 3 ? `${dx.slice(0, 3)}.${dx.slice(3)}` : dx);
    const [kids] = await pool.query('SELECT code FROM icd10cm_valid WHERE code LIKE ? ORDER BY code LIMIT 8', [`${dotted}%`]);
    const more = kids.map((r) => r.code);
    findings.push({ type: 'ICD_NOT_BILLABLE', severity: 'error', code: dx, moreSpecific: more,
      message: more.length
        ? `${dx} is not billable (category/header) — a more specific code is required (e.g. ${more.slice(0, 4).join(', ')}).`
        : `${dx} is not a valid billable ICD-10-CM code as submitted.`,
      source: 'icd10cm_valid' });
  }
  return findings;
}

async function specificityFindings(dxList) {
  const findings = [];
  for (const dx of dxList) {
    const [rows] = await pool.query(
      'SELECT unspec_code, description, specific_examples FROM icd_specificity_map WHERE unspec_code IN (?) LIMIT 1', [icdVariants(dx)]);
    const r = rows[0]; if (!r) continue;
    findings.push({ type: 'ICD_UNSPECIFIED', severity: 'info', code: r.unspec_code, description: r.description,
      moreSpecific: r.specific_examples, message: `${r.unspec_code} is unspecified; a more specific code may be available${r.specific_examples ? ` (e.g. ${r.specific_examples})` : ''}.`,
      source: 'icd_specificity_map' });
  }
  return findings;
}

/**
 * LCD/Article medical necessity from the OFFICIAL CMS MCD Article database (mcd_* tables), scoped
 * to the servicing MAC. jurisdiction='FL' (Medicare Part B, Central FL) restricts to First Coast
 * Service Options articles via mcd_contractor.is_first_coast. Detects both (a) an explicit
 * NON-COVERED diagnosis and (b) the absence of any covered diagnosis — both cause denials — and
 * surfaces the article's covered ICD-10s so the provider can select a supporting diagnosis.
 */
async function medicalNecessityFindings(lines, dxList, { jurisdiction = 'FL' } = {}) {
  const findings = [];
  const dxVariants = [...new Set(dxList.flatMap(icdVariants))];
  if (!dxVariants.length) return findings;
  const flOnly = String(jurisdiction).toUpperCase() === 'FL';
  const jLabel = flOnly ? 'First Coast (Central FL)' : 'all-jurisdiction';
  for (const l of lines) {
    const proc = norm(l.cpt); if (!proc) continue;
    // Articles that govern this procedure in the jurisdiction (official article↔HCPCS + contractor).
    const [arts] = flOnly
      ? await pool.query(
        `SELECT DISTINCT h.article_id FROM mcd_article_hcpc h
           JOIN mcd_article_x_contractor ax ON ax.article_id = h.article_id
           JOIN mcd_contractor c ON c.contractor_id = ax.contractor_id AND c.is_first_coast = 1
          WHERE h.hcpc_code = ?`, [proc])
      : await pool.query('SELECT DISTINCT article_id FROM mcd_article_hcpc WHERE hcpc_code = ?', [proc]);
    if (!arts.length) continue; // no governing coverage article in this jurisdiction
    const articleIds = arts.map((a) => a.article_id);

    // (a) A submitted diagnosis explicitly on the NON-COVERED list → definitive denial.
    const [noncov] = await pool.query(
      'SELECT DISTINCT icd_code FROM mcd_article_noncovered_icd WHERE article_id IN (?) AND icd_code IN (?)',
      [articleIds, dxVariants]);
    if (noncov.length) {
      findings.push({ type: 'MEDICAL_NECESSITY_NONCOVERED', severity: 'error', code: proc, articles: articleIds, jurisdiction: jLabel,
        message: `${proc}: diagnosis ${noncov.map((r) => r.icd_code).join(', ')} is on the ${jLabel} coverage article's NON-COVERED list — this line will be denied.`,
        source: 'mcd_article_noncovered_icd' });
      continue;
    }

    // (b) No submitted diagnosis on the covered list → denial for medical necessity.
    const [cov] = await pool.query(
      'SELECT DISTINCT article_id FROM mcd_article_covered_icd WHERE article_id IN (?) AND icd_code IN (?)',
      [articleIds, dxVariants]);
    if (!cov.length) {
      const [examples] = await pool.query(
        `SELECT m.icd_code, t.term AS icd_desc
           FROM mcd_article_covered_icd m
           LEFT JOIN terminology_cache t ON t.source = 'ICD10CM' AND t.code = m.icd_code
          WHERE m.article_id IN (?) GROUP BY m.icd_code ORDER BY m.icd_code LIMIT 12`, [articleIds]);
      const covered = examples.map((e) => ({ icd: e.icd_code, description: e.icd_desc || null }));
      const preview = covered.slice(0, 6).map((c) => c.icd).join(', ');
      findings.push({ type: 'MEDICAL_NECESSITY', severity: 'error', code: proc, articles: articleIds, jurisdiction: jLabel,
        coveredExamples: covered,
        message: `${proc} would be DENIED for medical necessity — none of the submitted diagnoses are on the ${jLabel} coverage article's covered list.${preview ? ` Supporting diagnoses include: ${preview}.` : ''}`,
        source: 'mcd_article_covered_icd + mcd_contractor' });
    }
  }
  return findings;
}

async function pdpmPrimaryFinding(primaryDx, fy) {
  if (!primaryDx) return [];
  const p = await lookupPdpm(primaryDx, fy);
  if (!p) return [];
  if (!p.acceptablePrimary) {
    return [{ type: 'PDPM_RTP', severity: 'error', code: p.code, category: p.primaryCategory,
      message: `${p.code} maps to PDPM clinical category "Return To Provider" — it is not an acceptable SNF primary diagnosis (I0020B).`,
      source: 'pdpm_icd_codes' }];
  }
  return [{ type: 'PDPM_CATEGORY', severity: 'info', code: p.code, category: p.primaryCategory,
    ptOt: p.ptOtCategory, slp: p.slpCategory,
    message: `${p.code} → PDPM clinical category "${p.primaryCategory}" (PT/OT: ${p.ptOtCategory}, SLP: ${p.slpCategory}).`,
    source: 'pdpm_icd_codes' }];
}

/**
 * Scrub a claim against all loaded edits. `claim`:
 *   { lines:[{cpt, modifiers?, units?}], diagnoses:[icd...], primaryDx?, patient:{age,sex}, fiscalYear? }
 * Returns { findings:[...], summary:{errors,warnings,info} }. Every finding cites its source table.
 */
export async function scrubClaim(claim = {}) {
  const lines = Array.isArray(claim.lines) ? claim.lines.filter((l) => l && l.cpt) : [];
  const codes = [...new Set(lines.map((l) => norm(l.cpt)).filter(Boolean))];
  const diagnoses = Array.isArray(claim.diagnoses) ? claim.diagnoses.filter(Boolean) : [];
  const fy = Number(claim.fiscalYear) || CURRENT_FY;

  const jurisdiction = claim.jurisdiction || 'FL'; // Medicare Part B, Central FL (First Coast)
  const checks = [
    ncciPtpFindings(codes),
    mueFindings(lines),
    aocFindings(codes),
    modifierFindings(lines),
    icdBillableFindings(diagnoses),
    ageSexFindings(diagnoses, claim.patient),
    specificityFindings(diagnoses),
    excludes1Findings(diagnoses),
    poaFindings(diagnoses),
    medicalNecessityFindings(lines, diagnoses, { jurisdiction }),
  ];
  // PDPM primary-diagnosis acceptability is a Part A (SNF PPS) check — only run it when a caller
  // explicitly asks (partA:true). Part B professional claims do not use PDPM.
  if (claim.partA && claim.primaryDx) checks.push(pdpmPrimaryFinding(claim.primaryDx, fy));
  const groups = await Promise.all(checks);
  const findings = groups.flat();
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings) summary[f.severity === 'error' ? 'errors' : f.severity === 'warning' ? 'warnings' : 'info'] += 1;
  return { findings, summary, checkedCodes: codes, checkedDiagnoses: diagnoses };
}
