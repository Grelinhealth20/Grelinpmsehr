import { logger } from '../config/logger.js';

export function notFound(req, res) {
  res.status(404).json({ error: 'Resource not found.' });
}

/**
 * Central error handler. Known operational errors expose a clean message;
 * unexpected errors are logged server-side and returned generically so we never
 * leak stack traces or internals to clients (VAPT: information disclosure).
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Multipart upload errors (multer) → clean 400 instead of a generic 500.
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 10 MB limit.' : 'File upload error.';
    return res.status(400).json({ error: msg, code: err.code });
  }
  // Body-parser / request-stream errors (oversized body, malformed JSON, bad
  // encoding, aborted request) carry a `type` + client status — return a clean
  // 4xx, never a 500. Without this an oversized/garbage body leaks a server error.
  if (err && typeof err.type === 'string') {
    const s = err.status || err.statusCode || 400;
    if (s < 500) {
      const msg = err.type === 'entity.too.large' ? 'Request body is too large.'
        : err.type === 'entity.parse.failed' ? 'Request body is not valid JSON.'
        : err.type === 'charset.unsupported' || err.type === 'encoding.unsupported' ? 'Unsupported request encoding.'
        : 'Invalid request.';
      return res.status(s).json({ error: msg, code: 'BAD_REQUEST' });
    }
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  }
  // Only surface a raw message for errors we explicitly trust: our operational errors always carry a
  // `code` (AuthError, etc.), or may set `expose: true`. Any other 4xx — including a library/DB error
  // that happens to carry a sub-500 status — returns a generic message, so an internal detail (SQL
  // text, a PHI fragment, a stack hint) can never leak through the 4xx path. Details only pass through
  // when they are a plain validation array on a trusted error.
  const trusted = status < 500 && (err.expose === true || typeof err.code === 'string');
  const body = { error: trusted ? err.message : (status >= 500 ? 'An unexpected error occurred.' : 'Invalid request.') };
  if (err.code) body.code = err.code;
  if (trusted && Array.isArray(err.details)) body.details = err.details;
  res.status(status).json(body);
}
