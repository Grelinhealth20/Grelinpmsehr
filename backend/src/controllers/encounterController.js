import {
  listEncounters, updateEncounterStatus, createStandaloneEncounter,
  listProviderPatients, listPatientEncounters, listClinicalRecords, latestPrescriptions,
} from '../services/encounterService.js';
import { listChecks } from '../services/eligibilityService.js';
import {
  listNotes as listNotesSvc, createNote as createNoteSvc, getNote as getNoteSvc,
  updateNote as updateNoteSvc, signNote as signNoteSvc, amendSignedNote as amendNoteSvc,
} from '../services/encounterNoteService.js';
import {
  providerServiceLine, listTemplatesForServiceLine, providerCanUseNoteType,
} from '../services/noteTemplateService.js';
import { recordAudit } from '../services/auditService.js';
import { notePdf } from '../services/pdfExport.js';

/**
 * Note templates AVAILABLE to the current provider — filtered to their service line
 * (SNF vs Pain Management) from the note_templates registry. The provider sees only
 * their own service's templates; the picker renders exactly this list.
 */
export async function noteTemplates(req, res, next) {
  try {
    const serviceLine = await providerServiceLine(req.authUserId);
    const templates = await listTemplatesForServiceLine(serviceLine);
    res.json({ serviceLine, templates });
  } catch (err) { next(err); }
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
    // SERVICE-LINE ACCESS: a provider may create ONLY the note templates for their own
    // specialty's service line (SNF vs Pain). Server-enforced — no cross-over.
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

export async function updateNote(req, res, next) {
  try {
    // If the note type is being changed, it must still belong to the provider's own
    // service line (SNF vs Pain) — no switching a note across service lines.
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
