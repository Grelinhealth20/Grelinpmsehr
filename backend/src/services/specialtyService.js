import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { logger } from '../config/logger.js';

const DEFAULT_SPECIALTIES = ['SNFs', 'Pain Management', 'TCM'];

export function toPublicSpecialty(row) {
  if (!row) return null;
  return { uuid: row.uuid, name: row.name, createdAt: row.created_at };
}

export async function listSpecialties() {
  const [rows] = await execute(`SELECT id, uuid, name, created_at FROM specialties ORDER BY name ASC`);
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

export async function createSpecialty(name, createdBy = null) {
  const uuid = uuidv4();
  await execute(
    `INSERT INTO specialties (uuid, name, created_by) VALUES (:uuid, :name, :createdBy)`,
    { uuid, name, createdBy },
  );
  const [rows] = await execute(`SELECT id, uuid, name, created_at FROM specialties WHERE uuid = :uuid`, { uuid });
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
