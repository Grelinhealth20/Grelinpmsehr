// ============================================================================
// COMBINED-EDGE mode — the gateway's public-edge responsibilities folded INTO the
// backend process (single service). Active only when COMBINED_EDGE=true; otherwise
// the backend stays the loopback-only internal API behind a separate gateway.
//
// Provides: the WAF (signature scan + scanner-UA + IP lists), the strict SPA CSP,
// edge rate limiters, and a reverse-proxy for non-/api requests to the frontend
// container. Because /api is served IN-PROCESS here (no network proxy hop), the
// WAF simply scans the already-parsed req.body — none of the gateway's body
// re-streaming is needed, and the rotating internal-key handshake is unnecessary.
// ============================================================================
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { logger } from './config/logger.js';

const parseList = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
export const WAF_BLOCKING = (process.env.WAF_BLOCKING || 'true').toLowerCase() === 'true';
const WAF_IP_ALLOWLIST = new Set(parseList(process.env.WAF_IP_ALLOWLIST));
const WAF_IP_BLOCKLIST = new Set(parseList(process.env.WAF_IP_BLOCKLIST));

// Signatures identical to the standalone gateway (conservative — no clinical false positives).
const WAF_SIGNATURES = [
  // Tautology equality (OR/AND) covers numeric (1=1) AND quoted ('1'='1, "1"="1) auth-bypass payloads —
  // written with non-capturing groups (no fragile numbered backreference) so it is robust and catches the
  // classic `' OR '1'='1` and `"x"="x`. The comment rule matches `-- ` OR `--` at end-of-input (`admin'--`).
  { name: 'sqli', re: /(\bunion\b[\s(]+\bselect\b)|(\bselect\b\s+\*\s+\bfrom\b)|(\binsert\b\s+\binto\b)|(\bdrop\b\s+\btable\b)|(\b(?:or|and)\b\s+(?:\d+\s*=\s*\d+|'[^']{0,30}'\s*=\s*'|"[^"]{0,30}"\s*=\s*"))|(--(?:\s|$))|(\/\*[\s\S]{0,200}?\*\/)|(\bsleep\s*\()|(\bbenchmark\s*\()|(\bwaitfor\b\s+\bdelay\b)|(\binformation_schema\b)/i },
  { name: 'xss', re: /(<script[\s/>])|(<\/script>)|(javascript:)|(<[a-z][a-z0-9]*[^>]{0,300}?\son[a-z]+\s*=)|(<iframe[\s/>])|(document\.cookie)/i },
  { name: 'traversal-lfi', re: /(\.\.[\/\\]){2,}|(\.\.\/){1,}etc\/passwd|(%2e%2e[%2f%5c])|(\/etc\/passwd)|(\bfile:\/\/)|(\\windows\\system32)|(boot\.ini)/i },
  // RCE / command-injection. Tuned to avoid CLINICAL false positives: real medical prose routinely
  // writes short tokens after a semicolon/pipe — "applied; ID band verified", "ordered; CAT scan",
  // "flushed; sh…". So the short/ambiguous commands (cat, ls, id, sh, ping) only match when followed by
  // genuine shell-argument context (a flag, a /path, a redirection, another separator, or end), never a
  // plain following word; `curl` must be followed by a URL/flag/path (so "curl up in bed" is safe); the
  // genuinely-rare commands (whoami, wget, nc, bash, powershell) match on a word boundary. Real payloads
  // — "; cat /etc/passwd", "| whoami", "$(curl http://evil)", "${jndi:…}" — are all still caught.
  // A $(...) subshell or `...` backtick WRAPPER is command execution by construction and never appears in
  // clinical prose, so any wrapped command matches on a word boundary. A BARE ";"/"|" chain, by contrast,
  // shares punctuation with real notes ("applied; ID band", "reviewed; id) noted"), so the ambiguous
  // short commands there require genuine shell-argument context (flag / path / redirection / separator /
  // end) — and NOT a closing paren, which is a clinical parenthetical. Real payloads — "; cat /etc/passwd",
  // "| whoami", "$(id)", "`id`", "$(curl http://evil)", "${jndi:…}" — are all caught; clinical text is not.
  { name: 'rce', re: /(?:[;|`]|\$\()\s*(?:whoami|wget|nc|bash|powershell)\b|(?:[;|`]|\$\()\s*curl\s+(?:-|['"]|https?:|ftp|\/|\w+:\/\/)|(?:\$\(|`)\s*(?:cat|ls|id|sh|ping)\b|[;|]\s*(?:cat|ls|id|sh|ping)(?=\s*(?:[-\/;|&<>]|$))|(\bcmd\.exe\b)|(\/bin\/(ba)?sh\b)|(\$\{jndi:)/i },
];
const SCANNER_UA_RE = /(sqlmap|nikto|nmap|masscan|acunetix|nessus|openvas|dirbuster|gobuster|wpscan|hydra|metasploit|zgrab|nuclei|fuzz|w3af|arachni)/i;
const WAF_SKIP_KEYS = new Set(['password', 'currentpassword', 'newpassword', 'temporarypassword', 'confirmpassword', 'token', 'csrftoken']);

function clientIp(req) { return req.ip || req.socket?.remoteAddress || ''; }
function scanValue(value) { if (!value) return null; for (const sig of WAF_SIGNATURES) if (sig.re.test(value)) return sig.name; return null; }
// Recursively percent-decode (bounded) so a DOUBLE-encoded payload (e.g. %2520union%2520select →
// %20union%20select → " union select") is scanned in its fully-decoded form and can't slip past a
// single-decode WAF. Stops when stable, at the depth cap, or on malformed encoding.
function deepDecode(s, max = 3) {
  let cur = String(s);
  for (let i = 0; i < max; i++) {
    let next;
    try { next = decodeURIComponent(cur); } catch { break; }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}
function collectScannable(value, out, depth = 0) {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') { out.push(value); return; }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) collectScannable(v, out, depth + 1); return; }
  for (const [k, v] of Object.entries(value)) { if (WAF_SKIP_KEYS.has(k.toLowerCase())) continue; collectScannable(v, out, depth + 1); }
}

/** WAF middleware — scans decoded URL + query values + parsed JSON body (credentials skipped). */
export function waf(req, res, next) {
  const ip = clientIp(req);
  if (WAF_IP_ALLOWLIST.has(ip)) return next();
  if (WAF_IP_BLOCKLIST.has(ip)) { logger.warn({ ip, url: req.originalUrl }, 'WAF: blocklisted IP'); if (WAF_BLOCKING) return res.status(403).json({ error: 'Forbidden.', code: 'WAF_IP_BLOCKED' }); }
  const ua = req.get('user-agent') || '';
  if (SCANNER_UA_RE.test(ua)) { logger.warn({ ip, ua, url: req.originalUrl }, 'WAF: scanner user-agent'); if (WAF_BLOCKING) return res.status(403).json({ error: 'Forbidden.', code: 'WAF_SCANNER_UA' }); }
  try { decodeURIComponent(req.originalUrl); }
  catch { logger.warn({ ip, url: req.originalUrl }, 'WAF: malformed URL encoding'); if (WAF_BLOCKING) return res.status(400).json({ error: 'Bad request.', code: 'WAF_BAD_ENCODING' }); }
  // Scan the URL fully (recursively) decoded so double-encoding cannot bypass the signatures.
  const haystacks = [deepDecode(req.originalUrl)];
  for (const v of Object.values(req.query || {})) { const s = Array.isArray(v) ? v.join(' ') : String(v); haystacks.push(s, deepDecode(s)); }
  if (req.body && typeof req.body === 'object') collectScannable(req.body, haystacks);
  for (const h of haystacks) {
    const hit = scanValue(h);
    if (hit) { logger.warn({ ip, url: req.originalUrl, rule: hit }, `WAF: ${hit} signature`); if (WAF_BLOCKING) return res.status(403).json({ error: 'Request blocked by WAF.', code: `WAF_${hit.toUpperCase()}` }); break; }
  }
  next();
}

// Strict SPA Content-Security-Policy (used INSTEAD of the API-only CSP when this process also serves the
// SPA). Mirrors the standalone gateway exactly.
export function spaCsp(isProd) {
  return {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"], baseUri: ["'none'"],
      formAction: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"],
      ...(isProd ? { upgradeInsecureRequests: [] } : {}),
    },
  };
}

/** Edge rate limiters — a stricter one for /api/auth, the global one is reused from rateLimiters.js. */
export const authEdgeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });

/** Reverse-proxy every non-/api request to the frontend container (SPA), like the gateway did. */
export function frontendProxy(frontendOrigin) {
  return createProxyMiddleware({
    target: frontendOrigin,
    changeOrigin: false,
    xfwd: true,
    on: {
      error: (err, req, res) => {
        logger.error({ err: err.message, url: req.originalUrl }, 'SPA proxy error');
        if (res && !res.headersSent && typeof res.status === 'function') res.status(502).json({ error: 'Frontend unavailable.', code: 'BAD_GATEWAY' });
      },
    },
  });
}
