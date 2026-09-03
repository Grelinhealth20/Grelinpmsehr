import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { recordAudit } from './auditService.js';

/**
 * Break-glass emergency access (ONC §170.315(d)(6)).
 *
 * A clinician who needs a patient outside their normal ownership scope during an emergency records a
 * time-boxed, reason-mandatory grant. The grant AND every subsequent access under it are written to the
 * tamper-evident audit log, so the override is fully attributable and reviewable after the fact. The
 * grant does NOT widen any OTHER user's access and expires automatically.
 */
const EMERGENCY_TTL_MINUTES = 120; // 2-hour window

/** Create a break-glass grant for (user → patient). Requires a substantive reason. */
export async function grantEmergencyAccess({ userId, patientId, patientUuid, reason, ip = null, userAgent = null }) {
  const clean = String(reason || '').trim();
  if (clean.length < 10) {
    const e = new Error('A clinical justification (at least 10 characters) is required for emergency access.');
    e.status = 400; e.code = 'REASON_REQUIRED';
    throw e;
  }
  const uuid = uuidv4();
  // Compute expiry DB-side (NOW() + INTERVAL) so it shares the same clock/timezone as the NOW()
  // comparison in hasActiveEmergencyGrant — a JS Date could be shifted by the JS↔DB timezone gap.
  // TTL is a hardcoded constant (never user input), so inlining it is injection-safe.
  await execute(
    `INSERT INTO emergency_access (uuid, user_id, patient_id, reason, expires_at, ip)
     VALUES (:uuid, :userId, :patientId, :reason, DATE_ADD(NOW(), INTERVAL ${EMERGENCY_TTL_MINUTES} MINUTE), :ip)`,
    { uuid, userId, patientId, reason: clean.slice(0, 500), ip },
  );
  const [[r]] = [await execute(
    "SELECT DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s') AS exp FROM emergency_access WHERE uuid = :uuid", { uuid },
  )].map((x) => x[0]);
  const expiresAt = r?.exp || null;
  // Loud, tamper-evident audit of the OVERRIDE itself.
  await recordAudit({
    actorUserId: userId, action: 'patient.emergency_access.grant', outcome: 'success',
    entityType: 'patient', entityId: patientUuid, ip, userAgent,
    metadata: { reason: clean.slice(0, 500), expiresAt, ttlMinutes: EMERGENCY_TTL_MINUTES },
  });
  return { uuid, expiresAt };
}

/** True iff the user currently holds an active (non-expired) break-glass grant for the patient. */
export async function hasActiveEmergencyGrant(userId, patientId) {
  const [rows] = await execute(
    `SELECT id FROM emergency_access
      WHERE user_id = :userId AND patient_id = :patientId AND expires_at > NOW()
      ORDER BY expires_at DESC LIMIT 1`,
    { userId, patientId },
  );
  return rows.length > 0;
}
