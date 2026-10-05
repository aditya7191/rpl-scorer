// Registration API + security + durability test (no browser). Spawns the real server.
// Uses Postgres (throw-away schema) when DATABASE_URL is set, else the JSON file.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const sharp = require('sharp');
const H = require('./helpers.js');
const PORT = 8093, URL = 'http://localhost:' + PORT, PW = 'reg-api-pw';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpl-ra-'));
const schema = H.testSchema();
let srv, pass = 0, cookie = '';
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

function start(extraEnv = {}) {
  return new Promise((res, rej) => {
    srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, RPL_ADMIN_PASSWORD: PW, RPL_DATA_DIR: dataDir, RPL_PG_SCHEMA: schema, SESSION_SECRET: 's3', RPL_REG_RATE: '40/600', ...extraEnv } });
    let out = '';
    srv.stdout.on('data', d => { out += d; if (/running/.test(out)) res(out); });
    srv.stderr.on('data', d => process.stderr.write(d));
    srv.on('exit', c => c && rej(new Error('server exit ' + c + ' ' + out)));
  });
}
const hardKill = () => new Promise(r => { srv.once('exit', r); srv.kill('SIGKILL'); });
async function req(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.auth !== false && cookie) headers.cookie = cookie;
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  const r = await fetch(URL + p, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
  const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('rpl_admin=')) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (_) {}
  return { status: r.status, body: j, buf, headers: r.headers };
}
const team = (name, extra = {}) => ({ teamName: name, captainName: name + ' Cap', captainMobile: '9820012345', vcName: name + ' Vc', vcMobile: '9876543210',
  playing: Array.from({ length: 9 }, (_, i) => name + ' P' + (i + 3)), subs: Array.from({ length: 4 }, (_, i) => name + ' S' + (i + 1)), paymentDone: 'no', ...extra });
function form(data, file, fname = 'shot.jpg', type = 'image/jpeg') {
  const fd = new FormData();
  fd.append('data', JSON.stringify(data));
  if (file) fd.append('screenshot', new Blob([file], { type }), fname);
  return fd;
}
const submit = (data, file, f, t) => req('/api/reg/submit', { body: form(data, file, f, t), auth: false });

