/**
 * Load the CMS Medicare Physician Fee Schedule RVU file (PPRRVU CSV) into mpfs_rvu. REAL CMS data.
 * Usage: node scripts/load_mpfs_rvu.mjs --year 2026 --file PPRRVU2026_Jan_nonQPP.csv
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const YEAR = Number(arg('year'));
const FILE = arg('file');
if (!YEAR || !FILE || !fs.existsSync(FILE)) { console.error('need --year --file (existing)'); process.exit(2); }

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
const num = (v) => { const s = String(v ?? '').trim().replace(/,/g, ''); return s === '' || Number.isNaN(Number(s)) ? null : Number(s); };
const CODE = /^[0-9A-Z]{5}$/;

await pool.query('DELETE FROM mpfs_rvu WHERE year = ?', [YEAR]);
const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
let started = false; let batch = []; let n = 0;
async function flush() {
  if (!batch.length) return; const rows = batch; batch = [];
  await pool.query(
    `INSERT INTO mpfs_rvu (year,hcpcs,modifier,description,status_code,work_rvu,nonfac_pe_rvu,fac_pe_rvu,mp_rvu,
        nonfac_total,fac_total,pctc_ind,global_days,mult_proc,bilat_surg,asst_surg,co_surg,team_surg,conv_factor)
     VALUES ? ON DUPLICATE KEY UPDATE description=VALUES(description), status_code=VALUES(status_code),
        work_rvu=VALUES(work_rvu), nonfac_pe_rvu=VALUES(nonfac_pe_rvu), fac_pe_rvu=VALUES(fac_pe_rvu), mp_rvu=VALUES(mp_rvu),
        nonfac_total=VALUES(nonfac_total), fac_total=VALUES(fac_total), pctc_ind=VALUES(pctc_ind), global_days=VALUES(global_days),
        mult_proc=VALUES(mult_proc), bilat_surg=VALUES(bilat_surg), asst_surg=VALUES(asst_surg), co_surg=VALUES(co_surg),
        team_surg=VALUES(team_surg), conv_factor=VALUES(conv_factor)`, [rows]);
  n += rows.length;
}
for await (const raw of rl) {
  const c = parseCsv(raw);
  if (!started) { if ((c[0] || '').trim() === 'HCPCS' && (c[1] || '').trim() === 'MOD') started = true; continue; }
  const hcpcs = (c[0] || '').trim();
  if (!CODE.test(hcpcs)) continue;
  batch.push([YEAR, hcpcs, (c[1] || '').trim().slice(0, 6), (c[2] || '').slice(0, 255), (c[3] || '').trim().slice(0, 1) || null,
    num(c[5]), num(c[6]), num(c[8]), num(c[10]), num(c[11]), num(c[12]),
    (c[13] || '').trim().slice(0, 4), (c[14] || '').trim().slice(0, 4), (c[18] || '').trim().slice(0, 4),
    (c[19] || '').trim().slice(0, 4), (c[20] || '').trim().slice(0, 4), (c[21] || '').trim().slice(0, 4),
    (c[22] || '').trim().slice(0, 4), num(c[25])]);
  if (batch.length >= 1000) await flush();
}
await flush();
console.log(`DONE — mpfs_rvu year ${YEAR}: ${n} rows`);
await pool.end();
process.exit(0);
