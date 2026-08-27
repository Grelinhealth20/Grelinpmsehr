import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * NPPES NPI Registry (CMS public API) lookup for SNF facilities.
 *
 * Accuracy first: the facility NPI is only returned on an UNAMBIGUOUS match
 * (a single exact-name match, or a single candidate). The address is only
 * returned when the candidate records AGREE on it. When the registry is
 * ambiguous (e.g. several related legal entities for one building), we return
 * whatever is certain and leave the rest blank rather than guess — so no
 * incorrect facility information is ever filled in.
 */
export const nppesEnabled = () => config.nppes.enabled;

const SUFFIX = /\b(LLC|INC|LP|LLP|LTD|PLLC|CORP|CO|PA|PC|THE|II|III)\b/g;

// Professional credentials and name suffixes NPPES stores SEPARATELY from the name —
// stripped from the tail of a provider name query so the surname isn't mistaken for one.
const CREDENTIAL_TOKENS = new Set([
  'MD', 'DO', 'MBBS', 'NP', 'APRN', 'PA', 'PAC', 'DDS', 'DMD', 'DPM', 'DC', 'OD', 'DNP',
  'CRNA', 'RN', 'LPN', 'PHD', 'PHARMD', 'PSYD', 'MSN', 'MPH', 'FNP', 'ANP', 'AGNP',
  'PMHNP', 'AGACNP', 'FACP', 'FAAP', 'MSW', 'LCSW', 'JR', 'SR', 'II', 'III', 'IV',
]);

function normName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
function titleCase(s) { return String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()); }
function locOf(r) { return (r.addresses || []).find((a) => a.address_purpose === 'LOCATION') || (r.addresses || [])[0] || null; }
function addrKey(a) { return a ? `${(a.address_1 || '').toUpperCase().trim()}|${(a.city || '').toUpperCase()}|${(a.state || '').toUpperCase()}|${(a.postal_code || '').slice(0, 5)}` : ''; }

/** Thrown when NPPES cannot be reached (network/egress/timeout) — distinct from an
 *  empty-but-successful result, so the UI can say "unreachable" not "no match". */
function unavailable(msg) { const e = new Error(msg); e.code = 'NPPES_UNAVAILABLE'; return e; }

