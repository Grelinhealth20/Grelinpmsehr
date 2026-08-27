import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import selfsigned from 'selfsigned';
import { fileURLToPath } from 'node:url';

/**
 * Grelin Health PMS & EHR — PUBLIC security gateway.
 *
 * The ONLY internet-facing service. Responsibilities:
 *   1. WAF — signature detection (SQLi / XSS / traversal-LFI / RCE) + scanner-UA
 *      and IP block/allow lists, in blocking or monitor mode.
 *   2. Hardened transport/headers — Helmet, strict CSP, HSTS, no x-powered-by.
 *   3. Edge rate limiting (global + stricter on /api/auth).
 *   4. Serve the built React SPA (with history-API fallback).
 *   5. Reverse-proxy /api → internal API on loopback, injecting the shared
 *      INTERNAL_API_KEY so the backend can prove requests came through us.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ----------------------------------------------------------------
const isProd = process.env.NODE_ENV === 'production';
const HOST = process.env.GATEWAY_HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.GATEWAY_PORT || '6002', 10);
const INTERNAL_API_URL = process.env.INTERNAL_API_URL || 'http://127.0.0.1:6000';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
// The backend rotates the internal key ~every 40 min. We start with the env key
// (which the backend keeps permanently valid) and refresh to the current key from
// the backend's loopback bootstrap endpoint. Kept in a mutable so rotation never
// interrupts proxying.
let currentInternalKey = INTERNAL_API_KEY;
const KEY_REFRESH_MS = Number.parseInt(process.env.INTERNAL_KEY_REFRESH_MS || '60000', 10);
const FRONTEND_DIST = path.resolve(
  __dirname,
  '..',
  process.env.FRONTEND_DIST || '../frontend/dist',
);
const WAF_BLOCKING = (process.env.WAF_BLOCKING || 'true').toLowerCase() === 'true';
const parseList = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const WAF_IP_ALLOWLIST = new Set(parseList(process.env.WAF_IP_ALLOWLIST));
const WAF_IP_BLOCKLIST = new Set(parseList(process.env.WAF_IP_BLOCKLIST));

// --- TLS (gateway terminates HTTPS itself when no external LB is in front) --
const TLS_ENABLED = (process.env.GATEWAY_TLS || (isProd ? 'true' : 'false')).toLowerCase() === 'true';
const HTTPS_PORT = Number.parseInt(process.env.GATEWAY_HTTPS_PORT || '6004', 10);
const CERT_DIR = path.resolve(__dirname, '..', 'certs');
const CERT_PATH = process.env.TLS_CERT_PATH || path.join(CERT_DIR, 'gateway.crt');
const KEY_PATH = process.env.TLS_KEY_PATH || path.join(CERT_DIR, 'gateway.key');

const logger = pino({
  level: isProd ? 'info' : 'debug',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-internal-api-key"]'],
    censor: '[REDACTED]',
  },
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

// ---------------------------------------------------------------------------
// WAF signature engine
// ---------------------------------------------------------------------------
// Signatures are intentionally conservative to limit false positives on a JSON
// API that carries names, emails and passwords. Each entry inspects decoded URL
// + query string + JSON body + a few headers.
const WAF_SIGNATURES = [
  {
    name: 'sqli',
    re: /(\bunion\b\s+\bselect\b)|(\bselect\b[\s\S]+\bfrom\b)|(\binsert\b\s+\binto\b)|(\bdrop\b\s+\btable\b)|(\bor\b\s+1\s*=\s*1)|(--\s)|(\/\*[\s\S]*\*\/)|(\bsleep\s*\()|(\bbenchmark\s*\()|(\bwaitfor\b\s+\bdelay\b)|(\binformation_schema\b)/i,
  },
  {
    name: 'xss',
    re: /(<script[\s>])|(<\/script>)|(javascript:)|(\bon(error|load|click|mouseover)\s*=)|(<iframe[\s>])|(<img[\s\S]+onerror)|(document\.cookie)|(<svg[\s\S]+onload)/i,
  },
  {
    name: 'traversal-lfi',
    re: /(\.\.[\/\\]){2,}|(\.\.\/){1,}etc\/passwd|(%2e%2e[%2f%5c])|(\/etc\/passwd)|(\bfile:\/\/)|(\\windows\\system32)|(boot\.ini)/i,
  },
  {
    name: 'rce',
    re: /(;|\||`|\$\()\s*(cat|ls|id|whoami|curl|wget|nc|bash|sh|powershell|cmd|ping)\b|(\bcmd\.exe\b)|(\/bin\/(ba)?sh\b)|(\$\{jndi:)/i,
  },
];

// User-Agents belonging to known scanners / offensive tooling.
const SCANNER_UA_RE =
  /(sqlmap|nikto|nmap|masscan|acunetix|nessus|openvas|dirbuster|gobuster|wpscan|hydra|metasploit|zgrab|nuclei|fuzz|w3af|arachni)/i;

function clientIp(req) {
  // Gateway is the edge; prefer the socket address. If a TLS terminator is put
  // in front (trust proxy), express populates req.ip from X-Forwarded-For.
  return req.ip || req.socket?.remoteAddress || '';
}

function scanValue(value) {
  if (!value) return null;
  for (const sig of WAF_SIGNATURES) {
    if (sig.re.test(value)) return sig.name;
  }
  return null;
}

// Credential/secret fields are never signature-scanned: a real password may
// legitimately contain SQL/shell punctuation (false-positive lockouts), and
// secrets must never be regex-matched or risk landing in logs. Every other
// field is still inspected, recursively.
const WAF_SKIP_KEYS = new Set([
  'password', 'currentpassword', 'newpassword', 'temporarypassword',
  'confirmpassword', 'token', 'csrftoken',
]);

function collectScannable(value, out, depth = 0) {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') { out.push(value); return; }
  if (typeof value !== 'object') return; // numbers/booleans carry no signatures
  if (Array.isArray(value)) {
    for (const v of value) collectScannable(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (WAF_SKIP_KEYS.has(k.toLowerCase())) continue;
    collectScannable(v, out, depth + 1);
  }
}

function waf(req, res, next) {
  const ip = clientIp(req);

  // 1. IP lists (allowlist wins — explicit trust bypasses signature checks).
  if (WAF_IP_ALLOWLIST.has(ip)) return next();
  if (WAF_IP_BLOCKLIST.has(ip)) {
    logger.warn({ ip, url: req.originalUrl }, 'WAF: blocklisted IP');
    if (WAF_BLOCKING) return res.status(403).json({ error: 'Forbidden.', code: 'WAF_IP_BLOCKED' });
  }

  // 2. Scanner user-agents.
  const ua = req.get('user-agent') || '';
  if (SCANNER_UA_RE.test(ua)) {
    logger.warn({ ip, ua, url: req.originalUrl }, 'WAF: scanner user-agent');
    if (WAF_BLOCKING) return res.status(403).json({ error: 'Forbidden.', code: 'WAF_SCANNER_UA' });
  }

  // 3. Signature scan over decoded URL, query values and JSON body.
  let decodedUrl = req.originalUrl;
  try {
    decodedUrl = decodeURIComponent(req.originalUrl);
  } catch {
    // Malformed percent-encoding is itself suspicious.
    logger.warn({ ip, url: req.originalUrl }, 'WAF: malformed URL encoding');
    if (WAF_BLOCKING) return res.status(400).json({ error: 'Bad request.', code: 'WAF_BAD_ENCODING' });
  }

  const haystacks = [decodedUrl];
  for (const v of Object.values(req.query || {})) {
    haystacks.push(Array.isArray(v) ? v.join(' ') : String(v));
  }
  if (req.body && typeof req.body === 'object') {
    collectScannable(req.body, haystacks); // scans all fields except credentials/secrets
  }

  for (const h of haystacks) {
    const hit = scanValue(h);
    if (hit) {
      logger.warn({ ip, url: req.originalUrl, rule: hit }, `WAF: ${hit} signature`);
      if (WAF_BLOCKING) {
        return res.status(403).json({ error: 'Request blocked by WAF.', code: `WAF_${hit.toUpperCase()}` });
      }
      break; // monitor mode: log once, allow through
    }
  }

  next();
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
// The gateway is the network edge. Trust X-Forwarded-* ONLY when a real proxy
// (TLS terminator / load balancer) actually sits in front — otherwise a client
// could spoof X-Forwarded-For to evade the WAF IP lists and per-IP rate limits.
// Set TRUST_PROXY to the number of trusted hops (e.g. 1) when fronted; default none.
const TRUST_PROXY = process.env.TRUST_PROXY ?? 'false';
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === 'true');

app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/healthz' },
  }),
);

// Hardened headers. CSP is tuned for the Vite-built SPA (self-hosted JS/CSS,
// same-origin XHR to /api, inline styles React may set via style attributes).
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        ...(isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  }),
);

app.use(compression());
app.use(cookieParser());

// Edge rate limits — applied to /api only (below). Static SPA assets are NOT
// rate-limited, so page/asset loads never consume the API budget.
const edgeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200, // per client IP / minute, for /api
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
  message: { error: 'Too many requests. Please slow down.' },
});
const authEdgeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

// Gateway liveness (never proxied, never WAF-scanned, never rate-limited).
app.get('/healthz', (req, res) => res.json({ status: 'ok', service: 'grelin-pms-gateway' }));

// ---------------------------------------------------------------------------
// /api — WAF, then reverse-proxy to the internal API on loopback.
// ---------------------------------------------------------------------------
// Parse the JSON body ONLY for /api so the WAF can inspect it; fixRequestBody
// re-streams it to the upstream. The cap MIRRORS the backend (6 MB) so long clinical
// notes (a 100k-word record is ~0.6 MB) and facility-logo data URIs pass through — a
// smaller cap here would 413 large notes at the gateway before they ever reach the API.
// Multipart file uploads are streamed RAW to the backend — never JSON-parsed,
// WAF-buffered, or re-emitted — so the upload stream reaches multer intact.
const jsonParser = express.json({ limit: '6mb' });
const isMultipart = (req) => (req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data');
const skipForUploads = (mw) => (req, res, next) => (isMultipart(req) ? next() : mw(req, res, next));

const apiProxy = createProxyMiddleware({
  target: INTERNAL_API_URL,
  changeOrigin: false, // loopback upstream; preserve Host for the backend CORS/origin logic
  xfwd: true,
  // Long enough for synchronous document-AI OCR extraction (multi-page scans)
  // to complete without the edge cutting the connection; the backend enforces
  // its own per-request OCR deadline below this.
  proxyTimeout: 120000,
  timeout: 120000,
  // Mounting at '/api' makes Express strip the prefix from req.url; restore the
  // full original path so the backend (which serves everything under /api) matches.
  pathRewrite: (_path, req) => req.originalUrl,
  on: {
    proxyReq: (proxyReq, req) => {
      // Prove to the backend that the request came through the trusted gateway,
      // using the current (rotating) internal key.
      if (currentInternalKey) proxyReq.setHeader('x-internal-api-key', currentInternalKey);
      // Re-emit the body the JSON parser consumed — but NEVER for multipart
      // uploads (those stream raw; re-emitting would corrupt the file body).
      if (!isMultipart(req)) fixRequestBody(proxyReq, req);
    },
    error: (err, req, res) => {
      logger.error({ err: err.message, url: req.originalUrl }, 'Proxy error');
      if (res && !res.headersSent && typeof res.status === 'function') {
        res.status(502).json({ error: 'Upstream API unavailable.', code: 'BAD_GATEWAY' });
      }
    },
  },
});

// Keep the internal key current. Present the key we currently hold (env key
// bootstraps this after a restart); the backend returns the newest key, which we
// adopt. Failures are non-fatal — we simply keep using the last good key.
async function refreshInternalKey() {
  try {
    const r = await fetch(`${INTERNAL_API_URL}/internal/gateway-key`, {
      headers: currentInternalKey ? { 'x-internal-api-key': currentInternalKey } : {},
    });
    if (r.ok) {
      const d = await r.json();
      if (d && typeof d.key === 'string' && d.key && d.key !== currentInternalKey) {
        currentInternalKey = d.key;
        logger.info('Adopted rotated internal key');
      }
    }
  } catch { /* keep the last good key */ }
}
setInterval(refreshInternalKey, Math.max(5000, KEY_REFRESH_MS)).unref?.();
refreshInternalKey();

