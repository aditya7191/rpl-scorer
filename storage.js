'use strict';
// Storage backends. Both keep the same shape: { currentId, matches: [match...] }.
//   - Postgres (when DATABASE_URL is set): one row per match (full event log + setup + MoM as JSONB),
//     plus a tiny meta table holding the current match id. Tables are created on startup.
//   - JSON file (fallback for local dev/tests): data/db.json, written atomically with fsync.
// commit(next, changed, deletedIds) resolves only after the data is durably stored, so the server
// replies after the write. deletedIds (optional) lists match ids to remove permanently.
//
// Team registration uses the same backend:
//   regLoad()            -> { teams: [...], settings: {...}|null, counters: {...} }
//   regCommit(op)        op = { teams: [team to insert/update], deleteTeamIds: [], images: [{ id, mime, data }],
//                               deleteImageIds: [], settings?, counters? } - all in one transaction (Postgres)
//   getImage(id)         -> { mime, data } | null
// Postgres: tables rpl_teams (one row per team, JSONB, unique (year, name_key)) and rpl_images (BYTEA).
// Uploaded screenshots / QR live in the database, never on local disk (Render's disk is wiped on restart).
// JSON fallback (local dev/tests only): data/registrations.json + data/images/<id>.
const fs = require('fs');
const path = require('path');

function jsonStore(dataDir) {
  const file = path.join(dataDir, 'db.json');
  const regFile = path.join(dataDir, 'registrations.json');
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
    async regLoad() {
      fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
      try {
        const j = JSON.parse(fs.readFileSync(regFile, 'utf8'));
        return { teams: j.teams || [], settings: j.settings || null, counters: j.counters || {} };
      } catch (e) {
        if (e.code !== 'ENOENT') throw new Error('Cannot read ' + regFile + ': ' + e.message);
        return { teams: [], settings: null, counters: {} };
      }
    },
    async regCommit(op) {
      // images first (so the JSON never points to a missing file), then the JSON, then remove old images
      for (const im of op.images || []) writeDurable(imgPath(im.id), JSON.stringify({ mime: im.mime }) + '\n' + im.data.toString('base64'));
      let cur = { teams: [], settings: null, counters: {} };
      try { cur = JSON.parse(fs.readFileSync(regFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const gone = new Set(op.deleteTeamIds || []);
      const byId = new Map((op.teams || []).map(t => [t.id, t]));
      const teams = (cur.teams || []).filter(t => !gone.has(t.id)).map(t => byId.get(t.id) || t);
      for (const t of op.teams || []) if (!teams.some(x => x.id === t.id)) teams.push(t);
      const next = { teams, settings: op.settings !== undefined ? op.settings : cur.settings || null, counters: op.counters !== undefined ? op.counters : cur.counters || {} };
      writeDurable(regFile, JSON.stringify(next));
      for (const id of op.deleteImageIds || []) { try { fs.unlinkSync(imgPath(id)); } catch (_) {} }
    },
    async getImage(id) {
      try {
        const raw = fs.readFileSync(imgPath(id), 'utf8'); const i = raw.indexOf('\n');
        return { mime: JSON.parse(raw.slice(0, i)).mime, data: Buffer.from(raw.slice(i + 1), 'base64') };
      } catch (e) { return null; }
    },
  };
  function imgPath(id) { if (!/^[a-z0-9]{8,64}$/.test(id)) throw new Error('bad image id'); return path.join(dataDir, 'images', id); }
  function writeDurable(f, content) {
    const tmp = f + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
    try { const d = fs.openSync(path.dirname(f), 'r'); fs.fsyncSync(d); fs.closeSync(d); } catch (_) { /* best effort */ }
  }
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
            await c.query(`CREATE TABLE IF NOT EXISTS ${T('rpl_teams')} (
              id TEXT PRIMARY KEY,
              year INT NOT NULL,
              name_key TEXT NOT NULL,
              token TEXT NOT NULL UNIQUE,
              created TIMESTAMPTZ NOT NULL,
              data JSONB NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              UNIQUE (year, name_key))`);
            await c.query(`CREATE TABLE IF NOT EXISTS ${T('rpl_images')} (
              id TEXT PRIMARY KEY,
              mime TEXT NOT NULL,
              bytes INT NOT NULL,
              data BYTEA NOT NULL,
              created TIMESTAMPTZ NOT NULL DEFAULT now())`);
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
    async regLoad() {
      return withRetry(async () => {
        const teams = (await pool.query(`SELECT data FROM ${T('rpl_teams')} ORDER BY created, id`)).rows.map(r => r.data);
        const meta = (await pool.query(`SELECT key, value FROM ${T('rpl_meta')} WHERE key IN ('regSettings', 'regCounters')`)).rows;
        const get = (k) => { const r = meta.find(x => x.key === k); return r ? r.value : null; };
        return { teams, settings: get('regSettings'), counters: get('regCounters') || {} };
      });
    },
    async regCommit(op) {
      return withRetry(async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          for (const im of op.images || []) {
            await c.query(`INSERT INTO ${T('rpl_images')} (id, mime, bytes, data) VALUES ($1, $2, $3, $4)
              ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, data = EXCLUDED.data`, [im.id, im.mime, im.data.length, im.data]);
          }
          if ((op.deleteTeamIds || []).length) await c.query(`DELETE FROM ${T('rpl_teams')} WHERE id = ANY($1::text[])`, [op.deleteTeamIds]);
          for (const t of op.teams || []) {
            await c.query(`INSERT INTO ${T('rpl_teams')} (id, year, name_key, token, created, data, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
              ON CONFLICT (id) DO UPDATE SET year = EXCLUDED.year, name_key = EXCLUDED.name_key, token = EXCLUDED.token, data = EXCLUDED.data, updated_at = now()`,
            [t.id, t.year, t.nameKey, t.token, t.created, JSON.stringify(t)]);
          }
          if ((op.deleteImageIds || []).length) await c.query(`DELETE FROM ${T('rpl_images')} WHERE id = ANY($1::text[])`, [op.deleteImageIds]);
          for (const [k, v] of [['regSettings', op.settings], ['regCounters', op.counters]]) {
            if (v === undefined) continue;
            await c.query(`INSERT INTO ${T('rpl_meta')} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, JSON.stringify(v)]);
          }
          await c.query('COMMIT');
        } catch (e) {
          try { await c.query('ROLLBACK'); } catch (_) {}
          throw e;
        } finally { c.release(); }
      });
    },
    async getImage(id) {
      return withRetry(async () => {
        const r = (await pool.query(`SELECT mime, data FROM ${T('rpl_images')} WHERE id = $1`, [id])).rows[0];
        return r ? { mime: r.mime, data: r.data } : null;
      });
    },
    async close() { await pool.end(); },
    _pool: pool,
  };
}

function createStore(env = process.env, defaultDataDir) {
  if (env.DATABASE_URL) return pgStore(env.DATABASE_URL, env);
  return jsonStore(env.RPL_DATA_DIR || defaultDataDir);
}

module.exports = { createStore, jsonStore, pgStore, pgConfig };
