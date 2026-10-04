'use strict';
// Storage backends. Both keep the same shape: { currentId, matches: [match...] }.
//   - Postgres (when DATABASE_URL is set): one row per match (full event log + setup + MoM as JSONB),
//     plus a tiny meta table holding the current match id. Tables are created on startup.
//   - JSON file (fallback for local dev/tests): data/db.json, written atomically with fsync.
// commit(next, changed, deletedIds) resolves only after the data is durably stored, so the server
// replies after the write. deletedIds (optional) lists match ids to remove permanently.
const fs = require('fs');
const path = require('path');

function jsonStore(dataDir) {
  const file = path.join(dataDir, 'db.json');
  return {
    kind: 'json',
    describe: () => 'JSON file ' + file,
    async init() {
      fs.mkdirSync(dataDir, { recursive: true });
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') throw new Error('Cannot read ' + file + ': ' + e.message);
        return { currentId: null, matches: [] };
      }
    },
    async commit(next /*, changed, deletedIds */) {
      const tmp = file + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      try { const d = fs.openSync(dataDir, 'r'); fs.fsyncSync(d); fs.closeSync(d); } catch (_) { /* best effort */ }
    },
    async ping() { return true; },
    async close() {},
  };
}

// Decide SSL: required for remote hosts (Neon). Disabled for localhost or when DATABASE_SSL=false/disable.
function pgConfig(url, env) {
  const u = new URL(url);
  const mode = (u.searchParams.get('sslmode') || env.DATABASE_SSL || '').toLowerCase();
  // We set ssl ourselves; remove URL ssl params so they do not override our setting.
  for (const k of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'channel_binding']) u.searchParams.delete(k);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(u.hostname) || u.hostname.startsWith('/');
  const off = ['disable', 'false', '0', 'off', 'no'].includes(mode) || (local && !['require', 'verify-full', 'true'].includes(mode));
  return {
    connectionString: u.toString(),
    ssl: off ? false : { rejectUnauthorized: env.DATABASE_SSL_NO_VERIFY !== '1' },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000, // Neon free compute may need a few seconds to wake up
    keepAlive: true,
  };
}

function pgStore(url, env) {
  const { Pool } = require('pg');
  const schema = env.RPL_PG_SCHEMA || 'public';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Bad RPL_PG_SCHEMA');
  const cfg = pgConfig(url, env);
  const pool = new Pool(cfg);
  // Neon closes idle connections when it suspends; do not crash on that.
  pool.on('error', (e) => console.error('postgres idle client error (will reconnect):', e.message));
  const T = (name) => '"' + schema + '"."' + name + '"';
  const host = new URL(cfg.connectionString).hostname;

  async function withRetry(fn) {
    // one retry for transient connection drops (e.g. compute was suspended)
    try { return await fn(); } catch (e) {
      if (!/terminat|ECONNRESET|Connection|timeout|EPIPE|57P01/i.test(String(e.code) + ' ' + e.message)) throw e;
      console.error('postgres error, retrying once:', e.message);
      return fn();
    }
  }

  return {
    kind: 'postgres',
    describe: () => 'Postgres ' + host + (cfg.ssl ? ' (SSL)' : ' (no SSL)') + (schema !== 'public' ? ' schema ' + schema : ''),
    async init() {
      return withRetry(async () => {
        const c = await pool.connect();
        try {
          await c.query('SELECT pg_advisory_lock(727274)'); // avoid races if two copies start at once
          try {
            if (schema !== 'public') await c.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
            await c.query(`CREATE TABLE IF NOT EXISTS ${T('rpl_matches')} (
              id TEXT PRIMARY KEY,
              created TIMESTAMPTZ NOT NULL,
              data JSONB NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
            await c.query(`CREATE TABLE IF NOT EXISTS ${T('rpl_meta')} (key TEXT PRIMARY KEY, value JSONB)`);
          } finally { await c.query('SELECT pg_advisory_unlock(727274)'); }
          const rows = (await c.query(`SELECT data FROM ${T('rpl_matches')} ORDER BY created, id`)).rows;
          const meta = (await c.query(`SELECT value FROM ${T('rpl_meta')} WHERE key = 'currentId'`)).rows[0];
          return { currentId: meta ? meta.value : null, matches: rows.map(r => r.data) };
        } finally { c.release(); }
      });
    },
    async commit(next, changed, deletedIds = []) {
      return withRetry(async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          if (deletedIds.length) await c.query(`DELETE FROM ${T('rpl_matches')} WHERE id = ANY($1::text[])`, [deletedIds]);
          for (const m of changed) {
            await c.query(`INSERT INTO ${T('rpl_matches')} (id, created, data, updated_at) VALUES ($1, $2, $3, now())
              ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [m.id, m.created, JSON.stringify(m)]);
          }
          await c.query(`INSERT INTO ${T('rpl_meta')} (key, value) VALUES ('currentId', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next.currentId)]);
          await c.query('COMMIT'); // Postgres has fsync'd the WAL when COMMIT returns
        } catch (e) {
          try { await c.query('ROLLBACK'); } catch (_) {}
          throw e;
        } finally { c.release(); }
      });
    },
    async ping() { await withRetry(() => pool.query('SELECT 1')); return true; },
    async close() { await pool.end(); },
    _pool: pool,
  };
}

function createStore(env = process.env, defaultDataDir) {
  if (env.DATABASE_URL) return pgStore(env.DATABASE_URL, env);
  return jsonStore(env.RPL_DATA_DIR || defaultDataDir);
}

module.exports = { createStore, jsonStore, pgStore, pgConfig };
