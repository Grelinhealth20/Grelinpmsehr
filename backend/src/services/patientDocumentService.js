import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt } from '../utils/crypto.js';

/** Canonical document categories shown in the Documents tab. New uploads use these keys; legacy
 *  license/insurance slot rows are folded into 'insurance_card' by categoryOf() so nothing is orphaned. */
export const DOC_CATEGORIES = [
  { key: 'medical_record', label: 'Medical Records' },
  { key: 'lab_result', label: 'Lab Results' },
  { key: 'imaging', label: 'Imaging' },
  { key: 'insurance_card', label: 'Insurance Cards' },
  { key: 'other', label: 'Other Records' },
];
const CATEGORY_KEYS = new Set(DOC_CATEGORIES.map((c) => c.key));
const LEGACY_TO_CATEGORY = {
  license_front: 'insurance_card', license_back: 'insurance_card',
  insurance_front: 'insurance_card', insurance_back: 'insurance_card',
  lab: 'lab_result', // encounter-attached lab documents (doc kind 'lab') → Lab Results category
};
/** Fold any stored doc_type (incl. legacy) into one of the canonical categories. */
export function categoryOf(docType) {
  return CATEGORY_KEYS.has(docType) ? docType : (LEGACY_TO_CATEGORY[docType] || 'other');
}
/** doc_type values that make up a requested category (so legacy rows still match the filter). */
function typesForCategory(category) {
  if (category === 'insurance_card') return ['insurance_card', 'license_front', 'license_back', 'insurance_front', 'insurance_back'];
  if (category === 'lab_result') return ['lab_result', 'lab']; // include encounter-attached lab docs
  return CATEGORY_KEYS.has(category) ? [category] : null;
}

/** Document metadata rows. The S3 key is internal; it is never sent to clients. */
export function toPublicDoc(row) {
  if (!row) return null;
  return {
    uuid: row.uuid,
    docType: row.doc_type,
    category: categoryOf(row.doc_type),
    fileName: row.file_name_enc ? decrypt(row.file_name_enc) : null,
    contentType: row.content_type,
    size: row.size_bytes,
    dos: row.dos || null, // Date of Service (documents are arranged by this)
    createdAt: row.created_at,
  };
}

const SELECT = `SELECT id, uuid, patient_id, encounter_id, doc_type, s3_key, file_name_enc, content_type, size_bytes,
  DATE_FORMAT(service_date, '%Y-%m-%d') AS dos, created_at
  FROM patient_documents`;

// doc_type set that makes up the ID/insurance card slots (single-slot, looked up by exact type).
const SLOT_DOC_TYPES = "('license_front','license_back','insurance_front','insurance_back','insurance_card')";

/**
 * BOUNDED document set for the patient modal / face sheet: ALL slot documents (license/insurance/ID —
 * a handful, needed for the exact-type slot lookups) plus the most-recent records. This never returns
 * the full library, so opening the modal is fast even when a patient has thousands of documents — the
 * full, searchable, categorized browse lives in the paginated Documents tab (listPatientDocumentsPaged).
 */
export async function listFacesheetDocs(patientId, recentLimit = 30) {
  const lim = Math.max(1, Math.min(100, Math.floor(Number(recentLimit)) || 30));
  const [[slots], [recents]] = await Promise.all([
    execute(`${SELECT} WHERE patient_id = :pid AND encounter_id IS NULL AND doc_type IN ${SLOT_DOC_TYPES}
             ORDER BY service_date DESC, id DESC`, { pid: patientId }),
    execute(`${SELECT} WHERE patient_id = :pid AND encounter_id IS NULL AND doc_type NOT IN ${SLOT_DOC_TYPES}
             ORDER BY service_date DESC, id DESC LIMIT ${lim}`, { pid: patientId }),
  ]);
  return [...slots.map(toPublicDoc), ...recents.map(toPublicDoc)];
}

