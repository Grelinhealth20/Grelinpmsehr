import { v4 as uuidv4 } from 'uuid';
import { pool, execute } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { decrypt } from '../utils/crypto.js';

/**
 * Append an entry to the immutable audit log. Failures here must never break the
 * primary request, but they are logged loudly (audit gaps are a compliance risk).
 */
export async function recordAudit({
  actorUserId = null,
  actorEmailBidx = null,
  action,
  entityType = null,
  entityId = null,
  outcome = 'success',
  ip = null,
  userAgent = null,
  metadata = null,
}) {
  try {
    await execute(
      `INSERT INTO audit_logs
        (uuid, actor_user_id, actor_email_bidx, action, entity_type, entity_id, outcome, ip, user_agent, metadata)
       VALUES (:uuid, :actorUserId, :actorEmailBidx, :action, :entityType, :entityId, :outcome, :ip, :userAgent, :metadata)`,
      {
        uuid: uuidv4(),
        actorUserId,
        actorEmailBidx,
        action,
        entityType,
        entityId: entityId != null ? String(entityId) : null,
        outcome,
        ip,
        userAgent: userAgent ? userAgent.slice(0, 255) : null,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    );
  } catch (err) {
    logger.error({ err, action }, 'Failed to write audit log');
  }
}

/**
 * Read the audit trail, tagged with each actor's current email + role (resolved
 * and decrypted via join). Orphaned entries (actor since deleted) fall back to a
 * safe label so the trail is never misattributed.
 */
export async function listAudit({ limit = 100, offset = 0, action = null } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const where = action ? 'WHERE al.action = ?' : '';
  const args = action ? [action, safeLimit, safeOffset] : [safeLimit, safeOffset];
  const [rows] = await pool.query(
    `SELECT al.uuid, al.actor_user_id, al.action, al.entity_type, al.entity_id, al.outcome,
            al.ip, al.user_agent, al.metadata, al.created_at,
            u.email_enc AS actor_email_enc, u.role AS actor_role
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ${where}
      ORDER BY al.id DESC LIMIT ? OFFSET ?`,
    args,
  );
  return rows.map((r) => ({
    uuid: r.uuid,
    action: r.action,
    actorEmail: r.actor_email_enc ? decrypt(r.actor_email_enc) : (r.actor_user_id ? 'Deleted user' : 'System'),
    actorRole: r.actor_role || null,
    entityType: r.entity_type,
    entityId: r.entity_id,
    outcome: r.outcome,
    ip: r.ip,
    metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : null,
    createdAt: r.created_at,
  }));
}
