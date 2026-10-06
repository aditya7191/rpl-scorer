// Headless browser E2E for team registration at phone size:
//   Android-like Chrome (Chromium) and iPhone Safari (WebKit, if installed).
// Covers form validation, screenshot upload, duplicate name, success page + thank-you image, download, share,
// private link, admin Teams tab (verify / reject / edit / delete / CSV / settings / year), public /teams, watermark.
const { chromium, webkit, devices } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert');
const sharp = require('sharp');
const H = require('./helpers.js');
const PORT = 8094, URL = 'http://localhost:' + PORT, PW = 'reg-e2e-pw';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpl-re-'));
const schema = H.testSchema();
const SHOTS = process.env.RPL_SHOTS_DIR || path.join(__dirname, '..', '..', 'registration-shots');
fs.mkdirSync(SHOTS, { recursive: true });
let srv, pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

function startServer() {
  return new Promise((res, rej) => {
    srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, RPL_ADMIN_PASSWORD: PW, RPL_DATA_DIR: dataDir, RPL_PG_SCHEMA: schema, RPL_REG_RATE: '200/600' } });
    srv.stdout.on('data', d => { if (/running/.test(d)) res(); });
    srv.stderr.on('data', d => process.stderr.write(d));
    srv.on('exit', c => c && rej(new Error('server exit ' + c)));
  });
}
function webkitAvailable() { try { return fs.existsSync(webkit.executablePath()); } catch (e) { return false; } }

const POOL = ['Rohit Kadam', 'Vikas More', 'Sunil Pawar', 'Amit Gupta', 'Nilesh Shinde', 'Prakash Jain', 'Deepak Yadav', 'Ganesh Naik', 'Kiran Salvi'];
const SUBS = ['Mahesh Patel', 'Sachin Gaikwad', 'Arjun Rao', 'Tushar Mane'];
const CAPS = { 'Rohidas Royals': ['Aditya Solanki', 'Rahul Patil'], 'Ghatkopar Strikers': ['Sagar Jadhav', 'Imran Shaikh'] };
async function fillForm(p, name, { pay = 'yes', file = null } = {}) {
  const [cap, vc] = CAPS[name.trim()] || ['Captain ' + name.trim().split(' ')[0], 'Vice ' + name.trim().split(' ')[0]];
  await p.fill('#teamName', name);
  await p.fill('#captainName', cap); await p.fill('#captainMobile', '98200 12345');
  await p.fill('#vcName', vc); await p.fill('#vcMobile', '+919876543210');
  for (let i = 0; i < 9; i++) await p.fill('#p' + i, POOL[i]);
  for (let i = 0; i < 4; i++) await p.fill('#s' + i, SUBS[i]);
  if (pay === 'yes') { await p.click('#payYes'); if (file) await p.setInputFiles('#shot', file); }
  else if (pay === 'no') await p.click('#payNo');
}
// Tap Register and make sure the form really submitted (WebKit's smooth scroll can make a tap miss once).
async function clickSubmit(p) {
  for (let i = 0; i < 3; i++) {
    const before = await p.evaluate(() => window.__submits || 0);
    await p.click('#submitBtn');
    const ok2 = await p.waitForFunction((b) => (window.__submits || 0) > b || !document.getElementById('f'), before, { timeout: 1500 }).then(() => true, () => false);
    if (ok2 || !/\/register$/.test(p.url())) return;
    await p.waitForTimeout(400);
  }
  throw new Error('submit did not fire');
}
async function watermarkOk(p) {
  return p.evaluate(async () => {
    const cs = getComputedStyle(document.body, '::before');
    const logo = document.querySelector('header img[src*="logo"]');
    const wm = await fetch('/logo-wm.webp').then(r => r.ok && r.headers.get('content-type').includes('webp')).catch(() => false);
    return { bg: cs.backgroundImage, op: parseFloat(cs.opacity), pos: cs.position, pe: cs.pointerEvents, logo: !!(logo && logo.complete && logo.naturalWidth > 0), wm };
  });
}

