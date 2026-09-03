import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './config/logger.js';
import { config } from './config/env.js';
import { requireGateway, acceptsInternalKey } from './middleware/requireGateway.js';
import { globalLimiter } from './middleware/rateLimiters.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { activeInternalKey } from './services/keyRotationService.js';
import apiRoutes from './routes/index.js';

export function createApp() {
  const app = express();

  // We sit behind the gateway/proxy; trust exactly one hop for correct client IPs.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      // Never log cookies/authorization headers (handled by logger redaction too).
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  // Hardened security headers. The API returns JSON only, so a strict CSP is safe.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Only the gateway origin may call the API, and only with credentials.
  app.use(
    cors({
      origin: config.api.gatewayOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    }),
  );

  app.use(compression());
  // Body cap sized for real clinical content: long-form notes (a 100k-word record is
  // ~0.6 MB; the note schema caps content well under this) and facility-logo data URIs
  // (~0.7 MB). Set ABOVE the note-content validation limit so an oversized note is
  // rejected by validation (clear 400) rather than the parser (413). Authenticated +
  // gateway-rate-limited, so the larger cap is not a meaningful DoS surface.
  app.use(express.json({ limit: '6mb' }));
  // Form-urlencoded parsing (bounded) — required by the OAuth 2.0 / SMART token endpoint, which per spec
  // receives application/x-www-form-urlencoded. Small cap: these are short token/credential payloads.
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  // Loopback bootstrap: the gateway pulls the current (rotating) internal key from
  // here, presenting a key already in the ring (its env key bootstraps this). Not
  // under /api, not client-reachable (API binds to loopback); prod requires a ring key.
  app.get('/internal/gateway-key', (req, res) => {
    if (config.isProd && !acceptsInternalKey(req.get('x-internal-api-key'))) {
      return res.status(403).json({ error: 'Forbidden.', code: 'GATEWAY_ONLY' });
    }
    res.json({ key: activeInternalKey() });
  });

  // Enforce the proxy layer + global rate limit before any route runs.
  app.use('/api', requireGateway, globalLimiter, apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
