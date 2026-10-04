// Shared test helpers. When DATABASE_URL is set, every test run uses its own throw-away
// Postgres schema (never touches existing tables) and drops it at the end.
const crypto = require('crypto');
const usePg = !!process.env.DATABASE_URL;
function testSchema() { return 'rpl_test_' + crypto.randomBytes(4).toString('hex'); }
async function dropSchema(schema) {
  if (!usePg || !/^rpl_test_[0-9a-f]+$/.test(schema)) return;
  const { pgConfig } = require('../storage.js');
  const { Client } = require('pg');
  const c = new Client(pgConfig(process.env.DATABASE_URL, process.env));
  await c.connect();
  try { await c.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); } finally { await c.end(); }
}
module.exports = { usePg, testSchema, dropSchema };
