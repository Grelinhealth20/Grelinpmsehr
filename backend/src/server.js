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

  // Bind to loopback ONLY — the API is never publicly reachable; the gateway is.
  const server = app.listen(config.api.port, config.api.host, () => {
    logger.info(
      `Internal API listening on http://${config.api.host}:${config.api.port} (env=${config.env})`,
    );
  });

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

bootstrap().catch((err) => {
  logger.error({ err }, 'Fatal boot error');
  process.exit(1);
});
