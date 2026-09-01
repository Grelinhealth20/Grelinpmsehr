/**
 * Load the complete RxNorm concept set directly from the NLM RxNorm API (RxNav) — REAL data,
 * no mock, no subset. Fetches every concept for the clinically-relevant term types and loads:
 *   rxnorm_concepts    (rxcui, name, tty)
 *   terminology_cache  (source='RXNORM') — prescribable/ingredient/brand names for med search
 *
 * RxNav is the NLM's public RxNorm service (no API key required):
 *   https://rxnav.nlm.nih.gov/REST/allconcepts.json?tty=...
 *
 * Usage: node scripts/load_rxnorm.mjs
 */
import { pool } from '../src/db/pool.js';

const BASE = 'https://rxnav.nlm.nih.gov/REST';
// Full set of named RxNorm term types (whole concept graph that carries a human name).
const ALL_TTYS = ['IN', 'PIN', 'MIN', 'BN', 'SCDC', 'SCDF', 'SCDG', 'SCD', 'SBDC', 'SBDF', 'SBDG', 'SBD', 'GPCK', 'BPCK', 'DF', 'DFG'];
// Term types worth surfacing in the unified clinician med-search (prescribable + ingredient + brand).
const CACHE_TTYS = new Set(['IN', 'PIN', 'MIN', 'BN', 'SCD', 'SBD', 'GPCK', 'BPCK']);

async function fetchTty(tty) {
  const url = `${BASE}/allconcepts.json?tty=${tty}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data?.minConceptGroup?.minConcept || [];
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return [];
}

console.log('Fetching RxNorm from RxNav (NLM) …');
const seen = new Map(); // rxcui -> {name, tty}
for (const tty of ALL_TTYS) {
  const concepts = await fetchTty(tty);
  for (const c of concepts) {
    if (!c.rxcui || !c.name) continue;
    // Each RXCUI has one canonical TTY; first authoritative type wins (ALL_TTYS is priority-ordered).
    if (!seen.has(c.rxcui)) seen.set(c.rxcui, { name: c.name, tty: c.tty || tty });
  }
  console.log(`  ${tty}: ${concepts.length}  (unique so far ${seen.size})`);
}

// Upsert rxnorm_concepts.
let batch = []; let n = 0;
const flushConcepts = async () => {
  if (!batch.length) return; const rows = batch; batch = [];
  await pool.query(
    `INSERT INTO rxnorm_concepts (rxcui, name, tty) VALUES ?
     ON DUPLICATE KEY UPDATE name=VALUES(name), tty=VALUES(tty), updated_at=NOW()`, [rows]);
  n += rows.length;
};
for (const [rxcui, { name, tty }] of seen) {
  if (!/^\d+$/.test(String(rxcui))) continue;
  batch.push([rxcui, name.slice(0, 1000), tty.slice(0, 20)]);
  if (batch.length >= 2000) await flushConcepts();
}
await flushConcepts();

// Unified terminology_cache — clinician-searchable med names (prescribable/ingredient/brand).
console.log('  building terminology_cache (RXNORM)…');
await pool.query('DELETE FROM terminology_cache WHERE source = ?', ['RXNORM']);
let cbatch = []; let cn = 0;
const flushCache = async () => {
  if (!cbatch.length) return; const rows = cbatch; cbatch = [];
  await pool.query(
    `INSERT INTO terminology_cache (source, code, term) VALUES ?
     ON DUPLICATE KEY UPDATE term=VALUES(term), updated_at=NOW()`, [rows]);
  cn += rows.length;
};
for (const [rxcui, { name, tty }] of seen) {
  if (!CACHE_TTYS.has(tty)) continue;
  cbatch.push(['RXNORM', String(rxcui).slice(0, 32), name.slice(0, 512)]);
  if (cbatch.length >= 2000) await flushCache();
}
await flushCache();

console.log(`\nDONE — rxnorm_concepts=${n}, terminology_cache[RXNORM]=${cn}`);
await pool.end();
process.exit(0);
