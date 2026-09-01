/**
 * Load selected mysqldump per-table .sql files into the CURRENT database (the backend's
 * configured connection — here the remote grelin_pmsehr). Table-scoped files only; the target
 * database is whatever the connection defaults to, so this never touches any other schema.
 *
 * Executes statement-by-statement (safe for very large extended-insert files, no giant packet),
 * with FK/unique checks off during load. Idempotent per file (files carry DROP TABLE IF EXISTS).
 *
 * Usage: node scripts/load_sql_dump.mjs --dir <extracted_dump_dir> --skip cpt_codes,ar_claims,...
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir');
const SKIP = new Set(String(arg('skip', '')).split(',').map((s) => s.trim()).filter(Boolean));
if (!DIR || !fs.existsSync(DIR)) { console.error('Missing --dir'); process.exit(2); }

// Map "Demosystem_ncci_ptp.sql" -> table "ncci_ptp".
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql'))
  .map((f) => ({ file: f, table: f.replace(/\.sql$/, '').replace(/^.*?_/, '') }))
  .filter((x) => !SKIP.has(x.table))
  .sort((a, b) => a.table.localeCompare(b.table));

async function runFile(conn, file, table) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(DIR, file)), crlfDelay: Infinity });
  let buf = ''; let stmts = 0;
  for await (const raw of rl) {
    const line = raw;
    const t = line.trimStart();
    if (!buf && (t === '' || t.startsWith('--'))) continue;      // skip blank / comment-only lines between statements
    buf += (buf ? '\n' : '') + line;
    if (line.trimEnd().endsWith(';')) {
      const sql = buf.trim(); buf = '';
      if (!sql || sql.startsWith('--')) continue;
      await conn.query(sql);
      stmts += 1;
    }
  }
  if (buf.trim()) { await conn.query(buf.trim()); stmts += 1; }
  const [[c]] = [(await conn.query(`SELECT COUNT(*) n FROM \`${table}\``))[0]];
  return { stmts, rows: c.n };
}

const conn = await pool.getConnection();
try {
  await conn.query('SET FOREIGN_KEY_CHECKS=0');
  await conn.query('SET UNIQUE_CHECKS=0');
  const [[dbrow]] = [(await conn.query('SELECT DATABASE() db'))[0]];
  console.log(`Loading ${files.length} table(s) into database: ${dbrow.db}\n`);
  for (const { file, table } of files) {
    process.stdout.write(`  ${table} … `);
    try { const r = await runFile(conn, file, table); console.log(`ok (${r.rows} rows)`); }
    catch (e) { console.log(`FAILED: ${e.message}`); }
  }
} finally {
  await conn.query('SET FOREIGN_KEY_CHECKS=1');
  await conn.query('SET UNIQUE_CHECKS=1');
  conn.release();
}
await pool.end();
process.exit(0);
