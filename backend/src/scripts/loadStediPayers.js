import { readFileSync } from 'node:fs';
import { pool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { upsertPayers, payerCount } from '../services/payerDirectoryService.js';
import { logger } from '../config/logger.js';

/**
 * Load Stedi's Payer Network CSV export into stedi_payers (a full replace so the
 * table mirrors the export exactly). Usage:
 *   node src/scripts/loadStediPayers.js "C:\\path\\to\\stedi-payers-YYYY-MM-DD.csv"
 * Defaults to the file the user downloaded when no path is given.
 */

const DEFAULT_CSV = 'C:\\Users\\Administrator\\Downloads\\stedi-payers-2026-08-24.csv';

/** RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, embedded commas/newlines. */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignore CR */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const clip = (v, n) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };

async function main() {
  const csvPath = process.argv[2] || DEFAULT_CSV;
  const text = readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV has no data rows.');

  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const iStedi = idx('StediId');
  const iPrimary = idx('PrimaryPayerId');
  const iName = idx('DisplayName');
  const iNames = idx('Names');
  const iAliases = idx('Aliases');
  const iElig = idx('EligibilityInquiry');
  const iCov = idx('CoverageTypes');
  const iStates = idx('OperatingStates');
  if (iStedi < 0 || iName < 0) throw new Error('CSV missing StediId / DisplayName columns.');

  const data = [];
  let eligible = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const stedi = clip(row[iStedi], 16);
    if (!stedi) continue;
    const elig = String(row[iElig] ?? '').trim().toLowerCase() === 'true' ? 1 : 0;
    if (elig) eligible++;
    data.push([
      stedi,
      clip(row[iPrimary], 32),
      clip(row[iName], 255) || stedi,
      (String(row[iNames] ?? '').trim() || null),
      (String(row[iAliases] ?? '').trim() || null),
      elig,
      clip(row[iCov], 64),
      clip(row[iStates], 512),
    ]);
  }
  if (!data.length) throw new Error('No payer rows parsed.');

  await runMigrations();                       // ensure stedi_payers exists
  await pool.query('TRUNCATE TABLE stedi_payers');
  const written = await upsertPayers(data);
  const total = await payerCount();
  logger.info({ csvPath, parsed: data.length, eligible, written, total }, 'Stedi payers loaded');
  console.log(`Loaded ${written} payers from ${csvPath} (${eligible} eligibility-supported). Table now has ${total}.`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err: err.message }, 'Stedi payer load failed'); console.error(err); process.exit(1); });
