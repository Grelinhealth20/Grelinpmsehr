import { config } from '../config/env.js';
import { safeEqual } from '../utils/crypto.js';
import { internalKeys } from '../services/keyRotationService.js';

/**
 * Defense-in-depth: the internal API already binds to loopback, but we also
 * require the shared gateway secret in production. This guarantees requests can
 * only originate from the trusted proxy layer — the API is never "directly
 * exposed", even if the network boundary were misconfigured.
 *
 * The internal key rotates every ~40 min; the backend accepts any key currently in
 * the rotation ring (newest + recent prior + the permanent env key), so a rotation
 * never rejects the gateway mid-flight.
 */
export function acceptsInternalKey(provided) {
  if (!provided) return false;
  return internalKeys().some((k) => k && safeEqual(provided, k));
}

export function requireGateway(req, res, next) {
  if (!config.isProd) return next(); // convenience for local/dev direct calls
  if (!acceptsInternalKey(req.get('x-internal-api-key'))) {
    return res.status(403).json({ error: 'Direct API access is not permitted.', code: 'GATEWAY_ONLY' });
  }
  next();
}
