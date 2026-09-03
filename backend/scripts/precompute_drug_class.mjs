/**
 * Precompute the denormalized `rxnorm_drug_class` table from the authoritative UMLS data just loaded
 * (RXNORM atoms in umls_atoms = rxcui↔CUI, ATC atoms, MED-RT atoms, and umls_rel MED-RT relationships).
 * One indexed lookup per ingredient at prescribe time — no runtime API, no fuzzy matching.
 *
 * Rows (rxcui, ingredient, class_system, class_id, class_name):
 *   ATC4 / ATC3           — WHO ATC chemical/pharmacological subgroup, via shared CUI (rxcui↔CUI↔ATC L5,
 *                            truncated to L4/L3). Used for therapeutic-duplication + class display.
 *   MEDRT_STRUCT          — MED-RT structural/chemical class (has_structural_class) = allergen class
 *                            (amoxicillin→Penicillins, sulfamethoxazole→Sulfonamides). Primary allergy signal.
 *   MEDRT_THERA           — MED-RT therapeutic class (has_therapeutic_class).
 *
 * Direction-safe: MED-RT joins are run from BOTH sides but constrained so the DRUG side is an RXNORM
 * CUI and the CLASS side is a MED-RT atom, so only the correct orientation yields rows.
 *
 * Usage: node scripts/precompute_drug_class.mjs
 */
import { pool } from '../src/db/pool.js';

const q = (s, p) => pool.query(s, p || []);

await q(`CREATE TABLE IF NOT EXISTS rxnorm_drug_class (
  rxcui        BIGINT UNSIGNED NOT NULL,
  ingredient   VARCHAR(255)    NOT NULL,
  class_system VARCHAR(16)     NOT NULL,
  class_id     VARCHAR(32)     NOT NULL,
  class_name   VARCHAR(255)    NOT NULL,
  PRIMARY KEY (rxcui, class_system, class_id),
  KEY idx_dc_ing (ingredient),
  KEY idx_dc_sys (class_system)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
await q('DELETE FROM rxnorm_drug_class');

// ---- ATC (via shared CUI: rxcui atom → same CUI → ATC L5 substance atom → truncate) ----
// Pick the BEST available label per ATC code — prefer the RxNorm-preferred term (ts='P'/is_pref) but
// fall back to any (many WHO-standard L3 labels like J01M "QUINOLONE ANTIBACTERIALS" are ts='S' only;
// requiring ts='P' would silently drop the class entirely and miss the "quinolone" allergen term).
for (const [sys, len] of [['ATC4', 5], ['ATC3', 4]]) {
  const [r] = await q(`
    INSERT IGNORE INTO rxnorm_drug_class (rxcui, ingredient, class_system, class_id, class_name)
    SELECT rxcui, name, ?, code, str FROM (
      SELECT rc.rxcui, rc.name, SUBSTRING(atc.code,1,?) code, lbl.str,
        ROW_NUMBER() OVER (PARTITION BY rc.rxcui, SUBSTRING(atc.code,1,?)
          ORDER BY (lbl.ts='P') DESC, lbl.is_pref DESC, CHAR_LENGTH(lbl.str)) rn
      FROM rxnorm_concepts rc
      JOIN umls_atoms rx  ON rx.sab='RXNORM' AND rx.code = CAST(rc.rxcui AS CHAR)
      JOIN umls_atoms atc ON atc.cui = rx.cui AND atc.sab='ATC' AND CHAR_LENGTH(atc.code)=7
      JOIN umls_atoms lbl ON lbl.sab='ATC' AND lbl.code = SUBSTRING(atc.code,1,?)
      WHERE rc.tty IN ('IN','PIN','MIN') AND CHAR_LENGTH(rc.name)<=255
    ) x WHERE rn=1`, [sys, len, len, len]);
  console.log(`${sys}: +${r.affectedRows}`);
}

// ---- MED-RT classes (via umls_rel; run both orientations, drug=RXNORM cui, class=MED-RT atom) ----
//   STRUCT = chemical/structural class (the allergen class), THERA = therapeutic class (display/coverage).
// (has_contraindicated_class is drug-interaction data — the class contraindicated WITH the drug, NOT the
//  drug's own allergen class — so it is deliberately NOT used for allergy screening.)
// Best label per class concept (prefer ts='P'/is_pref, else any) so no class is silently dropped.
const MEDRT = [['MEDRT_STRUCT', 'has_structural_class'], ['MEDRT_THERA', 'has_therapeutic_class']];
for (const [sys, rela] of MEDRT) {
  for (const [drugCol, clsCol] of [['cui1', 'cui2'], ['cui2', 'cui1']]) {
    const [r] = await q(`
      INSERT IGNORE INTO rxnorm_drug_class (rxcui, ingredient, class_system, class_id, class_name)
      SELECT rxcui, name, ?, cui, str FROM (
        SELECT rc.rxcui, rc.name, cls.cui, cls.str,
          ROW_NUMBER() OVER (PARTITION BY rc.rxcui, cls.cui ORDER BY (cls.ts='P') DESC, cls.is_pref DESC, CHAR_LENGTH(cls.str)) rn
        FROM rxnorm_concepts rc
        JOIN umls_atoms rx  ON rx.sab='RXNORM' AND rx.code = CAST(rc.rxcui AS CHAR)
        JOIN umls_rel  rel  ON rel.sab='MED-RT' AND rel.rela = ? AND rel.${drugCol} = rx.cui
        JOIN umls_atoms cls ON cls.sab='MED-RT' AND cls.cui = rel.${clsCol}
        WHERE rc.tty IN ('IN','PIN','MIN') AND CHAR_LENGTH(rc.name)<=255 AND CHAR_LENGTH(cls.str)<=255
      ) x WHERE rn=1`, [sys, rela]);
    if (r.affectedRows) console.log(`${sys} (${drugCol}→${clsCol}): +${r.affectedRows}`);
  }
}

// ---- report + spot-check ----
console.log('\n=== rxnorm_drug_class by system ===');
const [bySys] = await q('SELECT class_system, COUNT(*) cnt, COUNT(DISTINCT rxcui) ings FROM rxnorm_drug_class GROUP BY class_system');
for (const s of bySys) console.log(`  ${s.class_system.padEnd(14)} rows ${s.cnt}  ingredients ${s.ings}`);
console.log('\n=== allergen spot-check ===');
for (const d of ['amoxicillin', 'cephalexin', 'sulfamethoxazole', 'azithromycin', 'ciprofloxacin', 'ibuprofen', 'lisinopril']) {
  const [rows] = await q("SELECT class_system, class_name FROM rxnorm_drug_class WHERE LOWER(ingredient)=? ORDER BY class_system", [d]);
  console.log(`  ${d.padEnd(18)} ${rows.map((r) => `${r.class_system}:${r.class_name}`).join(' | ') || '(none)'}`);
}
await pool.end();
process.exit(0);
