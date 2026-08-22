/**
 * Idempotent schema definition. Each statement uses CREATE TABLE IF NOT EXISTS
 * so migration is safe to run repeatedly (auto table creation on boot).
 *
 * PHI / sensitive fields are stored ENCRYPTED (AES-256-GCM) in *_enc columns.
 * Searchable identifiers additionally carry a deterministic HMAC *_bidx (blind
 * index) so we can look rows up without decrypting the whole table.
 */
export const SCHEMA_STATEMENTS = [
  // --- Users -----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS users (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid            CHAR(36)        NOT NULL,
    email_enc       VARBINARY(512)  NOT NULL,
    email_bidx      CHAR(64)        NOT NULL,
    full_name_enc   VARBINARY(512)  NOT NULL,
    role            ENUM('master_admin','super_admin','billing','provider') NOT NULL,
    status          ENUM('active','restricted','disabled') NOT NULL DEFAULT 'active',
    access_level    JSON            NULL,
    password_hash   VARCHAR(255)    NOT NULL,
    must_reset_password TINYINT(1)  NOT NULL DEFAULT 0,
    failed_login_attempts INT       NOT NULL DEFAULT 0,
    locked_until    DATETIME        NULL,
    last_login_at   DATETIME        NULL,
    password_changed_at DATETIME    NULL,
    created_by      BIGINT UNSIGNED NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_uuid (uuid),
    UNIQUE KEY uq_users_email_bidx (email_bidx),
    KEY idx_users_role (role),
    KEY idx_users_status (status),
    CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Password history (prevent reuse) --------------------------------------
  `CREATE TABLE IF NOT EXISTS password_history (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id       BIGINT UNSIGNED NOT NULL,
    password_hash VARCHAR(255)    NOT NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_pwhist_user (user_id),
    CONSTRAINT fk_pwhist_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Refresh tokens (hashed, rotatable, revocable) -------------------------
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id     BIGINT UNSIGNED NOT NULL,
    token_hash  CHAR(64)        NOT NULL,
    expires_at  DATETIME        NOT NULL,
    revoked_at  DATETIME        NULL,
    ip          VARCHAR(64)     NULL,
    user_agent  VARCHAR(255)    NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_refresh_hash (token_hash),
    KEY idx_refresh_user (user_id),
    CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Audit log (append-only; HIPAA §164.312(b)) ----------------------------
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid         CHAR(36)        NOT NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    actor_email_bidx CHAR(64)    NULL,
    action       VARCHAR(80)     NOT NULL,
    entity_type  VARCHAR(80)     NULL,
    entity_id    VARCHAR(80)     NULL,
    outcome      ENUM('success','failure') NOT NULL DEFAULT 'success',
    ip           VARCHAR(64)     NULL,
    user_agent   VARCHAR(255)    NULL,
    metadata     JSON            NULL,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_audit_uuid (uuid),
    KEY idx_audit_actor (actor_user_id),
    KEY idx_audit_action (action),
    KEY idx_audit_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Specialties (managed list, wired to provider users) -------------------
  `CREATE TABLE IF NOT EXISTS specialties (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid        CHAR(36)        NOT NULL,
    name        VARCHAR(120)    NOT NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_spec_uuid (uuid),
    UNIQUE KEY uq_spec_name (name),
    CONSTRAINT fk_spec_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Appointments (EHR scheduler; patient fields ENCRYPTED as PHI) ---------
  `CREATE TABLE IF NOT EXISTS appointments (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid          CHAR(36)        NOT NULL,
    provider_id   BIGINT UNSIGNED NOT NULL,
    title_enc     VARBINARY(1024) NOT NULL,
    patient_name_enc VARBINARY(768) NULL,
    appt_type     ENUM('consult','followup','procedure') NOT NULL DEFAULT 'consult',
    appt_date     DATE            NOT NULL,
    start_min     SMALLINT UNSIGNED NOT NULL,
    duration_min  SMALLINT UNSIGNED NOT NULL,
    status        ENUM('scheduled','cancelled','completed') NOT NULL DEFAULT 'scheduled',
    created_by    BIGINT UNSIGNED NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_appt_uuid (uuid),
    KEY idx_appt_provider_date (provider_id, appt_date),
    KEY idx_appt_status (status),
    CONSTRAINT fk_appt_provider FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_appt_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Patients (face sheet; ALL demographics/insurance ENCRYPTED as PHI) ----
  `CREATE TABLE IF NOT EXISTS patients (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid           CHAR(36)        NOT NULL,
    provider_id    BIGINT UNSIGNED NOT NULL,
    mrn            VARCHAR(24)     NOT NULL,
    name_bidx      CHAR(64)        NULL,
    demographics_enc VARBINARY(6144) NOT NULL,
    insurance_enc  VARBINARY(3072) NULL,
    created_by     BIGINT UNSIGNED NULL,
    created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_patient_uuid (uuid),
    UNIQUE KEY uq_patient_mrn (mrn),
    KEY idx_patient_provider (provider_id),
    KEY idx_patient_name (name_bidx),
    CONSTRAINT fk_patient_provider FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_patient_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Patient documents (S3 object refs; scoped strictly per patient) -------
  `CREATE TABLE IF NOT EXISTS patient_documents (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid          CHAR(36)        NOT NULL,
    patient_id    BIGINT UNSIGNED NOT NULL,
    doc_type      ENUM('license_front','license_back','insurance_front','insurance_back','other') NOT NULL,
    s3_key        VARCHAR(512)    NOT NULL,
    file_name_enc VARBINARY(768)  NULL,
    content_type  VARCHAR(100)    NULL,
    size_bytes    INT UNSIGNED    NULL,
    uploaded_by   BIGINT UNSIGNED NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pdoc_uuid (uuid),
    KEY idx_pdoc_patient (patient_id),
    CONSTRAINT fk_pdoc_patient FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdoc_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Encounters (worklist state layered over an appointment) ---------------
  `CREATE TABLE IF NOT EXISTS encounters (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid           CHAR(36)        NOT NULL,
    provider_id    BIGINT UNSIGNED NOT NULL,
    appointment_id BIGINT UNSIGNED NULL,
    patient_id     BIGINT UNSIGNED NULL,
    eligibility_status ENUM('not_verified','eligible','ineligible','pending') NOT NULL DEFAULT 'not_verified',
    chart_status   ENUM('not_seen','charts_completed','cancelled') NOT NULL DEFAULT 'not_seen',
    created_by     BIGINT UNSIGNED NULL,
    created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_enc_uuid (uuid),
    UNIQUE KEY uq_enc_appointment (appointment_id),
    KEY idx_enc_provider (provider_id),
    CONSTRAINT fk_enc_provider FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_enc_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
    CONSTRAINT fk_enc_patient FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Login attempts (brute-force forensics) --------------------------------
  `CREATE TABLE IF NOT EXISTS login_attempts (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email_bidx  CHAR(64)        NULL,
    ip          VARCHAR(64)     NULL,
    successful  TINYINT(1)      NOT NULL DEFAULT 0,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_login_email (email_bidx),
    KEY idx_login_ip (ip),
    KEY idx_login_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Clinical documentation — CMS-compliant SNF MD notes. Body is an encrypted
  // PHI blob (structured JSON). A note is immutable once signed (billing-ready).
  `CREATE TABLE IF NOT EXISTS encounter_notes (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid          CHAR(36)        NOT NULL,
    encounter_id  BIGINT UNSIGNED NOT NULL,
    provider_id   BIGINT UNSIGNED NOT NULL,
    note_type     VARCHAR(60)     NOT NULL,
    reason        VARCHAR(120)    NULL,
    content_enc   VARBINARY(16384) NULL,
    status        ENUM('draft','signed') NOT NULL DEFAULT 'draft',
    billing_ready TINYINT(1)      NOT NULL DEFAULT 0,
    signed_by     BIGINT UNSIGNED NULL,
    signed_by_name VARCHAR(160)   NULL,
    signed_at     DATETIME        NULL,
    created_by    BIGINT UNSIGNED NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_note_uuid (uuid),
    KEY idx_note_encounter (encounter_id),
    KEY idx_note_provider (provider_id),
    CONSTRAINT fk_note_encounter FOREIGN KEY (encounter_id) REFERENCES encounters(id) ON DELETE CASCADE,
    CONSTRAINT fk_note_provider FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
