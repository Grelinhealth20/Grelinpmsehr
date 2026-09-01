/**
 * Load the CMS PDPM ICD-10 → clinical category mapping (exported from the official PDPM ICD
 * Codes Access DB to CSV). REAL CMS data. One CSV per fiscal year.
 *
 * Usage: node scripts/load_pdpm_icd.mjs --fy 2026 --file pdpm_fy2026.csv [--fy 2027 --file ...]
 * (repeatable pairs)
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

// Parse repeatable --fy/--file pairs.
const pairs = [];
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--fy') pairs.push({ fy: Number(process.argv[i + 1]), file: null });
  if (process.argv[i] === '--file' && pairs.length) pairs[pairs.length - 1].file = process.argv[i + 1];
}

// Minimal RFC-4180 CSV line parser (quoted fields, embedded commas/quotes).
function parseCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const APPEND = process.argv.includes('--append'); // keep existing rows (load complementary table)
async function loadFile(fy, file) {
  if (!fs.existsSync(file)) { console.error('  ! missing', file); return 0; }
  if (!APPEND) await pool.query('DELETE FROM pdpm_icd_codes WHERE fiscal_year = ?', [fy]);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = true; let batch = []; let n = 0;
  const flush = async () => {
    if (!batch.length) return; const rows = batch; batch = [];
    await pool.query(
      `INSERT INTO pdpm_icd_codes
        (fiscal_year, code, description, default_clinical_category, major_procedure_category, clinical_category_pt_ot, clinical_category_slp)
        VALUES ? ON DUPLICATE KEY UPDATE description=VALUES(description),
          default_clinical_category=VALUES(default_clinical_category), major_procedure_category=VALUES(major_procedure_category),
          clinical_category_pt_ot=VALUES(clinical_category_pt_ot), clinical_category_slp=VALUES(clinical_category_slp)`, [rows]);
    n += rows.length;
  };
  for await (const raw of rl) {
    const line = raw.replace(/﻿/g, '');
    if (!line.trim()) continue;
    if (header) { header = false; continue; }
    const c = parseCsv(line);
    const code = (c[0] || '').trim();
    if (!code) continue;
    batch.push([fy, code.slice(0, 10), (c[1] || '').slice(0, 512), (c[2] || '').slice(0, 128),
      (c[3] || '').slice(0, 128), (c[4] || '').slice(0, 128), (c[5] || '').slice(0, 128)]);
    if (batch.length >= 1000) await flush();
  }
  await flush();
  console.log(`  FY${fy}: ${n} rows`);
  return n;
}

console.log('Loading PDPM ICD → clinical category mapping…');
for (const { fy, file } of pairs) { if (fy && file) await loadFile(fy, file); }
const [[t]] = [(await pool.query('SELECT COUNT(*) n FROM pdpm_icd_codes'))[0]];
console.log(`DONE — pdpm_icd_codes total: ${t.n}`);
await pool.end();
process.exit(0);
