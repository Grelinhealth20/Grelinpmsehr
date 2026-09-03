import {
  listEncounters, updateEncounterStatus, createStandaloneEncounter,
  listProviderPatients, listPatientEncounters, listClinicalRecords, latestPrescriptions,
  getEncounterDetails,
} from '../services/encounterService.js';
import { listChecks } from '../services/eligibilityService.js';
import {
  listNotes as listNotesSvc, createNote as createNoteSvc, getNote as getNoteSvc,
  updateNote as updateNoteSvc, signNote as signNoteSvc, amendSignedNote as amendNoteSvc,
  getNoteCodes as getNoteCodesSvc, saveNoteCodes as saveNoteCodesSvc, scrubNoteCodes as scrubNoteCodesSvc,
  predictCodes as predictCodesSvc,
} from '../services/encounterNoteService.js';
import {
  listNoteTypeTemplates, providerCanUseNoteType,
} from '../services/noteTemplateService.js';
import {
  listCustomTemplates as listCustomTpl, createCustomTemplate as createCustomTpl,
  updateCustomTemplate as updateCustomTpl, deleteCustomTemplate as deleteCustomTpl,
} from '../services/customTemplateService.js';
import { codingEnabledForNote } from '../services/facilityService.js';
import { generateTemplateDraft, aiEnabled } from '../services/aiTemplateService.js';
import { logAiUsage } from '../services/aiUsageService.js';
import {
  addEncounterDocument, getEncounterDocuments, encounterDocumentUrl, removeEncounterDocument,
} from '../services/encounterDocumentService.js';

const CODING_DISABLED = { error: 'The coding engine is turned off for this facility.', code: 'CODING_DISABLED' };
import { recordAudit } from '../services/auditService.js';
import { notePdf } from '../services/pdfExport.js';

/**
 * Backend-authoritative note-type templates (H&P / SOAP / Progress) — the SINGLE source
 * of truth for the note section structure. The editor fetches this to render; the same
 * section keys drive the signed document. Universal: every provider gets all three.
 */
export async function noteTemplates(req, res, next) {
  try {
    res.json({ noteTypes: listNoteTypeTemplates(), aiTemplates: aiEnabled() });
  } catch (err) { next(err); }
}

/**
 * AI-assisted custom-template DRAFT from a provider's description. Returns a validated draft only
 * (headings + guidance + checkboxes); the provider reviews and saves it through the normal create
 * endpoint, which persists it (owner-scoped) for future use. AI errors surface as clean client messages.
 */
export async function generateCustomTemplate(req, res, next) {
  const started = Date.now();
  const preview = String(req.body?.prompt || '').slice(0, 200);
  try {
    const draft = await generateTemplateDraft(req.body?.prompt);
    // Real-time AI usage log — actual OpenAI token spend, per request.
    await logAiUsage({ userId: req.authUserId, action: 'template.generate', model: draft.model, status: 'ok',
      usage: draft.usage, sections: draft.sections.length, latencyMs: Date.now() - started, promptPreview: preview });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.customTemplate.aiDraft', entityType: 'custom_note_template', ...ctx(req), metadata: { sections: draft.sections.length, totalTokens: draft.usage?.total || 0 } });
    const { usage, model, ...clean } = draft;
    res.json({ draft: clean });
  } catch (err) {
    // Log failures too (0 tokens unless the upstream billed) so the Super-Admin log is complete.
    await logAiUsage({ userId: req.authUserId, action: 'template.generate', status: 'error',
      errorCode: err.code || 'AI_ERROR', latencyMs: Date.now() - started, promptPreview: preview });
    if (err.code && String(err.code).startsWith('AI_')) return res.status(err.status || 502).json({ error: err.message, code: err.code });
    next(err);
  }
}

