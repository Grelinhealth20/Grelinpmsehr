import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Stedi Healthcare API client — real-time eligibility (270/271) and Payer Network
 * search. All calls run SERVER-SIDE only; the API key never reaches the browser.
 *
 *   - Payer search  : GET  {base}/payers/search?query=<name>&eligibilityCheck=SUPPORTED
 *   - Eligibility   : POST {base}/change/medicalnetwork/eligibility/v3
 *
 * Auth is the raw API key in the Authorization header (Stedi's scheme). If no key
 * is configured the client is disabled and callers must surface a clear "not
 * configured" state — never fabricate eligibility data.
 */

export function stediEnabled() {
  return !!config.stedi.apiKey;
}

async function stediFetch(path, { method = 'GET', body, query } = {}) {
  if (!stediEnabled()) {
    const e = new Error('Eligibility service is not configured.');
    e.code = 'STEDI_DISABLED';
    throw e;
  }
  let url = `${config.stedi.baseUrl}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.stedi.timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: config.stedi.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      // Prefer the payer/clearinghouse's real reason (AAA errors[].description) over
      // a bare HTTP status, so the provider sees WHY it failed — not "failed (451)".
      const aaa = Array.isArray(json?.errors) ? json.errors : [];
      const aaaMsg = aaa.map((x) => x?.description).filter(Boolean).join(' ');
      const msg = json?.message || json?.error || aaaMsg || `Eligibility request failed (${res.status}).`;
      const e = new Error(msg);
      // Stedi geofences some payer connections (notably Medicare FFS) to U.S.-
      // originating IPs (AAA code 41 / HTTP 451). Flag it distinctly so the UI can
      // explain it's a server-location issue, not bad patient data.
      const isGeo = res.status === 451 || aaa.some((x) => String(x?.code) === '41') || /IP address(es)? to be in the U\.S\.|originating .*U\.S\./i.test(aaaMsg);
      e.code = isGeo ? 'STEDI_US_IP_REQUIRED' : 'STEDI_ERROR';
      e.status = res.status;
      e.detail = json || text?.slice(0, 500);
      throw e;
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('The eligibility request timed out. Please try again.');
      e.code = 'STEDI_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a payer entered on the face sheet (name, ID, or alias — e.g. "UHC",
 * "Cigna") to the canonical Stedi payer. Returns the best eligibility-supported
 * match:
 *   { stediId, primaryPayerId, name (canonical displayName) }
 * The **Stedi payer ID** (`stediId`, e.g. "HGJLR") is the routing key used as
 * `tradingPartnerServiceId` for eligibility — NOT the primary payer ID. Returns
 * null if nothing matches. Never guesses.
 */
export async function searchPayer(queryText) {
  const q = String(queryText || '').trim();
  if (!q) return null;
  const data = await stediFetch('/payers/search', { query: { query: q, eligibilityCheck: 'SUPPORTED' } });
  const items = Array.isArray(data?.items) ? data.items : [];
  // Prefer an eligibility-supported payer; the API already ranks best-first.
  const supported = items.find((it) => it?.payer?.transactionSupport?.eligibilityCheck === 'SUPPORTED') || items[0];
  const p = supported?.payer;
  if (!p || !p.stediId) return null; // Stedi payer ID is required to run a check
  return { stediId: p.stediId, primaryPayerId: p.primaryPayerId || null, name: p.displayName || q };
}

/**
 * Run a real-time eligibility check. `input` mirrors Stedi's request body:
 *   provider { npi, organizationName }, subscriber { firstName, lastName,
 *   dateOfBirth (YYYYMMDD), memberId, address }, encounter { serviceTypeCodes,
 *   dateOfService (YYYYMMDD) }, tradingPartnerServiceId, externalPatientId.
 * Returns the raw 271 response JSON (the shape eligibilityService normalizes).
 */
/**
 * Single real-time eligibility call — NO automatic rechecks. If the payer is
 * momentarily unavailable (AAA "Unable to Respond") the response is returned as-is;
 * the normalizer marks it as an error/"Recheck" state and the provider can re-verify
 * manually. We never silently retry or fabricate a result.
 */
export async function checkEligibility(input) {
  return stediFetch('/change/medicalnetwork/eligibility/v3', { method: 'POST', body: input });
}

/** Log helper the workflow uses for observability without leaking PHI. */
export function stediLog(event, meta = {}) {
  logger.info({ ...meta }, `stedi:${event}`);
}
