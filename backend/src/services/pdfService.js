import PDFDocument from 'pdfkit';
import { NOTE_TITLES, SECTION_LABELS, NOTE_LABEL_OVERRIDES } from './noteDocumentService.js';

/**
 * Enterprise PDF generator for downloadable EHR documents — clinical notes (medical
 * records), the patient Face Sheet, and benefits/eligibility. Every document is a
 * REAL, structured, text-based PDF (pdfkit; selectable Helvetica text, no canvas/
 * raster) and every page 1 carries the facility logo with the facility address
 * directly beneath it. Not a form — the output is a flat, non-editable record.
 */

// Black & white only — a payer-ready medical record. The facility logo (an embedded
// image) keeps its own colors; everything the PDF draws is grayscale.
const NAVY = '#111111'; // primary headings / values
const BLUE = '#000000'; // document title / sub-labels
const INK = '#1A1A1A';  // body text
const MUTED = '#565656'; // labels / secondary text
const LINE = '#BFBFBF';  // rules / table borders
const PANEL = '#EEEEEE'; // section bars / table header fill

const S = (v) => (v == null ? '' : String(v));
// mm/dd/yyyy for any date-like input: an ISO 'YYYY-MM-DD…' (parsed literally, no
// timezone shift), a full JS timestamp/Date, or a parseable string. Anything not a
// date is returned untouched so free-text values pass through cleanly.
const usDate = (d) => {
  const s = S(d).trim();
  if (!s) return '';
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  const t = new Date(s);
  if (!Number.isNaN(t.getTime()) && /\d{4}/.test(s)) {
    return `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}/${t.getFullYear()}`;
  }
  return s;
};

/** Create a Letter document + a promise that resolves to the finished Buffer. */
function createDoc({ title, author }) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 54, bottom: 70, left: 54, right: 54 },
    bufferPages: true,
    info: { Title: title || 'Medical Record', Author: author || 'Grelin Health', Producer: 'Grelin Health EHR' },
  });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
}

const CW = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const ML = (doc) => doc.page.margins.left;

/** Facility letterhead, left-aligned and stacked: logo on top, then the facility
 *  name beneath it, then the address beneath that — properly spaced, no overlap,
 *  with a rule closing the block. Mirrors a real medical-record header. */
function brandHeader(doc, facility = {}, logoBuffer = null) {
  const w = CW(doc); const x = ML(doc);
  if (logoBuffer) {
    try {
      const iw = 130; const ih = 52;
      doc.image(logoBuffer, x, doc.y, { fit: [iw, ih], align: 'left', valign: 'top' });
      doc.y += ih + 10; // clear the logo so the name never overlaps it
    } catch { /* unsupported image (e.g. raw SVG) — name-only header */ }
  }
  doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text(facility.name || 'Medical Facility', x, doc.y, { width: w });
  const cityLine = [facility.city ? `${facility.city},` : '', facility.state || '', facility.zip || ''].filter(Boolean).join(' ').trim();
  const addr = [facility.address, cityLine].filter(Boolean).join(' · ');
  if (addr) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(addr, x, doc.y + 3, { width: w });
  const contact = [facility.npi ? `NPI ${facility.npi}` : '', facility.phone || ''].filter(Boolean).join('  ·  ');
  if (contact) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(contact, x, doc.y + 2, { width: w });
  doc.y += 10;
  const ry = doc.y;
  doc.moveTo(x, ry).lineTo(x + w, ry).lineWidth(1).strokeColor(LINE).stroke();
  doc.moveDown(0.7);
}

function docTitle(doc, title, sub) {
  const w = CW(doc); const x = ML(doc);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(BLUE).text(title, x, doc.y, { width: w, align: 'center' });
  if (sub) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(sub, x, doc.y + 1, { width: w, align: 'center' });
  doc.moveDown(0.7);
}

function sectionBar(doc, label) {
  const w = CW(doc); const x = ML(doc);
  if (doc.y > doc.page.height - 120) doc.addPage();
  const h = 18;
  doc.rect(x, doc.y, w, h).fill(PANEL);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY).text(label.toUpperCase(), x + 8, doc.y + 5, { width: w - 16 });
  doc.y += h + 6;
  doc.fillColor(INK);
}

