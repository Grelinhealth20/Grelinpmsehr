/**
 * Load the licensed AMA CPT® Standard data files into the DB — REAL AMA data only.
 *
 * Populates:
 *   cpt_codes                  (master: Long/Medium/Short/Consumer + effective date)
 *   cpt_modifiers              (Level I two-digit modifiers)
 *   cpt_clinician_descriptors  (alternate clinician-facing phrasings, many per code)
 *   terminology_cache          (source='CPT', term=Long) — unified search alongside SNOMED CT
 *
 * The AMA ships a full redistribution each quarter; pass the ConsolidatedCodeList files in
 * chronological order (annual → update 1 → 2 → 3) so the latest descriptor/errata wins.
 *
 * Usage:
 *   node scripts/load_cpt.mjs \
 *     --consolidated a.txt,b.txt,c.txt,d.txt \
 *     --modifiers Modifiers.txt \
 *     --clinician ClinicianDescriptor.txt
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const CONSOLIDATED = String(arg('consolidated', '')).split(',').map((s) => s.trim()).filter(Boolean);
const MODIFIERS = arg('modifiers');
const CLINICIAN = arg('clinician');

const CPT_CODE = /^[0-9]{4}[0-9A-Z]$/;           // Cat I (5 digits), Cat II(F), Cat III(T), PLA(U/M)
const clean = (s) => String(s ?? '').replace(/﻿/g, '').trim();
const yyyymmdd = (s) => { const v = clean(s); return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null; };

async function* dataRows(file, headerNeedle) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let seenHeader = false;
  for await (const raw of rl) {
    const line = raw.replace(/﻿/g, '');
    if (!line.includes('\t')) continue;                     // skip copyright prose (no tabs)
    if (!seenHeader) { if (line.includes(headerNeedle)) seenHeader = true; continue; }
    yield line.split('\t');
  }
}

async function loadConsolidated() {
  let cpt = []; let term = []; let total = 0;
  const flush = async () => {
    if (cpt.length) {
      await pool.query(
        `INSERT INTO cpt_codes (code, concept_id, long_desc, medium_desc, short_desc, consumer_desc, effective_date)
         VALUES ? ON DUPLICATE KEY UPDATE concept_id=VALUES(concept_id), long_desc=VALUES(long_desc),
           medium_desc=VALUES(medium_desc), short_desc=VALUES(short_desc), consumer_desc=VALUES(consumer_desc),
           effective_date=VALUES(effective_date), updated_at=NOW()`, [cpt]);
      await pool.query(
        `INSERT INTO terminology_cache (source, code, term) VALUES ?
         ON DUPLICATE KEY UPDATE term=VALUES(term), updated_at=NOW()`, [term]);
      cpt = []; term = [];
    }
  };
  for (const file of CONSOLIDATED) {
    if (!fs.existsSync(file)) { console.error('  ! missing', file); continue; }
    let n = 0;
    for await (const c of dataRows(file, 'CPT Code')) {
      const code = clean(c[1]);
      const long = clean(c[2]);
      if (!CPT_CODE.test(code) || !long) continue;
      cpt.push([code, clean(c[0]) || null, long, clean(c[3]) || null, clean(c[4]) || null, clean(c[5]) || null, yyyymmdd(c[7])]);
      term.push(['CPT', code, long.slice(0, 512)]);
      n += 1; total += 1;
      if (cpt.length >= 1000) await flush();
    }
    await flush();
    console.log(`  ✓ ${file.split(/[\\/]/).pop()} : ${n} rows`);
  }
  return total;
}

async function loadModifiers() {
  if (!MODIFIERS || !fs.existsSync(MODIFIERS)) return 0;
  let rows = []; let n = 0;
  for await (const c of dataRows(MODIFIERS, 'Modifier Code')) {
    const mod = clean(c[1]); if (!mod) continue;
    rows.push([mod, clean(c[0]) || null, clean(c[2]) || null, clean(c[4]) || null, clean(c[5]) || null, clean(c[6]) || null]);
    n += 1;
    if (rows.length >= 500) { await flushMods(rows); rows = []; }
  }
  if (rows.length) await flushMods(rows);
  return n;
}
async function flushMods(rows) {
  await pool.query(
    `INSERT INTO cpt_modifiers (modifier, concept_id, level, name, description, section) VALUES ?
     ON DUPLICATE KEY UPDATE concept_id=VALUES(concept_id), level=VALUES(level), name=VALUES(name),
       description=VALUES(description), section=VALUES(section), updated_at=NOW()`, [rows]);
}

async function loadClinician() {
  if (!CLINICIAN || !fs.existsSync(CLINICIAN)) return 0;
  let rows = []; let n = 0;
  const flush = async () => {
    if (!rows.length) return;
    await pool.query(
      `INSERT INTO cpt_clinician_descriptors (descriptor_id, code, descriptor) VALUES ?
       ON DUPLICATE KEY UPDATE code=VALUES(code), descriptor=VALUES(descriptor), updated_at=NOW()`, [rows]);
    rows = [];
  };
  for await (const c of dataRows(CLINICIAN, 'Clinician Descriptor')) {
    const id = clean(c[2]); const code = clean(c[1]); const desc = clean(c[3]);
    if (!/^\d+$/.test(id) || !CPT_CODE.test(code) || !desc) continue;
    rows.push([id, code, desc.slice(0, 512)]); n += 1;
    if (rows.length >= 1000) await flush();
  }
  await flush();
  return n;
}

console.log('Loading AMA CPT Standard data files…');
const codes = await loadConsolidated();
const mods = await loadModifiers();
const clin = await loadClinician();
const [[{ c }]] = [await pool.query('SELECT COUNT(*) c FROM cpt_codes')].map((r) => r[0]);
console.log(`\nDONE — cpt_codes rows now: ${c}`);
console.log(`  consolidated processed: ${codes} | modifiers: ${mods} | clinician descriptors: ${clin}`);
await pool.end();
process.exit(0);
