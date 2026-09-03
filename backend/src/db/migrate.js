import { pool, assertDbConnection } from './pool.js';
import { SCHEMA_STATEMENTS } from './schema.js';
import { seedNoteTemplates } from '../services/noteTemplateService.js';
import { backfillAuditChain } from '../services/auditService.js';
import { logger } from '../config/logger.js';

const GENESIS_HASH = '0'.repeat(64);

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
    return true; // column was newly added (caller may backfill)
  }
  return false;
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
  // Encounter-scoped lab / imaging documents: link a patient_document to a specific encounter and
  // widen doc_type to include 'lab' and 'imaging'. Encounter-scoped so lab/imaging records live under
  // the patient's encounter folder in S3 and are listed per encounter.
  await ensureColumn(
    'patient_documents',
    'encounter_id',
    '`encounter_id` BIGINT UNSIGNED NULL AFTER `patient_id`',
    'CONSTRAINT `fk_pdoc_encounter` FOREIGN KEY (`encounter_id`) REFERENCES `encounters`(`id`) ON DELETE CASCADE',
  );
  await ensureIndex('patient_documents', 'idx_pdoc_encounter', '`encounter_id`, `doc_type`');
  try {
    await pool.query("ALTER TABLE patient_documents MODIFY doc_type ENUM('license_front','license_back','insurance_front','insurance_back','other','lab','imaging') NOT NULL");
  } catch (err) {
    logger.warn({ err: err.message }, 'patient_documents doc_type widen skipped');
  }
  // Optional link from an appointment to an existing patient record.
  await ensureColumn(
    'appointments',
    'patient_uuid',
    '`patient_uuid` CHAR(36) NULL AFTER `patient_name_enc`',
  );
  // Backfill the provider↔specialty join table from the legacy single specialty_id so
  // existing single-specialty providers keep their exact access. Idempotent (INSERT IGNORE).
  try {
    await pool.query(
      `INSERT IGNORE INTO user_specialties (user_id, specialty_id)
         SELECT id, specialty_id FROM users WHERE specialty_id IS NOT NULL`,
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'user_specialties backfill skipped');
  }
  // TCM as a first-class service line: widen the service_line ENUMs (must run BEFORE the
  // note-template seed inserts tcm rows) and reclassify the existing 'TCM' specialty, which
  // was previously mapped to 'snf'. Idempotent — MODIFY re-applies the same definition.
  try {
    await pool.query("ALTER TABLE specialties MODIFY service_line ENUM('snf','pain','tcm') NOT NULL DEFAULT 'snf'");
    await pool.query("ALTER TABLE note_templates MODIFY service_line ENUM('snf','pain','tcm') NOT NULL");
    await pool.query("UPDATE specialties SET service_line = 'tcm' WHERE (LOWER(name) = 'tcm' OR LOWER(name) LIKE '%transitional care%') AND service_line <> 'tcm'");
  } catch (err) {
    logger.warn({ err: err.message }, 'TCM service-line migration skipped');
  }
  // Provider credential tags (MD, DO, NP, APRN, ASNP, PA, …) — staff metadata, not PHI.
  await ensureColumn('users', 'credentials', '`credentials` JSON NULL AFTER `specialty_id`');
  // Individual-provider NPPES identity (NPI-1): the provider's own NPI and primary
  // taxonomy, fetched from the CMS NPPES registry. PUBLIC provider data, not PHI —
  // used on claims/eligibility as the rendering provider.
  await ensureColumn('users', 'npi', '`npi` VARCHAR(10) NULL AFTER `credentials`');
  await ensureColumn('users', 'taxonomy', '`taxonomy` VARCHAR(160) NULL AFTER `npi`');
  await ensureColumn('users', 'taxonomy_code', '`taxonomy_code` VARCHAR(16) NULL AFTER `taxonomy`');
  // Full NPPES (NPI-1) identity for an individual provider — captured from the registry so nothing
  // is dropped: license #, license state, gender, sole-proprietor flag, enumeration date, status.
  await ensureColumn('users', 'license_number', '`license_number` VARCHAR(32) NULL AFTER `taxonomy_code`');
  await ensureColumn('users', 'license_state', '`license_state` VARCHAR(2) NULL AFTER `license_number`');
  await ensureColumn('users', 'provider_gender', '`provider_gender` VARCHAR(16) NULL AFTER `license_state`');
  await ensureColumn('users', 'sole_proprietor', '`sole_proprietor` VARCHAR(8) NULL AFTER `provider_gender`');
  await ensureColumn('users', 'enumeration_date', '`enumeration_date` VARCHAR(20) NULL AFTER `sole_proprietor`');
  await ensureColumn('users', 'nppes_status', '`nppes_status` VARCHAR(16) NULL AFTER `enumeration_date`');
  // Facility logo — a data URI (base64 image), not PHI; shown across the app.
  await ensureColumn('facilities', 'logo', '`logo` MEDIUMTEXT NULL AFTER `taxonomy`');
  // Facility Tax ID (EIN) — organizational billing identifier, entered by an admin
  // (not in NPPES). Kept with the facility's other billing identifiers.
  await ensureColumn('facilities', 'tax_id', '`tax_id` VARCHAR(32) NULL AFTER `taxonomy`');
  // Per-facility feature switches (Super Admin controlled). Default ON so existing facilities keep working.
  await ensureColumn('facilities', 'coding_enabled', '`coding_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `status`');
  await ensureColumn('facilities', 'eligibility_enabled', '`eligibility_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `coding_enabled`');
  // Full NPPES (NPI-2) identity for a group/organization — captured so nothing is dropped:
  // taxonomy code, fax, authorized official, enumeration date, mailing address, registry status.
  await ensureColumn('facilities', 'taxonomy_code', '`taxonomy_code` VARCHAR(16) NULL AFTER `taxonomy`');
  await ensureColumn('facilities', 'fax', '`fax` VARCHAR(24) NULL AFTER `phone`');
  await ensureColumn('facilities', 'authorized_official', '`authorized_official` VARCHAR(200) NULL AFTER `taxonomy_code`');
  await ensureColumn('facilities', 'enumeration_date', '`enumeration_date` VARCHAR(20) NULL AFTER `authorized_official`');
  await ensureColumn('facilities', 'mailing_address', '`mailing_address` VARCHAR(300) NULL AFTER `enumeration_date`');
  await ensureColumn('facilities', 'nppes_status', '`nppes_status` VARCHAR(16) NULL AFTER `mailing_address`');
  // Rendering provider selected for an appointment (may differ from the owner).
  await ensureColumn(
    'appointments',
    'rendering_provider_id',
    '`rendering_provider_id` BIGINT UNSIGNED NULL AFTER `provider_id`',
    'CONSTRAINT `fk_appt_rendering` FOREIGN KEY (`rendering_provider_id`) REFERENCES `users`(`id`) ON DELETE SET NULL',
  );
  // Emergency contact on the patient face sheet (encrypted PHI blob).
  await ensureColumn('patients', 'emergency_enc', '`emergency_enc` MEDIUMBLOB NULL AFTER `facility_enc`');
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
  // Clinical Records ordering: drafts (Yet to Sign) first, then newest — kept fast at
  // 10k+ records with a composite index matching ORDER BY status, created_at.
  await ensureIndex('encounter_notes', 'idx_note_provider_status_created', '`provider_id`, `status`, `created_at`');
  await ensureIndex('encounter_notes', 'idx_note_status_created', '`status`, `created_at`');
  // Patient encounters sub-table (newest DOS first) — kept fast per patient at scale.
  await ensureIndex('encounters', 'idx_enc_patient_date', '`patient_id`, `encounter_date`');
  await ensureIndex('encounters', 'idx_enc_provider', '`provider_id`');
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
  // Enlarge encrypted columns whose VALIDATION-allowed content can exceed the original
  // fixed VARBINARY size (which caused "Data too long" and lost the save). MEDIUMBLOB is
  // stored off-page (no row-size impact) and holds any validation-allowed value:
  //  - encounter_notes.content_enc — long-form notes (many sections up to 500k chars)
  //  - patients.insurance_enc      — up to 5 policies with full benefits (~12 KB)
  //  - patients.emergency_enc      — up to 8 emergency contacts (~4 KB)
  const ensureMediumblob = async (table, column) => {
    const [c] = await pool.query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column],
    );
    if (c[0] && String(c[0].DATA_TYPE).toLowerCase() !== 'mediumblob') {
      await pool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` MEDIUMBLOB NULL`);
      logger.info({ table, column }, 'Enlarged encrypted column → MEDIUMBLOB');
    }
  };
  await ensureMediumblob('encounter_notes', 'content_enc');
  await ensureMediumblob('patients', 'insurance_enc');
  await ensureMediumblob('patients', 'emergency_enc');

  // Explicit SERVICE LINE per specialty (snf | pain) — the authoritative source for
  // clinical data-isolation, replacing name-string inference in the security path. On
  // first add, backfill existing rows by their name (word-boundary "pain"); thereafter
  // it is admin-controlled and never re-derived, so an admin override sticks.
  {
    const added = await ensureColumn(
      'specialties',
      'service_line',
      "`service_line` ENUM('snf','pain') NOT NULL DEFAULT 'snf' AFTER `name`",
    );
    if (added) {
      // Pad + non-letter boundaries == JS serviceForSpecialty()'s /\bpain\b/i, ICU-safe.
      const [r] = await pool.query(
        "UPDATE `specialties` SET `service_line` = 'pain' WHERE CONCAT(' ', LOWER(`name`), ' ') REGEXP '[^a-z]pain[^a-z]'",
      );
      logger.info({ painRows: r.affectedRows }, 'Backfilled specialties.service_line');
    }
  }

  // Backfill patient name-search tokens for any patient not yet indexed (one-time; also
  // covers patients created before flexible prefix search existed). Batched to scale.
  try {
    const { syncPatientNameTokensFromEnc } = await import('../services/patientService.js');
    let backfilled = 0;
    for (;;) {
      const [batch] = await pool.query(
        `SELECT p.id, p.demographics_enc FROM patients p
          WHERE NOT EXISTS (SELECT 1 FROM patient_name_tokens t WHERE t.patient_id = p.id)
          LIMIT 500`,
      );
      if (!batch.length) break;
      for (const row of batch) await syncPatientNameTokensFromEnc(row.id, row.demographics_enc);
      backfilled += batch.length;
      if (batch.length < 500) break;
    }
    if (backfilled) logger.info({ patients: backfilled }, 'Backfilled patient name-search tokens');
  } catch (err) { logger.warn({ err: err.message }, 'Patient name-token backfill skipped'); }

  // Seed/refresh the note-template registry (SNF + Pain service lines).
  try { const n = await seedNoteTemplates(); logger.info({ templates: n }, 'Note-template registry seeded'); }
  catch (err) { logger.warn({ err: err.message }, 'Note-template registry seed skipped'); }

  // Documents: category taxonomy (widen doc_type ENUM to Medical/Labs/Imaging/Insurance/Other), a
  // Date-of-Service column so documents can be arranged by DOS, and a composite index so the paginated
  // Documents tab stays fast at scale (thousands of documents per patient). Idempotent.
  try {
    await pool.query("ALTER TABLE patient_documents MODIFY doc_type ENUM('license_front','license_back','insurance_front','insurance_back','insurance_card','medical_record','lab_result','lab','imaging','other') NOT NULL");
  } catch (err) { logger.warn({ err: err.message }, 'patient_documents doc_type ENUM widen skipped'); }
  try {
    const added = await ensureColumn('patient_documents', 'service_date', '`service_date` DATE NULL AFTER `content_type`');
    if (added) await pool.query('UPDATE patient_documents SET service_date = DATE(created_at) WHERE service_date IS NULL');
  } catch (err) { logger.warn({ err: err.message }, 'patient_documents service_date add skipped'); }
  await ensureIndex('patient_documents', 'idx_pdoc_patient_dos', 'patient_id, service_date, id');

  // Audit hash-chain (ONC (d)(2)): ensure the single-row chain head exists, and establish the integrity
  // baseline exactly ONCE — only while the head is still genesis (never re-baseline afterwards, which
  // would mask tampering). After adoption, every append chains itself via recordAudit().
  try {
    await pool.query('INSERT IGNORE INTO audit_chain (id, last_hash) VALUES (1, ?)', [GENESIS_HASH]);
    const [[head]] = [await pool.query('SELECT last_hash FROM audit_chain WHERE id = 1')].map((x) => x[0]);
    if (!head || head.last_hash === GENESIS_HASH) {
      const [[c]] = [await pool.query('SELECT COUNT(*) n FROM audit_logs')].map((x) => x[0]);
      if (c.n > 0) { const bf = await backfillAuditChain(); logger.info({ rows: bf.updated }, 'Audit hash-chain baseline established'); }
    }
  } catch (err) { logger.warn({ err: err.message }, 'Audit hash-chain baseline skipped'); }

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
