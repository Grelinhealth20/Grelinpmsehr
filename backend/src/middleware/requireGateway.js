import { config } from '../config/env.js';
import { safeEqual } from '../utils/crypto.js';

/**
 * Defense-in-depth: the internal API already binds to loopback, but we also
 * require the shared gateway secret in production. This guarantees requests can
 * only originate from the trusted proxy layer — the API is never "directly
 * exposed", even if the network boundary were misconfigured.
 */
export function requireGateway(req, res, next) {
  if (!config.isProd) return next(); // convenience for local/dev direct calls
  const provided = req.get('x-internal-api-key');
  if (!config.api.internalKey || !provided || !safeEqual(provided, config.api.internalKey)) {
    return res.status(403).json({ error: 'Direct API access is not permitted.', code: 'GATEWAY_ONLY' });
  }
  next();
}
