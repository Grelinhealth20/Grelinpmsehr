import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt } from '../utils/crypto.js';

/** Document metadata rows. The S3 key is internal; it is never sent to clients. */
export function toPublicDoc(row) {
  if (!row) return null;
  return {
    uuid: row.uuid,
    docType: row.doc_type,
    fileName: row.file_name_enc ? decrypt(row.file_name_enc) : null,
    contentType: row.content_type,
    size: row.size_bytes,
    createdAt: row.created_at,
  };
}

const SELECT = `SELECT id, uuid, patient_id, doc_type, s3_key, file_name_enc, content_type, size_bytes, created_at
  FROM patient_documents`;

export async function listDocuments(patientId) {
  const [rows] = await execute(`${SELECT} WHERE patient_id = :pid ORDER BY created_at DESC`, { pid: patientId });
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

export async function createDocumentRecord({ patientId, docType, s3Key, fileName, contentType, size, uploadedBy }) {
  const uuid = uuidv4();
  await execute(
    `INSERT INTO patient_documents (uuid, patient_id, doc_type, s3_key, file_name_enc, content_type, size_bytes, uploaded_by)
     VALUES (:uuid, :pid, :type, :key, :nameEnc, :ct, :size, :uploadedBy)`,
    {
      uuid,
      pid: patientId,
      type: docType,
      key: s3Key,
      nameEnc: fileName ? encrypt(fileName) : null,
      ct: contentType || null,
      size: size || null,
      uploadedBy,
    },
  );
  return toPublicDoc(await getRawDocByUuid(uuid));
}

export async function deleteDocumentRecord(uuid) {
  const [res] = await execute(`DELETE FROM patient_documents WHERE uuid = :uuid`, { uuid });
  return res.affectedRows > 0;
}
