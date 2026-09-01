/**
 * Stream a UMLS RRF file (from stdin) into its table. REAL UMLS data only.
 *   --type sty  → MRSTY.RRF  → umls_semantic_types  (CUI|TUI|STN|STY|ATUI|CVF)
 *   --type def  → MRDEF.RRF  → umls_definitions      (CUI|AUI|ATUI|SATUI|SAB|DEF|SUPPRESS|CVF)
 *
 * Usage:
 *   unzip -p umls-...zip 2026AA/META/MRSTY.RRF | node scripts/load_umls_rrf.mjs --type sty
 *   unzip -p umls-...zip 2026AA/META/MRDEF.RRF | node scripts/load_umls_rrf.mjs --type def
 */
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const TYPE = String(arg('type', '')).toLowerCase();
if (!['sty', 'def'].includes(TYPE)) { console.error('--type must be sty|def'); process.exit(2); }

const table = TYPE === 'sty' ? 'umls_semantic_types' : 'umls_definitions';
console.log(`Loading ${table} from stdin…`);
await pool.query(`DELETE FROM ${table}`);   // idempotent full refresh

let batch = []; let n = 0;
async function flush() {
  if (!batch.length) return; const rows = batch; batch = [];
  if (TYPE === 'sty') {
    await pool.query(
      `INSERT IGNORE INTO umls_semantic_types (cui, tui, stn, sty) VALUES ?`, [rows]);
  } else {
    await pool.query(
      `INSERT INTO umls_definitions (cui, sab, def, suppress) VALUES ?`, [rows]);
  }
  n += rows.length;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (line.charCodeAt(0) !== 67) continue;         // rows start with CUI 'C'
  const c = line.split('|');
  if (TYPE === 'sty') {
    if (!c[0] || !c[1] || !c[3]) continue;
    batch.push([c[0], c[1], c[2] || null, c[3].slice(0, 128)]);
  } else {
    if (!c[0] || !c[5]) continue;
    batch.push([c[0], c[4] || '', c[5], c[6] || null]);
  }
  if (batch.length >= 2000) await flush();
}
await flush();
console.log(`DONE — ${table}: ${n} rows`);
await pool.end();
process.exit(0);
