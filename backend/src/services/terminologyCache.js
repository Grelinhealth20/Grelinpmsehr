import { pool } from '../db/pool.js';
import { logger } from '../config/logger.js';

/**
 * In-process LOCAL CACHE of the hot, small terminology datasets the coding engine validates against
 * on every prediction. The full reference tables live on the remote DB; validating a code there means
 * a network round-trip per call, and the prediction path calls isBillableIcd() dozens of times per
 * note. We load the COMPLETE billable ICD-10-CM set once into memory (code → description) so every
 * validation is an O(1) local lookup — deterministic, offline-resilient, and fast.
 *
 * The cache is authoritative REAL CMS data (icd10cm_valid), not a heuristic: nothing is fabricated,
 * and a code absent from the set is not billable. Loaded lazily on first use and warmed at boot.
 */

const DATASETS = {
  // key → { table, keyCol, valCol, description }
  icd10cm: { table: 'icd10cm_valid', keyCol: 'code', valCol: 'description', label: 'ICD-10-CM billable' },
};

const store = new Map(); // datasetKey → Map<normalizedCode, description>
const loading = new Map(); // datasetKey → Promise (dedupe concurrent first-loads)

const normCode = (c) => String(c || '').trim().toUpperCase();

async function load(datasetKey) {
  if (store.has(datasetKey)) return store.get(datasetKey);
  if (loading.has(datasetKey)) return loading.get(datasetKey);
  const spec = DATASETS[datasetKey];
  if (!spec) throw new Error(`unknown terminology dataset: ${datasetKey}`);
  const p = (async () => {
    const started = process.hrtime.bigint();
    const [rows] = await pool.query(`SELECT \`${spec.keyCol}\` AS code, \`${spec.valCol}\` AS description FROM \`${spec.table}\``);
    const map = new Map();
    for (const r of rows) map.set(normCode(r.code), r.description || null);
    store.set(datasetKey, map);
    loading.delete(datasetKey);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info({ dataset: spec.label, rows: map.size, ms: Math.round(ms) }, 'terminology cache loaded');
    return map;
  })().catch((err) => {
    loading.delete(datasetKey);
    logger.error({ err: err.message, dataset: spec.label }, 'terminology cache load failed');
    throw err;
  });
  loading.set(datasetKey, p);
  return p;
}

/** True iff `code` is a valid BILLABLE ICD-10-CM code (complete set, from local cache). */
export async function isBillableIcd(code) {
  if (!code) return false;
  const map = await load('icd10cm');
  return map.has(normCode(code));
}

/** Official ICD-10-CM long description for a billable code, or null. */
export async function icdDescription(code) {
  if (!code) return null;
  const map = await load('icd10cm');
  return map.get(normCode(code)) ?? null;
}

/** Warm the local caches at boot so the first prediction pays no load cost. Never throws. */
export async function warmTerminologyCache() {
  try {
    await load('icd10cm');
  } catch (err) {
    logger.warn({ err: err.message }, 'terminology cache warm skipped (will lazy-load on first use)');
  }
}

/** Diagnostics: which datasets are cached and how many rows each holds. */
export function terminologyCacheStats() {
  const out = {};
  for (const [k, m] of store.entries()) out[k] = m.size;
  return out;
}