async function publicFlow(browser, label, ctxOpts, shotFile) {
  console.log(' [' + label + ']');
  const TN = label === 'android-chrome' ? 'Rohidas Royals' : 'Ghatkopar Strikers', CAP = CAPS[TN];
  const ctx = await browser.newContext({ ...ctxOpts, acceptDownloads: true });
  // record what Share sends (real share sheet cannot open headless)
  await ctx.addInitScript(() => {
    window.__shared = null; window.__submits = 0;
    document.addEventListener('submit', () => { window.__submits++; }, true);
    navigator.canShare = (d) => !!(d && d.files && d.files.length && d.files.every(f => f instanceof File));
    navigator.share = async (d) => { window.__shared = { n: d.files.length, type: d.files[0].type, size: d.files[0].size, name: d.files[0].name, text: d.text }; };
  });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL + '/register');
  await p.waitForSelector('#f:not(.hide)');
  ok(await p.isVisible('text=Entry fee: ₹7,000 per team'), label + ': form shows entry fee ₹7,000');
  ok(!(await p.$('#upiId')) && !(await p.$('#qrImg')), label + ': UPI / QR hidden while not set');
  ok((await p.$$('#xiRows .prow')).length === 11 && (await p.$$('#subRows .prow')).length === 4, label + ': 11 Playing XI rows + 4 substitute rows');
  ok((await p.textContent('#xiTitle')).includes('Playing XI (11)') && (await p.textContent('#subTitle')).includes('Substitutes (4)') && (await p.textContent('#subTitle')).includes('injury'), label + ': labels Playing XI / Substitutes (injury replacement)');
  // empty submit
  await clickSubmit(p);
  await p.waitForSelector('#errTop:not(.hide)');
  ok((await p.textContent('[data-err="teamName"]')).includes('required') && (await p.textContent('[data-err="paymentDone"]')).length > 0, label + ': empty form shows errors (team name, payment)');
  // captain mirrors into row 1
  await fillForm(p, TN, { pay: 'yes' });
  ok(await p.inputValue('#pc') === CAP[0] && await p.inputValue('#pv') === CAP[1], label + ': captain + VC auto-filled as players 1 and 2');
  ok((await p.textContent('#countPill')).trim() === '15 / 15', label + ': counter shows 15 / 15');
  // bad mobile + duplicate player + missing screenshot
  await p.fill('#captainMobile', '12345');
  await p.fill('#s3', 'rohit  KADAM');
  await clickSubmit(p);
  await p.waitForSelector('#errTop:not(.hide)');
  ok(await p.waitForFunction(() => document.querySelector('[data-err="captainMobile"]').textContent.includes('10-digit'), null, { timeout: 4000 }).then(() => true, () => false), label + ': bad mobile rejected');
  const errHas = (f, t) => p.waitForFunction(([f, t]) => document.querySelector('[data-err="' + f + '"]').textContent.includes(t), [f, t], { timeout: 4000 }).then(() => true, () => false);
  ok(await errHas('subs.3', 'twice'), label + ': duplicate player name rejected');
  ok(await errHas('screenshot', 'screenshot'), label + ': payment Yes needs screenshot');
  await p.fill('#captainMobile', '9820012345'); await p.fill('#s3', SUBS[3]);
  // non-image file
  await p.setInputFiles('#shot', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  ok((await p.textContent('[data-err="screenshot"]')).includes('Only image'), label + ': non-image file refused in browser');
  // image upload + preview
  await p.setInputFiles('#shot', shotFile);
  await p.waitForSelector('#preview:not(.hide)');
  ok(await p.evaluate(() => document.getElementById('preview').naturalWidth > 0), label + ': screenshot preview shown');
  await p.fill('#utr', '412345678901');
  if (label === 'android-chrome') {
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: path.join(SHOTS, 'form.png'), fullPage: true });
  }
  const [resp] = await Promise.all([p.waitForResponse(r => r.url().endsWith('/api/reg/submit')), clickSubmit(p)]);
  await p.waitForURL(/\/registration\/[A-Za-z0-9_-]+$/);
  const sub = (await p.evaluate(async () => (await (await fetch('/api/reg/t/' + location.pathname.split('/')[2])).json()).team));
  ok(resp.status() === 200 && /^RPL7-\d{3}$/.test(sub.regNo), label + ': submitted -> ' + sub.regNo);
  await p.waitForFunction(() => { const i = document.getElementById('cardImg'); return i && i.complete && i.naturalWidth > 0; });
  ok(await p.isVisible('text=Registration successful!'), label + ': success page with celebration');
  const dims = await p.evaluate(() => { const i = document.getElementById('cardImg'); return [i.naturalWidth, i.naturalHeight, Math.round(i.getBoundingClientRect().height / i.getBoundingClientRect().width * 1000)]; });
  ok(dims[0] === 1080 && dims[1] === 1350 && dims[2] === 1250, label + ': thank-you image 1080x1350 shown with correct aspect');
  await p.waitForTimeout(400);
  if (label === 'android-chrome') await p.screenshot({ path: path.join(SHOTS, 'success.png') });
  else await p.screenshot({ path: path.join(SHOTS, 'success-iphone-safari.png') });
  // download
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#dlBtn')]);
  const dlPath = path.join(os.tmpdir(), 'rpl-dl-' + label + '.png'); await dl.saveAs(dlPath);
  const dlMeta = await sharp(dlPath).metadata();
  ok(dl.suggestedFilename().startsWith(sub.regNo) && dl.suggestedFilename().endsWith('.png') && dlMeta.format === 'png' && dlMeta.width === 1080, label + ': Download gives PNG ' + dl.suggestedFilename());
  if (label === 'android-chrome') fs.copyFileSync(dlPath, path.join(SHOTS, 'thankyou.png'));
  // share with file
  await p.waitForFunction(() => window.__shared !== undefined);
  await p.waitForTimeout(500);
  await p.click('#shareBtn');
  await p.waitForFunction(() => window.__shared);
  const shared = await p.evaluate(() => window.__shared);
  ok(shared.n === 1 && shared.type === 'image/png' && shared.size > 50000 && shared.name.endsWith('.png'), label + ': Share sends the PNG file (navigator.share with files)');
  // fallback when files can't be shared
  await p.evaluate(() => { navigator.canShare = undefined; });
  await p.click('#shareBtn');
  ok((await p.textContent('#saveHint')).includes('long-press'), label + ': fallback tells to long-press / download when file share unsupported');
  // reload private link (no ?new) shows details w/o mobiles
  const priv = p.url();
  await p.goto(priv); await p.waitForSelector('#details h2');
  const det = await p.textContent('#details');
  ok(det.includes('Screenshot uploaded') && det.includes('Playing XI') && det.includes('Substitutes') && !det.includes('9820012345') && !(await p.isVisible('#celebrate')), label + ': private link re-opens: details, no mobile numbers');
  // duplicate team name
  await p.goto(URL + '/register'); await p.waitForSelector('#f:not(.hide)'); await p.waitForSelector('#mine:not(.hide)');
  ok(await p.isVisible('#mine') && (await p.textContent('#mine')).includes(sub.regNo), label + ': form remembers registration on this phone');
  await fillForm(p, '  ' + TN.toUpperCase().replace(' ', '   ') + ' ', { pay: 'no' });
  const [r2] = await Promise.all([p.waitForResponse(r => r.url().endsWith('/api/reg/submit')), clickSubmit(p)]);
  ok(r2.status() === 409, label + ': duplicate team name -> 409');
  await p.waitForSelector('#errTop:not(.hide)');
  ok((await p.textContent('[data-err="teamName"]')).includes('already registered'), label + ': duplicate name error shown under team name');
  // fake image (image/png type but not an image): server refuses
  await fillForm(p, 'Fake Shot ' + label, { pay: 'yes', file: { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not really a png file at all') } });
  await p.waitForTimeout(300);
  const [r3] = await Promise.all([p.waitForResponse(r => r.url().endsWith('/api/reg/submit')), clickSubmit(p)]);
  ok(r3.status() === 400, label + ': fake image refused by server (magic bytes)');
  await p.waitForFunction(() => document.querySelector('[data-err="screenshot"]').textContent.length > 0);
  ok(true, label + ': server image error shown under screenshot field');
  // pay later
  await fillForm(p, 'Pay Later ' + label, { pay: 'no' });
  await Promise.all([p.waitForURL(/\/registration\//), clickSubmit(p)]);
  await p.waitForSelector('#payCard:not(.hide)');
  await p.setInputFiles('#shot', shotFile); await p.waitForSelector('#preview:not(.hide)');
  await Promise.all([p.waitForResponse(r => r.url().includes('/payment')), p.click('#payBtn')]);
  await p.waitForFunction(() => document.getElementById('details').innerText.includes('Screenshot uploaded'));
  ok(true, label + ': team can pay later and upload screenshot from private link');
  ok(errs.length === 0, label + ': no JS errors ' + errs.join('; '));
  await ctx.close();
  return sub;
}

(async () => {
  await startServer();
  const shotPng = await sharp({ create: { width: 1080, height: 2340, channels: 3, background: '#e8f0fe' } })
    .composite([{ input: Buffer.from('<svg width="1080" height="2340"><rect x="80" y="300" width="920" height="400" rx="30" fill="#1a73e8"/><text x="540" y="560" font-size="120" text-anchor="middle" fill="#fff">PAID 7000</text></svg>'), top: 0, left: 0 }]).png().toBuffer();
  const shotFile = { name: 'Screenshot_2026.png', mimeType: 'image/png', buffer: shotPng };
  const chrome = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  const android = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' };
  await publicFlow(chrome, 'android-chrome', android, shotFile);
  let wk = null;
  if (webkitAvailable()) {
    wk = await webkit.launch({ headless: true });
    const iphone = { ...devices['iPhone 13'] };
    await publicFlow(wk, 'iphone-safari', iphone, shotFile);
  } else console.log('  (WebKit not installed: skipping iPhone Safari run)');

  // ---- admin Teams tab (phone size) ----
  console.log(' [admin]');
  const actx = await chrome.newContext({ ...android, acceptDownloads: true });
  const a = await actx.newPage();
  const errs = []; a.on('pageerror', e => errs.push(e.message));
  await a.goto(URL + '/admin'); await a.fill('#pw', PW); await a.click('#loginBtn');
  await a.waitForSelector('#app:not(.hide)');
  await a.waitForSelector('#tList [data-tid]');
  const n = (await a.$$('#tList [data-tid]')).length;
  ok(n === (wk ? 4 : 2), 'admin Teams tab lists all ' + n + ' teams');
  ok((await a.textContent('#tStats')).includes('Teams'), 'admin stats shown');
  const first = await a.$('#tList [data-tid]:has-text("Rohidas Royals")');
  await first.click(); await a.waitForSelector('#modal.on');
  await a.waitForFunction(() => { const i = document.getElementById('shotImg'); return i && i.complete && i.naturalWidth > 0; });
  const sheet = await a.textContent('#sheet');
  ok(sheet.includes('Playing XI (11)') && sheet.includes('Substitutes') && sheet.includes('9820012345') && sheet.includes('412345678901'), 'details: Playing XI / subs split, mobile, UTR');
  ok(true, 'details: payment screenshot visible to admin');
  await a.screenshot({ path: path.join(SHOTS, 'admin-team-details.png') });
  await Promise.all([a.waitForResponse(r => r.url().includes('/payment') && r.status() === 200), a.click('[data-ra="verify"]')]);
  await a.waitForFunction(() => document.getElementById('sheet').innerText.includes('Verified'));
  ok((await a.textContent('#tList')).includes('Verified'), 'Verify payment -> Verified in list');
  // reject another
  await a.click('[data-act="close"]');
  await a.click('#tList [data-tid]:has-text("Pay Later android-chrome")'); await a.waitForSelector('#modal.on');
  await a.fill('#payNote', 'Wrong amount');
  await Promise.all([a.waitForResponse(r => r.url().includes('/payment') && r.status() === 200), a.click('[data-ra="reject"]')]);
  await a.waitForFunction(() => document.getElementById('sheet').innerText.includes('Rejected'));
  ok((await a.textContent('#sheet')).includes('Wrong amount'), 'Reject payment with note');
  // edit
  await a.click('[data-ra="edit"]'); await a.fill('#eName', 'Pay Later Renamed');
  await Promise.all([a.waitForResponse(r => r.request().method() === 'PUT' && r.status() === 200), a.click('[data-ra="saveedit"]')]);
  await a.waitForFunction(() => document.getElementById('tList').innerText.includes('Pay Later Renamed'));
  ok(true, 'Edit team name saved');
  // delete with confirm (cancel first)
  await a.click('[data-ra="askdel"]');
  ok((await a.textContent('#sheet')).includes('cannot be undone'), 'delete asks for confirmation');
  await a.click('text=No, keep it');
  ok((await a.$$('#tList [data-tid]')).length === n, 'cancel keeps team');
  const allTeams = () => a.evaluate(async () => (await (await fetch('/api/admin/reg/teams?year=all', { cache: 'no-store' })).json()).teams);
  const before = await allTeams();
  await a.click('[data-ra="askdel"]');
  await Promise.all([a.waitForResponse(r => r.request().method() === 'DELETE' && r.status() === 200), a.click('[data-ra="delok"]')]);
  await a.waitForFunction((k) => document.querySelectorAll('#tList [data-tid]').length === k, n - 1);
  ok(true, 'team deleted after confirm');
  // regression: the phone that registered the deleted team still has it in localStorage.
  // /register must drop it from the "Already registered from this phone" banner, and its private link must say it was deleted.
  const after = await allTeams();
  const gone = before.find(t => !after.some(x => x.id === t.id)), live = after.find(t => t.name === 'Rohidas Royals');
  ok(gone && live && !after.some(t => t.name === gone.name), 'deleted team is gone from admin list (all years)');
  const phone = await chrome.newContext(android); const ph = await phone.newPage();
  const pErrs = []; ph.on('pageerror', e => pErrs.push(e.message));
  await ph.goto(URL + '/teams');
  await ph.evaluate((list) => localStorage.setItem('rpl_regs', JSON.stringify(list)), [
    { token: gone.token, regNo: gone.regNo, team: gone.name, when: 1 }, { token: live.token, regNo: live.regNo, team: 'Old Name', when: 2 }]);
  await ph.goto(URL + '/register'); await ph.waitForSelector('#mine:not(.hide)');
  await ph.waitForFunction(() => !JSON.parse(localStorage.getItem('rpl_regs') || '[]').some(x => x.team === 'Old Name'));
  const mineTxt = await ph.textContent('#mine');
  const stored = await ph.evaluate(() => JSON.parse(localStorage.getItem('rpl_regs') || '[]'));
  ok(mineTxt.includes('Rohidas Royals') && !mineTxt.includes(gone.name) && !mineTxt.includes(gone.regNo + ' ') && stored.length === 1 && stored[0].token === live.token,
    'register banner: deleted team removed (banner + localStorage), live team kept with current name');
  await ph.evaluate((t) => localStorage.setItem('rpl_regs', JSON.stringify([{ token: t.token, regNo: t.regNo, team: t.name, when: 1 }])), gone);
  await ph.goto(URL + '/registration/' + gone.token); await ph.waitForSelector('#notFound:not(.hide)');
  ok((await ph.textContent('#notFound')).includes('This registration was deleted') && (await ph.evaluate(() => localStorage.getItem('rpl_regs'))) === null, 'private link of deleted team: "This registration was deleted" + forgotten on this phone');
  await ph.evaluate(() => localStorage.removeItem('rpl_regs'));
  await ph.goto(URL + '/register'); await ph.waitForSelector('#f:not(.hide)'); await ph.waitForTimeout(300);
  ok(!(await ph.isVisible('#mine')), 'register banner hidden when nothing remembered');
  ok(pErrs.length === 0, 'phone: no JS errors ' + pErrs.join('; '));
  await phone.close();
  // CSV export
  const [csvDl] = await Promise.all([a.waitForEvent('download'), a.click('#csvBtn')]);
  const csvPath = path.join(os.tmpdir(), 'rpl-teams.csv'); await csvDl.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  ok(csvDl.suggestedFilename() === 'rpl-teams-2026.csv' && csv.includes('Rohidas Royals') && csv.includes('Verified') && csv.includes('Playing 1 (C)') && csv.includes('Substitute 4') && !csv.includes('Pay Later Renamed'), 'Export CSV (2026) has teams, split columns, not the deleted team');
  // settings: UPI + note
  await a.click('[data-ra="settings"]'); await a.waitForSelector('#sUpi');
  ok(await a.inputValue('#sFee') === '7000' && await a.inputValue('#sPlay') === '11' && await a.inputValue('#sSubs') === '4' && await a.inputValue('#sYear') === '2026', 'settings show defaults (₹7000, 11 + 4, 2026)');
  await a.fill('#sUpi', 'rplcricket@okicici'); await a.fill('#sPayee', 'RPL Committee');
  await Promise.all([a.waitForResponse(r => r.url().endsWith('/api/admin/reg/settings') && r.status() === 200), a.click('[data-ra="savesettings"]')]);
  await a.screenshot({ path: path.join(SHOTS, 'admin-teams.png') });
  const pub = await chrome.newContext(android); const pp = await pub.newPage();
  await pp.goto(URL + '/register'); await pp.waitForSelector('#f:not(.hide)');
  ok((await pp.textContent('#upiId')) === 'rplcricket@okicici' && (await pp.getAttribute('a[href^="upi://"]', 'href')).includes('am=7000'), 'form shows UPI ID + UPI pay link once admin sets it');
  // New Match (on /score/admin): load registered team
  const sa = await actx.newPage();
  await sa.goto(URL + '/score/admin');
  // already logged in via shared cookie from /admin
  await sa.waitForSelector('#app:not(.hide)');
  await sa.click('[data-tab="new"]'); await sa.waitForSelector('#regPick:not(.hide)');
  const optVal = await sa.$eval('#pickA', s => [...s.options].find(o => o.text.includes('Rohidas Royals')).value);
  await sa.selectOption('#pickA', optVal);
  ok(await sa.inputValue('#teamA') === 'Rohidas Royals' && (await sa.inputValue('#playersA')).split('\n').length === 11, 'New Match: registered team + Playing XI loaded into scorer');
  await sa.close();
  // new year
  await a.click('[data-ra="settings"]'); await a.waitForSelector('#sYear');
  await a.fill('#sYear', '2027'); await a.fill('#sSeason', 'RPL Season 8');
  await Promise.all([a.waitForResponse(r => r.url().endsWith('/api/admin/reg/settings') && r.status() === 200), a.click('[data-ra="savesettings"]')]);
  await pp.goto(URL + '/register'); await pp.waitForSelector('#f:not(.hide)');
  ok((await pp.textContent('#seasonTxt')).includes('RPL Season 8 · 2027'), 'form follows new year / season');
  await fillForm(pp, 'Rohidas Royals', { pay: 'no' });
  const [ry] = await Promise.all([pp.waitForResponse(r => r.url().endsWith('/api/reg/submit')), pp.click('#submitBtn')]);
  await pp.waitForURL(/\/registration\//); await pp.waitForSelector('#details h2');
  ok(ry.status() === 200 && (await pp.textContent('#details')).includes('RPL8-001'), 'same team name allowed in 2027 (RPL8-001)');
  // public teams page, year-wise
  await pp.goto(URL + '/teams'); await pp.waitForSelector('#tvList .tteam');
  const yearsOpt = await pp.$$eval('#tvYear option', os => os.map(o => o.value));
  ok(yearsOpt.join(',') === '2027,2026', 'public /teams year dropdown: 2027, 2026');
  ok((await pp.$$('#tvList .tteam')).length === 1, '/teams shows 2027 teams by default (1)');
  await pp.selectOption('#tvYear', '2026'); await pp.waitForFunction(() => document.getElementById('tvSummary').innerText.includes('2026'));
  const txt = await pp.textContent('#tvList');
  ok((await pp.$$('#tvList .tteam')).length === n - 1 && txt.includes('Playing XI (11)') && txt.includes('Substitutes (4)') && txt.includes('15 players'), '/teams?year=2026 lists teams with Playing XI / subs and count');
  ok(!txt.includes('9820012345') && !txt.includes('9876543210') && !(await pp.content()).includes('screenshot'), '/teams shows no mobile numbers or screenshots');
  ok(pp.url().includes('year=2026'), '/teams URL keeps ?year=');
  await pp.screenshot({ path: path.join(SHOTS, 'teams-public.png'), fullPage: false });
  // home page = registration only: big Register CTA, Teams-by-year list, small Admin Login; no scoring links
  await pp.goto(URL + '/'); await pp.waitForFunction(() => document.getElementById('regCtaSub').textContent.includes('2027'));
  const lay = await pp.evaluate(() => {
    const y = (sel) => document.querySelector(sel).getBoundingClientRect().top + scrollY;
    const cta = document.getElementById('regCta'), adm = document.getElementById('adminLink');
    const links = [...document.querySelectorAll('a')].map(a => a.getAttribute('href') || '');
    return { cta: y('#regCta'), teams: y('#v-teams'), admin: y('#adminLink'), ctaH: cta.getBoundingClientRect().height, ctaHref: cta.getAttribute('href'), adminHref: adm.getAttribute('href'),
      ctaText: cta.innerText, adminFont: parseFloat(getComputedStyle(adm).fontSize), last: [...document.querySelectorAll('.wrap a, .wrap button')].pop() === adm,
      hasTabs: !!document.querySelector('.tabs'), hasScoreLink: links.some(h => h === '/score' || h.startsWith('/score/') || h.includes('Live') || h.includes('score')),
      bodyHasLive: /\bLive\b|Scorecard|No live match|Share score/i.test(document.body.innerText) };
  });
  ok(lay.cta < lay.teams && lay.cta < 80 && lay.ctaH >= 100 && lay.ctaHref === '/register' && lay.ctaText.includes('Register Your Team') && lay.ctaText.includes('RPL Season 8 · 2027 · Entry fee ₹7,000'), 'home: big "Register Your Team" section at the top (season, year, fee)');
  ok(lay.admin > lay.teams && lay.last && lay.adminHref === '/admin' && lay.adminFont <= 14, 'home: small "Admin Login" link at the very bottom');
  ok(!lay.hasTabs && !lay.hasScoreLink && !lay.bodyHasLive, 'home: no scoring tabs/links/content');
  await pp.waitForSelector('#v-teams .tteam');
  ok((await pp.$$('#v-teams .tteam')).length === 1 && (await pp.$$eval('#v-teams #tvYear option', o => o.length)) === 2, 'home: Teams-by-year list shows teams');
  await pp.screenshot({ path: path.join(SHOTS, 'home.png') });
  await Promise.all([pp.waitForURL(/\/register$/), pp.click('#regCta')]);
  ok(true, 'home: tapping Register Your Team opens the form');
  await pp.goto(URL + '/'); await Promise.all([pp.waitForURL(/\/admin$/), pp.click('#adminLink')]);
  await pp.waitForSelector('#login:not(.hide)'); ok(true, 'home: Admin Login link opens admin login');
  await a.click('[data-ra="settings"]'); await a.waitForSelector('#sOpen'); await a.uncheck('#sOpen');
  await Promise.all([a.waitForResponse(r => r.url().endsWith('/api/admin/reg/settings') && r.status() === 200), a.click('[data-ra="savesettings"]')]);
  await pp.goto(URL + '/'); await pp.waitForFunction(() => document.getElementById('regCta').classList.contains('closed'));
  ok((await pp.textContent('#regCta')).includes('registration closed'), 'home: CTA shows "registration closed" when admin closes it');
  await pp.goto(URL + '/register'); await pp.waitForSelector('#closed:not(.hide)'); ok(true, 'form shows closed message');
  await a.click('[data-ra="settings"]'); await a.waitForSelector('#sOpen'); await a.check('#sOpen');
  await Promise.all([a.waitForResponse(r => r.url().endsWith('/api/admin/reg/settings') && r.status() === 200), a.click('[data-ra="savesettings"]')]);
  // watermark + logo on every page
  const tok = (await (await fetch(URL + '/api/reg/teams?year=2026')).json()).teams.length && JSON.parse(await a.evaluate(async () => JSON.stringify((await (await fetch('/api/admin/reg/teams?year=2026')).json()).teams[0].token)));
  for (const [pg, u] of [[pp, '/'], [pp, '/register'], [pp, '/teams'], [pp, '/registration/' + tok], [a, '/admin'], [pp, '/score'], [a, '/score/admin']]) {
    await pg.goto(URL + u); await pg.waitForLoadState('networkidle');
    const w = await watermarkOk(pg);
    ok(w.bg.includes('logo-wm.webp') && w.op > 0 && w.op <= 0.1 && w.pos === 'fixed' && w.pe === 'none' && w.logo && w.wm, 'watermark (fixed, opacity ' + w.op + ') + header logo on ' + u);
  }
  if (wk) {
    const wctx = await wk.newContext(devices['iPhone 13']); const wp = await wctx.newPage();
    for (const u of ['/', '/register', '/admin', '/score']) { await wp.goto(URL + u); await wp.waitForLoadState('networkidle'); const w = await watermarkOk(wp); ok(w.bg.includes('logo-wm.webp') && w.op <= 0.1 && w.logo, 'iPhone Safari: watermark + logo on ' + u); }
    await wctx.close();
  }
  ok(errs.length === 0, 'admin: no JS errors ' + errs.join('; '));
  await chrome.close(); if (wk) await wk.close();
  srv.kill(); await new Promise(r => srv.once('exit', r)); await H.dropSchema(schema);
  console.log('REG E2E TESTS PASSED:', pass, '(screenshots in ' + SHOTS + ')');
})().catch(async e => { console.error('FAIL:', e.stack || e.message); try { srv.kill(); } catch (_) {} try { await H.dropSchema(schema); } catch (_) {} process.exit(1); });
