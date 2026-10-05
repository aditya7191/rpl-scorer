// Unit tests for team registration: validation, settings, CSV, image checks, thank-you card, storage (JSON + Postgres).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const sharp = require('sharp');
const V = require('../reg/validate.js');
const { processUpload, renderThankYou } = require('../reg/image.js');
const { createStore } = require('../storage.js');
const H = require('./helpers.js');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
const S = { ...V.DEFAULT_SETTINGS };
const good = () => ({ teamName: '  Rohidas   Royals ', captainName: 'Aditya Solanki', captainMobile: '+91 98200-12345', vcName: 'Rahul Patil', vcMobile: '09876543210',
  playing: ['P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'].map(x => 'Player ' + x), subs: ['Sub A', 'Sub B', 'Sub C', 'Sub D'], paymentDone: 'yes', utr: ' 4123 4567 8901 ' });

(async () => {
  // ---- settings ----
  ok(S.fee === 7000 && S.upiId === '' && S.playingCount === 11 && S.subsCount === 4 && S.year === 2026 && S.season === 'RPL Season 7' && S.open, 'defaults: fee 7000, UPI empty, 11 + 4 players, year 2026, RPL Season 7, open');
  let r = V.normalizeSettings({ fee: '5000', upiId: 'rpl.cricket@okaxis', year: '2027', season: 'RPL Season 8', playingCount: '8', subsCount: '2', open: false }, S);
  ok(!r.error && r.settings.fee === 5000 && r.settings.year === 2027 && r.settings.playingCount === 8 && r.settings.subsCount === 2 && r.settings.open === false, 'settings update ok');
  ok(V.normalizeSettings({ upiId: 'not a upi' }, S).error, 'bad UPI rejected');
  ok(V.normalizeSettings({ fee: -1 }, S).error && V.normalizeSettings({ year: 1999 }, S).error && V.normalizeSettings({ playingCount: 1 }, S).error && V.normalizeSettings({ season: '<script>' }, S).error, 'bad fee/year/count/season rejected');
  ok(V.normalizeSettings({ upiId: '' }, { ...S, upiId: 'a@b' }).settings.upiId === '', 'UPI can be cleared');
  const pub = V.publicSettings(S);
  ok(pub.totalPlayers === 15 && pub.qr === false && !('qrImageId' in pub), 'public settings: total 15, no internal ids');
  // ---- helpers ----
  ok(V.normalizeMobile('+91 98200 12345') === '9820012345' && V.normalizeMobile('919820012345') === '9820012345' && V.normalizeMobile('09820012345') === '9820012345', 'mobile: +91 / 91 / 0 prefixes accepted');
  ok(!V.normalizeMobile('1234567890') && !V.normalizeMobile('98200') && !V.normalizeMobile('98200123456') && !V.normalizeMobile('98a0012345'), 'mobile: bad numbers rejected');
  ok(V.nameKey(' ROHIDAS   royals ') === V.nameKey('rohidas royals') && V.nameKey('Rohidas-Royals') === V.nameKey('rohidas royals'), 'team name key is case/space insensitive');
  ok(V.seasonPrefix('RPL Season 7') === 'RPL7' && V.regNo('RPL7', 1) === 'RPL7-001' && V.regNo('RPL7', 123) === 'RPL7-123' && V.seasonPrefix('Summer Cup') === 'RPL', 'reg numbers RPL7-001');
  ok(V.cleanText('a\u200b\u202eb\n\tc') === 'a b c', 'control / zero-width / bidi characters removed');
  // ---- team validation ----
  let t = V.validateTeam(good(), S);
  ok(Object.keys(t.errors).length === 0, 'valid team passes');
  ok(t.value.name === 'Rohidas Royals' && t.value.captainMobile === '9820012345' && t.value.vcMobile === '9876543210' && t.value.utr === '412345678901' && t.value.paymentDone === true, 'values cleaned (spaces, mobile, UTR)');
  const team = V.buildTeam(t.value, { id: 'x' });
  ok(team.playing.length === 11 && team.playing[0] === 'Aditya Solanki' && team.playing[1] === 'Rahul Patil' && team.subs.length === 4, 'Playing XI = captain + VC + 9, plus 4 substitutes (15 total)');
  t = V.validateTeam({ ...good(), playing: good().playing.slice(0, 8) }, S); ok(t.errors.playing, 'too few Playing XI names rejected');
  t = V.validateTeam({ ...good(), subs: ['A b', 'C d', 'E f'] }, S); ok(t.errors.subs, 'too few substitutes rejected');
  t = V.validateTeam({ ...good(), subs: ['Sub A', 'Sub B', 'Sub C', ''] }, S); ok(t.errors['subs.3'], 'empty substitute name rejected');
  t = V.validateTeam({ ...good(), subs: ['Sub A', 'Sub B', 'Sub C', 'player p5'] }, S); ok(t.errors['subs.3'] && /twice/.test(t.errors['subs.3']), 'duplicate player name (case-insensitive) rejected');
  t = V.validateTeam({ ...good(), vcName: 'aditya  solanki' }, S); ok(t.errors.vcName, 'captain and VC must differ');
  t = V.validateTeam({ ...good(), teamName: '<img src=x onerror=alert(1)>' }, S); ok(t.errors.teamName, 'HTML in team name rejected');
  t = V.validateTeam({ ...good(), captainName: 'राहुल' }, S); ok(t.errors.captainName, 'non-English letters rejected (card fonts are Latin)');
  t = V.validateTeam({ ...good(), teamName: 'x'.repeat(41) }, S); ok(t.errors.teamName, 'team name > 40 chars rejected');
  t = V.validateTeam({ ...good(), captainMobile: '12345' }, S); ok(t.errors.captainMobile, 'bad captain mobile rejected');
  t = V.validateTeam({ ...good(), paymentDone: '' }, S); ok(t.errors.paymentDone, 'payment Yes/No required');
  t = V.validateTeam({ ...good(), utr: 'abc' }, S); ok(t.errors.utr, 'bad UTR rejected');
  t = V.validateTeam({ ...good(), playing: 'not array' }, S); ok(t.errors.playing, 'non-array players rejected');
  t = V.validateTeam({ ...good(), playing: good().playing.slice(0, 6), subs: ['Sub A', 'Sub B'] }, { playingCount: 8, subsCount: 2 }); ok(Object.keys(t.errors).length === 0, 'configurable counts (8 + 2) work');
  // ---- magic bytes ----
  const png = await sharp({ create: { width: 3000, height: 5000, channels: 3, background: '#2266aa' } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa6622' } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#22aa66' } }).webp().toBuffer();
  ok(V.sniffImage(png) === 'png' && V.sniffImage(jpg) === 'jpeg' && V.sniffImage(webp) === 'webp', 'magic bytes: png / jpeg / webp detected');
  ok(V.sniffImage(Buffer.from('<html><script>alert(1)</script></html>')) === null && V.sniffImage(Buffer.from('%PDF-1.4 xxxxxxxxxxx')) === null, 'magic bytes: html / pdf not images');
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(20)]);
  ok(V.sniffImage(heic) === 'heic', 'magic bytes: heic detected');
  // ---- upload processing ----
  let out = await processUpload(png);
  let meta = await sharp(out.data).metadata();
  ok(out.mime === 'image/jpeg' && meta.format === 'jpeg' && Math.max(meta.width, meta.height) === 1600 && meta.height === 1600 && meta.width === 960, 'big PNG resized to max 1600px JPEG (960x1600)');
  out = await processUpload(jpg); meta = await sharp(out.data).metadata();
  ok(meta.width === 800, 'small image not enlarged');
  for (const [buf, msg] of [[Buffer.from('hello world, not an image at all'), 'text file'], [Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbage-garbage-garbage')]), 'fake PNG header + garbage'], [heic, 'HEIC'], [Buffer.alloc(9 * 1024 * 1024, 0xff), '9 MB file']]) {
    let err = null; try { await processUpload(buf); } catch (e) { err = e; }
    ok(err && err.status >= 400, 'rejected upload: ' + msg + ' (' + (err && err.message) + ')');
  }
  const qr = await processUpload(png, { png: true, max: 1000 }); ok(qr.mime === 'image/png' && (await sharp(qr.data).metadata()).height === 1000, 'QR kept as PNG, max 1000px');
  // ---- thank-you card ----
  const card = await renderThankYou({ season: 'RPL Season 7', teamName: 'Rohidas Royals', captain: 'Aditya Solanki', vc: 'Rahul Patil', regNo: 'RPL7-001' });
  meta = await sharp(card).metadata();
  ok(card.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && meta.format === 'png' && meta.width === 1080 && meta.height === 1350, 'thank-you card is a valid PNG 1080x1350');
  const stats = await sharp(card).stats();
  ok(stats.channels[0].stdev > 20 && stats.channels[2].stdev > 20, 'card is not blank (colourful content)');
  const long = await renderThankYou({ season: 'RPL Season 7', teamName: 'Ghatkopar Super Strikers Eleven Club XI', captain: 'Venkataraman Subramaniam Iyer Long', vc: 'Mohammed Abdul Rehman Khan Long', regNo: 'RPL7-999' });
  ok((await sharp(long).metadata()).width === 1080, 'card renders long names');
  // ---- CSV ----
  const tt = { ...V.buildTeam(V.validateTeam(good(), S).value, {}), regNo: 'RPL7-001', year: 2026, season: 'RPL Season 7', fee: 7000, created: '2026-10-05T17:30:00.000Z', updated: '2026-10-05T17:30:00.000Z',
    payment: { done: true, status: 'verified', screenshotId: 'abc', utr: '412345678901', note: '=HYPERLINK("x")' } };
  const csv = V.teamsCsv([tt]);
  const lines = csv.replace(/^\ufeff/, '').trim().split('\r\n');
  const head = lines[0].split(',');
  ok(csv.startsWith('\ufeff') && lines.length === 2, 'CSV has BOM + header + 1 row');
  ok(head.includes('Playing 1 (C)') && head.includes('Playing 11') && head.includes('Substitute 4') && head.includes('Year') && head.includes('Playing XI count') && head.includes('Subs count'), 'CSV shows Playing XI / substitutes split and year');
  ok(lines[1].includes('Verified') && lines[1].includes('9820012345') && lines[1].includes('2026-10-05 23:00 IST'), 'CSV row has status, mobile, IST time');
  ok(lines[1].includes(`"'=HYPERLINK(""x"")"`), 'CSV formula injection neutralised');

  // ---- storage (registration part) ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpl-u-'));
  const schema = H.testSchema();
  const store = createStore({ ...process.env, RPL_PG_SCHEMA: schema }, dir);
  await store.init();
  let L = await store.regLoad(); ok(L.teams.length === 0 && L.settings === null, 'storage (' + store.kind + '): empty at start');
  const img = { id: 'a'.repeat(32), mime: 'image/jpeg', data: out.data };
  const t1 = { ...tt, id: 't1', token: 'tok1'.repeat(6), nameKey: 'rohidas royals' };
  await store.regCommit({ teams: [t1], images: [img], counters: { '2026:RPL7': 1 }, settings: { ...S, upiId: 'x@y' } });
  L = await store.regLoad();
  ok(L.teams.length === 1 && L.teams[0].name === 'Rohidas Royals' && L.counters['2026:RPL7'] === 1 && L.settings.upiId === 'x@y', 'storage: team + counters + settings saved');
  const gi = await store.getImage(img.id); ok(gi && gi.mime === 'image/jpeg' && Buffer.compare(gi.data, out.data) === 0, 'storage: image bytes round-trip exactly');
  if (H.usePg) {
    let dup = null; try { await store.regCommit({ teams: [{ ...t1, id: 't2', token: 'tok2'.repeat(6) }] }); } catch (e) { dup = e; }
    ok(dup && dup.code === '23505', 'Postgres: unique (year, name) enforced by DB too');
    await store.regCommit({ teams: [{ ...t1, id: 't3', token: 'tok3'.repeat(6), year: 2027 }] });
    ok((await store.regLoad()).teams.length === 2, 'Postgres: same name allowed in another year');
    await store.regCommit({ deleteTeamIds: ['t3'] });
  }
  await store.regCommit({ deleteTeamIds: ['t1'], deleteImageIds: [img.id] });
  L = await store.regLoad(); ok(L.teams.length === 0 && !(await store.getImage(img.id)), 'storage: team and screenshot deleted');
  await store.close(); await H.dropSchema(schema);
  console.log('REG UNIT TESTS PASSED:', pass);
})().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
