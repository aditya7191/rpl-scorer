// Restart/durability test (no browser): scores via the API, hard-kills the server (SIGKILL, no graceful
// shutdown) right after each reply, restarts it and checks every acknowledged change survived and the
// admin cookie is still valid. Uses Postgres when DATABASE_URL is set, else the JSON file.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const H = require('./helpers.js');
const PORT = 8092, URL = 'http://localhost:' + PORT, PW = 'restart-pw-123';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpl-r-'));
const schema = H.testSchema();
let srv, pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

function start(extraEnv = {}) {
  return new Promise((res, rej) => {
    srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, RPL_ADMIN_PASSWORD: PW, RPL_DATA_DIR: dataDir, RPL_PG_SCHEMA: schema, SESSION_SECRET: 'sess-secret-xyz', ...extraEnv } });
    let out = '';
    srv.stdout.on('data', d => { out += d; if (/running/.test(out)) res(out); });
    srv.stderr.on('data', d => process.stderr.write(d));
    srv.on('exit', c => c && rej(new Error('server exit ' + c + ' ' + out)));
  });
}
const hardKill = () => new Promise(r => { srv.once('exit', r); srv.kill('SIGKILL'); });
let cookie = '';
async function api(p, body) {
  const r = await fetch(URL + p, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json() };
}

(async () => {
  console.log('Restart test storage:', H.usePg ? 'postgres (schema ' + schema + ')' : 'json file');
  const out = await start();
  ok(out.includes(H.usePg ? 'Storage: Postgres' : 'Storage: JSON file'), 'server uses expected backend: ' + out.split('\n')[0]);
  const hz = await api('/healthz?db=1');
  ok(hz.status === 200 && hz.body.ok && hz.body.db === 'up' && hz.body.storage === (H.usePg ? 'postgres' : 'json'), '/healthz?db=1 ok');
  ok((await api('/healthz')).status === 200, '/healthz ok');
  ok((await api('/api/live')).body === null, 'empty at start');
  ok((await api('/api/admin/login', { password: PW })).status === 200 && cookie.startsWith('rpl_admin='), 'login');
  const setup = { teamA: 'Lions', teamB: 'Tigers', playersA: ['A1', 'A2', 'A3'], playersB: ['B1', 'B2', 'B3'], overs: 2, tossWinner: 'A', tossChoice: 'bat' };
  const m1 = await api('/api/admin/match', { setup }); ok(m1.status === 200, 'match 1 created');
  await api('/api/admin/event', { event: { t: 'openers', striker: 'A1', nonStriker: 'A2', bowler: 'B1' } });
  await api('/api/admin/event', { event: { t: 'ball', kind: 'run', runs: 4 } });
  await hardKill(); await start();
  ok((await api('/api/admin/me')).body.admin === true, 'admin cookie still valid after restart');
  let live = (await api('/api/live')).body;
  ok(live && live.innings[0].runs === 4, 'runs survive SIGKILL restart (4)');
  // new match abandons the old one; both must survive
  const m2 = await api('/api/admin/match', { setup: { ...setup, teamA: 'Eagles' } }); ok(m2.status === 200, 'match 2 created');
  await api('/api/admin/event', { event: { t: 'openers', striker: 'A1', nonStriker: 'A2', bowler: 'B1' } });
  for (const r of [6, 1, 2]) await api('/api/admin/event', { event: { t: 'ball', kind: 'run', runs: r } });
  const u = await api('/api/admin/undo', {}); ok(u.status === 200 && u.body.innings[0].runs === 7, 'undo -> 7');
  const live0 = (await api('/api/live')).body;
  await hardKill(); await start();
  live = (await api('/api/live')).body;
  ok(live.setup.teamA === 'Eagles' && live.innings[0].runs === 7 && JSON.stringify(live) === JSON.stringify(live0), 'match 2 state identical after restart (undo kept)');
  const list = (await api('/api/matches')).body;
  ok(list.length === 2 && list[1].status === 'abandoned' && list[1].scores[0] === 'Lions 4/0 (0.1)', 'match list keeps abandoned match 1');
  // parallel requests are serialized: 5 taps in parallel all persist
  await Promise.all([1, 2, 3, 4].map(r => api('/api/admin/event', { event: { t: 'ball', kind: 'run', runs: r } })));
  const before = (await api('/api/live')).body;
  await hardKill(); await start();
  const after = (await api('/api/live')).body;
  ok(after.innings[0].runs === 7 + 10 && JSON.stringify(after) === JSON.stringify(before), 'parallel taps all saved (17 runs, 4 parallel) and survive restart');
  // without SESSION_SECRET, cookie is derived from password: still survives restarts
  await hardKill(); await start({ SESSION_SECRET: '' }); cookie = '';
  await api('/api/admin/login', { password: PW });
  await hardKill(); await start({ SESSION_SECRET: '' });
  ok((await api('/api/admin/me')).body.admin === true, 'fallback (password-derived) cookie secret survives restart');
  await hardKill(); await H.dropSchema(schema);
  console.log('RESTART TESTS PASSED:', pass);
})().catch(async e => { console.error('FAIL:', e.message); try { srv.kill('SIGKILL'); } catch (_) {} try { await H.dropSchema(schema); } catch (_) {} process.exit(1); });
