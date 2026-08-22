import { pool, execute } from './pool.js';
import { runMigrations } from './migrate.js';
import { config, ROLES } from '../config/env.js';
import { logger } from '../config/logger.js';
import { emailExists, createUser } from '../services/userService.js';
import { hashPassword } from '../utils/password.js';
import { blindIndex } from '../utils/crypto.js';

/**
 * Seed the master administrator. Idempotent: does nothing if the account
 * already exists. The account is created with `must_reset_password = 1`, so the
 * very first login is forced through the password-reset flow.
 */
export async function seedMasterAdmin() {
  const { email, password, name } = config.masterAdmin;
  if (await emailExists(email)) {
    // Self-heal: the configured master account must always hold the master role
    // (it can never be demoted or locked out).
    const [res] = await execute(
      `UPDATE users SET role = 'master_admin', locked_until = NULL
        WHERE email_bidx = :bidx AND (role <> 'master_admin' OR locked_until IS NOT NULL)`,
      { bidx: blindIndex(email) },
    );
    logger.info({ email, healed: res.affectedRows > 0 }, 'Master admin present — ensured master role');
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
