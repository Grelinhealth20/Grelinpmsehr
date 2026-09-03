import { v4 as uuidv4 } from 'uuid';
import { pool, execute, withTransaction } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { decrypt, sha256Hex } from '../utils/crypto.js';

const GENESIS = '0'.repeat(64);

/** Deterministic JSON with sorted object keys, so a value hashes identically at write-time and at
 *  verify-time regardless of key order or MySQL's JSON-column key normalization. */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/** Canonical, order-stable content string for one audit row — the pre-image of its row_hash. */
function canonicalContent(f) {
  return stableStringify({
    uuid: f.uuid,
    actorUserId: f.actorUserId ?? null,
    actorEmailBidx: f.actorEmailBidx ?? null,
    action: f.action,
    entityType: f.entityType ?? null,
    entityId: f.entityId != null ? String(f.entityId) : null,
    outcome: f.outcome,
    ip: f.ip ?? null,
    userAgent: f.userAgent ?? null,
    metadata: f.metadata != null ? stableStringify(f.metadata) : null,
    createdAt: f.createdAt,
  });
}

/**
 * Append a TAMPER-EVIDENT entry to the audit log (ONC (d)(2) auditable events + tamper-resistance).
 * Each row is hash-chained: row_hash = SHA-256(prev row_hash || canonical content). A single-row
 * `audit_chain` head is locked FOR UPDATE inside a transaction so concurrent appends chain in a strict
 * order; any later edit/delete/reorder of a row breaks the chain and is detected by verifyAuditChain().
 * Failures never break the primary request, but are logged loudly (an audit gap is a compliance risk).
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
    const uuid = uuidv4();
    // App-generated UTC timestamp stored verbatim (DATETIME, no tz shift) so it is part of the hash and
    // reproducible at verify time via DATE_FORMAT.
    const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const ua = userAgent ? userAgent.slice(0, 255) : null;
    const fields = { uuid, actorUserId, actorEmailBidx, action, entityType, entityId, outcome, ip, userAgent: ua, metadata, createdAt };

    await withTransaction(async (exec) => {
      const [[head]] = [await exec('SELECT last_hash FROM audit_chain WHERE id = 1 FOR UPDATE')].map((x) => x[0]);
      const prevHash = head?.last_hash || GENESIS;
      const rowHash = sha256Hex(prevHash + canonicalContent(fields));
      await exec(
        `INSERT INTO audit_logs
          (uuid, actor_user_id, actor_email_bidx, action, entity_type, entity_id, outcome, ip, user_agent, metadata, created_at, prev_hash, row_hash)
         VALUES (:uuid, :actorUserId, :actorEmailBidx, :action, :entityType, :entityId, :outcome, :ip, :userAgent, :metadata, :createdAt, :prevHash, :rowHash)`,
        {
          uuid,
          actorUserId,
          actorEmailBidx,
          action,
          entityType,
          entityId: entityId != null ? String(entityId) : null,
          outcome,
          ip,
          userAgent: ua,
          metadata: metadata ? JSON.stringify(metadata) : null,
          createdAt,
          prevHash,
          rowHash,
        },
      );
      await exec('UPDATE audit_chain SET last_hash = :rowHash WHERE id = 1', { rowHash });
    });
  } catch (err) {
    logger.error({ err, action }, 'Failed to write audit log');
  }
}

/**
 * Verify the audit hash-chain (ONC (d)(2) tamper-detection). Walks every row in insertion order,
 * recomputes row_hash from the prior hash + canonical content, and reports the first break. Any edit,
 * deletion, reorder, or forged row is detected. Returns { ok, checked, brokenAt, reason }.
 */
export async function verifyAuditChain({ limit = 1_000_000 } = {}) {
  // LIMIT is inlined as a clamped integer — MySQL prepared statements reject a LIMIT placeholder
  // (established safe pattern in this codebase; the value is never attacker-controlled).
  const lim = Math.min(Math.max(1, Math.floor(Number(limit)) || 1_000_000), 100_000_000);
  const [rows] = await execute(
    `SELECT id, uuid, actor_user_id, actor_email_bidx, action, entity_type, entity_id, outcome, ip,
            user_agent, CAST(metadata AS CHAR) AS metadata_str,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_str, prev_hash, row_hash
       FROM audit_logs ORDER BY id ASC LIMIT ${lim}`,
  );
  let prev = GENESIS;
  let checked = 0;
  for (const r of rows) {
    if (r.prev_hash !== prev) {
      return { ok: false, checked, brokenAt: r.id, reason: 'prev_hash link mismatch (row inserted/removed/reordered)' };
    }
    const meta = r.metadata_str ? JSON.parse(r.metadata_str) : null;
    const content = canonicalContent({
      uuid: r.uuid,
      actorUserId: r.actor_user_id,
      actorEmailBidx: r.actor_email_bidx,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      outcome: r.outcome,
      ip: r.ip,
      userAgent: r.user_agent,
      metadata: meta,
      createdAt: r.created_str,
    });
    const expected = sha256Hex(prev + content);
    if (expected !== r.row_hash) {
      return { ok: false, checked, brokenAt: r.id, reason: 'row content altered (row_hash mismatch)' };
    }
    prev = r.row_hash;
    checked += 1;
  }
  return { ok: true, checked, brokenAt: null, reason: null };
}