/**
 * Paginated + searchable + category-filtered documents for a patient. Built to scale to thousands of
 * documents per patient (hundreds of thousands across a practice) with no client lag:
 *  - the NO-SEARCH path pages entirely in SQL (LIMIT/OFFSET on the (patient_id, created_at, id) index)
 *    and decrypts ONLY the current page's filenames — so a page load is O(pageSize), not O(all docs);
 *  - the SEARCH path can't use SQL LIKE (filenames are encrypted at rest), so it decrypts + filters this
 *    ONE patient's rows in memory. That is bounded per patient and only runs while actively searching.
 * Also returns per-category counts so the UI can show tallies without extra round-trips.
 */
/** Per-category document counts for the chips. One cheap indexed GROUP BY — call it ONCE (on load /
 *  after a mutation), NOT on every page navigation, so paging stays a single query. */
export async function documentCategoryCounts(patientId) {
  // ALL of the patient's documents — patient-level (face sheet / insurance / uploaded records) AND
  // encounter-attached (labs / imaging). Scoped strictly by patient_id, so still no cross-patient leak.
  const [rows] = await execute(
    `SELECT doc_type, COUNT(*) AS n FROM patient_documents WHERE patient_id = :pid GROUP BY doc_type`,
    { pid: patientId },
  );
  const counts = { all: 0 };
  for (const c of DOC_CATEGORIES) counts[c.key] = 0;
  for (const r of rows) { counts[categoryOf(r.doc_type)] += Number(r.n); counts.all += Number(r.n); }
  return counts;
}

export async function listPatientDocumentsPaged(patientId, { page = 1, pageSize = 25, q = '', category = '' } = {}) {
  // MUST floor to integers — LIMIT/OFFSET are inlined into SQL and reject floats (a malformed
  // pageSize like "20.9" would otherwise produce `LIMIT 20.9` → SQL parse error / 500).
  const lim = Math.max(1, Math.min(100, Math.floor(Number(pageSize)) || 25));
  const pg = Math.max(1, Math.floor(Number(page)) || 1);
  const needle = String(q || '').trim().toLowerCase();
  const types = category ? typesForCategory(category) : null;
  let typeSql = ''; const params = { pid: patientId };
  if (types) { typeSql = ` AND doc_type IN (${types.map((_, i) => `:t${i}`).join(',')})`; types.forEach((t, i) => { params[`t${i}`] = t; }); }
  // Complete patient document set — patient-level AND encounter-attached (labs/imaging), scoped by
  // patient_id only (no encounter_id filter), so the Documents tab shows every saved record for the
  // patient regardless of how it was added. Still strictly patient-scoped (no cross-patient leak).
  const base = `WHERE patient_id = :pid${typeSql}`;

  if (!needle) {
    // ONE round-trip: page rows + full-set total together via COUNT(*) OVER() (MySQL 8 window fn).
    const off = (pg - 1) * lim;
    const [rows] = await execute(
      `SELECT id, uuid, patient_id, encounter_id, doc_type, s3_key, file_name_enc, content_type, size_bytes,
         DATE_FORMAT(service_date, '%Y-%m-%d') AS dos, created_at, COUNT(*) OVER() AS _total
       FROM patient_documents ${base} ORDER BY service_date DESC, id DESC LIMIT ${lim} OFFSET ${off}`,
      params,
    );
    let total = rows.length ? Number(rows[0]._total) : 0;
    if (!rows.length && off > 0) { // page past the end — get the real total so the pager stays correct
      const [[cnt]] = await execute(`SELECT COUNT(*) AS total FROM patient_documents ${base}`, params);
      total = Number(cnt.total);
    }
    return { documents: rows.map(toPublicDoc), total, page: pg, pageSize: lim };
  }

  // Search (filenames are encrypted → no SQL LIKE): scan ONLY id + encrypted name for this patient,
  // decrypt + substring-match, then fetch full rows for just the matched PAGE. Scanning two columns
  // (not every column) keeps the network transfer small; only the page's rows are fully materialized.
  const [scan] = await execute(
    `SELECT id, file_name_enc FROM patient_documents ${base} ORDER BY service_date DESC, id DESC`, params);
  const matchedIds = [];
  for (const r of scan) {
    // NO degrade: a genuinely undecryptable filename THROWS (fail loud, same as the list path) — a
    // corrupt/tampered record is surfaced, never silently skipped. AES-GCM is deterministic, so this
    // never fires for intact data; if it does, it is real corruption and must not be hidden.
    const nm = r.file_name_enc ? decrypt(r.file_name_enc) : '';
    if (nm.toLowerCase().includes(needle)) matchedIds.push(r.id);
  }
  const total = matchedIds.length;
  const off = (pg - 1) * lim;
  const pageIds = matchedIds.slice(off, off + lim);
  if (!pageIds.length) return { documents: [], total, page: pg, pageSize: lim };
  const idParams = Object.fromEntries(pageIds.map((id, i) => [`i${i}`, id]));
  const [full] = await execute(`${SELECT} WHERE id IN (${pageIds.map((_, i) => `:i${i}`).join(',')})`, idParams);
  const byId = new Map(full.map((r) => [Number(r.id), r]));
  return { documents: pageIds.map((id) => toPublicDoc(byId.get(Number(id)))).filter(Boolean), total, page: pg, pageSize: lim };
}

