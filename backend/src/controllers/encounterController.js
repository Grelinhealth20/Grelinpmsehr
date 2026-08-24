import {
  listEncounters, updateEncounterStatus, createStandaloneEncounter,
  listProviderPatients, listPatientEncounters, listClinicalRecords,
} from '../services/encounterService.js';
import {
  listNotes as listNotesSvc, createNote as createNoteSvc, getNote as getNoteSvc,
  updateNote as updateNoteSvc, signNote as signNoteSvc,
} from '../services/encounterNoteService.js';
import { recordAudit } from '../services/auditService.js';

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
