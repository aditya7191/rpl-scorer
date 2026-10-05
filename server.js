'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const E = require('./public/engine.js');
const { createStore } = require('./storage.js');
const { createRegistration } = require('./reg/routes.js');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const PASSWORD = process.env.RPL_ADMIN_PASSWORD;
if (!PASSWORD) { console.error('ERROR: set RPL_ADMIN_PASSWORD env var'); process.exit(1); }
// Cookie signing key. Set SESSION_SECRET in production; otherwise derived from the admin password
// (still stable across restarts). Changing either one logs the admin out everywhere.
const SECRET = process.env.SESSION_SECRET
  ? crypto.createHash('sha256').update('rpl-session-secret:' + process.env.SESSION_SECRET).digest()
  : crypto.createHash('sha256').update('rpl-session:' + (process.env.RPL_SESSION_SECRET || '') + ':' + PASSWORD).digest();
const COOKIE = 'rpl_admin';

// ---------- storage ----------
// Single server: all matches are cached in memory; every change is written to the store
// (Postgres if DATABASE_URL is set, else data/db.json) and only then applied in memory and replied.
const store = createStore(process.env, path.join(__dirname, 'data'));
let db = { currentId: null, matches: [] };
const findMatch = (id) => db.matches.find(m => m.id === id);
const current = () => (db.currentId ? findMatch(db.currentId) : null);

// Run admin changes one at a time (check + change + durable write), so taps never interleave.
let queue = Promise.resolve();
function serialized(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }
// Apply a change to copies, persist, then swap into memory. If the write fails nothing changes.
async function commit(changedMatches, currentId, deletedIds = []) {
  const byId = new Map(changedMatches.map(m => [m.id, m]));
  const gone = new Set(deletedIds);
  const matches = db.matches.filter(m => !gone.has(m.id)).map(m => byId.get(m.id) || m);
  for (const m of changedMatches) if (!db.matches.some(x => x.id === m.id)) matches.push(m);
  const next = { currentId: currentId === undefined ? db.currentId : currentId, matches };
  await store.commit(next, changedMatches, deletedIds);
  db = next;
  for (const id of deletedIds) broadcastEvent('deleted', { id });
  broadcast();
}
const clone = (m) => JSON.parse(JSON.stringify(m));
// Wrap async admin handlers: serialize + turn storage errors into a 503 the admin can retry.
const adminRoute = (fn) => (req, res) => serialized(() => fn(req, res)).catch(e => {
  console.error('save failed:', e.message || e.code || String(e));
  if (!res.headersSent) res.status(503).json({ error: 'Could not save. Check connection and try again.', state: liveState() });
});

// ---------- auth ----------
function sign(exp) { return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex'); }
function makeToken() { const exp = Date.now() + 30 * 24 * 3600 * 1000; return exp + '.' + sign(exp); }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = String(t).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); }
  return null;
}
const isAdmin = (req) => validToken(getCookie(req, COOKIE));
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Login needed' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON only' }); // CSRF guard
  next();
}

// ---------- live updates (SSE) ----------
const clients = new Set();
function liveState() { const m = current(); return m ? E.compute(m) : null; }
function broadcastEvent(name, payload) {
  const data = 'event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const res of clients) res.write(data);
}
const broadcast = () => broadcastEvent('update', liveState());
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
// team registration (/register, /teams, /registration/<token>, admin Teams tab APIs)
const reg = createRegistration({ store, isAdmin: (req) => isAdmin(req), requireAdmin: (req, res, next) => requireAdmin(req, res, next) });
reg.mount(app);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: 0 }));

