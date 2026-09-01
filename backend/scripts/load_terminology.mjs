/**
 * Bulk-load a terminology dataset from a delimited/fixed file into terminology_cache.
 * For licensed file distributions (AMA CPT / ADA CDT, or any code+description file) that
 * are NOT available via the UMLS API. Real data only — no mock.
 *
 * Usage:
 *   node scripts/load_terminology.mjs --source CPT --file /path/to/cpt.txt
 *   node scripts/load_terminology.mjs --source CDT --file cdt.csv --delim comma --code-col 0 --term-col 1
 *
 * Auto-detects tab / comma / whitespace delimiting; by default code = first column,
 * term = the rest. Skips header/garbage lines. Idempotent (upsert on source+code).
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const SOURCE = String(arg('source', '')).toUpperCase();
const FILE = arg('file');
const DELIM = arg('delim', 'auto');
const CODE_COL = arg('code-col') != null ? Number(arg('code-col')) : null;
const TERM_COL = arg('term-col') != null ? Number(arg('term-col')) : null;

if (!SOURCE || !FILE) { console.error('Usage: --source <CPT|CDT|...> --file <path> [--delim tab|comma|auto] [--code-col N] [--term-col N]'); process.exit(2); }
if (!fs.existsSync(FILE)) { console.error('File not found:', FILE); process.exit(2); }

function splitLine(line) {
  if (DELIM === 'tab') return line.split('\t');
  if (DELIM === 'comma') return line.split(',');
  if (line.includes('\t')) return line.split('\t');
  if (line.split(',').length > 1) return line.split(',');
  const m = line.match(/^(\S+)\s+(.*)$/);
  return m ? [m[1], m[2]] : [line];
}

let batch = [];
let dataLines = 0; let loaded = 0;
async function flush() {
  if (!batch.length) return;
  const rows = batch; batch = [];
  await pool.query(
    'INSERT INTO terminology_cache (source, code, term) VALUES ? ON DUPLICATE KEY UPDATE term = VALUES(term), updated_at = NOW()',
    [rows],
  );
  loaded += rows.length;
}

const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
for await (const raw of rl) {
  const line = raw.replace(/﻿/g, '').trim();
  if (!line) continue;
  const cols = splitLine(line);
  const code = String(CODE_COL != null ? cols[CODE_COL] : (cols[0] || '')).trim();
  const term = String(TERM_COL != null ? cols[TERM_COL] : cols.slice(1).join(' ')).trim().replace(/^"|"$/g, '');
  if (!code || !term) continue;
  if (!/^[A-Za-z0-9.\-]{1,32}$/.test(code)) continue; // skip headers / malformed lines
  dataLines += 1;
  batch.push([SOURCE, code.slice(0, 32), term.slice(0, 512)]);
  if (batch.length >= 1000) await flush();
}
await flush();
console.log(`Loaded ${loaded} ${SOURCE} codes into terminology_cache (from ${dataLines} data lines).`);
await pool.end();
process.exit(0);
