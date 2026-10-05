'use strict';
// Pure helpers for team registration: input cleaning/validation, settings, reg numbers, CSV.
// No I/O here so it is easy to unit test.

const DEFAULT_SETTINGS = Object.freeze({
  open: true,
  year: 2026,         // registration year; every team is tied to a year (team names are unique per year)
  season: 'RPL Season 7',
  fee: 7000,          // entry fee per team in rupees (0 = hide)
  upiId: '',          // shown on the form only when set
  payeeName: '',      // optional name shown next to the UPI ID
  qrImageId: null,    // payment QR image (stored in DB), shown only when set
  playingCount: 11,   // Playing XI (captain + vice-captain are the first two)
  subsCount: 4,       // substitutes (injury replacement)
  note: '',           // optional extra instructions shown on the form
});

// Remove control / zero-width / bidi characters, normalise unicode and spaces.
function cleanText(v, max) {
  let s = String(v == null ? '' : v).normalize('NFKC');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}
// Names in English letters (the thank-you image fonts are Latin only): letters/numbers/space . ' & ( ) -
const NAME_RE = /^[\p{Script=Latin}0-9][\p{Script=Latin}\p{M}0-9 .'&()\-]*$/u;
function checkName(v, label, max = 40) {
  const s = cleanText(v);
  if (!s) return { error: label + ' is required' };
  if (s.length < 2) return { error: label + ' is too short' };
  if (s.length > max) return { error: label + ' is too long (max ' + max + ' letters)' };
  if (!NAME_RE.test(s)) return { error: label + ': write in English letters (A-Z, 0-9, space . \' & ( ) -)' };
  return { value: s };
}
// Case/space-insensitive key used for uniqueness checks.
const nameKey = (s) => cleanText(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

// 10-digit Indian mobile. Accepts +91 / 91 / 0 prefix, spaces and dashes.
function normalizeMobile(v) {
  let d = String(v == null ? '' : v).replace(/[\s\-().]/g, '');
  if (/^\+91\d{10}$/.test(d)) d = d.slice(3);
  else if (/^91\d{10}$/.test(d)) d = d.slice(2);
  else if (/^0\d{10}$/.test(d)) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

function seasonPrefix(season) {
  const m = String(season || '').match(/(\d+)(?!.*\d)/);
  return 'RPL' + (m ? String(parseInt(m[1], 10)) : '');
}
const regNo = (prefix, seq) => prefix + '-' + String(seq).padStart(3, '0');

const toInt = (v) => (v === '' || v == null || isNaN(Number(v)) ? NaN : Math.trunc(Number(v)));

// Validate admin settings. Returns { settings } or { error }.
function normalizeSettings(input, prev) {
  const p = { ...DEFAULT_SETTINGS, ...(prev || {}) };
  const i = input || {};
  const out = { ...p };
  if (i.open !== undefined) out.open = i.open === true || i.open === 'true' || i.open === 1 || i.open === '1';
  if (i.year !== undefined) {
    const y = toInt(i.year);
    if (!Number.isFinite(y) || y < 2015 || y > 2100) return { error: 'Year must be like 2026' };
    out.year = y;
  }
  if (i.season !== undefined) {
    const s = cleanText(i.season, 60);
    if (s.length < 3 || s.length > 40) return { error: 'Season name must be 3 to 40 letters' };
    if (!NAME_RE.test(s)) return { error: 'Season name: use only letters, numbers and spaces' };
    out.season = s;
  }
  if (i.fee !== undefined) {
    const f = toInt(i.fee);
    if (!Number.isFinite(f) || f < 0 || f > 1000000) return { error: 'Entry fee must be a number from 0 to 1000000' };
    out.fee = f;
  }
  if (i.upiId !== undefined) {
    const u = String(i.upiId || '').trim();
    if (u && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(u)) return { error: 'UPI ID looks wrong (example: name@okaxis)' };
    out.upiId = u;
  }
  if (i.payeeName !== undefined) {
    const n = cleanText(i.payeeName);
    if (n) { const c = checkName(n, 'Payee name', 50); if (c.error) return { error: c.error }; out.payeeName = c.value; } else out.payeeName = '';
  }
  if (i.note !== undefined) out.note = cleanText(i.note, 300);
  for (const [k, lo, hi, label] of [['playingCount', 2, 20, 'Playing players'], ['subsCount', 0, 10, 'Substitutes']]) {
    if (i[k] === undefined) continue;
    const n = toInt(i[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) return { error: label + ' must be ' + lo + ' to ' + hi };
    out[k] = n;
  }
  if (i.qrImageId !== undefined) out.qrImageId = i.qrImageId ? String(i.qrImageId) : null;
  return { settings: out };
}

// Public view of settings (what the form needs).
function publicSettings(s) {
  return { open: !!s.open, year: s.year, season: s.season, fee: s.fee || 0, upiId: s.upiId || '', payeeName: s.payeeName || '',
    qr: !!s.qrImageId, playingCount: s.playingCount, subsCount: s.subsCount, totalPlayers: s.playingCount + s.subsCount, note: s.note || '' };
}

// Validate a team (public form or admin edit).
// body: { teamName, captainName, captainMobile, vcName, vcMobile, playing: [others in XI], subs: [...], paymentDone, utr }
// `playing` holds the Playing XI WITHOUT captain and vice-captain (they are always the first two).
// Returns { value, errors } where errors is { field: message } (empty when valid).
function validateTeam(body, settings, opts = {}) {
  const b = body || {};
  const errors = {};
  const v = {};
  const put = (field, r) => { if (r.error) errors[field] = r.error; return r.value; };
  v.name = put('teamName', checkName(b.teamName, 'Team name', 40));
  v.captainName = put('captainName', checkName(b.captainName, 'Captain name'));
  v.vcName = put('vcName', checkName(b.vcName, 'Vice-captain name'));
  v.captainMobile = normalizeMobile(b.captainMobile);
  if (!v.captainMobile) errors.captainMobile = 'Captain mobile must be a valid 10-digit number';
  v.vcMobile = normalizeMobile(b.vcMobile);
  if (!v.vcMobile) errors.vcMobile = 'Vice-captain mobile must be a valid 10-digit number';
  if (v.captainName && v.vcName && nameKey(v.captainName) === nameKey(v.vcName)) errors.vcName = 'Captain and vice-captain must be different players';

  const needOthers = settings.playingCount - 2, needSubs = settings.subsCount;
  const arr = (x) => (Array.isArray(x) ? x : []);
  const others = arr(b.playing).slice(0, 40), subs = arr(b.subs).slice(0, 40);
  v.others = []; v.subs = [];
  if (others.length !== needOthers) errors.playing = 'Enter exactly ' + needOthers + ' more Playing XI names (captain and vice-captain are already counted)';
  if (subs.length !== needSubs) errors.subs = 'Enter exactly ' + needSubs + ' substitute names';
  others.forEach((x, idx) => { const r = checkName(x, 'Playing XI player ' + (idx + 3)); if (r.error) errors['playing.' + idx] = r.error; else v.others.push(r.value); });
  subs.forEach((x, idx) => { const r = checkName(x, 'Substitute ' + (idx + 1)); if (r.error) errors['subs.' + idx] = r.error; else v.subs.push(r.value); });
  // all names must be unique
  const all = [['captainName', v.captainName], ['vcName', v.vcName]]
    .concat(others.map((x, i) => ['playing.' + i, cleanText(x)]), subs.map((x, i) => ['subs.' + i, cleanText(x)]));
  const seen = new Map();
  for (const [f, n] of all) {
    if (!n) continue;
    const k = nameKey(n);
    if (seen.has(k) && !errors[f]) errors[f] = '"' + n + '" is written twice. Each player only once';
    else seen.set(k, f);
  }
  if (!opts.admin) {
    const pd = String(b.paymentDone || '').toLowerCase();
    if (pd !== 'yes' && pd !== 'no') errors.paymentDone = 'Select if payment is done (Yes / No)';
    v.paymentDone = pd === 'yes';
  }
  const utr = String(b.utr == null ? '' : b.utr).replace(/\s+/g, '');
  if (utr && !/^[A-Za-z0-9]{6,30}$/.test(utr)) errors.utr = 'UTR / transaction ID: only letters and numbers (6 to 30)';
  v.utr = errors.utr ? '' : utr;
  return { value: v, errors };
}

const STATUS_LABEL = { not_paid: 'Not paid', uploaded: 'Screenshot uploaded', verified: 'Verified', rejected: 'Rejected' };

// Build a team record from validated values.
function buildTeam(v, extra) {
  return {
    ...extra,
    name: v.name, nameKey: nameKey(v.name),
    captain: { name: v.captainName, mobile: v.captainMobile },
    vc: { name: v.vcName, mobile: v.vcMobile },
    playing: [v.captainName, v.vcName].concat(v.others),
    subs: v.subs.slice(),
  };
}

// Image type by magic bytes. Returns 'jpeg' | 'png' | 'webp' | 'gif' | 'heic' | null
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(buf.toString('latin1', 8, 12))) return 'heic';
  return null;
}

// CSV with formula-injection protection and Excel-friendly UTF-8 BOM.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function istString(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 330 * 60000);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
}
function teamsCsv(teams) {
  const maxP = Math.max(0, ...teams.map(t => t.playing.length)), maxS = Math.max(0, ...teams.map(t => t.subs.length));
  const head = ['Reg No', 'Year', 'Season', 'Team', 'Captain', 'Captain Mobile', 'Vice-Captain', 'VC Mobile', 'Playing XI count', 'Subs count'];
  for (let i = 1; i <= maxP; i++) head.push('Playing ' + i + (i === 1 ? ' (C)' : i === 2 ? ' (VC)' : ''));
  for (let i = 1; i <= maxS; i++) head.push('Substitute ' + i);
  head.push('Playing XI (all)', 'Substitutes (all)', 'Payment', 'Payment said done', 'Screenshot', 'UTR', 'Fee', 'Admin note', 'Registered (IST)', 'Updated (IST)');
  const rows = [head];
  for (const t of teams) {
    const r = [t.regNo, t.year, t.season, t.name, t.captain.name, t.captain.mobile, t.vc.name, t.vc.mobile, t.playing.length, t.subs.length];
    for (let i = 0; i < maxP; i++) r.push(t.playing[i] || '');
    for (let i = 0; i < maxS; i++) r.push(t.subs[i] || '');
    r.push(t.playing.join('; '), t.subs.join('; '), STATUS_LABEL[t.payment.status] || t.payment.status, t.payment.done ? 'Yes' : 'No',
      t.payment.screenshotId ? 'Yes' : 'No', t.payment.utr || '', t.fee == null ? '' : t.fee, t.payment.note || '', istString(t.created), istString(t.updated));
    rows.push(r);
  }
  return '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { DEFAULT_SETTINGS, cleanText, checkName, nameKey, normalizeMobile, seasonPrefix, regNo, normalizeSettings,
  publicSettings, validateTeam, buildTeam, sniffImage, teamsCsv, csvCell, istString, STATUS_LABEL };
