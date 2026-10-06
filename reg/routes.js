'use strict';
// Team registration: public form API, private thank-you link, public year-wise team list, admin APIs.
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const V = require('./validate.js');
const { processUpload, renderThankYou, UploadError, MAX_INPUT_BYTES } = require('./image.js');

const PUB = path.join(__dirname, '..', 'public');
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const newImageId = () => crypto.randomBytes(16).toString('hex');
const newToken = () => crypto.randomBytes(18).toString('base64url');

// Small in-memory sliding-window rate limiter (single server).
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k); }, 60000).unref();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return Math.ceil((windowMs - (now - list[0])) / 1000); }
    list.push(now); hits.set(key, list); return 0;
  };
}
function parseLimit(s, defMax, defSec) {
  const m = String(s || '').match(/^(\d+)\/(\d+)$/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10) * 1000] : [defMax, defSec * 1000];
}

function createRegistration({ store, isAdmin, requireAdmin, env = process.env }) {
  const st = { teams: [], settings: { ...V.DEFAULT_SETTINGS }, counters: {} };
  let queue = Promise.resolve();
  const serialized = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  const byToken = (t) => st.teams.find(x => x.token === t);
  const byId = (id) => st.teams.find(x => x.id === id);

  const [subMax, subWin] = parseLimit(env.RPL_REG_RATE, 10, 600);       // submissions per IP
  const submitLimit = limiter(subMax, subWin);
  const globalLimit = limiter(parseInt(env.RPL_REG_GLOBAL_RATE, 10) || 300, 600000);
  const lookupLimit = limiter(120, 60000);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_INPUT_BYTES, files: 1, fields: 10, fieldSize: 20000, parts: 12 } });
  const oneFile = (field) => (req, res, next) => upload.single(field)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Screenshot is too big (max 8 MB)', errors: { screenshot: 'Screenshot is too big (max 8 MB)' } });
    return res.status(400).json({ error: 'Upload failed: ' + (err.code === 'LIMIT_UNEXPECTED_FILE' ? 'only one image allowed' : 'bad form data') });
  });
  const ipOf = (req) => req.ip || (req.socket && req.socket.remoteAddress) || '?';
  const rate = (lim) => (req, res, next) => {
    const wait = lim(ipOf(req)) || globalLimit('all');
    if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: 'Too many tries. Please wait ' + Math.ceil(wait / 60) + ' minute(s) and try again.' }); }
    next();
  };
  const requireAdminRead = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Login needed' }));
  // multipart admin uploads: a custom header cannot be sent cross-site without CORS, so it works as a CSRF guard
  const requireAdminUpload = (req, res, next) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Login needed' });
    if (req.get('X-RPL-Admin') !== '1') return res.status(403).json({ error: 'Missing header' });
    next();
  };
  const fail = (res, e) => {
    if (e instanceof UploadError) return res.status(e.status).json({ error: e.message, errors: { screenshot: e.message } });
    console.error('registration error:', e.message || e.code || String(e));
    if (!res.headersSent) res.status(503).json({ error: 'Could not save. Check your internet and try again.' });
  };
  const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => fail(res, e));

  // views
  const publicTeam = (t) => ({ regNo: t.regNo, year: t.year, season: t.season, name: t.name, captain: t.captain.name, vc: t.vc.name,
    playing: t.playing, subs: t.subs, count: t.playing.length + t.subs.length });
  const privateTeam = (t) => ({ ...publicTeam(t), status: t.payment.status, statusLabel: V.STATUS_LABEL[t.payment.status], paymentDone: t.payment.done,
    hasScreenshot: !!t.payment.screenshotId, utr: t.payment.utr || '', created: t.created, fee: t.fee,
    canUploadPayment: t.payment.status !== 'verified' });
  const adminTeam = (t) => ({ ...t, statusLabel: V.STATUS_LABEL[t.payment.status], token: t.token });
  const sortTeams = (list) => list.slice().sort((a, b) => (b.year - a.year) || (a.seq - b.seq) || a.created.localeCompare(b.created));
  const years = () => {
    const m = new Map();
    for (const t of st.teams) m.set(t.year, (m.get(t.year) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([year, count]) => ({ year, count }));
  };
  const parseYear = (q) => { const y = parseInt(q, 10); return y >= 2015 && y <= 2100 ? y : null; };

  // thank-you card cache (team id + updated time)
  const cardCache = new Map();
  async function card(t) {
    const key = t.id + '|' + t.updated;
    if (cardCache.has(key)) return cardCache.get(key);
    const png = await renderThankYou({ season: t.season, teamName: t.name, captain: t.captain.name, vc: t.vc.name, regNo: t.regNo });
    cardCache.set(key, png);
    while (cardCache.size > 20) cardCache.delete(cardCache.keys().next().value);
    return png;
  }

  function mount(app) {
    // registration data changes (admin edits/deletes): never let a browser or proxy reuse an old API response
    app.use(['/api/reg', '/api/admin/reg'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const page = (file, extra) => (req, res) => { if (extra) extra(res); res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(PUB, file)); };
    app.get('/register', page('register.html'));
    app.get('/teams', page('teams.html'));
    const privateHeaders = (res) => res.set({ 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
    app.get('/registration/:token', (req, res) => {
      privateHeaders(res);
      if (!TOKEN_RE.test(req.params.token)) return res.status(404).sendFile(path.join(PUB, 'registration.html'));
      res.sendFile(path.join(PUB, 'registration.html'));
    });
    app.get('/registration/:token/card.png', wrap(async (req, res) => {
      privateHeaders(res);
      const t = TOKEN_RE.test(req.params.token) && byToken(req.params.token);
      if (!t) return res.status(404).json({ error: 'Not found' });
      const png = await card(t);
      res.set('Content-Type', 'image/png');
      if (req.query.download !== undefined) {
        const fname = (t.regNo + '-' + t.name).replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').slice(0, 60) + '.png';
        res.set('Content-Disposition', 'attachment; filename="' + fname + '"');
      }
      res.send(png);
    }));

    app.get('/api/reg/config', (req, res) => { res.set('Cache-Control', 'no-cache'); res.json(V.publicSettings(st.settings)); });
    app.get('/api/reg/qr', wrap(async (req, res) => {
      const id = st.settings.qrImageId;
      const im = id && await store.getImage(id);
      if (!im) return res.status(404).json({ error: 'No QR' });
      res.set({ 'Content-Type': im.mime, 'Cache-Control': 'public, max-age=300', ETag: '"' + id + '"' });
      res.send(im.data);
    }));
    app.get('/api/reg/name-check', rate(lookupLimit), (req, res) => {
      const r = V.checkName(req.query.name, 'Team name', 40);
      if (r.error) return res.json({ available: false, error: r.error });
      const k = V.nameKey(r.value), y = st.settings.year;
      const taken = st.teams.some(t => t.year === y && t.nameKey === k);
      res.json({ available: !taken, error: taken ? 'This team name is already registered for ' + y + '. Choose another name.' : null });
    });
    app.get('/api/reg/years', (req, res) => {
      const ys = years();
      if (!ys.some(y => y.year === st.settings.year)) ys.unshift({ year: st.settings.year, count: 0 });
      res.json({ current: st.settings.year, years: ys.sort((a, b) => b.year - a.year) });
    });
    app.get('/api/reg/teams', (req, res) => {
      const y = parseYear(req.query.year) || st.settings.year;
      const list = sortTeams(st.teams.filter(t => t.year === y)).map(publicTeam);
      res.json({ year: y, season: (list[0] && list[0].season) || (y === st.settings.year ? st.settings.season : ''), teams: list });
    });
    app.get('/api/reg/t/:token', (req, res) => {
      privateHeaders(res);
      const t = TOKEN_RE.test(req.params.token) && byToken(req.params.token);
      if (!t) return res.status(404).json({ error: 'Registration not found' });
      res.json({ team: privateTeam(t), settings: V.publicSettings(st.settings) });
    });

    // Phones remember their registrations in localStorage. The form page asks which of those still exist,
    // so a team deleted by the admin disappears from the "Already registered from this phone" banner.
    app.post('/api/reg/mine', rate(lookupLimit), (req, res) => {
      const tokens = Array.isArray(req.body && req.body.tokens) ? req.body.tokens.slice(0, 20) : null;
      if (!tokens) return res.status(400).json({ error: 'Bad request' });
      const regs = [], gone = [];
      for (const tk of tokens) {
        if (typeof tk !== 'string') continue;
        const t = TOKEN_RE.test(tk) && byToken(tk);
        if (t) regs.push({ token: tk, regNo: t.regNo, team: t.name, year: t.year }); else gone.push(tk);
      }
      res.json({ regs, gone });
    });

    // ---- public submit ----
    app.post('/api/reg/submit', rate(submitLimit), oneFile('screenshot'), wrap(async (req, res) => {
      const s = st.settings;
      if (!s.open) return res.status(403).json({ error: 'Registration is closed right now.' });
      let body;
      try { body = JSON.parse(req.body && req.body.data || '{}'); } catch (e) { return res.status(400).json({ error: 'Bad form data' }); }
      const { value: v, errors } = V.validateTeam(body, s);
      if (v.paymentDone && !req.file && !errors.paymentDone) errors.screenshot = 'Please upload the payment screenshot';
      const fields = Object.keys(errors);
      if (fields.length) return res.status(400).json({ error: errors[fields[0]], errors });
      let image = null;
      if (v.paymentDone) { const p = await processUpload(req.file.buffer); image = { id: newImageId(), ...p }; }
      const out = await serialized(async () => {
        const cur = st.settings;
        if (!cur.open) return { status: 403, body: { error: 'Registration is closed right now.' } };
        const year = cur.year, k = V.nameKey(v.name);
        if (st.teams.some(t => t.year === year && t.nameKey === k)) {
          const msg = 'Team name "' + v.name + '" is already registered for ' + year + '. Choose another name.';
          return { status: 409, body: { error: msg, errors: { teamName: msg } } };
        }
        const prefix = V.seasonPrefix(cur.season), ckey = year + ':' + prefix;
        const seq = (st.counters[ckey] || 0) + 1;
        const now = new Date().toISOString();
        const team = V.buildTeam(v, {
          id: newId(), token: newToken(), year, season: cur.season, seq, regNo: V.regNo(prefix, seq), fee: cur.fee,
          payment: { done: v.paymentDone, status: v.paymentDone ? 'uploaded' : 'not_paid', screenshotId: image ? image.id : null, utr: v.utr, note: '', verifiedAt: null },
          created: now, updated: now,
        });
        team.nameKey = k;
        const counters = { ...st.counters, [ckey]: seq };
        await store.regCommit({ teams: [team], images: image ? [image] : [], counters });
        st.teams.push(team); st.counters = counters;
        return { status: 200, body: { ok: true, regNo: team.regNo, token: team.token, url: '/registration/' + team.token } };
      });
      res.status(out.status).json(out.body);
    }));

    // team pays later: upload screenshot from the private link
    app.post('/api/reg/t/:token/payment', rate(submitLimit), oneFile('screenshot'), wrap(async (req, res) => {
      const t0 = TOKEN_RE.test(req.params.token) && byToken(req.params.token);
      if (!t0) return res.status(404).json({ error: 'Registration not found' });
      if (!req.file) return res.status(400).json({ error: 'Please upload the payment screenshot', errors: { screenshot: 'Please upload the payment screenshot' } });
      const utr = String(req.body && req.body.utr || '').replace(/\s+/g, '');
      if (utr && !/^[A-Za-z0-9]{6,30}$/.test(utr)) return res.status(400).json({ error: 'UTR / transaction ID: only letters and numbers (6 to 30)', errors: { utr: 'Only letters and numbers (6 to 30)' } });
      const p = await processUpload(req.file.buffer);
      const image = { id: newImageId(), ...p };
      const out = await serialized(async () => {
        const t = byToken(req.params.token);
        if (!t) return { status: 404, body: { error: 'Registration not found' } };
        if (t.payment.status === 'verified') return { status: 409, body: { error: 'Payment is already verified. No need to upload again.' } };
        const n = { ...t, payment: { ...t.payment, done: true, status: 'uploaded', screenshotId: image.id, utr: utr || t.payment.utr }, updated: new Date().toISOString() };
        await store.regCommit({ teams: [n], images: [image], deleteImageIds: t.payment.screenshotId ? [t.payment.screenshotId] : [] });
        replace(n);
        return { status: 200, body: { ok: true, team: privateTeam(n) } };
      });
      res.status(out.status).json(out.body);
    }));

    // ---- admin ----
    app.get('/api/admin/reg/teams', requireAdminRead, (req, res) => {
      const y = req.query.year === 'all' ? null : (parseYear(req.query.year) || st.settings.year);
      const list = sortTeams(y ? st.teams.filter(t => t.year === y) : st.teams).map(adminTeam);
      const ys = years(); if (!ys.some(x => x.year === st.settings.year)) ys.unshift({ year: st.settings.year, count: 0 });
      res.json({ year: y, teams: list, years: ys.sort((a, b) => b.year - a.year), settings: st.settings });
    });
    app.get('/api/admin/reg/teams/:id/screenshot', requireAdminRead, wrap(async (req, res) => {
      const t = byId(req.params.id);
      const im = t && t.payment.screenshotId && await store.getImage(t.payment.screenshotId);
      if (!im) return res.status(404).json({ error: 'No screenshot' });
      res.set({ 'Content-Type': im.mime, 'Cache-Control': 'private, no-store' });
      res.send(im.data);
    }));
    app.get('/api/admin/reg/export.csv', requireAdminRead, (req, res) => {
      const y = req.query.year === 'all' || !req.query.year ? null : parseYear(req.query.year);
      const list = sortTeams(y ? st.teams.filter(t => t.year === y) : st.teams);
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rpl-teams-' + (y || 'all-years') + '.csv"', 'Cache-Control': 'no-store' });
      res.send(V.teamsCsv(list));
    });
    const adminWrite = (fn) => [requireAdmin, (req, res) => serialized(() => fn(req, res)).catch(e => fail(res, e))];
    app.post('/api/admin/reg/teams/:id/payment', ...adminWrite(async (req, res) => {
      const t = byId(req.params.id);
      if (!t) return res.status(404).json({ error: 'Team not found. It may be deleted.' });
      const action = req.body && req.body.action, note = V.cleanText(req.body && req.body.note, 200);
      const p = { ...t.payment };
      if (action === 'verify') { p.status = 'verified'; p.verifiedAt = new Date().toISOString(); if (note) p.note = note; }
      else if (action === 'reject') { p.status = 'rejected'; p.verifiedAt = null; p.note = note || p.note || ''; }
      else if (action === 'reset') { p.status = p.screenshotId ? 'uploaded' : 'not_paid'; p.verifiedAt = null; }
      else return res.status(400).json({ error: 'Bad action' });
      const n = { ...t, payment: p, updated: new Date().toISOString() };
      await store.regCommit({ teams: [n] });
      replace(n);
      res.json({ ok: true, team: adminTeam(n) });
    }));
    app.put('/api/admin/reg/teams/:id', ...adminWrite(async (req, res) => {
      const t = byId(req.params.id);
      if (!t) return res.status(404).json({ error: 'Team not found. It may be deleted.' });
      // an existing team keeps its own Playing XI / substitute counts
      const { value: v, errors } = V.validateTeam(req.body, { playingCount: t.playing.length, subsCount: t.subs.length }, { admin: true });
      const f = Object.keys(errors);
      if (f.length) return res.status(400).json({ error: errors[f[0]], errors });
      const k = V.nameKey(v.name);
      if (st.teams.some(x => x.id !== t.id && x.year === t.year && x.nameKey === k)) return res.status(409).json({ error: 'Another team already uses this name in ' + t.year, errors: { teamName: 'Name already used in ' + t.year } });
      const n = V.buildTeam(v, { ...t, payment: { ...t.payment, utr: v.utr, note: req.body.note !== undefined ? V.cleanText(req.body.note, 200) : t.payment.note }, updated: new Date().toISOString() });
      n.nameKey = k;
      await store.regCommit({ teams: [n] });
      replace(n);
      res.json({ ok: true, team: adminTeam(n) });
    }));
    app.delete('/api/admin/reg/teams/:id', ...adminWrite(async (req, res) => {
      const t = byId(req.params.id);
      if (!t) return res.status(404).json({ error: 'Team not found. It may be already deleted.' });
      await store.regCommit({ deleteTeamIds: [t.id], deleteImageIds: t.payment.screenshotId ? [t.payment.screenshotId] : [] });
      st.teams = st.teams.filter(x => x.id !== t.id);
      res.json({ ok: true, id: t.id });
    }));
    app.post('/api/admin/reg/teams/:id/screenshot', requireAdminUpload, oneFile('screenshot'), wrap(async (req, res) => {
      if (!byId(req.params.id)) return res.status(404).json({ error: 'Team not found' });
      if (!req.file) return res.status(400).json({ error: 'Choose an image' });
      const image = { id: newImageId(), ...(await processUpload(req.file.buffer)) };
      const out = await serialized(async () => {
        const t = byId(req.params.id);
        if (!t) return { status: 404, body: { error: 'Team not found' } };
        const n = { ...t, payment: { ...t.payment, done: true, status: t.payment.status === 'verified' ? 'verified' : 'uploaded', screenshotId: image.id }, updated: new Date().toISOString() };
        await store.regCommit({ teams: [n], images: [image], deleteImageIds: t.payment.screenshotId ? [t.payment.screenshotId] : [] });
        replace(n);
        return { status: 200, body: { ok: true, team: adminTeam(n) } };
      });
      res.status(out.status).json(out.body);
    }));
    app.get('/api/admin/reg/settings', requireAdminRead, (req, res) => res.json(st.settings));
    app.put('/api/admin/reg/settings', ...adminWrite(async (req, res) => {
      const b = { ...(req.body || {}) }; delete b.qrImageId;
      const r = V.normalizeSettings(b, st.settings);
      if (r.error) return res.status(400).json({ error: r.error });
      await store.regCommit({ settings: r.settings });
      st.settings = r.settings;
      res.json(st.settings);
    }));
    app.post('/api/admin/reg/qr', requireAdminUpload, oneFile('qr'), wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Choose an image' });
      const image = { id: newImageId(), ...(await processUpload(req.file.buffer, { png: true, max: 1000 })) };
      const out = await serialized(async () => {
        const old = st.settings.qrImageId;
        const settings = { ...st.settings, qrImageId: image.id };
        await store.regCommit({ settings, images: [image], deleteImageIds: old ? [old] : [] });
        st.settings = settings;
        return settings;
      });
      res.json(out);
    }));
    app.delete('/api/admin/reg/qr', ...adminWrite(async (req, res) => {
      const old = st.settings.qrImageId;
      const settings = { ...st.settings, qrImageId: null };
      await store.regCommit({ settings, deleteImageIds: old ? [old] : [] });
      st.settings = settings;
      res.json(settings);
    }));
  }
  function replace(n) { st.teams = st.teams.map(x => (x.id === n.id ? n : x)); }

  async function load() {
    const r = await store.regLoad();
    st.teams = Array.isArray(r.teams) ? r.teams : [];
    st.settings = { ...V.DEFAULT_SETTINGS, ...(r.settings || {}) };
    st.counters = r.counters || {};
    return st;
  }
  return { mount, load, state: st, close: () => serialized(() => {}) };
}

module.exports = { createRegistration, limiter };
