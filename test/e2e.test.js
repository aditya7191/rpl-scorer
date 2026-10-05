// End-to-end test: starts server, drives scoring admin UI in headless Chrome, checks public /score live page updates.
// Run: node test/e2e.test.js   (needs Chrome at CHROME_PATH or /usr/bin/google-chrome)
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const PORT = 8091, URL = 'http://localhost:' + PORT, PW = 'test-secret-123';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpl-'));
const H = require('./helpers.js'); const schema = H.testSchema();
console.log('E2E storage:', H.usePg ? 'postgres (schema ' + schema + ')' : 'json file');
let srv, pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

function startServer() {
  return new Promise((res, rej) => {
    srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, RPL_ADMIN_PASSWORD: PW, RPL_DATA_DIR: dataDir, RPL_PG_SCHEMA: schema } });
    srv.stdout.on('data', d => { if (/Storage:/.test(d)) process.stdout.write('  ' + String(d).split('\n')[0] + '\n'); if (/running/.test(d)) res(); });
    srv.stderr.on('data', d => process.stderr.write(d));
    srv.on('exit', c => c && rej(new Error('server exit ' + c)));
  });
}
const stopServer = () => new Promise(r => { srv.once('exit', r); srv.kill(); });

(async () => {
  await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  const mob = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
  const viewerCtx = await browser.newContext(mob), adminCtx = await browser.newContext(mob);
  const pub = await viewerCtx.newPage(), adm = await adminCtx.newPage();
  const errs = []; for (const p of [pub, adm]) p.on('pageerror', e => errs.push(e.message));

  await pub.goto(URL + '/score');
  await pub.waitForSelector('text=No live match');
  ok(true, 'public page loads, no match');

  // security: admin API refuses without login
  const r401 = await pub.evaluate(async () => (await fetch('/api/admin/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  ok(r401 === 401, 'admin API blocked for viewer (401)');
  const d401 = await pub.evaluate(async () => (await fetch('/api/admin/matches/x', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  ok(d401 === 401, 'delete API blocked for viewer (401)');

  await adm.goto(URL + '/score/admin');
  await adm.fill('#pw', 'wrong'); await adm.click('#loginBtn');
  await adm.waitForSelector('text=Wrong password'); ok(true, 'wrong password rejected');
  await adm.waitForTimeout(1100);
  await adm.fill('#pw', PW); await adm.click('#loginBtn');
  await adm.waitForSelector('#v-new:not(.hide)'); ok(true, 'admin login works, shows New Match');
  ok(await adm.inputValue('#overs') === '4', 'default overs = 4');

  await adm.fill('#teamA', 'Lions'); await adm.fill('#teamB', 'Tigers');
  await adm.fill('#playersA', 'A1\nA2\nA3\nA4'); await adm.fill('#playersB', 'B1\nB2\nB3\nB4');
  await adm.fill('#overs', '2'); await adm.selectOption('#tossWinner', 'A'); await adm.selectOption('#tossChoice', 'bat');
  await adm.click('#createBtn');
  await adm.waitForSelector('[data-act="openers"]');

  const act = async (sel) => { await Promise.all([adm.waitForResponse(r => r.url().includes('/api/admin/') && r.request().method() === 'POST'), adm.click(sel)]); };
  const run = r => act(`[data-run="${r}"]`);
  const modalRuns = async (kind, r) => { await adm.click(`[data-act="${kind}"]`); await act(`[data-mk="${kind}"][data-mr="${r}"]`); };
  const score = async () => (await adm.textContent('#board .score')).replace(/\s+/g, ' ').trim();
  const striker = async () => (await adm.textContent('#board .strk')).replace('🏏', '').trim();
  const pubHas = (txt) => pub.waitForFunction(t => document.getElementById('v-live').innerText.includes(t), txt, { timeout: 5000 });

  await act('[data-act="openers"]');
  await pubHas('Lions batting'); ok(true, 'public sees innings start live');
  await run(1); ok(await striker() === 'A2', 'strike rotates on 1 run');
  await modalRuns('wide', 0); ok(await score() === '2/0 (0.1/2)', 'wide adds 1, not a legal ball: ' + await score());
  await run(4);
  await modalRuns('nb', 2); ok(await score() === '9/0 (0.2/2)', 'no ball +2 off bat = 3 runs, not legal');
  await adm.click('[data-act="wicket"]'); await act('[data-how="bowled"]');
  await adm.waitForSelector('[data-bat]');
  ok(!(await adm.$('[data-bat="A2"]')) && !(await adm.$('[data-bat="A1"]')), 'out / batting players not offered as new batsman');
  await act('[data-bat="A3"]'); ok(await striker() === 'A3', 'new batsman on strike');
  await run(0); await modalRuns('bye', 1); ok(await striker() === 'A1', 'bye 1 rotates strike');
  await run(2);
  ok(await score() === '12/1 (1.0/2)', 'after over 1: 12/1 (1.0)');
  await adm.waitForSelector('[data-bowl]');
  ok(!(await adm.$('[data-bowl="B1"]')), 'same bowler not offered for next over');
  await pubHas('12/1'); ok(true, 'public shows 12/1 live');
  await act('[data-bowl="B2"]');
  ok(await striker() === 'A3', 'end of over swaps strike (A3)');
  await run(6); await pubHas('18/1'); ok(true, 'public shows six (18/1)');
  await act('[data-act="undo"]'); ok(await score() === '12/1 (1.0/2)', 'undo removes six');
  await pubHas('12/1'); ok(true, 'public reflects undo');
  await run(1);
  // run out: non-striker (A3) after 1 run completed, fielder B3
  await adm.click('[data-act="wicket"]'); await adm.click('[data-how="runout"]');
  await adm.selectOption('#wWho', 'nonStriker'); await adm.selectOption('#wR', '1'); await adm.selectOption('#wF', 'B3');
  await act('[data-act="wok"]');
  ok(await score() === '14/2 (1.2/2)', 'run out with 1 run: 14/2');
  await act('[data-bat="A4"]');
  ok(await striker() === 'A4', 'new batsman replaces run-out batsman at his end');
  await modalRuns('lb', 2); await modalRuns('wide', 2);
  ok(await score() === '19/2 (1.3/2)', 'leg bye 2 + wide with 2 runs = 19/2');
  await adm.evaluate(() => { const t = document.getElementById('toast'); if (t) t.style.display = 'none'; });
  await adm.screenshot({ path: path.join(__dirname, '..', 'screenshot.png') });
  await pub.screenshot({ path: path.join(__dirname, '..', 'screenshot-public.png') });
  ok(true, 'screenshots saved');
  await run(3); await run(0); await run(1);
  await adm.waitForSelector('[data-act="openers"]');
  ok((await adm.textContent('#board')).includes('Target 24'), '1st innings ends at 2 overs, target 24');
  await adm.selectOption('#opS', 'B1'); await adm.selectOption('#opN', 'B2'); await adm.selectOption('#opB', 'A1');
  await act('[data-act="openers"]');
  for (const r of [6, 6, 6, 4]) await run(r);
  ok((await adm.textContent('#board .chase')).includes('Need 2 runs in 8 balls'), 'required runs / balls left');
  await pubHas('Need 2 runs in 8 balls'); ok(true, 'public shows chase equation');
  await modalRuns('wide', 0); await run(1);
  await adm.waitForSelector('[data-act="momok"]');
  ok((await adm.textContent('#board .result')).includes('Tigers won by 3 wickets'), 'result: Tigers won by 3 wickets');
  await pubHas('Tigers won by 3 wickets'); ok(true, 'public shows result');
  const firstMom = await adm.textContent('[data-mom]'); ok(firstMom.startsWith('B1'), 'MoM suggestion B1 top: ' + firstMom.slice(0, 60));
  await adm.click('[data-mom="B:B3"]'); await act('[data-act="momok"]');
  await pubHas('Man of the Match: B3'); ok(true, 'admin override MoM to B3 shown on public');
  // scorecard tab on public
  await pub.click('[data-tab="card"]');
  const card = await pub.textContent('#v-card');
  ok(card.includes('run out (B3)') && card.includes('b B1') && card.includes('Extras: 8') && card.includes('Fall of wickets'), 'public scorecard has dismissals, extras(8), FOW');
  ok(card.includes('9-1 (A2, 0.3 ov)') && card.includes('14-2 (A3, 1.2 ov)'), 'FOW values correct');
  // persistence: reload + server restart
  await adm.reload(); await adm.waitForSelector('[data-act="momok"]'); ok(true, 'admin reload keeps match');
  await stopServer(); await startServer();
  const live = await (await fetch(URL + '/api/live')).json();
  ok(live.result.text === 'Tigers won by 3 wickets' && live.mom.name === 'B3' && live.innings[0].runs === 23, 'data survives server restart');
  await pub.waitForFunction(() => document.getElementById('conn').title === 'Connected', null, { timeout: 10000 });
  ok(true, 'public SSE reconnects after restart');
  await pub.click('[data-tab="past"]'); await pub.waitForSelector('[data-mid]');
  ok((await pub.textContent('#v-past')).includes('Lions 23/2 (2.0)'), 'past matches list');

  // ---- delete matches (admin only) ----
  await adm.reload(); await adm.waitForSelector('[data-act="momok"]');
  await adm.click('[data-tab="new"]');
  await adm.fill('#teamA', 'Eagles'); await adm.fill('#teamB', 'Hawks');
  await adm.fill('#playersA', 'E1\nE2\nE3'); await adm.fill('#playersB', 'H1\nH2\nH3'); await adm.click('#createBtn');
  await adm.waitForSelector('[data-act="openers"]');
  const pubPast = (fn, arg) => pub.waitForFunction(fn, arg, { timeout: 5000 });
  await pubPast(() => document.getElementById('v-past').innerText.includes('Eagles vs Hawks')); ok(true, 'public past list shows new match live');
  ok(!(await pub.$('[data-del]')) && !(await pub.content()).includes('Delete match'), 'public page has no delete option');
  const all = await (await fetch(URL + '/api/matches')).json();
  const id1 = all.find(m => m.teamA === 'Lions').id, id2 = all.find(m => m.teamA === 'Eagles').id;
  // viewer is looking at the old match's scorecard
  await pub.click(`[data-mid="${id1}"]`); await pub.waitForFunction(() => document.getElementById('v-card').innerText.includes('Lions vs Tigers'));
  await adm.click('[data-tab="past"]'); await adm.waitForSelector(`[data-del="${id1}"]`);
  ok((await adm.$$('#v-past [data-del]')).length === 2, 'admin sees a Delete button for each match');
  await adm.click(`[data-del="${id1}"]`); await adm.waitForSelector('#modal.on');
  const msg = await adm.textContent('#sheet');
  ok(msg.includes('Delete this match permanently?') && msg.includes('This cannot be undone') && msg.includes('Lions vs Tigers') && msg.includes('Lions 23/2'), 'confirm dialog shows simple warning + teams/score');
  ok(!(await adm.isVisible('#v-card:not(.hide)')), 'tapping Delete does not open the scorecard');
  await adm.screenshot({ path: path.join(__dirname, '..', 'screenshot-delete.png') });
  await adm.click('[data-act="close"]');
  ok((await (await fetch(URL + '/api/matches')).json()).length === 2, 'Cancel keeps the match');
  await adm.click(`[data-del="${id1}"]`);
  await Promise.all([adm.waitForResponse(r => r.url().includes('/api/admin/matches/') && r.request().method() === 'DELETE' && r.status() === 200), adm.click('[data-act="delok"]')]);
  await adm.waitForFunction(() => document.querySelectorAll('#v-past [data-del]').length === 1); ok(true, 'admin list updates after delete');
  await pub.waitForFunction(() => !document.getElementById('v-card').innerText.includes('Lions vs Tigers'), null, { timeout: 5000 });
  ok(true, 'viewer looking at deleted match is moved off it immediately');
  await pub.click('[data-tab="past"]');
  await pubPast(() => { const t = document.getElementById('v-past').innerText; return !t.includes('Lions vs Tigers') && t.includes('Eagles vs Hawks'); });
  ok(true, 'public past list drops deleted match');
  // delete the current match from the Score tab
  await pub.click('[data-tab="live"]'); await pubHas('Eagles vs Hawks');
  await adm.click('[data-tab="score"]'); await adm.click(`#ctrl [data-del="${id2}"]`); await adm.waitForSelector('#modal.on');
  ok((await adm.textContent('#sheet')).includes('This is the current match'), 'current-match delete warns that live score goes away');
  await Promise.all([adm.waitForResponse(r => r.url().includes('/api/admin/matches/') && r.request().method() === 'DELETE' && r.status() === 200), adm.click('[data-act="delok"]')]);
  await pubHas('No live match'); ok(true, 'public live view shows "No live match" right away');
  await adm.waitForSelector('#board >> text=No live match'); ok((await adm.textContent('#ctrl')).includes('No match'), 'admin shows no match after deleting current');
  await pub.click('[data-tab="past"]'); await pub.waitForSelector('#v-past >> text=No matches yet'); ok(true, 'public past list empty');
  ok((await (await fetch(URL + '/api/live')).json()) === null, 'server has no current match');
  ok(errs.length === 0, 'no JS errors on pages ' + errs.join(';'));
  await browser.close(); await stopServer(); await H.dropSchema(schema);
  console.log('E2E TESTS PASSED:', pass);
})().catch(async e => { console.error('FAIL:', e.message); try { srv.kill(); } catch (_) {} try { await H.dropSchema(schema); } catch (_) {} process.exit(1); });
