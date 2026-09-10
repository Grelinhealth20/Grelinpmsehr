import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import { createApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { pool, assertDbConnection, warmPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { seedMasterAdmin } from './db/seed.js';
import { seedSpecialties } from './services/specialtyService.js';
import { initKeyRotation } from './services/keyRotationService.js';
import { warmTerminologyCache } from './services/terminologyCache.js';
import { warmMedSafetyIndex } from './services/medSafetyService.js';
import { loadPersistedFaxCredentials } from './services/faxService.js';
import { startFaxReconciler } from './services/faxReconciler.js';

async function bootstrap() {
  await assertDbConnection();
  await runMigrations(); // auto-create tables (idempotent)
  await seedMasterAdmin(); // ensure master admin exists (forced reset on first login)
  await seedSpecialties(); // ensure default specialties (SNFs, Pain Management, TCM)
  await initKeyRotation(); // load/seed the rotating key ring; start the 40-min timer
  const faxSt = await loadPersistedFaxCredentials(); // hydrate encrypted Fax.Plus refresh token from DB (survives restart)
  logger.info({ enabled: faxSt.enabled, hasRefreshToken: faxSt.hasRefreshToken }, 'Fax.Plus integration status');
  startFaxReconciler(); // if fax is live, start the no-missed-faxes / no-data-loss reconcile heartbeat

  const app = createApp();

  // Warm caches + connection pool so the FIRST requests after (re)start don't pay load/connection-setup
  // latency. All non-blocking — the API comes up immediately and a lazy load covers any early call;
  // every warm failure is LOGGED (never silent), and none affects correctness or data.
  warmTerminologyCache(); // complete billable ICD-10-CM set (coding predictions)
  warmPool().catch((e) => logger.warn({ err: e?.message }, 'pool warm error'));
  warmMedSafetyIndex().catch((e) => logger.warn({ err: e?.message }, 'med-safety index warm error'));

  // Single public edge (API + WAF + TLS + SPA proxy) — there is no separate internal/loopback tier.
  const server = startCombinedEdge(app);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down…');
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * COMBINED-EDGE listener: this process is the single public service (API + WAF + TLS + SPA proxy).
 * FAIL-LOUD, no fallback: with TLS enabled the real cert+key MUST be present and matching, else the
 * process refuses to start (never self-signs a browser-rejected cert).
 */
function startCombinedEdge(app) {
  const e = config.edge;
  if (e.tls) {
    if (!e.certPath || !e.keyPath || !fs.existsSync(e.certPath) || !fs.existsSync(e.keyPath)) {
      throw new Error(
        `COMBINED_EDGE with TLS requires TLS_CERT_PATH + TLS_KEY_PATH to exist (${e.certPath || '<unset>'} / ${e.keyPath || '<unset>'}). `
        + 'Copy the real certificate + private key into place before starting — refusing to self-sign in production.');
    }
    let creds;
    try {
      creds = { key: fs.readFileSync(e.keyPath), cert: fs.readFileSync(e.certPath), minVersion: 'TLSv1.2' };
      tls.createSecureContext(creds); // fail HERE if the key does not match the cert
    } catch (err) {
      throw new Error(`TLS cert/key at ${e.certPath} + ${e.keyPath} could not be loaded (${err.message}). Verify the key MATCHES the cert (modulus md5 must be equal).`);
    }
    const srv = https.createServer(creds, app).listen(e.httpsPort, e.host, () => {
      logger.info(`Combined edge (API + WAF + TLS + SPA) listening on https://${e.host}:${e.httpsPort} (env=${config.env})`);
      logger.info(`Reverse-proxying SPA from ${e.frontendOrigin}`);
    });
    // Plain-HTTP listener → permanent redirect to HTTPS, but answer /healthz directly (a container/LB
    // health probe on the HTTP port must not be 301'd to an unresolvable host).
    http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/healthz/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', service: 'grelin-pms' }));
      }
      // Upgrade to HTTPS on the SAME host the client requested — never rewrite the user's domain to a
      // configured canonical host (that silently flips e.g. ehr.grelinhealth.com → pms.grelinhealth.com).
      // canonicalHost is only a last resort when the request carries no Host header (e.g. HTTP/1.0).
      // Redirect to standard HTTPS (:443) — never leak the internal container port (e.g. :6004).
      const reqHost = String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '');
      const host = (reqHost || e.canonicalHost || 'localhost').replace(/:\d+$/, '');
      const path = String(req.url || '/').replace(/[\r\n]/g, '');
      res.writeHead(301, { Location: `https://${host}${path}` });
      res.end();
    }).listen(e.httpPort, e.host, () => logger.info(`HTTP :${e.httpPort} → HTTPS redirect active (preserves request host)`));
    return srv;
  }
  // Combined, but TLS terminated by an upstream LB → serve public HTTP (set TRUST_PROXY behind the LB).
  return app.listen(e.httpPort, e.host, () => {
    logger.info(`Combined edge (API + WAF + SPA, TLS upstream) listening on http://${e.host}:${e.httpPort} (env=${config.env})`);
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Fatal boot error');
  process.exit(1);
});