/**
 * One-time migration: assign chain hashes to pre-adoption audit rows (written before hash-chaining) so
 * the entire trail becomes verifiable going forward. NOTE: this establishes the integrity baseline at
 * adoption time — it cannot retro-detect tampering that occurred before the baseline (inherent to
 * adopting tamper-evidence on an existing log). Idempotent: re-running recomputes identical hashes.
 */
export async function backfillAuditChain() {
  const [rows] = await execute(
    `SELECT id, uuid, actor_user_id, actor_email_bidx, action, entity_type, entity_id, outcome, ip,
            user_agent, CAST(metadata AS CHAR) AS metadata_str,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_str
       FROM audit_logs ORDER BY id ASC`,
  );
  // Hash the chain in-memory (sequential, instant) …
  let prev = GENESIS;
  const plan = rows.map((r) => {
    const meta = r.metadata_str ? JSON.parse(r.metadata_str) : null;
    const rowHash = sha256Hex(prev + canonicalContent({
      uuid: r.uuid, actorUserId: r.actor_user_id, actorEmailBidx: r.actor_email_bidx, action: r.action,
      entityType: r.entity_type, entityId: r.entity_id, outcome: r.outcome, ip: r.ip,
      userAgent: r.user_agent, metadata: meta, createdAt: r.created_str,
    }));
    const entry = { id: r.id, prev, hash: rowHash };
    prev = rowHash;
    return entry;
  });
  // … then persist in chunked CASE bulk-updates (≈1 round-trip per 400 rows, not per row).
  for (let i = 0; i < plan.length; i += 400) {
    const chunk = plan.slice(i, i + 400);
    const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
    const sql = `UPDATE audit_logs SET prev_hash = CASE id ${cases} END, row_hash = CASE id ${cases} END WHERE id IN (${chunk.map(() => '?').join(',')})`;
    const params = [
      ...chunk.flatMap((c) => [c.id, c.prev]),
      ...chunk.flatMap((c) => [c.id, c.hash]),
      ...chunk.map((c) => c.id),
    ];
    await pool.query(sql, params);
  }
  await execute('UPDATE audit_chain SET last_hash = :h WHERE id = 1', { h: prev });
  return { updated: plan.length, head: prev };
}

/**
 * Read the audit trail, tagged with each actor's current email + role (resolved
 * and decrypted via join). Orphaned entries (actor since deleted) fall back to a
 * safe label so the trail is never misattributed.
 */
export async function listAudit({
  limit = 100, offset = 0, action = null, role = null, actorUuid = null,
  facilityUuid = null, dateFrom = null, dateTo = null, q = null,
} = {}) {
  // Floor to integers — LIMIT/OFFSET are inlined into SQL and reject floats (a malformed ?limit=10.5
  // would otherwise become `LIMIT 10.5` → SQL parse error / 500). Same guard as patientDocumentService.
  const safeLimit = Math.min(Math.max(Math.floor(Number(limit)) || 100, 1), 2000);
  const safeOffset = Math.max(Math.floor(Number(offset)) || 0, 0);
  const where = [];
  const params = {};
  if (action) { where.push('al.action = :action'); params.action = action; }
  if (role) { where.push('u.role = :role'); params.role = role; }
  if (actorUuid) { where.push('u.uuid = :actorUuid'); params.actorUuid = actorUuid; }
  if (facilityUuid) {
    where.push(`EXISTS (SELECT 1 FROM provider_facilities pf JOIN facilities f ON f.id = pf.facility_id
                 WHERE pf.provider_id = al.actor_user_id AND f.uuid = :facilityUuid)`);
    params.facilityUuid = facilityUuid;
  }
  if (dateFrom) { where.push('al.created_at >= :dateFrom'); params.dateFrom = dateFrom; }
  if (dateTo) { where.push('al.created_at <= :dateTo'); params.dateTo = dateTo; }
  if (q) { where.push('(al.action LIKE :q OR al.entity_type LIKE :q OR al.entity_id LIKE :q)'); params.q = `%${q}%`; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Each entry is resolved to the actor's current identity + role + assigned
  // facilities, so the trail can be grouped by account / role / facility.
  const [rows] = await execute(
    `SELECT al.uuid, al.actor_user_id, al.action, al.entity_type, al.entity_id, al.outcome,
            al.ip, al.user_agent, al.metadata, al.created_at,
            u.uuid AS actor_uuid, u.email_enc AS actor_email_enc, u.full_name_enc AS actor_name_enc, u.role AS actor_role,
            (SELECT GROUP_CONCAT(DISTINCT f.name ORDER BY f.name SEPARATOR ', ')
               FROM provider_facilities pf JOIN facilities f ON f.id = pf.facility_id
              WHERE pf.provider_id = al.actor_user_id) AS actor_facilities
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ${whereSql}
      ORDER BY al.id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  );
  return rows.map((r) => ({
    uuid: r.uuid,
    action: r.action,
    actorUuid: r.actor_uuid || null,
    actorEmail: r.actor_email_enc ? decrypt(r.actor_email_enc) : (r.actor_user_id ? 'Deleted user' : 'System'),
    actorName: r.actor_name_enc ? decrypt(r.actor_name_enc) : null,
    actorRole: r.actor_role || (r.actor_user_id ? null : 'system'),
    actorFacilities: r.actor_facilities || null,
    entityType: r.entity_type,
    entityId: r.entity_id,
    outcome: r.outcome,
    ip: r.ip,
    metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : null,
    createdAt: r.created_at,
  }));
}