// ---- Custom (provider-authored) note templates — owner-scoped -----------------------------------
export async function listCustomTemplates(req, res, next) {
  try { res.json({ templates: await listCustomTpl(req.authUserId) }); } catch (err) { next(err); }
}
export async function createCustomTemplate(req, res, next) {
  try {
    const template = await createCustomTpl(req.authUserId, req.body || {});
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.customTemplate.create', entityType: 'custom_note_template', entityId: template.uuid, ...ctx(req), metadata: { name: template.label } });
    res.status(201).json({ template });
  } catch (err) {
    if (/heading|name|template/i.test(err.message) && !/database|sql/i.test(err.message)) return res.status(400).json({ error: err.message, code: 'INVALID_TEMPLATE' });
    next(err);
  }
}
export async function updateCustomTemplate(req, res, next) {
  try {
    const template = await updateCustomTpl(req.authUserId, req.params.uuid, req.body || {});
    if (!template) return res.status(404).json({ error: 'Template not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.customTemplate.update', entityType: 'custom_note_template', entityId: template.uuid, ...ctx(req) });
    res.json({ template });
  } catch (err) {
    if (/heading|name|template/i.test(err.message) && !/database|sql/i.test(err.message)) return res.status(400).json({ error: err.message, code: 'INVALID_TEMPLATE' });
    next(err);
  }
}
// ---- Encounter lab / imaging document attachments (S3-backed, per-encounter folders) ------------
export async function listEncounterDocs(req, res, next) {
  try {
    const r = await getEncounterDocuments({ encounterUuid: req.params.encounterUuid, userId: req.authUserId, kind: req.query.kind });
    if (r.forbidden) return res.status(404).json({ error: 'Encounter not found.', code: 'NOT_FOUND' });
    if (r.error) return res.status(r.status || 400).json({ error: r.error, code: r.code });
    res.json({ documents: r.documents });
  } catch (err) { next(err); }
}
export async function uploadEncounterDoc(req, res, next) {
  try {
    const r = await addEncounterDocument({ encounterUuid: req.params.encounterUuid, userId: req.authUserId, kind: req.query.kind || req.body.kind, file: req.file });
    if (r.forbidden) return res.status(404).json({ error: 'Encounter not found.', code: 'NOT_FOUND' });
    if (r.error) return res.status(r.status || 400).json({ error: r.error, code: r.code });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.document.upload', entityType: 'encounter', entityId: req.params.encounterUuid, ...ctx(req), metadata: { kind: req.query.kind || req.body.kind } });
    res.status(201).json({ document: r.document });
  } catch (err) { next(err); }
}
export async function encounterDocUrl(req, res, next) {
  try {
    const r = await encounterDocumentUrl({ docUuid: req.params.docUuid, userId: req.authUserId });
    if (r.notFound) return res.status(404).json({ error: 'Document not found.', code: 'NOT_FOUND' });
    if (r.forbidden) return res.status(404).json({ error: 'Document not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.document.view', entityType: 'encounter_document', entityId: req.params.docUuid, ...ctx(req) });
    res.json({ url: r.url });
  } catch (err) { next(err); }
}
export async function deleteEncounterDoc(req, res, next) {
  try {
    const r = await removeEncounterDocument({ docUuid: req.params.docUuid, userId: req.authUserId });
    if (r.notFound || r.forbidden) return res.status(404).json({ error: 'Document not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.document.delete', entityType: 'encounter_document', entityId: req.params.docUuid, ...ctx(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

export async function deleteCustomTemplate(req, res, next) {
  try {
    const ok = await deleteCustomTpl(req.authUserId, req.params.uuid);
    if (!ok) return res.status(404).json({ error: 'Template not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.customTemplate.delete', entityType: 'custom_note_template', entityId: req.params.uuid, ...ctx(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** Authoritative encounter-header details for the note workspace (scoped to the viewer). */
export async function encounterDetails(req, res, next) {
  try {
    const details = await getEncounterDetails(req.params.encounterUuid, req.authUserId);
    if (!details) return res.status(404).json({ error: { message: 'Encounter not found.' } });
    return res.json({ details });
  } catch (err) { return next(err); }
}

function sendPdf(res, out) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', out.buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.buffer);
}

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

export async function list(req, res, next) {
  try {
    res.json({ encounters: await listEncounters(req.authUserId) });
  } catch (err) { next(err); }
}

// Server-paginated patient list (25/page) for the Patients & Encounters view.
export async function listPatients(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const q = (req.query.q || '').toString().slice(0, 80).trim();
    res.json(await listProviderPatients(req.authUserId, { page, pageSize, q }));
  } catch (err) { next(err); }
}

/** Flat Clinical Records list (per note), scoped: MD → facility-wide; others → own. */
export async function clinicalRecords(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const q = (req.query.q || '').toString().slice(0, 80).trim();
    const status = ['signed', 'draft'].includes(req.query.status) ? req.query.status : '';
    res.json(await listClinicalRecords(req.authUserId, { page, pageSize, q, status }));
  } catch (err) { next(err); }
}

// Server-paginated encounters for one owned patient (10/page).
export async function patientEncounters(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 10));
    const result = await listPatientEncounters(req.authUserId, req.params.patientUuid, { page, pageSize });
    if (!result) return res.status(404).json({ error: 'Patient not found.', code: 'NOT_FOUND' });
    res.json(result);
  } catch (err) { next(err); }
}

/**
 * Prescription context for a NEW note: the patient's carried-forward medication list
 * (most recent note, scoped) + pharmacy/PBM vendor from their latest eligibility.
 * Strictly patient-scoped — 404 if the patient isn't accessible to the caller.
 */
export async function rxContext(req, res, next) {
  try {
    const out = await latestPrescriptions(req.authUserId, req.params.patientUuid);
    if (!out) return res.status(404).json({ error: 'Patient not found.', code: 'NOT_FOUND' });
    // Pharmacy vendor from the patient's most recent eligibility check (real data only).
    let pharmacy = null;
    try {
      const checks = await listChecks(out.patientId);
      for (const c of (checks || [])) { if (c.summary?.pharmacy) { pharmacy = c.summary.pharmacy; break; } }
    } catch { /* pharmacy is best-effort — never blocks the med list */ }
    res.json({ prescriptions: out.prescriptions, sourceDate: out.sourceDate, pharmacy });
  } catch (err) { next(err); }
}

export async function createEncounter(req, res, next) {
  try {
    const { patientUuid, encounterDate } = req.body;
    const enc = await createStandaloneEncounter({ providerId: req.authUserId, patientUuid, encounterDate, createdBy: req.authUserId });
    if (!enc) return res.status(404).json({ error: 'Patient not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.create', entityType: 'encounter', entityId: enc.uuid, ...ctx(req), metadata: { encounterDate } });
    res.status(201).json({ encounter: enc });
  } catch (err) { next(err); }
}

export async function updateStatus(req, res, next) {
  try {
    const result = await updateEncounterStatus(req.params.appointmentUuid, req.authUserId, req.authUserId, req.body);
    if (!result) return res.status(404).json({ error: 'Encounter not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.status.update', entityType: 'encounter', entityId: req.params.appointmentUuid, ...ctx(req), metadata: { fields: Object.keys(req.body) } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/* --- Clinical notes -------------------------------------------------------- */
export async function listNotes(req, res, next) {
  try {
    const notes = await listNotesSvc(req.params.encounterUuid, req.authUserId);
    if (notes === null) return res.status(404).json({ error: 'Encounter not found.', code: 'NOT_FOUND' });
    res.json({ notes });
  } catch (err) { next(err); }
}

export async function createNote(req, res, next) {
  try {
    const { noteType, reason, content } = req.body;
    // SERVICE-LINE ACCESS: a provider may create ONLY note templates whose service line is
    // among their granted specialties (multi-specialty aware; a SNF+Pain provider may create
    // both, a single-specialty provider only their own). Server-enforced, authoritative.
    if (!(await providerCanUseNoteType(req.authUserId, noteType))) {
      return res.status(403).json({ error: 'This note template is not available for your specialty.', code: 'TEMPLATE_FORBIDDEN' });
    }
    const note = await createNoteSvc({ encounterUuid: req.params.encounterUuid, providerId: req.authUserId, noteType, reason, content, createdBy: req.authUserId });
    if (!note) return res.status(404).json({ error: 'Encounter not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.note.create', entityType: 'encounter_note', entityId: note.uuid, ...ctx(req), metadata: { noteType } });
    res.status(201).json({ note });
  } catch (err) { next(err); }
}

export async function getNote(req, res, next) {
  try {
    const note = await getNoteSvc(req.params.noteUuid, req.authUserId);
    if (!note) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    res.json({ note });
  } catch (err) { next(err); }
}

// --- Billable codes on a note (diagnoses + procedures) -------------------------------------
export async function getNoteCodes(req, res, next) {
  try {
    const codes = await getNoteCodesSvc(req.params.noteUuid, req.authUserId);
    if (!codes) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    res.json(codes);
  } catch (err) { next(err); }
}

export async function saveNoteCodes(req, res, next) {
  try {
    if (!(await codingEnabledForNote(req.params.noteUuid))) return res.status(403).json(CODING_DISABLED);
    const result = await saveNoteCodesSvc(req.params.noteUuid, req.authUserId, req.body || {});
    if (!result) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    if (result.locked) return res.status(409).json({ error: 'This note is signed and can no longer be edited.', code: 'NOTE_SIGNED' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.note.codes', entityType: 'encounter_note', entityId: req.params.noteUuid, ...ctx(req) });
    res.json(result);
  } catch (err) { next(err); }
}

export async function predictNoteCodes(req, res, next) {
  try {
    if (!(await codingEnabledForNote(req.params.noteUuid))) return res.status(403).json(CODING_DISABLED);
    const result = await predictCodesSvc(req.params.noteUuid, req.authUserId);
    if (!result) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    res.json(result);
  } catch (err) { next(err); }
}

export async function scrubNote(req, res, next) {
  try {
    if (!(await codingEnabledForNote(req.params.noteUuid))) return res.status(403).json(CODING_DISABLED);
    const patient = req.body?.patient || (req.body?.age != null || req.body?.sex ? { age: req.body.age, sex: req.body.sex } : undefined);
    const result = await scrubNoteCodesSvc(req.params.noteUuid, req.authUserId, patient);
    if (!result) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateNote(req, res, next) {
  try {
    // If the note type is being changed, the new type must belong to one of the provider's
    // granted service lines (multi-specialty aware) — no switching to a line they don't hold.
    if (req.body.noteType && !(await providerCanUseNoteType(req.authUserId, req.body.noteType))) {
      return res.status(403).json({ error: 'This note template is not available for your specialty.', code: 'TEMPLATE_FORBIDDEN' });
    }
    const result = await updateNoteSvc(req.params.noteUuid, req.authUserId, req.body);
    if (!result) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    if (result.locked) return res.status(409).json({ error: 'This note is signed and can no longer be edited.', code: 'NOTE_SIGNED' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.note.update', entityType: 'encounter_note', entityId: req.params.noteUuid, ...ctx(req) });
    res.json({ note: result });
  } catch (err) { next(err); }
}

export async function signNote(req, res, next) {
  try {
    const result = await signNoteSvc(req.params.noteUuid, req.authUserId, req.body);
    if (result && result.forbidden) return res.status(403).json({ error: 'Only a provider with an MD credential can sign off a note for billing.', code: 'SIGN_FORBIDDEN' });
    if (!result) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    if (result.locked) return res.status(409).json({ error: 'This note is already signed.', code: 'NOTE_SIGNED' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.note.sign', entityType: 'encounter_note', entityId: req.params.noteUuid, ...ctx(req), metadata: { noteType: result.noteType } });
    res.json({ note: result });
  } catch (err) { next(err); }
}

/** Download a clinical note as a branded, non-editable PDF (signed records; MD may
 *  also download an unsigned draft). Access-scoped, per-facility isolated. */
export async function downloadNote(req, res, next) {
  try {
    const out = await notePdf(req.params.noteUuid, req.authUserId);
    if (out.notFound) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    if (out.forbidden) return res.status(403).json({ error: 'Only signed medical records can be downloaded — unsigned records are restricted to an MD.', code: 'DOWNLOAD_FORBIDDEN' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.note.download', entityType: 'encounter_note', entityId: req.params.noteUuid, ...ctx(req), metadata: { format: 'pdf' } });
    sendPdf(res, out);
  } catch (err) { next(err); }
}

/** MD-only amendment of a SIGNED note — requires a reason (logged to the audit trail). */
export async function amendNote(req, res, next) {
  try {
    const { content, reason } = req.body;
    const result = await amendNoteSvc(req.params.noteUuid, req.authUserId, { content, reason });
    if (result && result.forbidden) return res.status(403).json({ error: 'Only an MD can edit a signed note.', code: 'AMEND_FORBIDDEN' });
    if (!result) return res.status(404).json({ error: 'Note not found.', code: 'NOT_FOUND' });
    if (result.notSigned) return res.status(409).json({ error: 'This note is a draft — edit it directly.', code: 'NOTE_NOT_SIGNED' });
    await recordAudit({ actorUserId: req.authUserId, action: 'encounter.note.amend', entityType: 'encounter_note', entityId: req.params.noteUuid, ...ctx(req), metadata: { reason } });
    res.json({ note: result });
  } catch (err) { next(err); }
}