(async () => {
  console.log('Registration API test storage:', H.usePg ? 'postgres (schema ' + schema + ')' : 'json file');
  await start();
  const shot = await sharp({ create: { width: 1200, height: 2600, channels: 3, background: '#3366cc' } }).png().toBuffer();
  let r = await req('/api/reg/config');
  ok(r.status === 200 && r.body.fee === 7000 && r.body.upiId === '' && r.body.totalPlayers === 15 && r.body.year === 2026, 'config: fee 7000, UPI hidden, 15 players, year 2026');
  ok((await req('/register')).status === 200 && (await req('/teams')).status === 200, '/register and /teams pages load');

  // --- submit with screenshot ---
  r = await submit(team('Rohidas Royals', { paymentDone: 'yes', utr: '412345678901' }), shot, 'shot.png', 'image/png');
  ok(r.status === 200 && r.body.regNo === 'RPL7-001' && /^[A-Za-z0-9_-]{24}$/.test(r.body.token), 'team 1 registered RPL7-001 with screenshot');
  const tok1 = r.body.token;
  r = await submit(team('Second Eleven'));
  ok(r.status === 200 && r.body.regNo === 'RPL7-002', 'team 2 registered without payment: RPL7-002');
  const tok2 = r.body.token;
  // duplicates / validation
  r = await submit(team('  ROHIDAS   royals '));
  ok(r.status === 409 && r.body.errors.teamName, 'duplicate team name (case/space-insensitive) -> 409');
  r = await submit(team('No Shot Team', { paymentDone: 'yes' }));
  ok(r.status === 400 && r.body.errors.screenshot, 'payment Yes without screenshot -> 400');
  r = await submit(team('Fake Image', { paymentDone: 'yes' }), Buffer.from('<html><script>alert(1)</script></html>'), 'x.png', 'image/png');
  ok(r.status === 400 && /Only image/.test(r.body.error), 'non-image file named .png rejected (magic bytes)');
  r = await submit(team('Too Big', { paymentDone: 'yes' }), Buffer.alloc(9 * 1024 * 1024, 0xff));
  ok(r.status === 413, 'upload over 8 MB rejected (413)');
  r = await submit(team('Few Players', { playing: ['A b'] }));
  ok(r.status === 400 && r.body.errors.playing, 'missing players -> 400');
  r = await submit(team('Bad <b>', {}));
  ok(r.status === 400 && r.body.errors.teamName, 'HTML in name -> 400');
  r = await req('/api/reg/submit', { body: 'data=%7B%7D', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, auth: false });
  ok(r.status === 400, 'garbage body -> 400');
  r = await req('/api/reg/name-check?name=rohidas%20ROYALS');
  ok(r.body.available === false, 'name-check says taken');
  ok((await req('/api/reg/name-check?name=Fresh%20Team')).body.available === true, 'name-check says available');

  // --- private link + card ---
  r = await req('/api/reg/t/' + tok1);
  ok(r.status === 200 && r.body.team.name === 'Rohidas Royals' && r.body.team.playing.length === 11 && r.body.team.subs.length === 4 && r.body.team.status === 'uploaded', 'private link shows team, 11 + 4, status uploaded');
  ok(!JSON.stringify(r.body).includes('9820012345') && !JSON.stringify(r.body).includes('screenshotId'), 'private link shows no mobile numbers / internal ids');
  ok(r.headers.get('referrer-policy') === 'no-referrer' && r.headers.get('cache-control') === 'no-store', 'private link: no-referrer + no-store');
  r = await req('/registration/' + tok1 + '/card.png');
  const meta = await sharp(r.buf).metadata();
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && meta.width === 1080 && meta.height === 1350, 'thank-you card PNG 1080x1350 served');
  r = await req('/registration/' + tok1 + '/card.png?download=1');
  ok(/attachment; filename="RPL7-001-Rohidas-Royals.png"/.test(r.headers.get('content-disposition')), 'download sets attachment filename');
  ok((await req('/registration/' + 'x'.repeat(24) + '/card.png')).status === 404 && (await req('/api/reg/t/bad')).status === 404, 'unknown token -> 404');
  ok((await req('/registration/' + tok1)).status === 200, 'private page loads');

  // pay later from private link
  r = await req('/api/reg/t/' + tok2 + '/payment', { body: (() => { const f = new FormData(); f.append('utr', 'UTR998877'); f.append('screenshot', new Blob([shot], { type: 'image/png' }), 's.png'); return f; })(), auth: false });
  ok(r.status === 200 && r.body.team.status === 'uploaded' && r.body.team.utr === 'UTR998877', 'team 2 uploads screenshot later via private link');

  // --- public list ---
  r = await req('/api/reg/teams?year=2026');
  ok(r.body.teams.length === 2 && r.body.teams[0].regNo === 'RPL7-001' && r.body.teams[0].count === 15 && r.body.teams[0].playing.length === 11, 'public team list for 2026');
  const pubTxt = JSON.stringify(r.body);
  ok(!pubTxt.includes('9820012345') && !pubTxt.includes('9876543210') && !pubTxt.includes('screenshot') && !pubTxt.includes('token') && !pubTxt.includes('status'), 'public list: no mobiles, screenshots, tokens or payment status');
  ok((await req('/api/reg/years')).body.years.some(y => y.year === 2026 && y.count === 2), 'years endpoint lists 2026 (2 teams)');

  // --- admin security ---
  const t1 = (await req('/api/reg/teams')).body.teams[0];
  ok((await req('/api/admin/reg/teams', { auth: false })).status === 401, 'admin team list needs login (401)');
  ok((await req('/api/admin/reg/export.csv', { auth: false })).status === 401, 'CSV export needs login (401)');
  ok((await req('/api/admin/login', { json: { password: PW } })).status === 200, 'admin login');
  let list = (await req('/api/admin/reg/teams')).body;
  ok(list.teams.length === 2 && list.teams[0].captain.mobile === '9820012345' && list.teams[0].payment.status === 'uploaded', 'admin sees full details incl. mobiles');
  const id1 = list.teams[0].id, id2 = list.teams[1].id;
  const saved = cookie; cookie = '';
  ok((await req('/api/admin/reg/teams/' + id1 + '/screenshot', { auth: false })).status === 401, 'screenshot not viewable without admin login');
  ok((await req('/api/admin/reg/teams/' + id1 + '/payment', { json: { action: 'verify' }, auth: false })).status === 401, 'verify needs login');
  ok((await req('/api/admin/reg/teams/' + id1, { method: 'DELETE', json: {}, headers: { cookie: 'rpl_admin=1.abc' }, auth: false })).status === 401, 'delete with forged cookie -> 401');
  cookie = saved;
  ok((await req('/api/admin/reg/teams/' + id1 + '/payment', { body: 'action=verify', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status === 415, 'form-encoded admin write rejected (CSRF guard 415)');
  ok((await req('/api/admin/reg/qr', { body: (() => { const f = new FormData(); f.append('qr', new Blob([shot]), 'q.png'); return f; })() })).status === 403, 'multipart admin upload without X-RPL-Admin header rejected (403)');
  r = await req('/api/admin/reg/teams/' + id1 + '/screenshot');
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && (await sharp(r.buf).metadata()).height === 1600 && /no-store/.test(r.headers.get('cache-control')), 'admin sees screenshot (compressed JPEG, 1600px)');
  // --- admin actions ---
  r = await req('/api/admin/reg/teams/' + id1 + '/payment', { json: { action: 'verify' } });
  ok(r.status === 200 && r.body.team.payment.status === 'verified', 'verify payment');
  r = await req('/api/admin/reg/teams/' + id2 + '/payment', { json: { action: 'reject', note: 'Amount wrong' } });
  ok(r.status === 200 && r.body.team.payment.status === 'rejected' && r.body.team.payment.note === 'Amount wrong', 'reject payment with note');
  ok((await req('/api/reg/t/' + tok1 + '/payment', { body: (() => { const f = new FormData(); f.append('screenshot', new Blob([shot], { type: 'image/png' }), 's.png'); return f; })(), auth: false })).status === 409, 'verified team cannot re-upload (409)');
  const editBody = { teamName: 'Rohidas Royals XI', captainName: 'New Captain', captainMobile: '9000000001', vcName: t1.vc, vcMobile: '9000000002', playing: t1.playing.slice(2), subs: t1.subs, utr: 'NEWUTR123', note: 'ok' };
  r = await req('/api/admin/reg/teams/' + id1, { method: 'PUT', json: editBody });
  ok(r.status === 200 && r.body.team.name === 'Rohidas Royals XI' && r.body.team.playing[0] === 'New Captain' && r.body.team.payment.status === 'verified', 'edit team (name, captain) keeps payment status');
  r = await req('/api/admin/reg/teams/' + id1, { method: 'PUT', json: { ...editBody, teamName: 'second  ELEVEN' } });
  ok(r.status === 409, 'edit to a name already used this year -> 409');
  r = await req('/api/admin/reg/teams/' + id1, { method: 'PUT', json: { ...editBody, subs: ['Only One'] } });
  ok(r.status === 400, 'edit with wrong player count -> 400');
  // settings
  r = await req('/api/admin/reg/settings', { method: 'PUT', json: { upiId: 'rpl.test@okaxis', fee: 7000, note: 'Last date 20 Oct' } });
  ok(r.status === 200 && r.body.upiId === 'rpl.test@okaxis', 'settings: set UPI ID');
  r = await req('/api/admin/reg/qr', { body: (() => { const f = new FormData(); f.append('qr', new Blob([shot], { type: 'image/png' }), 'q.png'); return f; })(), headers: { 'X-RPL-Admin': '1' } });
  ok(r.status === 200 && r.body.qrImageId, 'settings: upload payment QR');
  r = await req('/api/reg/qr'); ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'public QR served');
  ok((await req('/api/reg/config')).body.qr === true && (await req('/api/reg/config')).body.upiId === 'rpl.test@okaxis', 'form config shows UPI + QR once set');
  // CSV
  r = await req('/api/admin/reg/export.csv?year=2026');
  const csv = r.buf.toString('utf8');
  ok(r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && /rpl-teams-2026\.csv/.test(r.headers.get('content-disposition')), 'CSV export (2026) downloads');
  ok(csv.includes('Rohidas Royals XI') && csv.includes('Second Eleven') && csv.includes('Verified') && csv.includes('Rejected') && csv.includes('Substitute 4') && csv.includes('Playing 11'), 'CSV has both teams, statuses and Playing XI / substitutes columns');
  // --- new year: uniqueness per year ---
  r = await req('/api/admin/reg/settings', { method: 'PUT', json: { year: 2027, season: 'RPL Season 8' } });
  ok(r.body.year === 2027, 'admin switches registration year to 2027 / Season 8');
  r = await submit(team('Second Eleven'));
  ok(r.status === 200 && r.body.regNo === 'RPL8-001', 'same team name allowed in new year (RPL8-001)');
  ok((await req('/api/reg/teams?year=2027')).body.teams.length === 1 && (await req('/api/reg/teams?year=2026')).body.teams.length === 2, 'year-wise lists separate (2026: 2, 2027: 1)');
  ok((await req('/api/reg/years')).body.years.map(y => y.year).join(',') === '2027,2026', 'years dropdown data: 2027, 2026');
  const c26 = (await req('/api/admin/reg/export.csv?year=2026')).buf.toString(), c27 = (await req('/api/admin/reg/export.csv?year=2027')).buf.toString(), call = (await req('/api/admin/reg/export.csv?year=all')).buf.toString();
  ok(c26.trim().split('\r\n').length === 3 && c27.trim().split('\r\n').length === 2 && call.trim().split('\r\n').length === 4, 'CSV filter by year works (2026: 2, 2027: 1, all: 3)');
  // closed registration
  await req('/api/admin/reg/settings', { method: 'PUT', json: { open: false } });
  r = await submit(team('Late Team'));
  ok(r.status === 403, 'registration closed -> 403');
  await req('/api/admin/reg/settings', { method: 'PUT', json: { open: true } });

  // --- durability: SIGKILL right after writes, data + screenshot bytes survive ---
  const shotBefore = (await req('/api/admin/reg/teams/' + id2 + '/screenshot')).buf;
  await hardKill(); await start();
  list = (await req('/api/admin/reg/teams?year=all')).body;
  ok(list.teams.length === 3 && list.teams.find(t => t.id === id1).payment.status === 'verified' && list.teams.find(t => t.id === id1).name === 'Rohidas Royals XI', 'teams, edits and statuses survive SIGKILL restart');
  const shotAfter = (await req('/api/admin/reg/teams/' + id2 + '/screenshot')).buf;
  ok(shotAfter.length > 1000 && Buffer.compare(shotBefore, shotAfter) === 0, 'screenshot bytes identical after restart (stored in ' + (H.usePg ? 'Postgres bytea' : 'data dir') + ')');
  ok((await req('/api/reg/config')).body.year === 2027 && (await req('/api/reg/qr')).status === 200, 'settings + QR survive restart');
  r = await submit(team('After Restart'));
  ok(r.body.regNo === 'RPL8-002', 'reg number counter continues after restart (RPL8-002)');
  // delete
  r = await req('/api/admin/reg/teams/' + id2, { method: 'DELETE', json: {} });
  ok(r.status === 200, 'admin deletes team');
  ok((await req('/api/reg/t/' + tok2)).status === 404 && (await req('/api/admin/reg/teams/' + id2 + '/screenshot')).status === 404, 'deleted team: private link + screenshot gone');
  ok((await req('/api/admin/reg/teams/' + id2, { method: 'DELETE', json: {} })).status === 404, 'delete again -> 404');
  if (H.usePg) {
    const rows = await H.pgQuery(`SELECT (SELECT count(*)::int FROM "${schema}".rpl_teams) AS t, (SELECT count(*)::int FROM "${schema}".rpl_images) AS i`);
    ok(rows[0].t === 3 && rows[0].i === 2, 'Postgres: 3 team rows, 2 images (team 1 screenshot + QR) after delete');
  } else {
    ok(fs.readdirSync(path.join(dataDir, 'images')).filter(f => !f.endsWith('.tmp')).length === 2, 'JSON: 2 image files left after delete');
  }
  await hardKill();
  // --- rate limit ---
  await start({ RPL_REG_RATE: '3/600' });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await submit(team('Rate Team ' + 'abcde'[i]))).status);
  ok(codes.slice(0, 3).every(c => c === 200) && codes[3] === 429 && codes[4] === 429, 'rate limit: 4th submission from same IP -> 429 (' + codes.join(',') + ')');
  await hardKill();
  await H.dropSchema(schema);
  console.log('REG API TESTS PASSED:', pass);
})().catch(async e => { console.error('FAIL:', e.stack || e.message); try { srv.kill('SIGKILL'); } catch (_) {} try { await H.dropSchema(schema); } catch (_) {} process.exit(1); });