/** Two-column key/value facts. `pairs` = [[k,v], …]; skips empty values. */
function kvGrid(doc, pairs, cols = 2) {
  const items = pairs.filter(([, v]) => S(v).trim() !== '');
  if (!items.length) return;
  const w = CW(doc); const x = ML(doc); const gap = 14;
  const colW = (w - gap * (cols - 1)) / cols;
  let row = 0; let col = 0; let rowY = doc.y; let rowH = 0;
  for (const [k, v] of items) {
    const cx = x + col * (colW + gap);
    const kH = doc.font('Helvetica-Bold').fontSize(7.5).heightOfString(k.toUpperCase(), { width: colW });
    const vH = doc.font('Helvetica').fontSize(10).heightOfString(S(v), { width: colW });
    const cellH = kH + vH + 6;
    if (col === 0 && rowY + cellH > doc.page.height - 90) { doc.addPage(); rowY = doc.y; }
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(k.toUpperCase(), cx, rowY, { width: colW });
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(S(v), cx, rowY + kH + 1, { width: colW });
    rowH = Math.max(rowH, cellH);
    col += 1;
    if (col >= cols) { col = 0; row += 1; rowY += rowH + 4; rowH = 0; }
  }
  doc.y = col === 0 ? rowY : rowY + rowH + 4;
  doc.moveDown(0.4);
}

function paragraph(doc, label, text) {
  const t = S(text).trim();
  if (!t) return;
  const w = CW(doc); const x = ML(doc);
  if (doc.y > doc.page.height - 110) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY).text(label, x, doc.y, { width: w });
  doc.font('Helvetica').fontSize(10).fillColor(INK).text(t, x, doc.y + 2, { width: w, align: 'left' });
  doc.moveDown(0.5);
}

/** Simple bordered table. headers/rows are string arrays; colFracs sum to 1. */
function table(doc, headers, rows, colFracs) {
  const w = CW(doc); const x = ML(doc);
  const fr = colFracs || headers.map(() => 1 / headers.length);
  const widths = fr.map((f) => f * w);
  const pad = 5;
  const drawRow = (cells, opts = {}) => {
    const font = opts.header ? 'Helvetica-Bold' : 'Helvetica';
    const size = opts.header ? 8 : 9;
    const hs = cells.map((c, i) => doc.font(font).fontSize(size).heightOfString(S(c), { width: widths[i] - pad * 2 }));
    const rh = Math.max(14, ...hs) + pad * 2;
    if (doc.y + rh > doc.page.height - 80) doc.addPage();
    const yy = doc.y;
    if (opts.header) doc.rect(x, yy, w, rh).fill(PANEL);
    let cx = x;
    cells.forEach((c, i) => {
      doc.font(font).fontSize(size).fillColor(opts.header ? NAVY : INK).text(S(c), cx + pad, yy + pad, { width: widths[i] - pad * 2 });
      cx += widths[i];
    });
    doc.moveTo(x, yy + rh).lineTo(x + w, yy + rh).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.y = yy + rh;
  };
  drawRow(headers, { header: true });
  rows.forEach((r) => drawRow(r));
  doc.moveDown(0.5);
}

