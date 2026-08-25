import { createApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { pool, assertDbConnection } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { seedMasterAdmin } from './db/seed.js';
import { seedSpecialties } from './services/specialtyService.js';
import { initKeyRotation } from './services/keyRotationService.js';

async function bootstrap() {
  await assertDbConnection();
  await runMigrations(); // auto-create tables (idempotent)
  await seedMasterAdmin(); // ensure master admin exists (forced reset on first login)
  await seedSpecialties(); // ensure default specialties (SNFs, Pain Management, TCM)
  await initKeyRotation(); // load/seed the rotating key ring; start the 40-min timer

  const app = createApp();

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
