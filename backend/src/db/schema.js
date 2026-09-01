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
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid         CHAR(36)        NOT NULL,
    name         VARCHAR(120)    NOT NULL,
    service_line ENUM('snf','pain','tcm') NOT NULL DEFAULT 'snf',
    created_by   BIGINT UNSIGNED NULL,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_spec_uuid (uuid),
    UNIQUE KEY uq_spec_name (name),
    CONSTRAINT fk_spec_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Provider ↔ Specialty (MANY-TO-MANY) -----------------------------------
  // A provider may hold MULTIPLE specialties (e.g. SNFs + Pain). Their clinical
  // access = the UNION of the service lines of these specialties. The legacy
  // users.specialty_id remains the "primary" specialty for display; this table is
  // the authoritative source for access decisions (see accessScope.providerServiceLines).
  `CREATE TABLE IF NOT EXISTS user_specialties (
    user_id      BIGINT UNSIGNED NOT NULL,
    specialty_id BIGINT UNSIGNED NOT NULL,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, specialty_id),
    KEY idx_us_user (user_id),
    CONSTRAINT fk_us_user      FOREIGN KEY (user_id)      REFERENCES users(id)       ON DELETE CASCADE,
    CONSTRAINT fk_us_specialty FOREIGN KEY (specialty_id) REFERENCES specialties(id) ON DELETE CASCADE
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
    insurance_enc  MEDIUMBLOB      NULL,
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

  // --- Patient name-search tokens (prefix blind indexes; enables flexible search
  //     by last name / first name / initial / partial WITHOUT storing plaintext) ---
  `CREATE TABLE IF NOT EXISTS patient_name_tokens (
    patient_id  BIGINT UNSIGNED NOT NULL,
    token_bidx  CHAR(64)        NOT NULL,
    PRIMARY KEY (patient_id, token_bidx),
    KEY idx_pnt_token (token_bidx),
    CONSTRAINT fk_pnt_patient FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
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

  // --- Benefits Verification (X12 271 eligibility; PHI, per patient+policy) ---
  `CREATE TABLE IF NOT EXISTS eligibility_checks (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid           CHAR(36)        NOT NULL,
    patient_id     BIGINT UNSIGNED NOT NULL,
    policy_index   TINYINT UNSIGNED NOT NULL DEFAULT 0,
    appointment_uuid CHAR(36)      NULL,
    payer_name     VARCHAR(160)    NULL,
    member_id_bidx CHAR(64)        NULL,
    insurance_bidx CHAR(64)        NULL,
    status         VARCHAR(24)     NULL,
    automatic      TINYINT(1)      NOT NULL DEFAULT 0,
    service_date   DATE            NULL,
    plan_end       DATE            NULL,
    summary_enc    MEDIUMBLOB      NULL,
    raw_enc        MEDIUMBLOB      NULL,
    created_by     BIGINT UNSIGNED NULL,
    created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_elig_uuid (uuid),
    KEY idx_elig_patient (patient_id),
    KEY idx_elig_patient_policy (patient_id, policy_index),
    CONSTRAINT fk_elig_patient FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    CONSTRAINT fk_elig_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Stedi Payer Network (public reference data; NOT PHI) -------------------
  // Loaded from Stedi's payer export CSV. Resolves a face-sheet payer (name / ID /
  // alias, e.g. "UHC", "Cigna", "62308") to the canonical Stedi payer ID used as
  // tradingPartnerServiceId for eligibility. Keyed by the Stedi payer ID.
  `CREATE TABLE IF NOT EXISTS stedi_payers (
    stedi_id         VARCHAR(16)  NOT NULL,
    primary_payer_id VARCHAR(32)  NULL,
    display_name     VARCHAR(255) NOT NULL,
    names            TEXT         NULL,
    aliases          TEXT         NULL,
    eligibility_supported TINYINT(1) NOT NULL DEFAULT 0,
    coverage_types   VARCHAR(64)  NULL,
    operating_states VARCHAR(512) NULL,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (stedi_id),
    KEY idx_stedi_primary (primary_payer_id),
    KEY idx_stedi_name (display_name),
    KEY idx_stedi_elig (eligibility_supported)
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
    content_enc   MEDIUMBLOB      NULL,
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

  // --- Facilities ------------------------------------------------------------
  // First-class facility records. Facility data is PUBLIC (CMS NPPES registry),
  // NOT PHI, so it is stored in plaintext and is searchable. A Super/Master admin
  // verifies the NPPES-fetched details before saving.
  `CREATE TABLE IF NOT EXISTS facilities (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    uuid          CHAR(36)        NOT NULL,
    npi           VARCHAR(10)     NULL,
    name          VARCHAR(200)    NOT NULL,
    address       VARCHAR(200)    NULL,
    city          VARCHAR(120)    NULL,
    state         VARCHAR(2)      NULL,
    zip           VARCHAR(10)     NULL,
    phone         VARCHAR(24)     NULL,
    taxonomy      VARCHAR(160)    NULL,
    status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
    source        VARCHAR(16)     NOT NULL DEFAULT 'nppes',
    verified_by   BIGINT UNSIGNED NULL,
    created_by    BIGINT UNSIGNED NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_fac_uuid (uuid),
    UNIQUE KEY uq_fac_npi (npi),
    KEY idx_fac_name (name),
    KEY idx_fac_state (state),
    CONSTRAINT fk_fac_verified_by FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_fac_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Provider ⇄ Facility assignments (many-to-many) ------------------------
  // Governs which facilities a provider may work at. Patient/encounter access is
  // scoped through these assignments to strictly prevent cross-facility sharing.
  `CREATE TABLE IF NOT EXISTS provider_facilities (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    provider_id   BIGINT UNSIGNED NOT NULL,
    facility_id   BIGINT UNSIGNED NOT NULL,
    assigned_by   BIGINT UNSIGNED NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pf (provider_id, facility_id),
    KEY idx_pf_facility (facility_id),
    CONSTRAINT fk_pf_provider FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_pf_facility FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE,
    CONSTRAINT fk_pf_assigned_by FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // --- Note template registry (governs SNF vs Pain template access) ----------
  // Each clinical note template belongs to a SERVICE LINE ('snf' or 'pain'). A
  // provider sees & may create ONLY the templates for their own service line — the
  // two sets never cross over. Reference data (labels/CPT), NOT PHI. Notes themselves
  // still live in encounter_notes, so all existing note behaviour is unchanged.
  `CREATE TABLE IF NOT EXISTS note_templates (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    note_type     VARCHAR(60)     NOT NULL,
    service_line  ENUM('snf','pain','tcm') NOT NULL,
    label         VARCHAR(160)    NOT NULL,
    category      VARCHAR(160)    NULL,
    cpt           VARCHAR(160)    NULL,
    menu_group    ENUM('common','more') NOT NULL DEFAULT 'more',
    sort_order    INT             NOT NULL DEFAULT 100,
    active        TINYINT(1)      NOT NULL DEFAULT 1,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_note_template_type (note_type),
    KEY idx_note_template_service (service_line, active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Local cache of REAL terminology codes looked up from UMLS (NLM) — SNOMED CT US,
  // RxNorm, CPT, HCPCS, ICD-10-CM, CDT, LOINC. Grows as codes are used; no mock data.
  `CREATE TABLE IF NOT EXISTS terminology_cache (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    source        VARCHAR(20)     NOT NULL,
    code          VARCHAR(32)     NOT NULL,
    term          VARCHAR(512)    NOT NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_term (source, code),
    KEY idx_term_lookup (source, term(96))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // AMA CPT® master — full descriptor set (Long/Medium/Short/Consumer) per code, loaded from
  // the licensed AMA CPT Standard data files (ConsolidatedCodeList.txt). REAL AMA data only.
  // `short_desc` is the ≤28-char descriptor required on 837P/CMS-1500 claims; `long_desc` is
  // the clinical/documentation descriptor. Category I/II(F)/III(T) and PLA(U/M) codes included.
  `CREATE TABLE IF NOT EXISTS cpt_codes (
    code            VARCHAR(5)      NOT NULL,
    concept_id      BIGINT UNSIGNED NULL,
    long_desc       TEXT            NOT NULL,
    medium_desc     VARCHAR(255)    NULL,
    short_desc      VARCHAR(64)     NULL,
    consumer_desc   TEXT            NULL,
    effective_date  DATE            NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (code),
    KEY idx_cpt_short (short_desc),
    FULLTEXT KEY ft_cpt_long (long_desc)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // AMA CPT® modifiers (Level I two-digit) — from Modifiers.txt. Used at charge/claim entry.
  `CREATE TABLE IF NOT EXISTS cpt_modifiers (
    modifier        VARCHAR(5)      NOT NULL,
    concept_id      BIGINT UNSIGNED NULL,
    level           VARCHAR(4)      NULL,
    name            VARCHAR(512)    NULL,
    description     TEXT            NULL,
    section         VARCHAR(255)    NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (modifier)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // AMA CPT® clinician descriptors — alternate clinician-facing phrasings (many per code),
  // from ClinicianDescriptor.txt. Powers EHR procedure pick-lists and documentation search.
  `CREATE TABLE IF NOT EXISTS cpt_clinician_descriptors (
    descriptor_id   BIGINT UNSIGNED NOT NULL,
    code            VARCHAR(5)      NOT NULL,
    descriptor      VARCHAR(512)    NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (descriptor_id),
    KEY idx_cpt_cd_code (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // SNOMED CT US Edition (RF2 Snapshot) — concept master. Loaded from the licensed NLM/SNOMED
  // International US Edition release (sct2_Concept_Snapshot). REAL SNOMED data only.
  `CREATE TABLE IF NOT EXISTS snomed_concepts (
    id                    BIGINT UNSIGNED NOT NULL,
    active                TINYINT(1)      NOT NULL DEFAULT 1,
    definition_status_id  BIGINT UNSIGNED NULL,
    effective_time        DATE            NULL,
    updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_sct_concept_active (active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // SNOMED CT US Edition — all descriptions (FSN + synonyms), from sct2_Description_Snapshot.
  // `us_preferred` is set from the US English language refset (900000000000509007, Preferred
  // acceptability) so the clinician-facing preferred term is known per concept.
  `CREATE TABLE IF NOT EXISTS snomed_descriptions (
    id                    BIGINT UNSIGNED NOT NULL,
    concept_id            BIGINT UNSIGNED NOT NULL,
    type_id               BIGINT UNSIGNED NULL,
    term                  VARCHAR(512)    NOT NULL,
    language_code         VARCHAR(8)      NULL,
    case_significance_id  BIGINT UNSIGNED NULL,
    active                TINYINT(1)      NOT NULL DEFAULT 1,
    us_preferred          TINYINT(1)      NOT NULL DEFAULT 0,
    updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_sct_desc_concept (concept_id),
    KEY idx_sct_desc_term (term(96)),
    KEY idx_sct_desc_active (active, type_id),
    FULLTEXT KEY ft_sct_term (term)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // UMLS Metathesaurus atoms (MRCONSO) for high-value source vocabularies not otherwise loaded
  // directly — RxNorm (meds), HCPCS Level II (billing), LOINC (labs), CVX (vaccines). English
  // atoms only. Streamed from the licensed UMLS release. Feeds terminology_cache per (sab,code).
  `CREATE TABLE IF NOT EXISTS umls_atoms (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    cui           CHAR(10)        NULL,
    sab           VARCHAR(40)     NOT NULL,
    code          VARCHAR(64)     NOT NULL,
    tty           VARCHAR(20)     NULL,
    str           VARCHAR(1000)   NOT NULL,
    is_pref       TINYINT(1)      NOT NULL DEFAULT 0,
    ts            CHAR(1)         NULL,
    suppress      CHAR(1)         NULL,
    PRIMARY KEY (id),
    KEY idx_umls_sabcode (sab, code),
    KEY idx_umls_cui (cui),
    KEY idx_umls_str (str(96))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // RxNorm concepts (medications) — fetched directly from the NLM RxNorm API (RxNav). One row
  // per RXCUI with its term type (IN/BN/SCD/SBD/GPCK/BPCK/…). REAL RxNorm data only.
  `CREATE TABLE IF NOT EXISTS rxnorm_concepts (
    rxcui         BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(1000)   NOT NULL,
    tty           VARCHAR(20)     NOT NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (rxcui),
    KEY idx_rxnorm_tty (tty),
    KEY idx_rxnorm_name (name(96))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // UMLS semantic types (MRSTY) — one or more per concept (CUI). REAL UMLS data.
  `CREATE TABLE IF NOT EXISTS umls_semantic_types (
    cui           CHAR(10)        NOT NULL,
    tui           VARCHAR(10)     NOT NULL,
    stn           VARCHAR(64)     NULL,
    sty           VARCHAR(128)    NOT NULL,
    PRIMARY KEY (cui, tui),
    KEY idx_umls_sty_tui (tui),
    KEY idx_umls_sty_name (sty)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // UMLS concept definitions (MRDEF) — source-attributed narrative definitions per concept.
  `CREATE TABLE IF NOT EXISTS umls_definitions (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    cui           CHAR(10)        NOT NULL,
    sab           VARCHAR(40)     NOT NULL,
    def           TEXT            NOT NULL,
    suppress      CHAR(1)         NULL,
    PRIMARY KEY (id),
    KEY idx_umls_def_cui (cui),
    KEY idx_umls_def_sab (sab)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Medicare Provider & Supplier Taxonomy Crosswalk — NUCC taxonomy code ↔ Medicare specialty.
  // Loaded from the CMS data API (data.cms.gov). REAL CMS data.
  `CREATE TABLE IF NOT EXISTS provider_taxonomy_crosswalk (
    id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    medicare_specialty    VARCHAR(12)     NULL,
    provider_type_desc    VARCHAR(255)    NULL,
    taxonomy_code         VARCHAR(20)     NOT NULL,
    taxonomy_desc         VARCHAR(512)    NULL,
    updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_ptc_tax (taxonomy_code),
    KEY idx_ptc_spec (medicare_specialty)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // CMS Place of Service (POS) codes — required on every professional claim line. Small, stable,
  // public-domain CMS set (no CMS API; maintained as the authoritative current code set).
  `CREATE TABLE IF NOT EXISTS place_of_service_codes (
    pos_code      CHAR(2)         NOT NULL,
    name          VARCHAR(128)    NOT NULL,
    description   TEXT            NULL,
    PRIMARY KEY (pos_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // PDPM ICD-10 → clinical category mapping (CMS official PDPM ICD Codes DB). Drives SNF PDPM
  // primary-diagnosis clinical category (I0020B), PT/OT and SLP categories, and major-procedure
  // remap. REAL CMS data, per fiscal year. `default_clinical_category='Return To Provider'` means
  // the code is NOT an acceptable SNF primary diagnosis.
  `CREATE TABLE IF NOT EXISTS pdpm_icd_codes (
    fiscal_year               SMALLINT UNSIGNED NOT NULL,
    code                      VARCHAR(10)  NOT NULL,
    description               VARCHAR(512) NULL,
    default_clinical_category VARCHAR(128) NULL,
    major_procedure_category  VARCHAR(128) NULL,
    clinical_category_pt_ot   VARCHAR(128) NULL,
    clinical_category_slp     VARCHAR(128) NULL,
    updated_at                DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (fiscal_year, code),
    KEY idx_pdpm_cat (default_clinical_category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Medicare Physician Fee Schedule Relative Value file (PPRRVU) — full CMS RVU set. Loaded from
  // the licensed CMS RVU release CSV (AMA CPT descriptions © AMA). Source-of-truth CMS table, kept
  // separate from the app-curated `rvu_procedures`. Payment = (work·WGPCI + PE·PEGPCI + MP·MPGPCI)·CF.
  `CREATE TABLE IF NOT EXISTS mpfs_rvu (
    year          SMALLINT UNSIGNED NOT NULL,
    hcpcs         VARCHAR(10)     NOT NULL,
    modifier      VARCHAR(6)      NOT NULL DEFAULT '',
    description   VARCHAR(255)    NULL,
    status_code   CHAR(1)         NULL,
    work_rvu      DECIMAL(10,4)   NULL,
    nonfac_pe_rvu DECIMAL(10,4)   NULL,
    fac_pe_rvu    DECIMAL(10,4)   NULL,
    mp_rvu        DECIMAL(10,4)   NULL,
    nonfac_total  DECIMAL(10,4)   NULL,
    fac_total     DECIMAL(10,4)   NULL,
    pctc_ind      VARCHAR(4)      NULL,
    global_days   VARCHAR(4)      NULL,
    mult_proc     VARCHAR(4)      NULL,
    bilat_surg    VARCHAR(4)      NULL,
    asst_surg     VARCHAR(4)      NULL,
    co_surg       VARCHAR(4)      NULL,
    team_surg     VARCHAR(4)      NULL,
    conv_factor   DECIMAL(10,4)   NULL,
    PRIMARY KEY (year, hcpcs, modifier),
    KEY idx_mpfs_status (status_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Official SNOMED CT US → ICD-10-CM complex map (RF2 ExtendedMap refset 6011000124106). This is
  // the authoritative crosswalk that turns a clinician-selected SNOMED concept into a billable
  // ICD-10-CM code. map_group/map_priority order candidates; map_rule/map_advice carry the
  // context (IFA age/sex/context-dependent). REAL SNOMED International/NLM data.
  `CREATE TABLE IF NOT EXISTS snomed_map_icd10cm (
    snomed_id     BIGINT UNSIGNED NOT NULL,
    map_group     INT             NOT NULL DEFAULT 1,
    map_priority  INT             NOT NULL DEFAULT 1,
    map_rule      VARCHAR(512)    NULL,
    map_advice    VARCHAR(1024)   NULL,
    icd_code      VARCHAR(16)     NULL,
    map_category  VARCHAR(20)     NULL,
    KEY idx_sctmap_concept (snomed_id, map_group, map_priority),
    KEY idx_sctmap_icd (icd_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // ---- Official CMS Medicare Coverage Database (MCD) Article coverage --------------------------
  // Loaded from the licensed MCD quarterly download (current_article CSVs). Authoritative,
  // jurisdiction-complete replacement for the dump's article_coverage_* tables. Drives Part B
  // LCD/Article medical-necessity, scoped to the servicing MAC (First Coast = Central FL).
  `CREATE TABLE IF NOT EXISTS mcd_contractor (
    contractor_id   INT             NOT NULL,
    name            VARCHAR(255)    NULL,
    number          VARCHAR(20)     NULL,
    state_id        INT             NULL,
    is_first_coast  TINYINT(1)      NOT NULL DEFAULT 0,
    status          CHAR(1)         NULL,
    PRIMARY KEY (contractor_id),
    KEY idx_mcdc_fc (is_first_coast)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS mcd_article_x_contractor (
    article_id      INT             NOT NULL,
    contractor_id   INT             NOT NULL,
    PRIMARY KEY (article_id, contractor_id),
    KEY idx_maxc_contractor (contractor_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS mcd_article_covered_icd (
    article_id      INT             NOT NULL,
    icd_code        VARCHAR(16)     NOT NULL,
    grp             INT             NULL,
    PRIMARY KEY (article_id, icd_code),
    KEY idx_mcov_icd (icd_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS mcd_article_noncovered_icd (
    article_id      INT             NOT NULL,
    icd_code        VARCHAR(16)     NOT NULL,
    grp             INT             NULL,
    PRIMARY KEY (article_id, icd_code),
    KEY idx_mnon_icd (icd_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS mcd_article_hcpc (
    article_id      INT             NOT NULL,
    hcpc_code       VARCHAR(10)     NOT NULL,
    PRIMARY KEY (article_id, hcpc_code),
    KEY idx_mhcpc_code (hcpc_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Billable (valid-for-submission) ICD-10-CM leaf codes — the ONLY diagnoses a payer accepts.
  // Populated from icd10_codes (CMS billable set); category/header codes are absent = not billable.
  // Own collation (utf8mb4_unicode_ci) so billability joins with the terminology tables use indexes.
  `CREATE TABLE IF NOT EXISTS icd10cm_valid (
    code          VARCHAR(16)     NOT NULL,
    category      VARCHAR(8)      NULL,
    description   VARCHAR(512)    NULL,
    PRIMARY KEY (code),
    KEY idx_icdv_cat (category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // CMS-HCC / RxHCC risk-adjustment coefficients (RAF factor values), from the licensed CMS HCC
  // model software. `name` is the model variable (demographic segment, HCCxx, or interaction);
  // `coeff` is its relative factor. REAL CMS data. Enables RAF scoring alongside icd_hcc_map.
  `CREATE TABLE IF NOT EXISTS hcc_coefficient (
    model         VARCHAR(20)     NOT NULL,
    name          VARCHAR(64)     NOT NULL,
    coeff         DECIMAL(8,4)    NOT NULL,
    label         VARCHAR(255)    NULL,
    PRIMARY KEY (model, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // CMS-HCC hierarchy trumping rules (from the model software's hierarchy macro): if `cc` is
  // present, `trumped_cc` is set to 0. REAL CMS model data. Applied before summing HCC coefficients.
  `CREATE TABLE IF NOT EXISTS hcc_hierarchy (
    model         VARCHAR(20)     NOT NULL,
    cc            INT             NOT NULL,
    trumped_cc    INT             NOT NULL,
    PRIMARY KEY (model, cc, trumped_cc),
    KEY idx_hcchier_trumped (model, trumped_cc)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Billable codes captured on a clinical note (diagnoses + procedures). Diagnoses are captured
  // SNOMED-first and auto-mapped to a billable ICD-10-CM (via snomed_map_icd10cm); procedures are
  // CPT/HCPCS. Structured (queryable for claims/scrubbing) — mirrors how encounters store clinical
  // metadata. `code` always holds the BILLABLE code (ICD-10 for dx, CPT for proc).
  `CREATE TABLE IF NOT EXISTS encounter_note_codes (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    note_id       BIGINT UNSIGNED NOT NULL,
    kind          ENUM('dx','proc') NOT NULL,
    code_system   VARCHAR(16)     NOT NULL,
    code          VARCHAR(20)     NOT NULL,
    description   VARCHAR(512)    NULL,
    snomed_code   VARCHAR(20)     NULL,
    snomed_term   VARCHAR(512)    NULL,
    modifiers     VARCHAR(20)     NULL,
    units         INT             NULL,
    is_primary    TINYINT(1)      NOT NULL DEFAULT 0,
    seq           INT             NOT NULL DEFAULT 0,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_enc_note_codes (note_id, kind, seq),
    CONSTRAINT fk_note_codes_note FOREIGN KEY (note_id) REFERENCES encounter_notes(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // MCD Billing & Coding Article → MAC (contractor) mapping, from the CMS Medicare Coverage
  // Database API (api.coverage.cms.gov). Lets LCD/Article medical-necessity be scoped to the
  // servicing jurisdiction. `is_first_coast` flags the Central FL MAC (First Coast Service
  // Options). `article_id` = MCD document_id (matches article_coverage_icd.article_id).
  `CREATE TABLE IF NOT EXISTS mcd_article_contractor (
    article_id        BIGINT UNSIGNED NOT NULL,
    display_id        VARCHAR(20)     NULL,
    document_type     VARCHAR(60)     NULL,
    title             VARCHAR(512)    NULL,
    contractor_name   VARCHAR(255)    NULL,
    contractor_type   VARCHAR(255)    NULL,
    is_first_coast    TINYINT(1)      NOT NULL DEFAULT 0,
    effective_date    VARCHAR(20)     NULL,
    url               VARCHAR(512)    NULL,
    updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (article_id),
    KEY idx_mcd_fc (is_first_coast),
    KEY idx_mcd_contractor (contractor_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
