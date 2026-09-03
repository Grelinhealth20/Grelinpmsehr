import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { createProxyMiddleware } from 'http-proxy-middleware';
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
    // union[(/space]select catches "union(select"; or/and N=N and 'a'='a' catch numeric/string
    // tautologies beyond the literal 1=1. Kept anchored/bounded — no catastrophic backtracking.
    // NOTE: a bare "select … from" is NOT flagged — SELECT and FROM are ordinary English words that
    // appear constantly in clinical notes ("select a plan from the options"), and the API is fully
    // parameterized so prose can't inject. Real SQLi is caught by the SQL-SPECIFIC patterns below:
    // union-select, select-STAR-from, tautologies (N=N / 'a'='a'), stacked/comment syntax, info_schema.
    re: /(\bunion\b[\s(]+\bselect\b)|(\bselect\b\s+\*\s+\bfrom\b)|(\binsert\b\s+\binto\b)|(\bdrop\b\s+\btable\b)|(\b(or|and)\b\s+\d+\s*=\s*\d+)|(\b(or|and)\b\s+(['"])[^'"]{0,20}\7\s*=\s*\7)|(--\s)|(\/\*[\s\S]{0,200}?\*\/)|(\bsleep\s*\()|(\bbenchmark\s*\()|(\bwaitfor\b\s+\bdelay\b)|(\binformation_schema\b)/i,
  },
  {
    name: 'xss',
    // The event-handler rule is TAG-SCOPED (`<tag ... on...=`) so it catches EVERY on* handler
    // (onfocus/ontoggle/onpointerover/…), not just a fixed few, WITHOUT false-positiving on plain
    // clinical text like "onset=" (which has no preceding HTML tag). `[^>]{0,300}?` bounds backtracking.
    re: /(<script[\s/>])|(<\/script>)|(javascript:)|(<[a-z][a-z0-9]*[^>]{0,300}?\son[a-z]+\s*=)|(<iframe[\s/>])|(document\.cookie)/i,
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
  skip: (req) => req.path === '/health', // mounted under '/api', so req.path is '/health' for /api/health
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
// The API also legitimately consumes application/x-www-form-urlencoded (the SMART OAuth token
// endpoint). Parse it too so the WAF INSPECTS its fields instead of streaming them past unscanned.
const urlencodedParser = express.urlencoded({ extended: false, limit: '6mb' });
const isMultipart = (req) => (req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data');
const isJson = (req) => /application\/json|\+json/i.test(req.headers['content-type'] || '');
const isUrlEncoded = (req) => /application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '');
const hasBody = (req) => {
  const cl = Number(req.headers['content-length'] || 0);
  return cl > 0 || /chunked/i.test(req.headers['transfer-encoding'] || '');
};
const skipForUploads = (mw) => (req, res, next) => (isMultipart(req) ? next() : mw(req, res, next));
// Only parse urlencoded when it actually IS urlencoded (skip JSON/multipart/no-body requests).
const urlencodedOnly = (req, res, next) => (isUrlEncoded(req) ? urlencodedParser(req, res, next) : next());
// DEFENSE-IN-DEPTH (WAF coverage): reject a request that carries a body in a content-type the API does
// not use (text/plain, application/xml, none, …). Without this, express.json/urlencoded leave req.body
// empty for such bodies, so the WAF has nothing to scan and the RAW body streams to the backend
// unscanned — a signature-evasion path. The API only ever consumes JSON, urlencoded, or multipart, so
// anything else with a body is rejected at the edge (415) rather than forwarded uninspected.
const enforceBodyContentType = (req, res, next) => {
  if (!hasBody(req)) return next();
  if (isJson(req) || isUrlEncoded(req) || isMultipart(req)) return next();
  return res.status(415).json({ error: 'Unsupported content type.', code: 'UNSUPPORTED_MEDIA_TYPE' });
};

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
      // Prove to the backend that the request came through the trusted gateway, using the current
      // (rotating) internal key. ALWAYS strip any client-supplied value first (http-proxy copies inbound
      // headers onto the upstream request), so a client can never smuggle its own x-internal-api-key —
      // even in the edge case where we currently hold no key (env unset + refresh failed).
      proxyReq.removeHeader('x-internal-api-key');
      if (currentInternalKey) proxyReq.setHeader('x-internal-api-key', currentInternalKey);
      // Re-emit the body the JSON parser consumed so it reaches the upstream — but
      // NEVER for multipart uploads (those stream raw; re-emitting would corrupt the
      // file body). We re-stream explicitly instead of http-proxy-middleware's
      // fixRequestBody(): in v3 that helper silently bails (writing NOTHING) when it
      // can't read a Content-Type off the OUTGOING request, yet http-proxy has already
      // copied the ORIGINAL Content-Length onto the upstream request — so the backend's
      // body parser blocks forever waiting for bytes that never arrive and EVERY POST
      // hangs. Writing the parsed JSON back with a corrected Content-Length fixes it.
      // Non-JSON bodies (urlencoded, etc.) were never consumed by the JSON parser, so their raw stream
      // passes through untouched. Keying off the request's JSON CONTENT-TYPE (not off whether the parsed
      // object has keys) is essential: an empty body `{}` still arrives with the original Content-Length
      // copied onto the upstream request, so skipping it would leave the backend's express.json() blocking
      // on bytes that never come — which hung every POST/PUT carrying a `{}` payload (e.g. /coding/scrub,
      // /coding/raf, eligibility verify). Serializing `{}` sends a correct 2-byte body + Content-Length.
      // The JSON/urlencoded parser already drained AND ended `req`, so http-proxy's `req.pipe(proxyReq)`
      // never fires `.end()` on the upstream request — we write the buffered body and end it ourselves so
      // the backend's parser sees a complete request instead of blocking on Content-Length bytes forever.
      // Multipart streams raw to multer (never buffered here). Content-type keys the re-serialization so an
      // empty body (`{}`) is still re-sent with a correct Content-Length rather than skipped (which hung
      // every POST/PUT with a `{}` payload).
      if (!isMultipart(req) && req.body && typeof req.body === 'object') {
        let bodyData = null; let contentType = null;
        if (isJson(req)) { bodyData = JSON.stringify(req.body); contentType = 'application/json'; }
        else if (isUrlEncoded(req)) { bodyData = new URLSearchParams(req.body).toString(); contentType = 'application/x-www-form-urlencoded'; }
        if (bodyData !== null) {
          proxyReq.setHeader('Content-Type', contentType);
          proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
          proxyReq.end(bodyData);
        }
      }
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
// The gateway TERMINATES the client's Expect: 100-continue at ingress (Node answers
// the continue and body-parser reads the body here). The upstream hop must NOT carry
// that header forward: node-http-proxy would copy it onto the loopback request and
// then stall waiting for the backend to re-negotiate a 100-continue for a body we've
// already consumed — hanging every POST/PUT/PATCH. Strip it before proxying.
const stripHopHeaders = (req, _res, next) => { delete req.headers.expect; next(); };
app.use(
  '/api',
  edgeLimiter,
  stripHopHeaders,
  enforceBodyContentType,     // reject bodies in content-types the API doesn't use (no unscanned passthrough)
  skipForUploads(jsonParser), // parse + expose JSON for WAF inspection
  urlencodedOnly,             // parse + expose urlencoded (SMART OAuth token) for WAF inspection
  skipForUploads(waf),        // signature scan over URL + query + parsed body
  apiProxy,
);

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
        // Redirect to a CONFIGURED canonical host — never blindly reflect the client-controlled Host
        // header (a reflected open-redirect / cache-poisoning vector). When GATEWAY_CANONICAL_HOST is
        // unset, fall back to the request Host but strip it to hostname/port chars only (defeats header
        // injection); set GATEWAY_CANONICAL_HOST in production to close the reflection entirely.
        const raw = process.env.GATEWAY_CANONICAL_HOST
          || (req.headers.host || `localhost:${HTTPS_PORT}`).replace(/[^A-Za-z0-9.:-]/g, '');
        const host = raw.replace(/:\d+$/, `:${HTTPS_PORT}`);
        const path = String(req.url || '/').replace(/[\r\n]/g, '');
        res.writeHead(301, { Location: `https://${host}${path}` });
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
