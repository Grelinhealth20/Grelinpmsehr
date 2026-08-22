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
