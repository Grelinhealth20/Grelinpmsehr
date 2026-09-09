import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './config/logger.js';
import { config } from './config/env.js';
import { globalLimiter } from './middleware/rateLimiters.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import apiRoutes from './routes/index.js';
import { waf, spaCsp, authEdgeLimiter, frontendProxy } from './edge.js';

// SINGLE-SERVICE EDGE. There is no separate gateway: this process IS the public edge — it terminates
// TLS, runs the WAF + hardened headers + edge rate-limits, serves /api in-process, and reverse-proxies
// every non-/api request to the frontend SPA. (The old two-tier gateway container has been retired.)
export function createApp() {
  const app = express();

  // Trust-proxy must match the real topology, or X-Forwarded-For can be spoofed to evade the WAF IP
  // lists + per-IP rate limits. We ARE the edge: with direct TLS there is NO proxy in front → trust
  // nothing. Behind an AWS ALB/NLB that terminates TLS, set TRUST_PROXY=1 (or the real hop count).
  const TRUST_PROXY = process.env.TRUST_PROXY;
  app.set('trust proxy',
    /^\d+$/.test(TRUST_PROXY || '') ? Number(TRUST_PROXY)
      : TRUST_PROXY === 'true' ? true
        : false);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      // Never log cookies/authorization headers (handled by logger redaction too).
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  // Hardened security headers. This process serves the SPA, so it uses the strict SPA CSP
  // (script/style/img/font/connect 'self', etc.), frame-deny, no-referrer, and HSTS in production.
  app.use(
    helmet({
      contentSecurityPolicy: spaCsp(config.isProd),
      hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // The SPA is served from THIS same origin, so browser API calls are same-origin (CORS is not even
  // exercised for them). CORS stays locked to the canonical public origin, with credentials, so any
  // cross-origin caller (e.g. a SMART app) is still constrained.
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
  // edge-rate-limited, so the larger cap is not a meaningful DoS surface.
  // Capture the RAW body for the Fax.Plus (Svix) webhook so its HMAC signature can be verified over the
  // exact bytes — signature verification must run on the unparsed payload, not the re-serialized JSON.
  app.use(express.json({ limit: '16mb', verify: (req, _res, buf) => { if ((req.originalUrl || '').includes('/fax/webhook')) req.rawBody = buf; } }));
  // Form-urlencoded parsing (bounded) — required by the OAuth 2.0 / SMART token endpoint, which per spec
  // receives application/x-www-form-urlencoded. Small cap: these are short token/credential payloads.
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());

  // Edge protection is IN-PROCESS: the WAF scans every /api request, and the stricter auth limiter
  // guards /api/auth against credential stuffing. /api is served in-process by apiRoutes (no proxy hop).
  app.use('/api/auth', authEdgeLimiter);
  app.use('/api', globalLimiter, waf, apiRoutes);
  // Hard boundary: an unknown /api/* path returns a definitive JSON 404 here — it must NEVER fall
  // through to the SPA reverse-proxy (no silent fallback, and API paths are never handed to the frontend).
  app.use('/api', notFound);
  // Everything that is NOT /api is the SPA → reverse-proxy to the frontend container.
  app.use(frontendProxy(config.edge.frontendOrigin));
  app.use(errorHandler);

  return app;
}
