/**
 * Payroll — pay-period LOCK / snapshot. A super/master admin FINALIZES a period; each provider's computed
 * pay is frozen into `pay_period_snapshots` (immutable). After that, a later note edit/delete can never
 * change a PAID period — reporting reads the snapshot for finalized periods. This is what makes the RVU
 * payscale a real, auditable paycheck. Only a master admin may REOPEN a finalized period.
 */
import { v4 as uuidv4 } from 'uuid';
import { execute, withTransaction } from '../db/pool.js';
import { decrypt } from '../utils/crypto.js';
import { logger } from '../config/logger.js';
import { providerPayscale } from './reportsService.js';
import { findProviderIdByUuid } from './userService.js';

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Provider ids in scope for a period: one provider, a facility's assigned providers, or everyone with signed work. */
async function providersInScope({ from, to, providerUuid, facilityUuid }) {
  if (providerUuid) { const id = await findProviderIdByUuid(providerUuid); return id ? [id] : []; }
  const params = {};
  const DOS = 'COALESCE(e.encounter_date, a.appt_date, DATE(e.created_at))'; // scope by DATE OF SERVICE
  const where = ["n.status = 'signed'"];
  if (from) { where.push(`${DOS} >= :from`); params.from = from; }
  if (to) { where.push(`${DOS} < :to`); params.to = to; }
  let join = '';
  if (facilityUuid) { join = 'JOIN provider_facilities pf ON pf.provider_id = n.provider_id JOIN facilities f ON f.id = pf.facility_id'; where.push('f.uuid = :fuuid'); params.fuuid = facilityUuid; }
  const [rows] = await execute(`SELECT DISTINCT n.provider_id AS id FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id LEFT JOIN appointments a ON a.id = e.appointment_id ${join} WHERE ${where.join(' AND ')}`, params);
  return rows.map((r) => r.id);
}

/** Finalize (lock) a pay period for every provider in scope. Already-finalized providers are skipped. */
export async function finalizePeriod({ from, to, periodType = 'monthly', providerUuid = null, facilityUuid = null, cfKind = 'standard', localityCode = '99' }, adminId) {
  if (!from || !to) { const e = new Error('A period (from/to) is required.'); e.status = 400; e.code = 'BAD_PERIOD'; throw e; }
  // Never finalize a period that has not fully elapsed: a note signed after the snapshot but inside the
  // window would be orphaned (never paid) — that is an UNDER-PAY. `to` is the exclusive end (first day
  // after the period), so it must be on/before today. This makes every signed note land in a period that
  // is still open at signing time, so finalization captures the complete period exactly once.
  if (to > todayUtc()) { const e = new Error('Cannot finalize a pay period that has not yet ended.'); e.status = 400; e.code = 'PERIOD_NOT_ENDED'; throw e; }
  const ids = await providersInScope({ from, to, providerUuid, facilityUuid });
  let finalized = 0, updated = 0, skipped = 0, failed = 0;
  const failures = [];
  for (const pid of ids) {
    // Each provider is finalized INDEPENDENTLY: a per-provider failure (e.g. a note already ledgered to
    // another period → UNIQUE collision) rolls back only THAT provider's snapshot+ledger (atomic, no
    // partial/double-pay) and is recorded — it never aborts finalizing the remaining providers in the batch.
    try {
    const [[ex]] = [await execute('SELECT id, status FROM pay_period_snapshots WHERE provider_id = :pid AND period_from = :from AND period_to = :to LIMIT 1', { pid, from, to })];
    if (ex[0] && ex[0].status === 'finalized') { skipped++; continue; } // already locked — never silently overwrite
    // excludePaid:true → notes already paid in ANOTHER finalized period are not counted or re-ledgered here.
    const pay = await providerPayscale(pid, { from, to, cfKind, localityCode });
    const noteIds = pay.noteIds || [];
    const row = {
      uuid: uuidv4(), pid, periodType, from, to, cfKind, localityCode,
      rate: pay.providerRatePerWorkRvu, workRvu: pay.totalWorkRvu, providerPay: pay.providerPay,
      group: pay.groupRetained, med: pay.medicareWorkValue, lines: JSON.stringify(pay.lines || []), adminId: adminId || null,
    };
    // Snapshot + paid-note ledger are written ATOMICALLY: either the period locks AND its notes are claimed
    // as paid, or neither happens. A partial write is what would let a note be paid twice.
    await withTransaction(async (exec) => {
      let snapshotId;
      if (ex[0]) { // was reopened → re-finalize with a fresh recompute
        await exec(
          `UPDATE pay_period_snapshots SET status='finalized', period_type=:periodType, cf_kind=:cfKind, locality=:localityCode,
             rate=:rate, work_rvu=:workRvu, provider_pay=:providerPay, group_retained=:group, medicare_value=:med,
             lines_json=:lines, finalized_by=:adminId, finalized_at=NOW() WHERE id=:id`,
          { ...row, id: ex[0].id });
        snapshotId = ex[0].id;
      } else {
        const [res] = await exec(
          `INSERT INTO pay_period_snapshots (uuid, provider_id, period_type, period_from, period_to, cf_kind, locality,
             rate, work_rvu, provider_pay, group_retained, medicare_value, lines_json, status, finalized_by)
           VALUES (:uuid,:pid,:periodType,:from,:to,:cfKind,:localityCode,:rate,:workRvu,:providerPay,:group,:med,:lines,'finalized',:adminId)`,
          row);
        snapshotId = res.insertId;
      }
      // Claim each contributing note as PAID. UNIQUE(note_id) guarantees pay-once: if any note is already
      // ledgered to another period the INSERT throws and the whole finalize for this provider rolls back
      // (no silent double-pay). rate = per-note work_rvu × provider rate for auditability.
      for (const nid of noteIds) {
        await exec(
          'INSERT INTO paid_note_ledger (note_id, snapshot_id, provider_id) VALUES (:nid, :sid, :pid)',
          { nid, sid: snapshotId, pid });
      }
    });
    if (ex[0]) updated++; else finalized++;
    } catch (e) {
      failed++; failures.push({ providerId: pid, code: e.code || null, error: e.message });
      logger.warn({ providerId: pid, from, to, err: e.message }, 'finalizePeriod: provider skipped due to error (batch continues)');
    }
  }
  return { from, to, periodType, providers: ids.length, finalized, updated, skipped, failed, failures };
}

