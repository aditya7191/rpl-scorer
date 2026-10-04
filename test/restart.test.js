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
async function del(id, opts = {}) {
  const headers = { cookie: opts.cookie === undefined ? cookie : opts.cookie };
  if (opts.json !== false) headers['Content-Type'] = 'application/json';
  const r = await fetch(URL + '/api/admin/matches/' + encodeURIComponent(id), { method: 'DELETE', headers, body: opts.json === false ? undefined : '{}' });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// Read SSE events from /api/stream until `until(events)` is true.
async function sseCollect(trigger, until, ms = 5000) {
  const ac = new AbortController(); const events = [];
  const r = await fetch(URL + '/api/stream', { signal: ac.signal });
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  const timer = setTimeout(() => ac.abort(), ms);
  let started = false;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (chunk.match(/^event: (.*)$/m) || [])[1], data = (chunk.match(/^data: (.*)$/m) || [])[1];
        if (ev) events.push({ ev, data: JSON.parse(data) });
      }
      if (!started && events.length) { started = true; events.length = 0; trigger(); }
      if (started && until(events)) break;
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); ac.abort(); }
  return events;
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
  // ---- delete match ----
  const m1id = list[1].id, m2id = list[0].id;
  ok((await del(m1id, { cookie: '' })).status === 401, 'delete without login rejected (401)');
  ok((await del(m1id, { cookie: 'rpl_admin=123.abc' })).status === 401, 'delete with forged cookie rejected (401)');
  ok((await del(m1id, { json: false })).status === 415, 'delete without JSON content type rejected (415, CSRF guard)');
  ok((await api('/api/matches')).body.length === 2, 'rejected deletes changed nothing');
  ok((await del('no-such-match')).status === 404, 'delete unknown match -> 404');
  let dres, dp;
  const ev1 = await sseCollect(() => { dp = del(m1id); }, evs => evs.some(e => e.ev === 'update'));
  dres = await dp;
  ok(dres && dres.status === 200 && dres.body.ok && dres.body.wasCurrent === false, 'admin deletes past match 1');
  ok(ev1[0].ev === 'deleted' && ev1[0].data.id === m1id && ev1[1].ev === 'update' && ev1[1].data.id === m2id, 'SSE broadcasts deleted(match 1) then live state (match 2 still live)');
  ok((await api('/api/matches/' + m1id)).status === 404, 'deleted match no longer readable');
  await hardKill(); await start();
  let l2 = (await api('/api/matches')).body;
  ok(l2.length === 1 && l2[0].id === m2id && l2[0].current, 'past-match delete survives SIGKILL restart; current match kept');
  ok((await del(m1id)).status === 404, 'deleting again -> 404');
  const ev2 = await sseCollect(() => { dp = del(m2id); }, evs => evs.some(e => e.ev === 'update'));
  dres = await dp;
  ok(dres.status === 200 && dres.body.wasCurrent === true && dres.body.state === null, 'admin deletes current match');
  ok(ev2.some(e => e.ev === 'deleted' && e.data.id === m2id) && ev2.find(e => e.ev === 'update').data === null, 'SSE sends live state null after current match deleted');
  ok((await api('/api/live')).body === null && (await api('/api/matches')).body.length === 0, 'no live match, list empty');
  ok((await api('/api/admin/event', { event: { t: 'ball', kind: 'run', runs: 1 } })).status === 400, 'scoring after delete says no match');
  await hardKill(); await start();
  ok((await api('/api/live')).body === null && (await api('/api/matches')).body.length === 0, 'current-match delete (and cleared current id) survives restart');
  if (H.usePg) {
    const rows = await H.pgQuery(`SELECT (SELECT count(*)::int FROM "${schema}".rpl_matches) AS n, (SELECT value FROM "${schema}".rpl_meta WHERE key = 'currentId') AS cur`);
    ok(rows[0].n === 0 && rows[0].cur === null, 'Postgres: match rows deleted and currentId cleared');
  } else {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    ok(j.matches.length === 0 && j.currentId === null, 'JSON file: matches deleted and currentId cleared');
  }
  const m3 = await api('/api/admin/match', { setup: { ...setup, teamA: 'Hawks' } });
  ok(m3.status === 200 && (await api('/api/live')).body.setup.teamA === 'Hawks', 'new match can be started after delete');
  await hardKill(); await start();
  ok((await api('/api/live')).body.setup.teamA === 'Hawks' && (await api('/api/matches')).body.length === 1, 'new match after delete survives restart');
  // without SESSION_SECRET, cookie is derived from password: still survives restarts
  await hardKill(); await start({ SESSION_SECRET: '' }); cookie = '';
  await api('/api/admin/login', { password: PW });
  await hardKill(); await start({ SESSION_SECRET: '' });
  ok((await api('/api/admin/me')).body.admin === true, 'fallback (password-derived) cookie secret survives restart');
  await hardKill(); await H.dropSchema(schema);
  console.log('RESTART TESTS PASSED:', pass);
})().catch(async e => { console.error('FAIL:', e.message); try { srv.kill('SIGKILL'); } catch (_) {} try { await H.dropSchema(schema); } catch (_) {} process.exit(1); });