app.get('/healthz', async (req, res) => {
  if (req.query.db === undefined) return res.json({ ok: true, storage: store.kind });
  try { await store.ping(); res.json({ ok: true, storage: store.kind, db: 'up' }); }
  catch (e) { res.status(503).json({ ok: false, storage: store.kind, db: 'down' }); }
});
app.get('/api/live', (req, res) => res.json(liveState()));
app.get('/api/matches', (req, res) => {
  res.json(db.matches.slice().reverse().map(m => {
    const st = E.compute(m);
    return { id: m.id, created: m.created, teamA: st.setup.teamA, teamB: st.setup.teamB, status: st.abandoned ? 'abandoned' : st.status,
      result: st.result ? st.result.text : null, mom: m.mom ? m.mom.name : null, current: m.id === db.currentId,
      scores: st.innings.filter(i => i.started).map(i => i.batTeam + ' ' + i.runs + '/' + i.wkts + ' (' + i.oversText + ')') };
  }));
});
app.get('/api/matches/:id', (req, res) => {
  const m = findMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(E.compute(m));
});
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write('event: update\ndata: ' + JSON.stringify(liveState()) + '\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// admin
let lastFail = 0;
app.post('/api/admin/login', (req, res) => {
  if (Date.now() - lastFail < 1000) return res.status(429).json({ error: 'Wait 1 second and try again' });
  const p = String((req.body && req.body.password) || '');
  const a = crypto.createHash('sha256').update(p).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) { lastFail = Date.now(); return res.status(401).json({ error: 'Wrong password' }); }
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', COOKIE + '=' + encodeURIComponent(makeToken()) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + 30 * 24 * 3600 + secure);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.set('Set-Cookie', COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

app.post('/api/admin/match', requireAdmin, adminRoute(async (req, res) => {
  const setup = E.normalizeSetup(req.body && req.body.setup);
  const err = E.validateSetup(setup);
  if (err) return res.status(400).json({ error: err });
  const changed = [];
  const cur = current();
  if (cur) { const st = E.compute(cur); if (st.status !== 'done') { const c = clone(cur); c.abandoned = true; changed.push(c); } }
  const m = { id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), created: new Date().toISOString(), setup, events: [], mom: null };
  changed.push(m);
  await commit(changed, m.id);
  res.json(E.compute(m));
}));
app.post('/api/admin/event', requireAdmin, adminRoute(async (req, res) => {
  const m = current();
  if (!m) return res.status(400).json({ error: 'No match. Start a new match.' });
  const ev = req.body && req.body.event;
  // optimistic concurrency: client tells which event count it saw (prevents double taps from two phones)
  if (req.body.expect !== undefined && req.body.expect !== m.events.length) return res.status(409).json({ error: 'Score changed on another device. Refreshed.', state: E.compute(m) });
  const st = E.compute(m);
  const clean = sanitizeEvent(ev);
  const err = clean ? E.apply(st, clean) : 'Bad event';
  if (err) return res.status(400).json({ error: err, state: E.compute(m) });
  const n = clone(m); n.events.push(clean); n.abandoned = false;
  await commit([n]);
  res.json(E.compute(n));
}));
app.post('/api/admin/undo', requireAdmin, adminRoute(async (req, res) => {
  const m = current();
  if (!m || !m.events.length) return res.status(400).json({ error: 'Nothing to undo' });
  if (req.body.expect !== undefined && req.body.expect !== m.events.length) return res.status(409).json({ error: 'Score changed on another device. Refreshed.', state: E.compute(m) });
  const n = clone(m); n.events.pop(); n.mom = null;
  await commit([n]);
  res.json(E.compute(n));
}));
app.post('/api/admin/mom', requireAdmin, adminRoute(async (req, res) => {
  const m = current();
  if (!m) return res.status(400).json({ error: 'No match' });
  const st = E.compute(m);
  if (!st.result) return res.status(400).json({ error: 'Match not finished' });
  const key = String(req.body.key || '');
  const p = st.momSuggest.find(x => x.key === key);
  if (!p) return res.status(400).json({ error: 'Pick a player' });
  const n = clone(m); n.mom = { key: p.key, name: p.name, team: p.team, teamName: p.teamName, pts: p.pts };
  await commit([n]);
  res.json(E.compute(n));
}));
// Delete a match permanently (any match, including the current one). Admin only.
app.delete('/api/admin/matches/:id', requireAdmin, adminRoute(async (req, res) => {
  const m = findMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found. It may be already deleted.' });
  const wasCurrent = m.id === db.currentId;
  await commit([], wasCurrent ? null : undefined, [m.id]);
  res.json({ ok: true, id: m.id, wasCurrent, state: liveState() });
}));

function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const str = (x) => String(x == null ? '' : x).slice(0, 60);
  switch (ev.t) {
    case 'openers': return { t: 'openers', striker: str(ev.striker), nonStriker: str(ev.nonStriker), bowler: str(ev.bowler) };
    case 'batsman': return { t: 'batsman', name: str(ev.name) };
    case 'bowler': return { t: 'bowler', name: str(ev.name) };
    case 'ball': {
      const o = { t: 'ball', kind: str(ev.kind), runs: parseInt(ev.runs, 10) || 0 };
      if (ev.kind === 'wicket' && ev.wkt) o.wkt = { how: str(ev.wkt.how), out: str(ev.wkt.out || 'striker'), fielder: str(ev.wkt.fielder).trim() };
      return o;
    }
    default: return null;
  }
}

// ---------- start ----------
let server;
store.init().then(async (loaded) => {
  db = { currentId: loaded.currentId || null, matches: Array.isArray(loaded.matches) ? loaded.matches : [] };
  const r = await reg.load();
  console.log('Storage: ' + store.describe() + ' - ' + db.matches.length + ' match(es), ' + r.teams.length + ' registered team(s) loaded');
  server = app.listen(PORT, () => console.log('RPL Scorer running on http://localhost:' + PORT + '  (admin: /admin)'));
}).catch((e) => { console.error('ERROR: storage init failed:', e.message || e.code || String(e)); process.exit(1); });

function shutdown(sig) {
  console.log(sig + ' received, shutting down');
  for (const res of clients) res.end();
  const done = () => Promise.all([serialized(() => {}), reg.close()]).then(() => store.close()).finally(() => process.exit(0));
  if (server) { server.close(done); if (server.closeIdleConnections) server.closeIdleConnections(); } else done();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
