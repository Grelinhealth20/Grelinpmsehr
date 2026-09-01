/**
 * Backfill the MCD article→MAC mapping for coverage articles NOT returned by the current
 * local-coverage-articles API report (retired articles). Their contractor is read from the
 * embedded JSON on the official MCD article page (`"contract":"…"`). REAL CMS data.
 *
 * Usage: node scripts/load_mcd_retired_articles.mjs
 */
import { pool } from '../src/db/pool.js';

const PAGE = (id) => `https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=${id}`;
const CONCURRENCY = 5;

async function contractorFor(id) {
  try {
    const res = await fetch(PAGE(id), { headers: { 'User-Agent': 'grelin-ehr/1.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"contract":"([^"]+)"/);
    if (!m) return null;
    const name = m[1].replace(/\\u0026/g, '&').trim();
    const title = (html.match(/"documentTitle":"([^"]+)"/) || html.match(/"title":"([^"]{4,300})"/) || [])[1] || null;
    return { name, title, isFirstCoast: /first coast/i.test(name) ? 1 : 0 };
  } catch { return null; }
}

const [rows] = await pool.query(
  `SELECT DISTINCT a.article_id FROM article_coverage_icd a
     LEFT JOIN mcd_article_contractor m ON m.article_id = a.article_id
    WHERE m.article_id IS NULL`);
const ids = rows.map((r) => r.article_id);
console.log(`Backfilling ${ids.length} unmatched (retired) articles from MCD pages…`);

let matched = 0; let firstCoast = 0; const upserts = [];
for (let i = 0; i < ids.length; i += CONCURRENCY) {
  const chunk = ids.slice(i, i + CONCURRENCY);
  const res = await Promise.all(chunk.map(async (id) => ({ id, c: await contractorFor(id) })));
  for (const { id, c } of res) {
    if (!c) { console.log(`  A${id}: no contractor found`); continue; }
    matched += 1; if (c.isFirstCoast) firstCoast += 1;
    upserts.push([id, `A${id}`, 'Article (retired)', (c.title || '').slice(0, 512), c.name.slice(0, 255), '', c.isFirstCoast, '', PAGE(id).slice(0, 512)]);
  }
  process.stdout.write(`\r  processed ${Math.min(i + CONCURRENCY, ids.length)}/${ids.length}, matched ${matched}`);
}
process.stdout.write('\n');

if (upserts.length) {
  await pool.query(
    `INSERT INTO mcd_article_contractor (article_id, display_id, document_type, title, contractor_name, contractor_type, is_first_coast, effective_date, url)
     VALUES ? ON DUPLICATE KEY UPDATE contractor_name=VALUES(contractor_name), is_first_coast=VALUES(is_first_coast)`, [upserts]);
}
console.log(`DONE — backfilled ${matched} retired articles (${firstCoast} First Coast/FL).`);
const n = async (s) => Number((await pool.query(s))[0][0].n);
console.log(`  coverage articles now mapped: ${await n('SELECT COUNT(DISTINCT a.article_id) n FROM article_coverage_icd a JOIN mcd_article_contractor m ON m.article_id=a.article_id')} / ${await n('SELECT COUNT(DISTINCT article_id) n FROM article_coverage_icd')}`);
await pool.end();
process.exit(0);