async function query(params) {
  const url = `${config.nppes.baseUrl}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.nppes.timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!resp.ok) throw unavailable(`NPPES HTTP ${resp.status}`);
    const data = await resp.json();
    return Array.isArray(data.results) ? data.results : []; // 200 with 0 results = genuine no-match
  } catch (e) {
    if (e.code === 'NPPES_UNAVAILABLE') { logger.warn({ err: e.message }, 'NPPES unavailable'); throw e; }
    // Network error, DNS failure, timeout/abort — on AWS this usually means no outbound
    // egress from the task's subnet to npiregistry.cms.hhs.gov (NAT gateway / SG).
    logger.warn({ err: e.message, url: config.nppes.baseUrl }, 'NPPES unreachable (network/egress)');
    throw unavailable(`NPPES unreachable: ${e.message}`);
  } finally { clearTimeout(timer); }
}

// Extract the COMPLETE, accurate facility record from a raw NPPES result.
function mapFacility(r) {
  const b = r.basic || {};
  const loc = locOf(r);
  const mailing = (r.addresses || []).find((a) => a.address_purpose === 'MAILING') || null;
  const primaryTax = (r.taxonomies || []).find((t) => t.primary) || (r.taxonomies || [])[0] || null;
  const street = loc ? `${loc.address_1 || ''}${loc.address_2 ? ` ${loc.address_2}` : ''}`.trim() : '';
  const official = [b.authorized_official_first_name, b.authorized_official_last_name].filter(Boolean).join(' ').trim();
  return {
    npi: String(r.number || ''),
    name: titleCase(b.organization_name || ''),
    address: titleCase(street),
    city: titleCase(loc?.city || ''),
    state: String(loc?.state || '').toUpperCase(),
    zip: String(loc?.postal_code || '').slice(0, 5),
    phone: loc?.telephone_number || b.authorized_official_telephone_number || '',
    fax: loc?.fax_number || '',
    taxonomy: primaryTax?.desc || '',
    taxonomyCode: primaryTax?.code || '',
    licenseState: primaryTax?.state || '',
    authorizedOfficial: official ? `${official}${b.authorized_official_title_or_position ? `, ${b.authorized_official_title_or_position}` : ''}` : '',
    enumerationDate: b.enumeration_date || '',
    status: (b.status === 'A' ? 'active' : b.status === 'D' ? 'deactivated' : (b.status || '')),
    mailingAddress: mailing ? titleCase(`${mailing.address_1 || ''}${mailing.address_2 ? ` ${mailing.address_2}` : ''}, ${mailing.city || ''}, ${(mailing.state || '').toUpperCase()} ${(mailing.postal_code || '').slice(0, 5)}`.replace(/^,\s*|,\s*,/g, '').trim()) : '',
  };
}

/**
 * Search the NPPES registry by NPI or organization name and return the COMPLETE
 * details of each candidate (for a Super/Master admin to verify before saving).
 * Triggered as soon as an NPI (10 digits) or a name is entered.
 * @returns {Promise<Array<{npi,name,address,city,state,zip,phone,fax,taxonomy,...}>>}
 */
export async function searchFacilities({ q = '', npi = '', state = '', city = '', limit = 15 } = {}) {
  if (!config.nppes.enabled) return [];
  const cleanNpi = String(npi || '').replace(/\D/g, '');
  const base = { version: '2.1', enumeration_type: 'NPI-2', limit: String(Math.min(50, Math.max(1, limit))) };

  let results = [];
  if (cleanNpi.length === 10) {
    results = await query(new URLSearchParams({ ...base, number: cleanNpi }));
  } else {
    const cleanName = String(q || '').replace(/[.,]+$/, '').trim();
    if (cleanName.length < 3) return [];
    if (state) base.state = state;
    if (city) base.city = city;
    results = await query(new URLSearchParams({ ...base, organization_name: `${cleanName}*` }));
    if (!results.length) {
      const toks = normName(cleanName).split(' ').filter(Boolean).slice(0, 3).join(' ');
      if (toks) results = await query(new URLSearchParams({ ...base, organization_name: `${toks}*` }));
    }
  }
  return results.map(mapFacility).filter((f) => f.npi && f.name);
}

// Extract the COMPLETE, accurate INDIVIDUAL provider record (NPI-1) from a raw
// NPPES result — name, credential, and primary taxonomy (specialty + license).
function mapProvider(r) {
  const b = r.basic || {};
  const loc = locOf(r);
  const primaryTax = (r.taxonomies || []).find((t) => t.primary) || (r.taxonomies || [])[0] || null;
  const first = titleCase(b.first_name || '');
  const last = titleCase(b.last_name || '');
  const middle = titleCase(b.middle_name || '');
  const fullName = [first, middle, last].filter(Boolean).join(' ').trim();
  const street = loc ? `${loc.address_1 || ''}${loc.address_2 ? ` ${loc.address_2}` : ''}`.trim() : '';
  return {
    npi: String(r.number || ''),
    firstName: first,
    lastName: last,
    middleName: middle,
    fullName,
    // NPPES credential string, e.g. "MD", "M.D.", "DO", "NP". Split into clean tags.
    credential: String(b.credential || '').trim(),
    credentials: String(b.credential || '')
      .split(/[,/]/).map((c) => c.replace(/\./g, '').toUpperCase().trim()).filter(Boolean),
    taxonomy: primaryTax?.desc || '',
    taxonomyCode: primaryTax?.code || '',
    licenseNumber: primaryTax?.license || '',
    licenseState: primaryTax?.state || '',
    gender: b.gender || '',
    soleProprietor: b.sole_proprietor || '',
    enumerationDate: b.enumeration_date || '',
    status: (b.status === 'A' ? 'active' : b.status === 'D' ? 'deactivated' : (b.status || '')),
    address: titleCase(street),
    city: titleCase(loc?.city || ''),
    state: String(loc?.state || '').toUpperCase(),
    zip: String(loc?.postal_code || '').slice(0, 5),
  };
}

/**
 * Search the NPPES registry for an INDIVIDUAL provider (NPI-1) by NPI or name and
 * return the COMPLETE details of each candidate (for a Super/Master admin to verify
 * before saving). Name search accepts "First Last" or a single last name; a state
 * filter narrows results. Triggered as soon as an NPI (10 digits) or a name is typed.
 */
export async function searchProviders({ q = '', npi = '', state = '', limit = 15 } = {}) {
  if (!config.nppes.enabled) return [];
  const cleanNpi = String(npi || '').replace(/\D/g, '');
  const base = { version: '2.1', enumeration_type: 'NPI-1', limit: String(Math.min(50, Math.max(1, limit))) };

  let results = [];
  if (cleanNpi.length === 10) {
    results = await query(new URLSearchParams({ ...base, number: cleanNpi }));
  } else {
    // Drop periods WITHIN tokens ("M.D." → "MD") and treat commas as separators, so a
    // typed credential collapses to a single recognizable token instead of splitting.
    const clean = String(q || '').replace(/\./g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length < 2) return [];
    if (state) base.state = state;
    let toks = clean.split(/\s+/).filter(Boolean);
    // NPPES stores the name and the professional credential SEPARATELY, so strip any
    // trailing credential/suffix tokens a user typed (e.g. "Jenakan Jeramian Dev MD" →
    // surname is "Dev", not "MD"). Only strip from the end, and never the last remaining
    // token, so a real surname is never removed.
    while (toks.length > 1 && CREDENTIAL_TOKENS.has(toks[toks.length - 1].toUpperCase())) toks.pop();
    const params = { ...base };
    if (toks.length >= 2) {
      // "First Last" (or more) — first token → first name, last token → last name.
      params.first_name = `${toks[0]}*`;
      params.last_name = `${toks[toks.length - 1]}*`;
    } else {
      // Single token — match it as a last name (most selective for providers).
      params.last_name = `${toks[0]}*`;
    }
    results = await query(new URLSearchParams(params));
    // Fallback: a single token might be a first name — retry that way.
    if (!results.length && toks.length === 1) {
      results = await query(new URLSearchParams({ ...base, first_name: `${toks[0]}*` }));
    }
  }
  return results.map(mapProvider).filter((p) => p.npi && (p.lastName || p.firstName));
}

/**
 * @returns {Promise<null | {npi?, address?, city?, state?, zip?}>}
 */
export async function lookupFacility({ name, city, state }) {
  if (!config.nppes.enabled) return null;
  const cleanName = String(name || '').replace(/[.,]+$/, '').trim();
  // Require a geographic anchor (state or city) so a name can't match the wrong
  // facility in another part of the country.
  if (cleanName.length < 3 || (!state && !city)) return null;

  const base = { version: '2.1', enumeration_type: 'NPI-2', limit: '50' };
  if (state) base.state = state;
  if (city) base.city = city;

  // Best-effort auto-fill: a registry outage must never block facility creation,
  // so treat "unreachable" as "no match" here (unlike the explicit search endpoints).
  const safe = (p) => query(p).catch(() => []);
  let results = await safe(new URLSearchParams({ ...base, organization_name: `${cleanName}*` }));
  if (!results.length) {
    // Fallback: first significant tokens only (handles trailing OCR noise).
    const toks = normName(cleanName).split(' ').filter(Boolean).slice(0, 3).join(' ');
    if (toks && toks !== normName(cleanName)) results = await safe(new URLSearchParams({ ...base, organization_name: `${toks}*` }));
  }
  if (!results.length) return null;

  const target = normName(cleanName);
  const targetTokens = new Set(target.split(' ').filter(Boolean));
  const scored = results.map((r) => {
    const orgN = normName(r.basic?.organization_name);
    let score = 0;
    if (orgN === target) score = 100;
    else if (orgN && (orgN.startsWith(target) || target.startsWith(orgN) || orgN.includes(target) || target.includes(orgN))) score = 85;
    else {
      const b = orgN.split(' ').filter(Boolean);
      const common = b.filter((t) => targetTokens.has(t)).length;
      score = targetTokens.size ? (common / Math.max(targetTokens.size, b.length)) * 80 : 0;
    }
    const loc = locOf(r);
    if (state && loc?.state && loc.state.toUpperCase() !== state.toUpperCase()) score -= 60;
    if (city && loc?.city && loc.city.toUpperCase() !== String(city).toUpperCase()) score -= 15;
    return { r, orgN, score, loc };
  }).filter((x) => x.score >= 70).sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  // NPI only when unambiguous: exactly one exact-name match, or one candidate.
  const exact = scored.filter((x) => x.orgN === target);
  let npi = '';
  if (exact.length === 1) npi = String(exact[0].r.number || '');
  else if (scored.length === 1) npi = String(scored[0].r.number || '');

  // Address: use the chosen NPI's address; else consensus across candidates.
  let loc = null;
  if (npi) loc = (scored.find((x) => String(x.r.number) === npi) || {}).loc || null;
  else {
    const locs = scored.map((x) => x.loc).filter(Boolean);
    const keys = new Set(locs.map(addrKey));
    if (keys.size === 1 && locs.length) loc = locs[0];
  }

  if (!npi && !loc) return null;
  const out = {};
  if (npi) out.npi = npi;
  if (loc) {
    const street = `${loc.address_1 || ''}${loc.address_2 ? ` ${loc.address_2}` : ''}`.trim();
    if (street) out.address = titleCase(street);
    if (loc.city) out.city = titleCase(loc.city);
    if (loc.state) out.state = String(loc.state).toUpperCase();
    if (loc.postal_code) out.zip = String(loc.postal_code).slice(0, 5);
  }
  return out;
}