/** The finalized snapshot for one provider+period (or null). Used by reporting to serve locked pay. */
export async function snapshotFor(providerId, from, to) {
  const [[r]] = [await execute("SELECT * FROM pay_period_snapshots WHERE provider_id = :pid AND period_from = :from AND period_to = :to AND status = 'finalized' LIMIT 1", { pid: providerId, from, to })];
  return r[0] || null;
}

/** List finalized snapshots (admin), newest first, with provider names. */
export async function listSnapshots({ from = null, to = null, providerUuid = null } = {}) {
  const params = {};
  const where = ["s.status = 'finalized'"];
  if (from) { where.push('s.period_from >= :from'); params.from = from; }
  if (to) { where.push('s.period_to <= :to'); params.to = to; }
  if (providerUuid) { where.push('u.uuid = :puuid'); params.puuid = providerUuid; }
  const [rows] = await execute(
    `SELECT s.uuid, DATE_FORMAT(s.period_from,'%Y-%m-%d') AS pfrom, DATE_FORMAT(s.period_to,'%Y-%m-%d') AS pto, s.period_type,
            s.provider_pay, s.group_retained, s.work_rvu, DATE_FORMAT(s.finalized_at,'%Y-%m-%dT%H:%i:%sZ') AS finalized_at,
            u.uuid AS provider_uuid, u.full_name_enc
       FROM pay_period_snapshots s JOIN users u ON u.id = s.provider_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.period_from DESC, s.provider_pay DESC`, params);
  return rows.map((r) => ({
    uuid: r.uuid, providerUuid: r.provider_uuid,
    provider: r.full_name_enc ? (() => { try { return decrypt(r.full_name_enc); } catch { return '—'; } })() : '—',
    from: r.pfrom, to: r.pto, periodType: r.period_type,
    providerPay: Number(r.provider_pay), groupRetained: Number(r.group_retained), workRvu: Number(r.work_rvu), finalizedAt: r.finalized_at,
  }));
}

/** MASTER-only: reopen a finalized period so it can be re-finalized (audited by the caller). Releases the
 *  period's paid-note ledger rows so those notes return to payable — atomically with the status flip, so a
 *  period is never left "reopened" while its notes are still marked paid (which would strand them). */
export async function reopenSnapshot(uuid) {
  return withTransaction(async (exec) => {
    const [[snap]] = [await exec("SELECT id FROM pay_period_snapshots WHERE uuid = :u AND status = 'finalized' LIMIT 1", { u: uuid })];
    if (!snap[0]) return false; // not found or already reopened
    await exec("UPDATE pay_period_snapshots SET status = 'reopened' WHERE id = :id", { id: snap[0].id });
    await exec('DELETE FROM paid_note_ledger WHERE snapshot_id = :id', { id: snap[0].id });
    return true;
  });
}
