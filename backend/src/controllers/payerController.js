import { searchPayers, upsertPayers } from '../services/payerDirectoryService.js';
import { searchPayersLive } from '../services/stediService.js';

/**
 * Typeahead search over the Stedi payer network for the face-sheet Payer picker.
 *
 * DB-FIRST + LIVE PAYER-SEARCH AUGMENTATION. The local Stedi payer dataset (fast,
 * deterministic, offline) answers every keystroke. When the local match is thin — no
 * eligibility-supported hit, or few results — we ALSO query the live Stedi Payer
 * Network API (a reference-data lookup, NOT the eligibility API) and merge the two
 * (deduped by Stedi ID, eligibility-supported first), then upsert the live rows into
 * the directory so the next identical search is instant. Shorthand like "UHC" or a
 * brand-new payer resolves in real time without slowing the common case.
 */
export async function search(req, res, next) {
  try {
    const q = (req.query.q || '').toString().slice(0, 80).trim();
    const limit = 10;
    const local = await searchPayers(q, { limit });

    // Local is "strong enough" when it already returns an eligibility-supported payer
    // and a few options — then skip the live call entirely (fast path).
    const hasSupported = local.some((p) => p.eligibilitySupported);
    const strong = hasSupported && local.length >= 3;

    if (q.length < 2 || strong) return res.json({ payers: local.slice(0, limit) });

    // Augment with the live Stedi PAYER-SEARCH API (best-effort; never fails the
    // request). This is the payer directory lookup, not the eligibility check.
    const live = await searchPayersLive(q, { limit });

    // Merge, dedupe by Stedi ID (local wins for display), eligibility-supported first.
    const byId = new Map();
    for (const p of [...local, ...live]) {
      if (!p.stediId) continue;
      if (!byId.has(p.stediId)) byId.set(p.stediId, { stediId: p.stediId, primaryPayerId: p.primaryPayerId || null, name: p.name, eligibilitySupported: !!p.eligibilitySupported });
    }
    const merged = [...byId.values()]
      .sort((a, b) => (Number(b.eligibilitySupported) - Number(a.eligibilitySupported)) || a.name.length - b.name.length)
      .slice(0, limit);

    // Self-heal the directory with any NEW payers the live search surfaced (fire and
    // forget — a cache write must never delay or fail the provider's search).
    const localIds = new Set(local.map((p) => p.stediId));
    const fresh = live.filter((p) => p.stediId && !localIds.has(p.stediId));
    if (fresh.length) {
      const rows = fresh.map((p) => [p.stediId, p.primaryPayerId, p.name, p._raw?.names || '', p._raw?.aliases || '', p.eligibilitySupported ? 1 : 0, p._raw?.coverageTypes || '', p._raw?.operatingStates || '']);
      upsertPayers(rows).catch(() => {});
    }

    res.json({ payers: merged });
  } catch (err) { next(err); }
}
