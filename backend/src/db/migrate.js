import { pool, assertDbConnection } from './pool.js';
import { SCHEMA_STATEMENTS } from './schema.js';
import { logger } from '../config/logger.js';

/**
 * Apply the schema. Idempotent (CREATE TABLE IF NOT EXISTS) so it runs safely on
 * every boot. Can also be invoked directly: `npm run migrate`.
 */
/** Idempotently add a non-unique index to an existing table (enterprise scale). */
async function ensureIndex(table, indexName, columns) {
  const [idx] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, indexName],
  );
  if (idx.length === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columns})`);
    logger.info({ table, indexName }, 'Added index via migration');
  }
}

/**
 * Idempotently add a UNIQUE index. Tolerant: if existing duplicate rows prevent
 * creation, it logs and continues (the app-level retry still guards inserts) so a
 * legacy dataset never blocks boot.
 */
async function ensureUniqueIndex(table, indexName, columns) {
  const [idx] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, indexName],
  );
  if (idx.length) return;
  try {
    await pool.query(`ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${indexName}\` (${columns})`);
    logger.info({ table, indexName }, 'Added unique index via migration');
  } catch (err) {
    logger.warn({ table, indexName, err: err.message }, 'Unique index not added (existing duplicates?) — app-level retry still guards inserts');
  }
}

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
  // Facility logo — a data URI (base64 image), not PHI; shown across the app.
  await ensureColumn('facilities', 'logo', '`logo` MEDIUMTEXT NULL AFTER `taxonomy`');
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
  // Facility a patient belongs to — governs cross-facility data isolation. Nullable
  // so legacy patients (created before facilities existed) remain owned by their provider.
  await ensureColumn(
    'patients',
    'facility_id',
    '`facility_id` BIGINT UNSIGNED NULL AFTER `provider_id`',
    'CONSTRAINT `fk_patient_facility` FOREIGN KEY (`facility_id`) REFERENCES `facilities`(`id`) ON DELETE SET NULL',
  );
  // Scale indexes (Clinical Records over 10k+ notes): keep the flat, time-ordered
  // note list fast for both the own-scope and facility-wide paths. (facility_id and
  // patient_id are already indexed by their foreign keys.)
  await ensureIndex('encounter_notes', 'idx_note_created', '`created_at`');
  await ensureIndex('encounter_notes', 'idx_note_provider_created', '`provider_id`, `created_at`');
  // Per-patient visit numbers must be unique. NULLs are allowed to repeat, so an
  // appointment encounter awaiting its number never collides. Backed by app-level
  // retry so concurrent inserts resolve to distinct numbers instead of duplicates.
  await ensureUniqueIndex('encounters', 'uq_enc_patient_no', '`patient_id`, `encounter_no`');
  // Procedure (CPT/HCPCS) an appointment is for — drives procedure-specific
  // eligibility (STC targeting). Nullable so existing appointments are unaffected.
  await ensureColumn('appointments', 'procedure_code', '`procedure_code` VARCHAR(10) NULL AFTER `appt_type`');
  // Link an eligibility check to an appointment (appointment-level verification).
  await ensureColumn('eligibility_checks', 'appointment_uuid', '`appointment_uuid` CHAR(36) NULL AFTER `policy_index`');
  await ensureIndex('eligibility_checks', 'idx_elig_appointment', '`appointment_uuid`');
  // Insurance identity (payer + member/MBI, blind-indexed) + whether a check was an
  // AUTOMATIC payer call — used to cap automatic verifications per patient+insurance
  // and to reuse existing benefits instead of re-calling the payer.
  await ensureColumn('eligibility_checks', 'insurance_bidx', '`insurance_bidx` CHAR(64) NULL AFTER `member_id_bidx`');
  await ensureColumn('eligibility_checks', 'automatic', '`automatic` TINYINT(1) NOT NULL DEFAULT 0 AFTER `status`');
  await ensureIndex('eligibility_checks', 'idx_elig_patient_insurance', '`patient_id`, `insurance_bidx`');
  // Front-desk check-in / check-out appointment states (idempotent MODIFY).
  await pool.query(
    "ALTER TABLE `appointments` MODIFY COLUMN `status` ENUM('scheduled','checked_in','checked_out','cancelled','completed') NOT NULL DEFAULT 'scheduled'",
  );
  // System settings (super-admin controlled feature flags, e.g. whether real-time
  // eligibility verification is enabled EHR-wide). Small key/value store, not PHI.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS \`app_settings\` (
       \`setting_key\` VARCHAR(64) NOT NULL PRIMARY KEY,
       \`setting_value\` JSON NOT NULL,
       \`updated_by\` BIGINT UNSIGNED NULL,
       \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  // Rotating key material (JWT signing secrets + gateway internal key). A single
  // persisted row so automatic rotation survives restarts without invalidating any
  // live session or breaking gateway↔API proxying. Not PHI; secrets only.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS \`security_keyring\` (
       \`id\` TINYINT UNSIGNED NOT NULL PRIMARY KEY,
       \`access_ring\` JSON NOT NULL,
       \`refresh_ring\` JSON NOT NULL,
       \`internal_ring\` JSON NOT NULL,
       \`rotated_at\` DATETIME NOT NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
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
