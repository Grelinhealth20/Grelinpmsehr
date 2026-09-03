import rateLimit from 'express-rate-limit';

/**
 * Global API limiter — blunts scraping / brute force at the app tier while
 * comfortably accommodating a busy SPA (each screen fans out several reads).
 * Health checks are exempt so monitoring never trips it.
 */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200, // per client IP / minute
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/api/health',
  message: { error: 'Too many requests. Please slow down.' },
});

/** Strict limiter for authentication endpoints (credential stuffing defense). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

/**
 * AI (OpenAI) endpoint limiter — each call spends real tokens, so cap generation PER PROVIDER to a
 * sane rate. Keyed by authenticated user (falls back to IP) so one provider cannot run up the bill.
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12, // template drafts per provider per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.authUserId ? `ai:${req.authUserId}` : req.ip),
  message: { error: 'You’re generating templates too quickly — please wait a moment and try again.', code: 'AI_RATE_LIMIT' },
});

/**
 * OCR / document-extraction limiter — these endpoints run an expensive OCR
 * pipeline (image/PDF rasterization + inference), so cap PER authenticated user
 * (falls back to IP). Mirrors aiLimiter's per-user keying and 1-minute window so
 * one account can't pin the OCR service with a flood of scans.
 */
export const ocrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // OCR / extract calls per user per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.authUserId ? `ocr:${req.authUserId}` : req.ip),
  message: { error: 'Too many document scans — please wait a moment and try again.', code: 'OCR_RATE_LIMIT' },
});