app.use('/api/auth', authEdgeLimiter);
app.use('/api', edgeLimiter, skipForUploads(jsonParser), skipForUploads(waf), apiProxy);

// ---------------------------------------------------------------------------
// SPA delivery. Two supported topologies — the gateway is the edge either way,
// so the WAF, CSP and rate limits always sit in front of the app:
//
//   1. FRONTEND_ORIGIN set  → the React build lives in its own container (its
//      own image, served by nginx). We reverse-proxy everything that is not
//      /api to it; that container handles the history-API fallback.
//   2. otherwise            → serve the build straight off disk (single-image
//      or bare-metal deploys), with the history fallback handled here.
// ---------------------------------------------------------------------------
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';

if (FRONTEND_ORIGIN) {
  app.use(
    createProxyMiddleware({
      target: FRONTEND_ORIGIN,
      changeOrigin: false,
      xfwd: true,
      on: {
        error: (err, req, res) => {
          logger.error({ err: err.message, url: req.originalUrl }, 'SPA proxy error');
          if (res && !res.headersSent && typeof res.status === 'function') {
            res.status(502).json({ error: 'Frontend unavailable.', code: 'BAD_GATEWAY' });
          }
        },
      },
    }),
  );
} else {
  app.use(
    express.static(FRONTEND_DIST, {
      index: false,
      maxAge: isProd ? '1h' : 0,
      setHeaders: (res, filePath) => {
        // Content-hashed assets can be cached hard; index.html must not be.
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );

  app.get('*', (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
}

// 404 / error handlers.
app.use((req, res) => res.status(404).json({ error: 'Not found.', code: 'NOT_FOUND' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  // Body-parser / request-stream errors (oversized body, malformed JSON, bad
  // encoding) carry a client status + type — return a clean 4xx, not a 500.
  if (err && typeof err.type === 'string') {
    const s = err.status || err.statusCode || 400;
    if (s < 500) {
      const msg = err.type === 'entity.too.large' ? 'Request body is too large.'
        : err.type === 'entity.parse.failed' ? 'Request body is not valid JSON.'
        : 'Invalid request.';
      return res.status(s).json({ error: msg, code: 'BAD_REQUEST' });
    }
  }
  logger.error({ err: err.message }, 'Gateway error');
  res.status(500).json({ error: 'Internal error.', code: 'GATEWAY_ERROR' });
});

/** Ensure a TLS cert/key exists; generate a self-signed pair on first boot. */
async function ensureCertificate() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
    ],
  });
  fs.writeFileSync(KEY_PATH, pems.private, { mode: 0o600 });
  fs.writeFileSync(CERT_PATH, pems.cert);
  logger.info('Generated a self-signed TLS certificate for the gateway (certs/gateway.crt).');
}

let server;
const banner = `→ API ${INTERNAL_API_URL} (env=${process.env.NODE_ENV || 'development'}, WAF=${WAF_BLOCKING ? 'blocking' : 'monitor'})`;

async function start() {
  if (TLS_ENABLED) {
    await ensureCertificate();
    const creds = { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH), minVersion: 'TLSv1.2' };
    server = https.createServer(creds, app).listen(HTTPS_PORT, HOST, () => {
      logger.info(`Gateway listening on https://${HOST}:${HTTPS_PORT} ${banner}`);
      logger.info(FRONTEND_ORIGIN ? `Proxying SPA from ${FRONTEND_ORIGIN}` : `Serving SPA from ${FRONTEND_DIST}`);
    });
    // Plain-HTTP listener that permanently redirects to HTTPS.
    http
      .createServer((req, res) => {
        const host = (req.headers.host || `localhost:${HTTPS_PORT}`).replace(/:\d+$/, `:${HTTPS_PORT}`);
        res.writeHead(301, { Location: `https://${host}${req.url}` });
        res.end();
      })
      .listen(PORT, HOST, () => logger.info(`HTTP :${PORT} → HTTPS :${HTTPS_PORT} redirect active`));
  } else {
    server = app.listen(PORT, HOST, () => {
      logger.info(`Gateway listening on http://${HOST}:${PORT} ${banner}`);
      logger.info(FRONTEND_ORIGIN ? `Proxying SPA from ${FRONTEND_ORIGIN}` : `Serving SPA from ${FRONTEND_DIST}`);
    });
  }
}
start().catch((err) => { logger.error({ err: err.message }, 'Gateway failed to start'); process.exit(1); });

const shutdown = (signal) => {
  logger.info({ signal }, 'Shutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
