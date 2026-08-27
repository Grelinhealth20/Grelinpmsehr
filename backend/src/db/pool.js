import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Build the MySQL TLS options. When a pinned DB CA is configured we verify the
 * server's chain against it (rejectUnauthorized) and skip only the HOSTNAME check —
 * MySQL's auto-generated server cert carries a fixed CN, not the host/IP, so identity
 * is anchored by the pinned CA instead. Without a CA we fall back to the configured
 * rejectUnauthorized (system roots). TLS 1.2 is the floor.
 */
function buildDbSsl() {
  if (!config.db.ssl) return undefined;
  const opts = { minVersion: 'TLSv1.2', rejectUnauthorized: config.db.sslRejectUnauthorized };
  if (config.db.sslCa) {
    try {
      opts.ca = fs.readFileSync(config.db.sslCa);
      opts.rejectUnauthorized = true; // pinned CA → always verify the chain
      opts.checkServerIdentity = () => undefined; // CN is not the host; CA pinning is the anchor
    } catch (err) {
      logger.warn({ err: err.message, ca: config.db.sslCa }, 'DB CA not readable — TLS without pinned verification');
    }
  }
  return opts;
}

/**
 * Single shared connection pool. Parameterized queries only (mysql2 prepared
 * statements) — never string-concatenate SQL, which protects against SQL
 * injection (VAPT / OWASP A03).
 */
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true, // queue instead of erroring when all connections are busy
  connectionLimit: config.db.connectionLimit,
  // Keep a warm pool (up to half the limit) so bursty hospital traffic doesn't
  // pay connection-setup latency on every request; recycle the rest after 60s.
  maxIdle: Math.max(4, Math.floor(config.db.connectionLimit / 2)),
  idleTimeout: 60000,
  queueLimit: 0, // unbounded fair queue under load (back-pressure, never drop)
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000, // TCP keepalive so idle sockets aren't dropped
  connectTimeout: 15000,
  namedPlaceholders: true,
  ssl: buildDbSsl(),
});

// Swallow async pool-level socket errors (e.g. a remote-closed idle connection)
// so a dead pooled socket never crashes the process — the pool re-establishes.
pool.on('error', (err) => {
  logger.warn({ code: err?.code, msg: err?.message }, 'MySQL pool connection error (auto-recovering)');
});

const TRANSIENT = new Set(['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED']);

/**
 * execute() with a single automatic retry on transient connection errors, so a
 * stale pooled socket surfaces as a brief retry instead of a 500. All app
 * queries go through this.
 */
export async function execute(sql, params = {}) {
  try {
    const [rows] = await pool.execute(sql, params);
    return [rows];
  } catch (err) {
    if (TRANSIENT.has(err?.code)) {
      logger.warn({ code: err.code }, 'Transient DB error — retrying once');
      const [rows] = await pool.execute(sql, params);
      return [rows];
    }
    throw err;
  }
}

/**
 * Run `fn` inside a single transaction on one pooled connection. `fn` receives a
 * scoped `exec(sql, params)` bound to that connection (so `SELECT ... FOR UPDATE`
 * row locks taken inside are honored by the same transaction). Commits on success,
 * rolls back on any throw. Used to serialize read-modify-write of a patient row.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const exec = async (sql, params = {}) => { const [rows] = await conn.execute(sql, params); return [rows]; };
    const result = await fn(exec);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function assertDbConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    let cipher = null;
    try { const [r] = await conn.query("SHOW STATUS LIKE 'Ssl_cipher'"); cipher = r[0]?.Value || null; } catch { /* ignore */ }
    logger.info(
      { host: config.db.host, db: config.db.database, tls: cipher ? `on (${cipher})` : 'off' },
      'Database connection established',
    );
  } finally {
    conn.release();
  }
}

/** Convenience helper: run a query and return rows. */
export async function query(sql, params = {}) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}
