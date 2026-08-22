import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './config/logger.js';
import { config } from './config/env.js';
import { requireGateway } from './middleware/requireGateway.js';
import { globalLimiter } from './middleware/rateLimiters.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
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
  app.use(express.json({ limit: '100kb' })); // small body cap (DoS resistance)
  app.use(cookieParser());

  // Enforce the proxy layer + global rate limit before any route runs.
  app.use('/api', requireGateway, globalLimiter, apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
