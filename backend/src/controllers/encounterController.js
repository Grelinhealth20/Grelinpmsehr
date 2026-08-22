import { listEncounters, updateEncounterStatus } from '../services/encounterService.js';
import { recordAudit } from '../services/auditService.js';

export async function list(req, res, next) {
  try {
    res.json({ encounters: await listEncounters(req.authUserId) });
  } catch (err) { next(err); }
}

export async function updateStatus(req, res, next) {
  try {
    const result = await updateEncounterStatus(req.params.appointmentUuid, req.authUserId, req.authUserId, req.body);
    if (!result) return res.status(404).json({ error: 'Encounter not found.', code: 'NOT_FOUND' });
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'encounter.status.update',
      entityType: 'encounter',
      entityId: req.params.appointmentUuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { fields: Object.keys(req.body) },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
}
