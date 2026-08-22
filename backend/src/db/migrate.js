import { pool, assertDbConnection } from './pool.js';
import { SCHEMA_STATEMENTS } from './schema.js';
import { logger } from '../config/logger.js';

/**
 * Apply the schema. Idempotent (CREATE TABLE IF NOT EXISTS) so it runs safely on
 * every boot. Can also be invoked directly: `npm run migrate`.
 */
/** Idempotently add a column (and optional FK) to an existing table. */
async function ensureColumn(table, column, definition, fkClause) {
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (cols.length === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
    if (fkClause) await pool.query(`ALTER TABLE \`${table}\` ADD ${fkClause}`);
    logger.info({ table, column }, 'Added column via migration');
  }
}

export async function runMigrations() {
  await assertDbConnection();
  for (const statement of SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
  // Wire providers to specialties (added after the base users table existed).
  await ensureColumn(
    'users',
    'specialty_id',
    '`specialty_id` BIGINT UNSIGNED NULL AFTER `access_level`',
    'CONSTRAINT `fk_users_specialty` FOREIGN KEY (`specialty_id`) REFERENCES `specialties`(`id`) ON DELETE SET NULL',
  );
  // SNF facility information on the patient face sheet (encrypted PHI blob).
  await ensureColumn('patients', 'facility_enc', '`facility_enc` VARBINARY(3072) NULL AFTER `insurance_enc`');
  // Optional link from an appointment to an existing patient record.
  await ensureColumn(
    'appointments',
    'patient_uuid',
    '`patient_uuid` CHAR(36) NULL AFTER `patient_name_enc`',
  );
  // Provider credential tags (MD, DO, NP, APRN, ASNP, PA, …) — staff metadata, not PHI.
  await ensureColumn('users', 'credentials', '`credentials` JSON NULL AFTER `specialty_id`');
  // Rendering provider selected for an appointment (may differ from the owner).
  await ensureColumn(
    'appointments',
    'rendering_provider_id',
    '`rendering_provider_id` BIGINT UNSIGNED NULL AFTER `provider_id`',
    'CONSTRAINT `fk_appt_rendering` FOREIGN KEY (`rendering_provider_id`) REFERENCES `users`(`id`) ON DELETE SET NULL',
  );
  // Emergency contact on the patient face sheet (encrypted PHI blob).
  await ensureColumn('patients', 'emergency_enc', '`emergency_enc` VARBINARY(2048) NULL AFTER `facility_enc`');
  // Human-readable encounter number per DOS, wired to the patient MRN.
  await ensureColumn('encounters', 'encounter_no', '`encounter_no` VARCHAR(48) NULL AFTER `uuid`');
  // Date of service for standalone (manually created) encounters not tied to an appointment.
  await ensureColumn('encounters', 'encounter_date', '`encounter_date` DATE NULL AFTER `patient_id`');
  logger.info(`Schema ensured (${SCHEMA_STATEMENTS.length} tables)`);
}

// Allow running standalone.
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
