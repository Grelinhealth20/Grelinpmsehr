/**
 * Load the official SNOMED CT US → ICD-10-CM complex map (RF2 ExtendedMap refset 6011000124106)
 * from stdin into snomed_map_icd10cm. REAL SNOMED data. Active rows only.
 *
 * Columns: id[0] eff[1] active[2] module[3] refset[4] referencedComponentId[5]=SCTID
 *          mapGroup[6] mapPriority[7] mapRule[8] mapAdvice[9] mapTarget[10]=ICD mapCategory[12]
 *
 * Usage: unzip -p snomed.zip '.../der2_iisssccRefset_ExtendedMapSnapshot_*.txt' | node scripts/load_snomed_icd_map.mjs
 */
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const ICD10CM_REFSET = '6011000124106';
await pool.query('DELETE FROM snomed_map_icd10cm');

let batch = []; let scanned = 0; let kept = 0;
async function flush() {
  if (!batch.length) return; const rows = batch; batch = [];
  await pool.query(
    'INSERT INTO snomed_map_icd10cm (snomed_id, map_group, map_priority, map_rule, map_advice, icd_code, map_category) VALUES ?',
    [rows]);
  kept += rows.length;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let header = true;
for await (const line of rl) {
  if (header) { header = false; continue; }
  if ((++scanned % 200000) === 0) process.stdout.write(`\r  scanned ${scanned}, kept ${kept + batch.length}`);
  const c = line.split('\t');
  if (c[2] !== '1' || c[4] !== ICD10CM_REFSET) continue;
  batch.push([
    c[5], Number(c[6]) || 1, Number(c[7]) || 1,
    (c[8] || '').slice(0, 512), (c[9] || '').slice(0, 1024),
    (c[10] || '').trim().slice(0, 16) || null, (c[12] || '').slice(0, 20)]);
  if (batch.length >= 2000) await flush();
}
await flush();
process.stdout.write(`\r  scanned ${scanned}, kept ${kept}\n`);
console.log(`DONE — snomed_map_icd10cm: ${kept} rows`);
await pool.end();
process.exit(0);
