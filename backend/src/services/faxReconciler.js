import { logger } from '../config/logger.js';
import { faxEnabled } from './faxService.js';
import { reconcileAllFaxes } from './referralService.js';

/**
 * Fax reconciliation heartbeat — the safety net that guarantees NO MISSED FAXES and NO DATA LOSS.
 *
 * The webhook (push) is the real-time path, but a webhook can be undelivered, unregistered, or rejected
 * (e.g. before the signing secret is set). So while faxing is LIVE, this timer periodically runs the
 * all-in-one reconcile — inbox catch-up, received-document self-heal, and outbound status settle — every
 * one of which is idempotent, so re-running never duplicates or loses anything. A single in-flight run is
 * enforced (no overlap); every run and every failure is LOGGED (never silent).
 */

const INTERVAL_MS = Math.max(60_000, Number(process.env.FAX_RECONCILE_MS) || 5 * 60 * 1000); // ≥60s, default 5 min
let timer = null;
let running = false;
let last = null; // { at, result | error }

/** Run one reconcile pass now. Safe to call anytime; no-ops when fax is off or a run is already in flight. */
export async function runFaxReconcileOnce(reason = 'manual') {
  if (!faxEnabled()) return { skipped: 'fax-not-live' };
  if (running) return { skipped: 'already-running' };
  running = true;
  try {
    const result = await reconcileAllFaxes();
    last = { at: new Date().toISOString(), reason, result };
    return result;
  } catch (e) {
    last = { at: new Date().toISOString(), reason, error: e.message };
    logger.error({ err: e.message, reason }, 'fax reconcile pass failed');
    return { error: e.message };
  } finally { running = false; }
}

/** Start the heartbeat if fax is live and it isn't already running. Kicks an immediate catch-up pass. */
export function startFaxReconciler() {
  if (timer) return faxReconcilerStatus();
  if (!faxEnabled()) return faxReconcilerStatus(); // nothing to poll until activated
  timer = setInterval(() => { runFaxReconcileOnce('scheduled'); }, INTERVAL_MS);
  if (timer.unref) timer.unref(); // never keep the process alive on this timer alone
  logger.info({ intervalMs: INTERVAL_MS }, 'fax reconciler started');
  runFaxReconcileOnce('startup'); // immediate catch-up so a restart never leaves a gap
  return faxReconcilerStatus();
}

/** Stop the heartbeat (e.g. on deactivation). */
export function stopFaxReconciler() {
  if (timer) { clearInterval(timer); timer = null; logger.info('fax reconciler stopped'); }
  return faxReconcilerStatus();
}

export function faxReconcilerStatus() { return { active: !!timer, intervalMs: INTERVAL_MS, last }; }
