import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { serviceForSpecialty } from './noteTemplateService.js';

const DEFAULT_SPECIALTIES = ['SNFs', 'Pain Management', 'TCM'];

/** Normalize an incoming service line to a valid enum, or null to auto-derive from name. */
function normalizeServiceLine(line) {
  const v = String(line || '').toLowerCase().trim();
  return v === 'pain' || v === 'snf' ? v : null;
}

export function toPublicSpecialty(row) {
  if (!row) return null;
  return { uuid: row.uuid, name: row.name, serviceLine: row.service_line || 'snf', createdAt: row.created_at };
}

export async function listSpecialties() {
  const [rows] = await execute(`SELECT id, uuid, name, service_line, created_at FROM specialties ORDER BY name ASC`);
  return rows.map(toPublicSpecialty);
}

export async function findSpecialtyIdByUuid(uuid) {
  if (!uuid) return null;
  const [rows] = await execute(`SELECT id FROM specialties WHERE uuid = :uuid LIMIT 1`, { uuid });
  return rows[0]?.id ?? null;
}

export async function specialtyNameExists(name) {
  const [rows] = await execute(`SELECT id FROM specialties WHERE name = :name LIMIT 1`, { name });
  return rows.length > 0;
}

/**
 * Create a specialty. The service line is admin-settable; when omitted it is derived
 * deterministically from the name (word-boundary "pain" → pain, else snf) — the single
 * default rule, applied once at creation and thereafter stored explicitly.
 */
export async function createSpecialty(name, createdBy = null, serviceLine = null) {
  const uuid = uuidv4();
  const line = normalizeServiceLine(serviceLine) || serviceForSpecialty(name);
  await execute(
    `INSERT INTO specialties (uuid, name, service_line, created_by) VALUES (:uuid, :name, :line, :createdBy)`,
    { uuid, name, line, createdBy },
  );
  const [rows] = await execute(
    `SELECT id, uuid, name, service_line, created_at FROM specialties WHERE uuid = :uuid`,
    { uuid },
  );
  return toPublicSpecialty(rows[0]);
}

/** Seed the default specialties on first boot (idempotent). */
export async function seedSpecialties() {
  for (const name of DEFAULT_SPECIALTIES) {
    if (!(await specialtyNameExists(name))) {
      await createSpecialty(name, null);
    }
  }
  logger.info('Default specialties ensured');
}
