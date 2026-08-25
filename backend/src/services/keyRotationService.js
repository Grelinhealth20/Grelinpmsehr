import crypto from 'crypto';
import { execute } from '../db/pool.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Automatic, cluster-safe key rotation. Every `rotateSeconds` (default 40 min) the
 * JWT access/refresh signing secrets and the gateway internal key are rotated and
 * persisted to the single `security_keyring` row.
 *
 * Zero-disruption guarantees:
 *  - SIGN with the newest secret; VERIFY against the whole ring — a token minted
 *    before a rotation keeps verifying until it naturally expires.
 *  - The ring is sized to each token's TTL, so pruning never orphans a live token.
 *  - The ring is persisted, so a restart restores the exact accepted secrets.
 *  - The env secrets remain permanently accepted for verification (tooling / back-compat).
 *
 * Cluster-safe:
 *  - Every instance RELOADS the ring from the DB each tick, so all instances converge
 *    on the same accepted secrets and always sign with a persisted secret.
 *  - Rotation is a compare-and-swap UPDATE guarded by `rotated_at`, so exactly ONE
 *    instance rotates per interval; the rest simply adopt the persisted result.
 */

const nowSec = () => Math.floor(Date.now() / 1000);
const mint = () => crypto.randomBytes(48).toString('hex');
const ROTATE_S = Math.max(60, config.jwt.rotateSeconds || 2400);
// Reload/rotation check cadence — frequent enough that non-winners converge quickly,
// but capped so we don't hammer the DB. Bounded to the rotation window.
const TICK_MS = Math.min(ROTATE_S, 60) * 1000;

let ring = null; // { access:[{k,t}], refresh:[{k,t}], internal:[{k,t}] } newest-first
let timer = null;

function caps() {
  return {
    // +2 slots of headroom so a token minted right before a rotation is always covered.
    access: Math.max(2, Math.ceil(config.jwt.accessTtl / ROTATE_S) + 2),
    refresh: Math.max(2, Math.ceil(config.jwt.refreshTtl / ROTATE_S) + 2),
    internal: 4,
  };
}

function seedRing() {
  const t = nowSec();
  return { access: [{ k: mint(), t }], refresh: [{ k: mint(), t }], internal: [{ k: mint(), t }] };
}

// mysql2 auto-parses JSON columns to JS values, but a driver/version may hand back
// the raw string — accept either so the persisted ring always loads.
const asRing = (v) => {
  const parsed = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(parsed) && parsed.length ? parsed : null;
};

/** Insert/replace the whole row (used for the initial seed and forced rotation). */
async function persist() {
  await execute(
    `INSERT INTO security_keyring (id, access_ring, refresh_ring, internal_ring, rotated_at)
       VALUES (1, :a, :r, :i, NOW())
     ON DUPLICATE KEY UPDATE access_ring = :a, refresh_ring = :r, internal_ring = :i, rotated_at = NOW()`,
    { a: JSON.stringify(ring.access), r: JSON.stringify(ring.refresh), i: JSON.stringify(ring.internal) },
  );
}

/** Adopt the persisted ring (converge with whatever instance last rotated). */
async function loadFromDb() {
  const [rows] = await execute('SELECT access_ring, refresh_ring, internal_ring FROM security_keyring WHERE id = 1');
  if (!rows[0]) return false;
  const a = asRing(rows[0].access_ring);
  const r = asRing(rows[0].refresh_ring);
  const i = asRing(rows[0].internal_ring);
  if (a && r && i) { ring = { access: a, refresh: r, internal: i }; return true; }
  return false;
}

/** Load/seed the ring and start the tick. Safe to call once on boot. */
export async function initKeyRotation() {
  try {
    if (!(await loadFromDb())) { ring = seedRing(); await persist(); }
  } catch (err) {
    // Never block boot on key rotation; env secrets stay valid regardless.
    logger.error({ err: err.message }, 'Key rotation init failed — using in-memory ring');
    ring = ring || seedRing();
  }
  if (!timer) {
    timer = setInterval(() => { tick().catch((e) => logger.error({ err: e.message }, 'Key rotation tick failed')); }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  return ring;
}

async function tick() {
  try { await loadFromDb(); } catch { /* keep current ring */ }
  await maybeRotate();
}

/**
 * Rotate iff due. Compare-and-swap on `rotated_at`: only the instance whose UPDATE
 * matches (rotated_at old enough) actually rotates; others get affectedRows=0 and
 * simply keep the ring they just reloaded. We only ever adopt a secret we persisted,
 * so no instance signs with a secret another instance would reject.
 */
async function maybeRotate() {
  if (!ring) return;
  const c = caps();
  const t = nowSec();
  const next = {
    access: [{ k: mint(), t }, ...ring.access].slice(0, c.access),
    refresh: [{ k: mint(), t }, ...ring.refresh].slice(0, c.refresh),
    internal: [{ k: mint(), t }, ...ring.internal].slice(0, c.internal),
  };
  try {
    const [res] = await execute(
      `UPDATE security_keyring
          SET access_ring = :a, refresh_ring = :r, internal_ring = :i, rotated_at = NOW()
        WHERE id = 1 AND rotated_at <= (NOW() - INTERVAL :ttl SECOND)`,
      { a: JSON.stringify(next.access), r: JSON.stringify(next.refresh), i: JSON.stringify(next.internal), ttl: ROTATE_S },
    );
    if (res.affectedRows === 1) { ring = next; logger.info('Security keys rotated'); }
    else { await loadFromDb().catch(() => {}); } // another instance rotated, or not due
  } catch (err) {
    logger.error({ err: err.message }, 'Key rotation CAS failed');
  }
}

/** Force a rotation now (used by tests and any manual trigger). */
export async function rotate() {
  if (!ring) { await initKeyRotation(); return ring; }
  const c = caps();
  const t = nowSec();
  ring.access = [{ k: mint(), t }, ...ring.access].slice(0, c.access);
  ring.refresh = [{ k: mint(), t }, ...ring.refresh].slice(0, c.refresh);
  ring.internal = [{ k: mint(), t }, ...ring.internal].slice(0, c.internal);
  try { await persist(); } catch (err) { logger.error({ err: err.message }, 'Key ring persist failed'); }
  return ring;
}

export function stopKeyRotation() { if (timer) { clearInterval(timer); timer = null; } }

// --- Accessors: SIGN with the newest; VERIFY against the ring + permanent env secret.
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

export function activeAccessSecret() { return ring?.access?.[0]?.k || config.jwt.accessSecret; }
export function accessSecrets() { return uniq([...(ring?.access?.map((e) => e.k) || []), config.jwt.accessSecret]); }

export function activeRefreshSecret() { return ring?.refresh?.[0]?.k || config.jwt.refreshSecret; }
export function refreshSecrets() { return uniq([...(ring?.refresh?.map((e) => e.k) || []), config.jwt.refreshSecret]); }

export function activeInternalKey() { return ring?.internal?.[0]?.k || config.api.internalKey || ''; }
export function internalKeys() { return uniq([...(ring?.internal?.map((e) => e.k) || []), config.api.internalKey]); }
