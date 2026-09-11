import { pool, assertDbConnection } from './pool.js';
import { SCHEMA_STATEMENTS } from './schema.js';
import { seedNoteTemplates } from '../services/noteTemplateService.js';
import { backfillAuditChain } from '../services/auditService.js';
import { userNameTokens } from '../services/userService.js';
import { decrypt } from '../utils/crypto.js';
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
    await pool.query("ALTER TABLE specialties MODIFY service_line ENUM('snf','pain','tcm','pi') NOT NULL DEFAULT 'snf'");
    await pool.query("ALTER TABLE note_templates MODIFY service_line ENUM('snf','pain','tcm','pi') NOT NULL");
    await pool.query("UPDATE specialties SET service_line = 'tcm' WHERE (LOWER(name) = 'tcm' OR LOWER(name) LIKE '%transitional care%') AND service_line <> 'tcm'");
    // Classify Personal Injury (PIP/BI) specialties onto the 'pi' service line (idempotent).
    await pool.query("UPDATE specialties SET service_line = 'pi' WHERE (LOWER(name) LIKE '%personal injury%' OR LOWER(name) LIKE '%pip%' OR LOWER(name) LIKE '%bodily injury%' OR name REGEXP '(^|[^a-z])(pi|bi)([^a-z]|$)') AND service_line <> 'pi'");
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
  // Facility CODE — the short, admin-set, UNIQUE site prefix used in the facility-specific MRN
  // (CODE-NNNNNN-C) and Encounter ID (CODE-YYYY-NNNNNN). Auto-seeded from the name for existing
  // facilities (below); admins can edit it. Uppercase alphanumeric.
  await ensureColumn('facilities', 'facility_code', '`facility_code` VARCHAR(12) NULL AFTER `name`');
  try { await pool.query('CREATE UNIQUE INDEX `uq_facility_code` ON `facilities` (`facility_code`)'); }
  catch (e) { if (!/Duplicate key name|already exists/i.test(e.message)) logger.warn({ err: e.message }, 'facility_code unique index'); }
  // Atomic per-scope counters — the concurrency-safe backbone of the facility-specific ID series
  // (scope 'mrn:<facilityId>' and 'enc:<facilityId>:<year>'). One row per scope; the MySQL
  // LAST_INSERT_ID trick increments and returns the next value atomically (no gaps, no collisions).
  await pool.query(
    `CREATE TABLE IF NOT EXISTS \`id_sequences\` (
       \`scope\` VARCHAR(64) NOT NULL,
       \`seq\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
       \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (\`scope\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  // Backfill a UNIQUE facility_code for any facility that lacks one — derived from the name (first
  // alphanumerics, uppercased, ≥2 chars), with a numeric suffix on collision. Deterministic, one-time.
  try {
    const [needCode] = await pool.query('SELECT id, name FROM facilities WHERE facility_code IS NULL OR facility_code = ""');
    if (needCode.length) {
      const [taken] = await pool.query('SELECT facility_code AS c FROM facilities WHERE facility_code IS NOT NULL AND facility_code <> ""');
      const used = new Set(taken.map((r) => String(r.c).toUpperCase()));
      for (const f of needCode) {
        const alpha = String(f.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        let base = (alpha.slice(0, 3) || `F${f.id}`).padEnd(2, 'X').slice(0, 8);
        let code = base; let n = 1;
        while (used.has(code)) { const suf = String(n++); code = (base.slice(0, Math.max(2, 8 - suf.length)) + suf); }
        used.add(code);
        await pool.query('UPDATE facilities SET facility_code = :c WHERE id = :id', { c: code, id: f.id });
      }
      logger.info({ facilities: needCode.length }, 'Backfilled facility_code');
    }
  } catch (err) { logger.warn({ err: err.message }, 'facility_code backfill skipped'); }
  // Per-facility feature switches (Super Admin controlled). Default ON so existing facilities keep working.
  await ensureColumn('facilities', 'coding_enabled', '`coding_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `status`');
  await ensureColumn('facilities', 'eligibility_enabled', '`eligibility_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `coding_enabled`');
  // Per-facility REFERRAL FEATURE switch (Super Admin). Default ON so existing facilities keep Referrals.
  // Distinct from fax_referrals_enabled (which gates only faxing) — this gates the whole Referrals feature
  // for that facility's providers.
  await ensureColumn('facilities', 'referrals_enabled', '`referrals_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `eligibility_enabled`');
  // Per-facility referral FAX numbers (Super Admin controlled). Each facility can carry its OWN
  // dedicated Fax.Plus DIDs — one number that RECEIVES inbound referrals and one that outbound
  // referrals are sent FROM — distinct from the general NPPES `fax`. Inbound faxes are routed to a
  // facility by the DID they arrive on (fax_incoming_number → must be unique per facility), and
  // outbound referral faxes are sent FROM that facility's fax_outgoing_number (falling back to the
  // global Fax.Plus number when unset). fax_referrals_enabled defaults ON so existing facilities keep
  // working; a Super Admin can turn a facility's referral faxing off.
  await ensureColumn('facilities', 'fax_incoming_number', "`fax_incoming_number` VARCHAR(24) NULL AFTER `fax`");
  await ensureColumn('facilities', 'fax_outgoing_number', "`fax_outgoing_number` VARCHAR(24) NULL AFTER `fax_incoming_number`");
  await ensureColumn('facilities', 'fax_referrals_enabled', "`fax_referrals_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `fax_outgoing_number`");
  // FACILITY-SPECIFIC control: may an incoming fax to THIS facility's DID auto-create a patient when no
  // existing chart matches? ON by default; a super/master admin can turn it off per facility so unmatched
  // inbound faxes for that facility stay unlinked in the intake queue for manual review. Matching an
  // EXISTING chart is unaffected — only NEW-chart creation is gated.
  await ensureColumn('facilities', 'fax_auto_create_patients', "`fax_auto_create_patients` TINYINT(1) NOT NULL DEFAULT 1 AFTER `fax_referrals_enabled`");
  await ensureColumn('facilities', 'fax_updated_by', "`fax_updated_by` BIGINT UNSIGNED NULL AFTER `fax_auto_create_patients`");
  await ensureColumn('facilities', 'fax_updated_at', "`fax_updated_at` DATETIME NULL AFTER `fax_updated_by`");
  // UNIQUE (not just indexed): an inbound DID must map to exactly ONE facility, else received PHI faxes
  // could mis-route. A UNIQUE index on a NULLable column still allows many NULLs (facilities with no DID),
  // so only ASSIGNED numbers are constrained. If legacy duplicates exist the ALTER is skipped with a warn
  // (routingMap() then fails those DIDs closed at runtime). Config sets '' → NULL, so no empty-string clash.
  await ensureUniqueIndex('facilities', 'uniq_fac_fax_incoming', '`fax_incoming_number`');
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
  // CMS Place of Service on the note (seeded from the note type at creation, provider-overridable to any
  // CMS POS — 11/12/31/32/10/…). Drives facility vs non-facility PE RVU in the payscale/coding. Not PHI.
  await ensureColumn('encounter_notes', 'pos_code', '`pos_code` VARCHAR(4) NULL AFTER `note_type`');
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
  // Pay-period snapshots — IMMUTABLE payroll records. When a super/master admin FINALIZES a period, the
  // computed pay per provider is frozen here so a later note edit/delete can never change a PAID period.
  // Reporting reads the snapshot for finalized periods (real-time only for un-finalized ones). Not PHI
  // (pay + RVU aggregates + code-level breakdown).
  await pool.query(
    `CREATE TABLE IF NOT EXISTS \`pay_period_snapshots\` (
       \`id\` BIGINT UNSIGNED NOT NULL PRIMARY KEY AUTO_INCREMENT,
       \`uuid\` CHAR(36) NOT NULL,
       \`provider_id\` BIGINT UNSIGNED NOT NULL,
       \`period_type\` VARCHAR(10) NOT NULL,
       \`period_from\` DATE NOT NULL,
       \`period_to\` DATE NOT NULL,
       \`cf_kind\` VARCHAR(10) NOT NULL DEFAULT 'standard',
       \`locality\` VARCHAR(4) NOT NULL DEFAULT '99',
       \`rate\` DECIMAL(10,4) NOT NULL,
       \`work_rvu\` DECIMAL(14,4) NOT NULL DEFAULT 0,
       \`provider_pay\` DECIMAL(14,2) NOT NULL DEFAULT 0,
       \`group_retained\` DECIMAL(14,2) NOT NULL DEFAULT 0,
       \`medicare_value\` DECIMAL(14,2) NOT NULL DEFAULT 0,
       \`lines_json\` LONGTEXT NULL,
       \`status\` VARCHAR(10) NOT NULL DEFAULT 'finalized',
       \`finalized_by\` BIGINT UNSIGNED NULL,
       \`finalized_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       UNIQUE KEY \`uq_snapshot\` (\`provider_id\`, \`period_from\`, \`period_to\`),
       UNIQUE KEY \`uq_snapshot_uuid\` (\`uuid\`),
       KEY \`idx_snapshot_period\` (\`period_from\`, \`period_to\`)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  // Paid-note ledger — the record of exactly which SIGNED notes have been PAID in a finalized snapshot.
  // `note_id` is UNIQUE across the whole table, so a note can be paid in at most one period EVER: every
  // live pay computation anti-joins this ledger, which makes double-paying an encounter structurally
  // impossible ("already-paid RVUs never show on the next paycheck"). Reopening a period deletes its ledger
  // rows, returning those notes to payable. Not PHI (note id + pay figures only).
  await pool.query(
    `CREATE TABLE IF NOT EXISTS \`paid_note_ledger\` (
       \`id\` BIGINT UNSIGNED NOT NULL PRIMARY KEY AUTO_INCREMENT,
       \`note_id\` BIGINT UNSIGNED NOT NULL,
       \`snapshot_id\` BIGINT UNSIGNED NOT NULL,
       \`provider_id\` BIGINT UNSIGNED NOT NULL,
       \`work_rvu\` DECIMAL(14,4) NOT NULL DEFAULT 0,
       \`provider_pay\` DECIMAL(14,2) NOT NULL DEFAULT 0,
       \`paid_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       UNIQUE KEY \`uq_paid_note\` (\`note_id\`),
       KEY \`idx_paid_snapshot\` (\`snapshot_id\`),
       KEY \`idx_paid_provider\` (\`provider_id\`)
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
  // encounter_notes.content_enc holds DYNAMIC long-form records that can exceed 500k words.
  // Promote it to LONGBLOB so a very large encrypted note can never hit the 16 MB MEDIUMBLOB
  // ceiling and lose the save. Widening only — safe on existing rows.
  const ensureLongblob = async (table, column) => {
    const [c] = await pool.query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column],
    );
    if (c[0] && String(c[0].DATA_TYPE).toLowerCase() !== 'longblob') {
      await pool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` LONGBLOB NULL`);
      logger.info({ table, column }, 'Enlarged encrypted column → LONGBLOB');
    }
  };
  await ensureLongblob('encounter_notes', 'content_enc');
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

  // Referrals — fax (Fax.Plus) tracking columns. The referrals table is created by SCHEMA_STATEMENTS;
  // these add the fax-integration fields to any already-existing table (idempotent).
  try {
    await ensureColumn('referrals', 'counterparty_fax', "`counterparty_fax` VARCHAR(32) NULL AFTER `counterparty_org`");
    await ensureColumn('referrals', 'counterparty_npi', "`counterparty_npi` VARCHAR(10) NULL AFTER `counterparty_fax`");
    await ensureColumn('referrals', 'fax_id', "`fax_id` VARCHAR(64) NULL AFTER `scheduled_date`");
    await ensureColumn('referrals', 'fax_status', "`fax_status` VARCHAR(40) NULL AFTER `fax_id`");
    await ensureColumn('referrals', 'fax_file_id', "`fax_file_id` VARCHAR(128) NULL AFTER `fax_status`");
    await ensureColumn('referrals', 'fax_s3_key', "`fax_s3_key` VARCHAR(512) NULL AFTER `fax_file_id`");
    await ensureColumn('referrals', 'fax_pages', "`fax_pages` INT NULL AFTER `fax_s3_key`");
    await ensureColumn('referrals', 'fax_error', "`fax_error` VARCHAR(255) NULL AFTER `fax_pages`");
    await ensureColumn('referrals', 'faxed_at', "`faxed_at` DATETIME NULL AFTER `fax_error`");
    await ensureColumn('referrals', 'fax_events', "`fax_events` JSON NULL AFTER `faxed_at`"); // fax status timeline
    // Fax.Plus AI triage result for an INCOMING fax — computed ONCE at ingest and cached here so it is
    // never recomputed (efficient, no AI-credit overusage). Assists the intake provider (auto-extracted
    // patient/specialty/summary) without a manual button.
    await ensureColumn('referrals', 'fax_ai', "`fax_ai` JSON NULL AFTER `fax_events`");
    await ensureColumn('referrals', 'fax_ai_at', "`fax_ai_at` DATETIME NULL AFTER `fax_ai`");
    // DETERMINISTIC OCR field-extraction envelope for an INCOMING fax (patient identity, referring
    // provider/facility, reason, diagnosis+ICD, requested specialty, urgency, insurance) — computed once at
    // ingest by the local PaddleOCR service (NO AI, NO mock). Encrypted at rest ({v,enc} JSON envelope) as
    // it holds PHI, consistent with every other clinical field. Distinct from fax_ai (the optional Fax.Plus
    // triage); this deterministic result is authoritative for the structured referral fields.
    await ensureColumn('referrals', 'extracted_enc', "`extracted_enc` VARBINARY(16384) NULL AFTER `fax_ai_at`");
    await ensureColumn('referrals', 'extracted_at', "`extracted_at` DATETIME NULL AFTER `extracted_enc`");
    await ensureIndex('referrals', 'idx_ref_fax', 'fax_id');
    // Idempotency HARD-GUARANTEE for inbound ingestion: dedupe any duplicate fax_id rows a pre-index
    // concurrent ingest (webhook + poll racing) may have created — keep the earliest — then enforce a
    // UNIQUE index so a duplicate can never be committed again (multiple NULLs are allowed by MySQL, so
    // drafts / unsent referrals are unaffected).
    try {
      const [dd] = await pool.query(
        `DELETE r FROM referrals r
           JOIN (SELECT fax_id, MIN(id) AS keep_id FROM referrals WHERE fax_id IS NOT NULL GROUP BY fax_id HAVING COUNT(*) > 1) d
             ON r.fax_id = d.fax_id AND r.id <> d.keep_id`);
      if (dd?.affectedRows) logger.warn({ removed: dd.affectedRows }, 'removed duplicate inbound-fax referral rows before unique index');
    } catch (e) { logger.warn({ err: e.message }, 'referral fax_id dedupe skipped'); }
    await ensureUniqueIndex('referrals', 'uniq_ref_fax_id', '`fax_id`');
    // Deep-page pagination at scale (100k+ referrals, 10/page): the list is owner-scoped and ordered by
    // referral_date DESC, id DESC — this composite keeps that ORDER BY index-backed for the common path.
    await ensureIndex('referrals', 'idx_ref_provider_date', 'provider_id, referral_date, id');
    // Inbound faxes are ingested as incoming referrals with status 'received' — widen the status ENUM to
    // include it (idempotent MODIFY). Without this the ingest INSERT truncates/fails under strict SQL mode.
    await pool.query("ALTER TABLE referrals MODIFY status ENUM('draft','sent','accepted','scheduled','completed','declined','cancelled','received') NOT NULL DEFAULT 'draft'");
  } catch (err) { logger.warn({ err: err.message }, 'referrals fax columns add skipped'); }

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

  // One-time backfill of user name-search tokens (enables server-side paginated user search without
  // decrypting names). Runs ONLY when the token table is empty but users exist. Batch-inserted so it stays
  // fast even at thousands of users; best-effort per user (a name that can't be decrypted is skipped, logged).
  try {
    const [[tk]] = [await pool.query('SELECT COUNT(*) AS n FROM user_name_tokens')].map((x) => x[0]);
    const [[uc]] = [await pool.query('SELECT COUNT(*) AS n FROM users')].map((x) => x[0]);
    if (Number(tk.n) === 0 && Number(uc.n) > 0) {
      const [users] = await pool.query('SELECT id, full_name_enc FROM users');
      const rows = [];
      let undecryptable = 0;
      for (const u of users) {
        let name = '';
        try { name = u.full_name_enc ? decrypt(u.full_name_enc) : ''; } catch { undecryptable += 1; continue; }
        for (const tok of userNameTokens(name)) rows.push([u.id, tok]);
      }
      for (let i = 0; i < rows.length; i += 2000) {
        const chunk = rows.slice(i, i + 2000);
        await pool.query(`INSERT IGNORE INTO user_name_tokens (user_id, token_bidx) VALUES ${chunk.map(() => '(?,?)').join(',')}`, chunk.flat());
      }
      logger.info({ users: users.length, tokens: rows.length, undecryptable }, 'Backfilled user name-search tokens');
    }
  } catch (err) { logger.warn({ err: err.message }, 'user name-token backfill skipped'); }

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
