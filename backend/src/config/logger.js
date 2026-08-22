import pino from 'pino';
import { config } from './env.js';

/**
 * Structured logger. In production we NEVER log PHI or secrets — the redaction
 * list below scrubs common sensitive fields defensively.
 */
export const logger = pino({
  level: config.isProd ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'ssn',
      '*.ssn',
    ],
    censor: '[REDACTED]',
  },
  transport: config.isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