function footers(doc, facilityName) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    // Writing in the bottom-margin band must NOT trigger an auto page-break.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const x = ML(doc); const w = CW(doc); const y = doc.page.height - 46;
    doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(`${facilityName || 'Grelin Health'}  ·  Confidential medical record`, x, y + 6, { width: w / 2, align: 'left', lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(`Page ${i + 1} of ${range.count}`, x + w / 2, y + 6, { width: w / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
  doc.flushPages();
}

const signature = (doc, signerName, signedAt) => {
  doc.moveDown(0.6);
  const x = ML(doc); const w = CW(doc);
  const y = doc.y; doc.moveTo(x, y).lineTo(x + w, y).lineWidth(1).strokeColor(LINE).stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(`Electronically signed by ${signerName || 'Provider'}`, x, doc.y, { width: w });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`Signed ${usDate(signedAt) || signedAt || ''} · Finalized and part of the billing record.`, x, doc.y + 1, { width: w });
};

/* ============================= Document builders ========================== */

const VITALS = [['temp', 'Temp °F'], ['hr', 'HR'], ['bp', 'BP'], ['rr', 'RR'], ['spo2', 'SpO2 %'], ['weight', 'Wt lb'], ['pain', 'Pain']];

export function buildNotePdf({ facility = {}, logoBuffer = null, patient = {}, note = {}, codes = { diagnoses: [], procedures: [] }, signerName, signedAt }) {
  const { doc, done } = createDoc({ title: `Medical Record — ${patient.name || 'Patient'}`, author: facility.name });
  brandHeader(doc, facility, logoBuffer);
  docTitle(doc, NOTE_TITLES[note.noteType] || 'Clinical Note', note.status === 'signed' ? null : 'DRAFT — not finalized');

  kvGrid(doc, [
    ['Patient', patient.name], ['MRN', patient.mrn], ['Encounter ID', patient.encounterNo],
    ['Date of Service', usDate(patient.encounterDate)], ['Date of Birth', usDate(patient.dob)],
  ], 3);

  const content = note.content || {};
  const vit = content.vitals || {};
  const vitLine = VITALS.map(([k, l]) => (vit[k] ? `${l}: ${vit[k]}` : null)).filter(Boolean);
  if (vitLine.length) { sectionBar(doc, 'Vital Signs'); doc.font('Helvetica').fontSize(10).fillColor(INK).text(vitLine.join('     '), ML(doc), doc.y, { width: CW(doc) }); doc.moveDown(0.5); }

  const sections = content.sections || {};
  // Render in the note's own template order (provider perspective) when present;
  // fall back to whatever key order the object carries.
  const order = Array.isArray(content.sectionOrder) && content.sectionOrder.length
    ? [...content.sectionOrder, ...Object.keys(sections).filter((k) => !content.sectionOrder.includes(k))]
    : Object.keys(sections);
  const keys = order.filter((k) => S(sections[k]).trim());
  if (keys.length) {
    // Use the note-type's own header overrides so the PDF headers read exactly like
    // the editor and the Word document (e.g. "Reason for Admission", not "Chief Complaint").
    const overrides = NOTE_LABEL_OVERRIDES[note.noteType] || {};
    sectionBar(doc, 'Clinical Note');
    for (const k of keys) paragraph(doc, overrides[k] || SECTION_LABELS[k] || k, sections[k]);
  }

  const rx = (content.prescriptions || []).filter((p) => p.drug);
  if (rx.length) {
    sectionBar(doc, 'Prescriptions');
    table(doc, ['Medication', 'Dose', 'Route', 'Frequency', 'Qty', 'Refills'],
      rx.map((p) => [p.drug, p.dose, p.route, p.frequency, p.quantity, p.refills]),
      [0.30, 0.14, 0.14, 0.20, 0.11, 0.11]);
    doc.moveDown(0.2);
    rx.filter((p) => p.sig).forEach((p) => doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(`Sig (${p.drug}): ${p.sig}`, ML(doc), doc.y, { width: CW(doc) }));
  }

  // Coded diagnoses & procedures (Medicare Part B billing). Diagnoses are captured SNOMED-first
  // and carry the billable ICD-10-CM; the primary diagnosis is marked. Real captured codes only.
  const dxs = (codes.diagnoses || []).filter((d) => d && d.icd);
  const pxs = (codes.procedures || []).filter((p) => p && p.cpt);
  if (dxs.length || pxs.length) {
    sectionBar(doc, 'Coded Diagnoses & Procedures — Medicare Part B');
    if (dxs.length) {
      // Primary first, then the rest, in captured order.
      const ordered = [...dxs].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
      table(doc, ['', 'ICD-10-CM', 'Diagnosis', 'SNOMED CT'],
        ordered.map((d) => [d.primary ? 'Primary' : '', d.icd, d.description || '', d.snomedCode ? String(d.snomedCode) : '']),
        [0.12, 0.15, 0.53, 0.20]);
      doc.moveDown(0.3);
    }
    if (pxs.length) {
      table(doc, ['CPT/HCPCS', 'Mod', 'Units', 'Procedure'],
        pxs.map((p) => [p.cpt, p.modifiers || '', String(p.units || 1), p.description || '']),
        [0.16, 0.10, 0.10, 0.64]);
      doc.moveDown(0.2);
    }
  }

  if (note.status === 'signed') signature(doc, signerName, signedAt);

  footers(doc, facility.name);
  doc.end();
  return done;
}

export function buildFaceSheetPdf({ facility = {}, logoBuffer = null, patient = {} }) {
  const demo = patient.demographics || {};
  const name = `${demo.firstName || ''} ${demo.lastName || ''}`.trim() || 'Patient';
  const { doc, done } = createDoc({ title: `Face Sheet — ${name}`, author: facility.name });
  brandHeader(doc, facility, logoBuffer);
  docTitle(doc, 'Patient Face Sheet', patient.mrn ? `MRN ${patient.mrn}` : null);

  sectionBar(doc, 'Demographics');
  kvGrid(doc, [
    ['Name', name], ['Date of Birth', usDate(demo.dob)], ['Gender', demo.gender],
    ['Phone', demo.phone], ['Email', demo.email],
    ['Address', [demo.address, [demo.city, demo.state].filter(Boolean).join(', '), demo.zip].filter(Boolean).join(' ')],
  ], 2);

  const snf = patient.facility || {};
  if (Object.values(snf).some((v) => S(v).trim())) {
    sectionBar(doc, 'SNF Facility & Admission');
    kvGrid(doc, [
      ['Facility', snf.facilityName], ['Facility NPI', snf.npi], ['Unit', snf.unit], ['Room', snf.room],
      ['Resident ID', snf.residentId], ['Admit date', usDate(snf.admitDate)], ['Admitted from', snf.admittedFrom],
      ['Admission location', snf.admissionLocation],
    ], 2);
  }

  const ins = (patient.insurance || []).filter((i) => i.payer || i.memberId || i.mbi);
  if (ins.length) {
    sectionBar(doc, 'Insurance');
    ins.forEach((p, i) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(BLUE).text(`${(p.type || `Policy ${i + 1}`).toUpperCase()}`, ML(doc), doc.y, { width: CW(doc) });
      doc.moveDown(0.1);
      kvGrid(doc, [
        ['Payer', p.payer], ['Payer ID', p.payerId], ['Member ID', p.memberId], ['MBI', p.mbi],
        ['Group', p.group], ['Plan type', p.planType],
      ], 3);
    });
  }

  const ec = (patient.emergencyContacts || []).filter((c) => c.name || c.phone);
  if (ec.length) {
    sectionBar(doc, 'Emergency Contacts');
    table(doc, ['Name', 'Relationship', 'Phone', 'Email'], ec.map((c) => [c.name, c.relationship, c.phone, c.email]), [0.3, 0.22, 0.22, 0.26]);
  }

  footers(doc, facility.name);
  doc.end();
  return done;
}

export function buildBenefitsPdf({ facility = {}, logoBuffer = null, patient = {}, summary = {}, verifiedAt }) {
  const s = summary || {};
  const { doc, done } = createDoc({ title: `Benefits — ${patient.name || 'Patient'}`, author: facility.name });
  brandHeader(doc, facility, logoBuffer);
  docTitle(doc, 'Benefits Verification', `Eligibility (X12 271)${verifiedAt ? ` · Verified ${usDate(verifiedAt)}` : ''}`);

  sectionBar(doc, 'Coverage');
  kvGrid(doc, [
    ['Status', s.statusLabel || s.status], ['Plan', s.plan?.name], ['Plan type', s.plan?.type],
    ['Payer', `${s.payer?.name || ''}${s.payer?.id ? ` · ${s.payer.id}` : ''}`],
    ['Effective date', usDate(s.plan?.begin)],
    [s.status === 'inactive' ? 'Termination date' : 'Through', usDate(s.plan?.end)],
    ['Date of service', usDate(s.plan?.serviceDate)],
  ], 2);

  const m = s.member || {};
  sectionBar(doc, 'Member');
  kvGrid(doc, [
    ['Member', m.name], ['Member ID', m.memberId], ['MBI / HIC', m.mbi], ['Date of birth', usDate(m.dob)],
    ['Group', m.group], ['PCP', s.pcp?.name],
  ], 2);

  const accs = [];
  (s.financial?.deductible || []).forEach((e) => accs.push(['Deductible', e]));
  (s.financial?.oop || []).forEach((e) => accs.push(['Out-of-pocket', e]));
  if (accs.length) {
    sectionBar(doc, 'Deductible & Out-of-Pocket');
    table(doc, ['Type', 'Level', 'Network', 'Total', 'Used', 'Remaining'],
      accs.map(([label, e]) => [label, e.level || '', e.network || '', e.annual || '', e.met || '', e.remaining || '']),
      [0.22, 0.16, 0.20, 0.14, 0.14, 0.14]);
  }

  const svcs = s.services || [];
  if (svcs.length) {
    sectionBar(doc, 'Coverage by Service');
    for (const svc of svcs) {
      if (doc.y > doc.page.height - 130) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BLUE).text(svc.name, ML(doc), doc.y, { width: CW(doc) });
      doc.moveDown(0.1);
      table(doc, ['Benefit', 'Level', 'Network', 'Coverage', 'Notes'],
        (svc.items || []).map((it) => [it.label, it.coverageLevel || '', it.network || '', `${it.value || ''}${it.per ? ` ${it.per}` : ''}`, (it.messages || []).join('; ') || it.note || '']),
        [0.18, 0.14, 0.16, 0.2, 0.32]);
    }
  }

  footers(doc, facility.name);
  doc.end();
  return done;
}
