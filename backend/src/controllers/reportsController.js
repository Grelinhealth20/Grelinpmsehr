/**
 * Provider Reports + RVU Payscale controller. The provider is ALWAYS the authenticated user
 * (`req.authUserId`) — never a client-supplied id — so every response is strictly own-data (no
 * cross-provider leakage). Read-only.
 */
import { providerSummary, providerPayscale, providerPayPeriods, providerMonthlyStatement, adminProviderPayscale } from '../services/reportsService.js';
import { encountersRows, buildEncountersWorkbook, billingDetailRows, buildBillingWorkbook } from '../services/reportExportService.js';
import { findProviderIdByUuid } from '../services/userService.js';
import { finalizePeriod, listSnapshots, reopenSnapshot } from '../services/payrollService.js';
import { recordAudit } from '../services/auditService.js';

function sendXlsx(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}
const periodLabel = (from, to) => `${from || 'all'} to ${to || 'today'}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateParam = (v) => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
const uuidParam = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);
const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

/** ADMIN (master/super): per-provider pay across the group, filterable by facility + provider. */
export async function adminPayscale(req, res, next) {
  try {
    res.json(await adminProviderPayscale({
      facilityUuid: uuidParam(req.query.facility),
      providerUuid: uuidParam(req.query.provider),
      from: dateParam(req.query.from),
      to: dateParam(req.query.to),
      cfKind: oneOf(req.query.cfKind, ['standard', 'apm'], 'standard'),
    }));
  } catch (err) { next(err); }
}

export async function summary(req, res, next) {
  try {
    const from = dateParam(req.query.from);
    const to = dateParam(req.query.to);
    res.json(await providerSummary(req.authUserId, { from, to }));
  } catch (err) { next(err); }
}

export async function payscale(req, res, next) {
  try {
    const from = dateParam(req.query.from);
    const to = dateParam(req.query.to);
    const cfKind = oneOf(req.query.cfKind, ['standard', 'apm'], 'standard');
    const localityCode = oneOf(req.query.locality, ['99', '03', '04'], '99');
    const setting = oneOf(req.query.setting, ['facility', 'office'], 'facility');
    res.json(await providerPayscale(req.authUserId, {
      from, to, credentials: req.user?.credentials || [], cfKind, localityCode, setting,
    }));
  } catch (err) { next(err); }
}

export async function statement(req, res, next) {
  try {
    const now = new Date();
    const year = Math.min(2100, Math.max(2000, parseInt(req.query.year, 10) || now.getUTCFullYear()));
    const month = Math.min(12, Math.max(1, parseInt(req.query.month, 10) || (now.getUTCMonth() + 1)));
    const cfKind = oneOf(req.query.cfKind, ['standard', 'apm'], 'standard');
    const localityCode = oneOf(req.query.locality, ['99', '03', '04'], '99');
    const setting = oneOf(req.query.setting, ['facility', 'office'], 'facility');
    res.json(await providerMonthlyStatement(req.authUserId, {
      year, month, credentials: req.user?.credentials || [], cfKind, localityCode, setting,
    }));
  } catch (err) { next(err); }
}

// ---- Excel downloads ----------------------------------------------------------------------------------
// Provider (own data).
export async function downloadEncounters(req, res, next) {
  try {
    const from = dateParam(req.query.from), to = dateParam(req.query.to);
    const rows = await encountersRows({ providerId: req.authUserId, from, to });
    const meta = { Provider: req.user?.fullName || '', Period: periodLabel(from, to), Generated: new Date().toISOString().slice(0, 10) };
    const buf = await buildEncountersWorkbook({ title: 'Visit / Encounters Report', meta, rows });
    sendXlsx(res, buf, `encounters_${from || 'all'}_${to || 'today'}.xlsx`);
  } catch (err) { next(err); }
}
export async function downloadBilling(req, res, next) {
  try {
    const from = dateParam(req.query.from), to = dateParam(req.query.to);
    const rows = await billingDetailRows({ providerId: req.authUserId, from, to });
    const meta = { Provider: req.user?.fullName || '', Period: periodLabel(from, to), Generated: new Date().toISOString().slice(0, 10) };
    const buf = await buildBillingWorkbook({ title: 'Billing Report', meta, rows });
    sendXlsx(res, buf, `billing_${from || 'all'}_${to || 'today'}.xlsx`);
  } catch (err) { next(err); }
}
// Admin (all providers / by facility / by provider).
export async function adminDownloadEncounters(req, res, next) {
  try {
    const from = dateParam(req.query.from), to = dateParam(req.query.to);
    const facilityUuid = uuidParam(req.query.facility);
    const providerUuid = uuidParam(req.query.provider);
    const providerId = providerUuid ? await findProviderIdByUuid(providerUuid) : null;
    if (providerUuid && !providerId) return res.status(404).json({ error: 'Provider not found.', code: 'NOT_FOUND' });
    const rows = await encountersRows({ providerId, facilityUuid, from, to });
    const meta = { Scope: providerUuid ? 'Provider' : facilityUuid ? 'Facility' : 'All providers', Period: periodLabel(from, to), Generated: new Date().toISOString().slice(0, 10) };
    const buf = await buildEncountersWorkbook({ title: 'Visit / Encounters Report', meta, rows });
    sendXlsx(res, buf, `encounters_${from || 'all'}_${to || 'today'}.xlsx`);
  } catch (err) { next(err); }
}
export async function adminDownloadBilling(req, res, next) {
  try {
    const from = dateParam(req.query.from), to = dateParam(req.query.to);
    const facilityUuid = uuidParam(req.query.facility);
    const providerUuid = uuidParam(req.query.provider);
    const providerId = providerUuid ? await findProviderIdByUuid(providerUuid) : null;
    if (providerUuid && !providerId) return res.status(404).json({ error: 'Provider not found.', code: 'NOT_FOUND' });
    const rows = await billingDetailRows({ providerId, facilityUuid, from, to });
    const meta = { Scope: providerUuid ? 'Provider' : facilityUuid ? 'Facility' : 'All providers', Period: periodLabel(from, to), Generated: new Date().toISOString().slice(0, 10) };
    const buf = await buildBillingWorkbook({ title: 'Billing Report', meta, rows });
    sendXlsx(res, buf, `billing_${from || 'all'}_${to || 'today'}.xlsx`);
  } catch (err) { next(err); }
}

// ---- Payroll: pay-period LOCK (admin) -----------------------------------------------------------------
/** SUPER/MASTER: finalize (lock) a pay period. Freezes each provider's pay into an immutable snapshot and
 *  claims their signed notes as PAID so they can never appear on a later paycheck. */
export async function finalize(req, res, next) {
  try {
    const from = dateParam(req.body?.from), to = dateParam(req.body?.to);
    if (!from || !to) return res.status(400).json({ error: 'A valid period (from, to) is required.', code: 'BAD_PERIOD' });
    const periodType = oneOf(req.body?.periodType, ['monthly', 'biweekly'], 'monthly');
    const facilityUuid = uuidParam(req.body?.facility);
    const providerUuid = uuidParam(req.body?.provider);
    const cfKind = oneOf(req.body?.cfKind, ['standard', 'apm'], 'standard');
    const localityCode = oneOf(req.body?.locality, ['99', '03', '04'], '99');
    const result = await finalizePeriod({ from, to, periodType, facilityUuid, providerUuid, cfKind, localityCode }, req.authUserId);
    await recordAudit({
      actorUserId: req.authUserId, action: 'payroll.finalize', entityType: 'pay_period', entityId: `${from}_${to}`,
      ip: req.ip, userAgent: req.get('user-agent'),
      metadata: { from, to, periodType, providers: result.providers, finalized: result.finalized, updated: result.updated, skipped: result.skipped, facility: facilityUuid || undefined, provider: providerUuid || undefined },
    });
    res.json(result);
  } catch (err) { next(err); }
}

/** SUPER/MASTER: list finalized snapshots (payroll history). */
export async function listFinalized(req, res, next) {
  try {
    res.json({ snapshots: await listSnapshots({ from: dateParam(req.query.from), to: dateParam(req.query.to), providerUuid: uuidParam(req.query.provider) }) });
  } catch (err) { next(err); }
}

/** MASTER only: reopen a finalized period (releases its paid-note ledger so it can be re-finalized). */
export async function reopen(req, res, next) {
  try {
    const uuid = uuidParam(req.params.uuid);
    if (!uuid) return res.status(400).json({ error: 'A valid snapshot id is required.', code: 'BAD_ID' });
    const ok = await reopenSnapshot(uuid);
    if (!ok) return res.status(404).json({ error: 'No finalized period with that id.', code: 'NOT_FOUND' });
    await recordAudit({
      actorUserId: req.authUserId, action: 'payroll.reopen', entityType: 'pay_period', entityId: uuid,
      ip: req.ip, userAgent: req.get('user-agent'), metadata: { snapshot: uuid },
    });
    res.json({ reopened: true, uuid });
  } catch (err) { next(err); }
}

export async function payPeriods(req, res, next) {
  try {
    const periodType = oneOf(req.query.periodType, ['monthly', 'biweekly'], 'monthly');
    const count = Math.min(24, Math.max(1, parseInt(req.query.count, 10) || 6));
    const cfKind = oneOf(req.query.cfKind, ['standard', 'apm'], 'standard');
    const localityCode = oneOf(req.query.locality, ['99', '03', '04'], '99');
    const setting = oneOf(req.query.setting, ['facility', 'office'], 'facility');
    res.json(await providerPayPeriods(req.authUserId, {
      periodType, count, credentials: req.user?.credentials || [], cfKind, localityCode, setting,
    }));
  } catch (err) { next(err); }
}
