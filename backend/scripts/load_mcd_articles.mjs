/**
 * Load the MCD Billing & Coding Article → MAC (contractor) mapping from the CMS Medicare
 * Coverage Database API. REAL CMS data. Flags First Coast Service Options (Central FL MAC).
 * Usage: node scripts/load_mcd_articles.mjs
 */
import { pool } from '../src/db/pool.js';

const BASE = 'https://api.coverage.cms.gov/v1/reports/local-coverage-articles';

async function fetchAll() {
  const out = []; let token = '';
  for (let guard = 0; guard < 100; guard += 1) {
    const url = token ? `${BASE}?next_token=${encodeURIComponent(token)}` : BASE;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`MCD API ${res.status}`);
    const j = await res.json();
    out.push(...(j.data || []));
    token = j.meta?.next_token || '';
    if (!token) break;
  }
  return out;
}

console.log('Fetching MCD articles (contractor mapping)…');
const arts = await fetchAll();
console.log(`  fetched ${arts.length} articles`);
await pool.query('DELETE FROM mcd_article_contractor');
let batch = [];
const flush = async () => { if (!batch.length) return; const rows = batch; batch = []; await pool.query('INSERT INTO mcd_article_contractor (article_id, display_id, document_type, title, contractor_name, contractor_type, is_first_coast, effective_date, url) VALUES ? ON DUPLICATE KEY UPDATE contractor_name=VALUES(contractor_name), is_first_coast=VALUES(is_first_coast)', [rows]); };
for (const a of arts) {
  if (!a.document_id) continue;
  const cnt = String(a.contractor_name_type || '').replace(/\r/g, '');
  const [name, ...rest] = cnt.split('\n');
  const type = rest.join(' ').replace(/[()]/g, '').trim();
  const firstCoast = /first coast/i.test(name || '') ? 1 : 0;
  batch.push([a.document_id, (a.document_display_id || '').slice(0, 20), (a.document_type || '').slice(0, 60),
    (a.title || '').slice(0, 512), (name || '').trim().slice(0, 255), type.slice(0, 255), firstCoast,
    (a.effective_date || '').slice(0, 20), (a.url || '').slice(0, 512)]);
  if (batch.length >= 500) await flush();
}
await flush();

const n = async (s) => Number((await pool.query(s))[0][0].n);
console.log(`\nDONE — mcd_article_contractor: ${await n('SELECT COUNT(*) n FROM mcd_article_contractor')}`);
console.log(`  First Coast (Central FL) articles: ${await n('SELECT COUNT(*) n FROM mcd_article_contractor WHERE is_first_coast=1')}`);
console.log(`  of my coverage articles (${await n('SELECT COUNT(DISTINCT article_id) n FROM article_coverage_icd')}), mapped to a contractor: ${await n('SELECT COUNT(DISTINCT a.article_id) n FROM article_coverage_icd a JOIN mcd_article_contractor m ON m.article_id=a.article_id')}`);
console.log(`  ...and First Coast among them: ${await n('SELECT COUNT(DISTINCT a.article_id) n FROM article_coverage_icd a JOIN mcd_article_contractor m ON m.article_id=a.article_id WHERE m.is_first_coast=1')}`);
await pool.end();
process.exit(0);
