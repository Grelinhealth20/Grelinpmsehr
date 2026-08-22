import { pool } from './pool.js';
import { runMigrations } from './migrate.js';
import { config, ROLES } from '../config/env.js';
import { logger } from '../config/logger.js';
import { emailExists, createUser } from '../services/userService.js';
import { hashPassword } from '../utils/password.js';

/**
 * Seed the master administrator. Idempotent: does nothing if the account
 * already exists. The account is created with `must_reset_password = 1`, so the
 * very first login is forced through the password-reset flow.
 */
export async function seedMasterAdmin() {
  const { email, password, name } = config.masterAdmin;
  if (await emailExists(email)) {
    logger.info({ email }, 'Master admin already present — skipping seed');
    return;
  }
  const passwordHash = await hashPassword(password);
  await createUser({
    email,
    fullName: name,
    role: ROLES.MASTER_ADMIN,
    passwordHash,
    mustResetPassword: true, // force reset on first login
    createdBy: null,
    status: 'active',
  });
  logger.info({ email }, 'Master admin seeded (password reset required on first login)');
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) {
  runMigrations()
    .then(seedMasterAdmin)
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Seed failed');
      process.exit(1);
    });
}
