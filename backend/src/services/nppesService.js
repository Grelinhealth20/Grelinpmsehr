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

function normName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
function titleCase(s) { return String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()); }
function locOf(r) { return (r.addresses || []).find((a) => a.address_purpose === 'LOCATION') || (r.addresses || [])[0] || null; }
function addrKey(a) { return a ? `${(a.address_1 || '').toUpperCase().trim()}|${(a.city || '').toUpperCase()}|${(a.state || '').toUpperCase()}|${(a.postal_code || '').slice(0, 5)}` : ''; }

async function query(params) {
  const url = `${config.nppes.baseUrl}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.nppes.timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (e) {
    logger.warn({ err: e.message }, 'NPPES query failed');
    return [];
  } finally { clearTimeout(timer); }
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

  let results = await query(new URLSearchParams({ ...base, organization_name: `${cleanName}*` }));
  if (!results.length) {
    // Fallback: first significant tokens only (handles trailing OCR noise).
    const toks = normName(cleanName).split(' ').filter(Boolean).slice(0, 3).join(' ');
    if (toks && toks !== normName(cleanName)) results = await query(new URLSearchParams({ ...base, organization_name: `${toks}*` }));
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