/** Lab or imaging documents attached to ONE encounter (newest first). */
export async function listEncounterDocuments(encounterId, docType) {
  const [rows] = await execute(
    `${SELECT} WHERE encounter_id = :eid AND doc_type = :t ORDER BY created_at DESC`,
    { eid: encounterId, t: docType });
  return rows.map(toPublicDoc);
}

/** Raw rows (includes s3_key) — for internal use only (download/delete). */
export async function listRawDocuments(patientId) {
  const [rows] = await execute(`${SELECT} WHERE patient_id = :pid`, { pid: patientId });
  return rows;
}

export async function getRawDocByUuid(uuid) {
  const [rows] = await execute(`${SELECT} WHERE uuid = :uuid LIMIT 1`, { uuid });
  return rows[0] || null;
}

export async function findDocByType(patientId, docType) {
  const [rows] = await execute(`${SELECT} WHERE patient_id = :pid AND doc_type = :t LIMIT 1`, { pid: patientId, t: docType });
  return rows[0] || null;
}

export async function createDocumentRecord({ patientId, encounterId = null, docType, s3Key, fileName, contentType, size, uploadedBy, serviceDate = null }) {
  const uuid = uuidv4();
  // service_date = the provided Date of Service (YYYY-MM-DD) or, if none, today's date — so documents
  // always have a DOS to arrange by. Validated to a plain date shape; anything else falls back to today.
  const sdate = /^\d{4}-\d{2}-\d{2}$/.test(String(serviceDate || '')) ? serviceDate : null;
  await execute(
    `INSERT INTO patient_documents (uuid, patient_id, encounter_id, doc_type, s3_key, file_name_enc, content_type, size_bytes, service_date, uploaded_by)
     VALUES (:uuid, :pid, :eid, :type, :key, :nameEnc, :ct, :size, COALESCE(:sdate, CURDATE()), :uploadedBy)`,
    {
      uuid,
      pid: patientId,
      eid: encounterId,
      type: docType,
      key: s3Key,
      nameEnc: fileName ? encrypt(fileName) : null,
      ct: contentType || null,
      size: size || null,
      sdate,
      uploadedBy,
    },
  );
  return toPublicDoc(await getRawDocByUuid(uuid));
}

export async function deleteDocumentRecord(uuid) {
  const [res] = await execute(`DELETE FROM patient_documents WHERE uuid = :uuid`, { uuid });
  return res.affectedRows > 0;
}
