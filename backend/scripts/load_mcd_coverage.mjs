/**
 * Load the official CMS MCD Article coverage (current_article CSV bundle) into the mcd_* tables.
 * REAL CMS data. Authoritative, jurisdiction-complete source for Part B LCD/Article necessity.
 *
 * Usage: node scripts/load_mcd_coverage.mjs --dir <extracted_current_article_csv_dir>
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir');
if (!DIR || !fs.existsSync(DIR)) { console.error('need --dir (extracted current_article CSVs)'); process.exit(2); }

function parseCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Generic streaming loader: file → table, mapping each parsed row to a values array (or null to skip).
async function loadCsv(file, table, cols, mapFn) {
  const path = `${DIR}/${file}`;
  if (!fs.existsSync(path)) { console.error('  ! missing', file); return 0; }
  await pool.query(`DELETE FROM ${table}`);
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let header = true; let batch = []; let n = 0;
  const flush = async () => {
    if (!batch.length) return; const rows = batch; batch = [];
    await pool.query(`INSERT IGNORE INTO ${table} (${cols.join(',')}) VALUES ?`, [rows]);
    n += rows.length;
  };
  for await (const raw of rl) {
    if (header) { header = false; continue; }
    if (!raw.trim()) continue;
    const c = parseCsv(raw);
    const v = mapFn(c);
    if (!v) continue;
    batch.push(v);
    if (batch.length >= 5000) await flush();
  }
  await flush();
  console.log(`  ${table}: ${n} rows`);
  return n;
}

const icd = (s) => String(s || '').trim().toUpperCase();
console.log('Loading official MCD Article coverage…');

// contractor.csv: contractor_id[0], bus_name[3], number[4], state_id[10], status[14]
await loadCsv('contractor.csv', 'mcd_contractor', ['contractor_id', 'name', 'number', 'state_id', 'is_first_coast', 'status'],
  (c) => (c[0] && /^\d+$/.test(c[0].trim()) ? [Number(c[0]), (c[3] || '').slice(0, 255), (c[4] || '').slice(0, 20), c[10] ? Number(c[10]) : null, /first coast/i.test(c[3] || '') ? 1 : 0, (c[14] || '').slice(0, 1) || null] : null));

// article_x_contractor.csv: article_id[0], contractor_id[3]
await loadCsv('article_x_contractor.csv', 'mcd_article_x_contractor', ['article_id', 'contractor_id'],
  (c) => (c[0] && c[3] && /^\d+$/.test(c[0].trim()) && /^\d+$/.test(c[3].trim()) ? [Number(c[0]), Number(c[3])] : null));

// article_x_icd10_covered.csv: article_id[0], icd10_code_id[2], group[4]
await loadCsv('article_x_icd10_covered.csv', 'mcd_article_covered_icd', ['article_id', 'icd_code', 'grp'],
  (c) => (c[0] && c[2] && /^\d+$/.test(c[0].trim()) ? [Number(c[0]), icd(c[2]).slice(0, 16), c[4] ? Number(c[4]) : null] : null));

// article_x_icd10_noncovered.csv
await loadCsv('article_x_icd10_noncovered.csv', 'mcd_article_noncovered_icd', ['article_id', 'icd_code', 'grp'],
  (c) => (c[0] && c[2] && /^\d+$/.test(c[0].trim()) ? [Number(c[0]), icd(c[2]).slice(0, 16), c[4] ? Number(c[4]) : null] : null));

// article_x_hcpc_code.csv: article_id[0], hcpc_code_id[2]
await loadCsv('article_x_hcpc_code.csv', 'mcd_article_hcpc', ['article_id', 'hcpc_code'],
  (c) => (c[0] && c[2] && /^\d+$/.test(c[0].trim()) ? [Number(c[0]), icd(c[2]).slice(0, 10)] : null));

const n = async (s) => Number((await pool.query(s))[0][0].n);
console.log(`\nDONE. First Coast contractors: ${await n('SELECT COUNT(*) n FROM mcd_contractor WHERE is_first_coast=1')}`);
console.log(`  First Coast articles: ${await n('SELECT COUNT(DISTINCT ax.article_id) n FROM mcd_article_x_contractor ax JOIN mcd_contractor c ON c.contractor_id=ax.contractor_id WHERE c.is_first_coast=1')}`);
await pool.end();
process.exit(0);
