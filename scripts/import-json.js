// One-time copy of a local data/db.json into Postgres (e.g. your Neon database).
// Usage: DATABASE_URL='postgresql://...' node scripts/import-json.js [path/to/db.json]
// Upserts every match by id (safe to run twice) and sets the current match.
const fs = require('fs'), path = require('path');
const { createStore } = require('../storage.js');
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
const file = process.argv[2] || path.join(__dirname, '..', 'data', 'db.json');
const src = JSON.parse(fs.readFileSync(file, 'utf8'));
(async () => {
  const store = createStore(process.env);
  const existing = await store.init();
  const byId = new Map(existing.matches.map(m => [m.id, m]));
  for (const m of src.matches) byId.set(m.id, m);
  const next = { currentId: src.currentId || existing.currentId || null, matches: [...byId.values()] };
  await store.commit(next, src.matches);
  console.log('Imported ' + src.matches.length + ' match(es) from ' + file + ' into ' + store.describe() + '. Current match: ' + next.currentId);
  await store.close();
})().catch(e => { console.error('Import failed:', e.message); process.exit(1); });
