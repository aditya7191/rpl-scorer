/* Admin: Teams tab (registrations), settings, and loading registered teams into New Match. */
/* Uses $, api, openModal, closeModal, UI from admin.html (called after that script has run). */
let regData = null, regYear = null, regBusy = false;
const ST_LABEL = { not_paid: 'Not paid', uploaded: 'Screenshot uploaded', verified: 'Verified', rejected: 'Rejected' };
const resc = (s) => UI.esc(s);
const statusPill = (t) => '<span class="pill st-' + resc(t.payment.status) + '">' + resc(ST_LABEL[t.payment.status] || t.payment.status) + '</span>';

async function loadTeams(year) {
  const y = year || regYear || '';
  try {
    const r = await fetch('/api/admin/reg/teams' + (y ? '?year=' + encodeURIComponent(y) : ''), { cache: 'no-store' });
    if (r.status === 401) { showLogin(); return; }
    regData = await r.json();
  } catch (e) { UI.toast('Could not load teams'); return; }
  regYear = regData.year;
  $('tYear').innerHTML = regData.years.map(x => '<option value="' + x.year + '">' + x.year + ' (' + x.count + ')</option>').join('') + '<option value="all">All years</option>';
  $('tYear').value = regYear == null ? 'all' : String(regYear);
  $('csvBtn').href = '/api/admin/reg/export.csv?year=' + (regYear == null ? 'all' : regYear);
  const s = regData.settings;
  $('regOpen').innerHTML = s.open ? '<b style="color:var(--grn)">Registration OPEN</b> for ' + s.year + ' (' + resc(s.season) + ')' : '<b class="err">Registration CLOSED</b>';
  renderTeams();
}
function renderTeams() {
  if (!regData) return;
  const q = $('tSearch').value.trim().toLowerCase(), f = $('tStatus').value;
  const all = regData.teams;
  const cnt = (k) => all.filter(t => t.payment.status === k).length;
  $('tStats').innerHTML = '<div><b>' + all.length + '</b>Teams</div><div><b>' + cnt('verified') + '</b>Verified</div><div><b>' + cnt('uploaded') + '</b>To check</div><div><b>' + (cnt('not_paid') + cnt('rejected')) + '</b>Not paid</div>';
  const list = all.filter(t => (!f || t.payment.status === f) && (!q || [t.name, t.regNo, t.captain.name, t.vc.name, t.captain.mobile, t.vc.mobile].concat(t.playing, t.subs).some(x => String(x).toLowerCase().includes(q))));
  $('tList').innerHTML = list.length ? list.map(t => '<div class="card match" data-tid="' + resc(t.id) + '"><div class="row"><b>' + resc(t.name) + '</b>' + statusPill(t) + '</div>' +
    '<div class="mut">' + resc(t.regNo) + (regYear == null ? ' · ' + t.year : '') + ' · C: ' + resc(t.captain.name) + ' (' + resc(t.captain.mobile) + ') · VC: ' + resc(t.vc.name) + '</div>' +
    '<div class="mut">' + t.playing.length + ' playing + ' + t.subs.length + ' subs · ' + UI.when(t.created) + '</div></div>').join('')
    : '<div class="card mut">' + (all.length ? 'No team matches the filter.' : 'No teams registered for this year yet.') + '</div>';
}
const findTeam = (id) => regData && regData.teams.find(t => t.id === id);
function teamDetails(id) {
  const t = findTeam(id); if (!t) return UI.toast('Team not found');
  const p = t.payment;
  openModal('<div class="row"><h2>' + resc(t.name) + '</h2>' + statusPill(t) + '</div>' +
    '<div class="kv"><b>Reg. No.</b><span>' + resc(t.regNo) + '</span><b>Year</b><span>' + t.year + ' · ' + resc(t.season) + '</span>' +
    '<b>Captain</b><span>' + resc(t.captain.name) + ' · <a href="tel:' + resc(t.captain.mobile) + '">' + resc(t.captain.mobile) + '</a></span>' +
    '<b>Vice-captain</b><span>' + resc(t.vc.name) + ' · <a href="tel:' + resc(t.vc.mobile) + '">' + resc(t.vc.mobile) + '</a></span>' +
    '<b>Players</b><span>' + (t.playing.length + t.subs.length) + ' (' + t.playing.length + ' Playing XI + ' + t.subs.length + ' substitutes)</span>' +
    '<b>Payment</b><span>Team said: ' + (p.done ? 'Yes, paid' : 'Not yet') + (t.fee ? ' · Fee ₹' + Number(t.fee).toLocaleString('en-IN') : '') + '</span>' +
    (p.utr ? '<b>UTR</b><span>' + resc(p.utr) + '</span>' : '') + (p.note ? '<b>Note</b><span>' + resc(p.note) + '</span>' : '') +
    '<b>Registered</b><span>' + UI.when(t.created) + '</span></div>' +
    '<h3>Playing XI (' + t.playing.length + ')</h3><ol class="list2">' + t.playing.map((x, i) => '<li>' + resc(x) + (i === 0 ? ' (C)' : i === 1 ? ' (VC)' : '') + '</li>').join('') + '</ol>' +
    '<h3>Substitutes – injury replacement (' + t.subs.length + ')</h3><ol class="list2" start="' + (t.playing.length + 1) + '">' + t.subs.map(x => '<li>' + resc(x) + '</li>').join('') + '</ol>' +
    '<h3>Payment screenshot</h3>' + (p.screenshotId ? '<a href="/api/admin/reg/teams/' + encodeURIComponent(t.id) + '/screenshot" target="_blank"><img class="shot" id="shotImg" alt="Payment screenshot" src="/api/admin/reg/teams/' + encodeURIComponent(t.id) + '/screenshot?v=' + encodeURIComponent(p.screenshotId) + '"></a>' : '<div class="mut">No screenshot uploaded.</div>') +
    '<label>Upload / replace screenshot (if team sent it on WhatsApp)</label><input type="file" accept="image/*" id="admShot">' +
    '<label>Note (optional, e.g. reason for reject)</label><input id="payNote" maxlength="200" value="' + resc(p.note || '') + '">' +
    '<div class="btnrow"><button class="big" data-ra="verify" data-id="' + resc(t.id) + '" style="background:var(--grn)">✅ Verify payment</button><button class="big danger" data-ra="reject" data-id="' + resc(t.id) + '">❌ Reject</button></div>' +
    (p.status === 'verified' || p.status === 'rejected' ? '<button class="big sec" data-ra="reset" data-id="' + resc(t.id) + '">↩️ Undo verify / reject</button>' : '') +
    '<div class="btnrow"><button class="big sec" data-ra="edit" data-id="' + resc(t.id) + '">✏️ Edit team</button><button class="big del" data-ra="askdel" data-id="' + resc(t.id) + '">🗑️ Delete team</button></div>' +
    '<a class="big sec" style="display:block;text-align:center;text-decoration:none" target="_blank" href="/registration/' + encodeURIComponent(t.token) + '">🎉 Open team\'s thank-you card / private link</a>' +
    '<a class="big sec" style="display:block;text-align:center;text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/91' + resc(t.captain.mobile) + '?text=' + encodeURIComponent('RPL ' + t.regNo + ' – ' + t.name + ': your registration link ' + location.origin + '/registration/' + t.token) + '">💬 WhatsApp captain</a>' +
    '<button class="big sec" data-act="close">Close</button>');
  const inp = $('admShot');
  if (inp) inp.onchange = () => uploadAdminShot(t.id, inp.files[0]);
}
async function uploadAdminShot(id, file) {
  if (!file) return;
  const fd = new FormData(); fd.append('screenshot', file);
  try {
    const r = await fetch('/api/admin/reg/teams/' + encodeURIComponent(id) + '/screenshot', { method: 'POST', body: fd, headers: { 'X-RPL-Admin': '1' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    replaceTeam(j.team); teamDetails(id); UI.toast('Screenshot saved');
  } catch (e) { UI.toast(e.message); }
}
function replaceTeam(t) { regData.teams = regData.teams.map(x => (x.id === t.id ? t : x)); renderTeams(); }
async function payAction(id, action) {
  if (regBusy) return; regBusy = true;
  try {
    const r = await api('/api/admin/reg/teams/' + encodeURIComponent(id) + '/payment', { action, note: ($('payNote') || {}).value || '' });
    replaceTeam(r.team); teamDetails(id); UI.toast(action === 'verify' ? 'Payment verified' : action === 'reject' ? 'Payment rejected' : 'Status reset');
  } catch (e) { UI.toast(e.message); } finally { regBusy = false; }
}
function editTeam(id) {
  const t = findTeam(id); if (!t) return;
  const inp = (fid, label, val, extra) => '<label>' + label + '</label><input id="' + fid + '" value="' + resc(val) + '" maxlength="40"' + (extra || '') + '>';
  openModal('<h2>Edit ' + resc(t.name) + '</h2>' + inp('eName', 'Team name', t.name) +
    '<div class="two"><div>' + inp('eCap', 'Captain', t.captain.name) + '</div><div>' + inp('eCapM', 'Captain mobile', t.captain.mobile, ' type="tel" inputmode="numeric"') + '</div></div>' +
    '<div class="two"><div>' + inp('eVc', 'Vice-captain', t.vc.name) + '</div><div>' + inp('eVcM', 'VC mobile', t.vc.mobile, ' type="tel" inputmode="numeric"') + '</div></div>' +
    '<h3>Playing XI (3 to ' + t.playing.length + '; 1 = captain, 2 = VC)</h3>' + t.playing.slice(2).map((x, i) => '<div class="prow"><span class="no">' + (i + 3) + '</span><input class="eP" value="' + resc(x) + '" maxlength="40"></div>').join('') +
    '<h3>Substitutes</h3>' + t.subs.map((x, i) => '<div class="prow"><span class="no sub">' + (t.playing.length + i + 1) + '</span><input class="eS" value="' + resc(x) + '" maxlength="40"></div>').join('') +
    inp('eUtr', 'UTR / transaction ID', t.payment.utr || '', ' maxlength="30"') + inp('eNote', 'Admin note', t.payment.note || '', ' maxlength="200"') +
    '<div id="eErr" class="err"></div><button class="big" data-ra="saveedit" data-id="' + resc(t.id) + '">💾 Save changes</button><button class="big sec" data-ra="details" data-id="' + resc(t.id) + '">Cancel</button>');
}
async function saveEdit(id) {
  const body = { teamName: $('eName').value, captainName: $('eCap').value, captainMobile: $('eCapM').value, vcName: $('eVc').value, vcMobile: $('eVcM').value,
    playing: [...document.querySelectorAll('.eP')].map(i => i.value), subs: [...document.querySelectorAll('.eS')].map(i => i.value), utr: $('eUtr').value, note: $('eNote').value };
  try { const r = await api('/api/admin/reg/teams/' + encodeURIComponent(id), body, 'PUT'); replaceTeam(r.team); teamDetails(id); UI.toast('Team saved'); }
  catch (e) { $('eErr').textContent = e.message; }
}
function askDelTeam(id) {
  const t = findTeam(id); if (!t) return;
  openModal('<h2>Delete this team permanently?</h2><div class="card" style="background:#0b1222"><b>' + resc(t.name) + '</b><div class="mut">' + resc(t.regNo) + ' · ' + t.year + ' · Captain ' + resc(t.captain.name) + '</div></div>' +
    '<div>This cannot be undone. The team, its players and payment screenshot will be removed. The team\'s private link will stop working.</div>' +
    '<button class="big danger" data-ra="delok" data-id="' + resc(t.id) + '">Yes, delete team</button><button class="big sec" data-ra="details" data-id="' + resc(t.id) + '">No, keep it</button>');
}
async function delTeam(id) {
  if (regBusy) return; regBusy = true;
  try { await api('/api/admin/reg/teams/' + encodeURIComponent(id), {}, 'DELETE'); closeModal(); UI.toast('Team deleted'); await loadTeams(); }
  catch (e) { UI.toast(e.message); } finally { regBusy = false; }
}
function settingsForm() {
  const s = regData.settings;
  $('settingsCard').innerHTML = '<h2>Registration settings</h2>' +
    '<label class="switch"><input type="checkbox" id="sOpen"' + (s.open ? ' checked' : '') + '> Registration open</label>' +
    '<div class="two"><div><label>Registration year</label><input id="sYear" type="number" inputmode="numeric" value="' + s.year + '"></div><div><label>Season name</label><input id="sSeason" maxlength="40" value="' + resc(s.season) + '"></div></div>' +
    '<div class="two"><div><label>Entry fee (₹, 0 = hide)</label><input id="sFee" type="number" inputmode="numeric" value="' + s.fee + '"></div><div><label>UPI ID (empty = hide)</label><input id="sUpi" value="' + resc(s.upiId) + '" placeholder="name@okaxis" autocapitalize="off"></div></div>' +
    '<label>Payee name shown with UPI (optional)</label><input id="sPayee" maxlength="50" value="' + resc(s.payeeName) + '">' +
    '<div class="two"><div><label>Playing XI count</label><input id="sPlay" type="number" inputmode="numeric" value="' + s.playingCount + '"></div><div><label>Substitutes count</label><input id="sSubs" type="number" inputmode="numeric" value="' + s.subsCount + '"></div></div>' +
    '<div class="mut">Total players per team = Playing XI + substitutes (now ' + (s.playingCount + s.subsCount) + '). Captain and VC are part of the Playing XI.</div>' +
    '<label>Note shown on form (optional, e.g. last date)</label><input id="sNote" maxlength="300" value="' + resc(s.note) + '">' +
    '<label>Payment QR image</label>' + (s.qrImageId ? '<img src="/api/reg/qr?v=' + resc(s.qrImageId) + '" style="max-width:160px;background:#fff;border-radius:8px;display:block" alt="QR"><button class="big sec" data-ra="delqr">Remove QR</button>' : '<div class="mut">No QR set.</div>') +
    '<input type="file" accept="image/*" id="sQr">' +
    '<div id="sErr" class="err"></div><button class="big" data-ra="savesettings">💾 Save settings</button>' +
    '<div class="mut">Changing the year starts a new registration year. Team names only need to be unique within a year. Old years stay in the history.</div>';
  $('sQr').onchange = uploadQr;
}
async function saveSettings() {
  const body = { open: $('sOpen').checked, year: $('sYear').value, season: $('sSeason').value, fee: $('sFee').value, upiId: $('sUpi').value.trim(),
    payeeName: $('sPayee').value, playingCount: $('sPlay').value, subsCount: $('sSubs').value, note: $('sNote').value };
  try { const s = await api('/api/admin/reg/settings', body, 'PUT'); regData.settings = s; UI.toast('Settings saved'); $('settingsCard').classList.add('hide'); await loadTeams(s.year); }
  catch (e) { $('sErr').textContent = e.message; }
}
async function uploadQr() {
  const f = $('sQr').files[0]; if (!f) return;
  const fd = new FormData(); fd.append('qr', f);
  try {
    const r = await fetch('/api/admin/reg/qr', { method: 'POST', body: fd, headers: { 'X-RPL-Admin': '1' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    regData.settings = j; settingsForm(); UI.toast('QR saved');
  } catch (e) { $('sErr').textContent = e.message; }
}
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-tid]');
  if (card && !e.target.closest('button,a')) return teamDetails(card.dataset.tid);
  const b = e.target.closest('[data-ra]'); if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.ra) {
    case 'details': return teamDetails(id);
    case 'verify': return payAction(id, 'verify');
    case 'reject': return payAction(id, 'reject');
    case 'reset': return payAction(id, 'reset');
    case 'edit': return editTeam(id);
    case 'saveedit': return saveEdit(id);
    case 'askdel': return askDelTeam(id);
    case 'delok': return delTeam(id);
    case 'settings': settingsForm(); $('settingsCard').classList.toggle('hide'); return;
    case 'savesettings': return saveSettings();
    case 'delqr': return api('/api/admin/reg/qr', {}, 'DELETE').then(s => { regData.settings = s; settingsForm(); UI.toast('QR removed'); }).catch(err => UI.toast(err.message));
  }
});
document.addEventListener('DOMContentLoaded', () => {
  $('tYear').onchange = () => loadTeams($('tYear').value);
  $('tStatus').onchange = renderTeams;
  $('tSearch').oninput = renderTeams;
  $('pickA').onchange = () => pickTeam('A');
  $('pickB').onchange = () => pickTeam('B');
});
// ---- New Match: load registered teams ----
let pickList = [];
async function loadPicks() {
  try {
    const r = await fetch('/api/admin/reg/teams', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json(); pickList = j.teams;
    if (!pickList.length) { $('regPick').classList.add('hide'); return; }
    const opts = '<option value="">- type manually -</option>' + pickList.map(t => '<option value="' + resc(t.id) + '">' + resc(t.name) + ' (' + resc(t.regNo) + ')</option>').join('');
    for (const k of ['pickA', 'pickB']) { const v = $(k).value; $(k).innerHTML = opts; $(k).value = pickList.some(t => t.id === v) ? v : ''; }
    $('regPick').classList.remove('hide');
  } catch (e) { /* ignore */ }
}
function pickTeam(side) {
  const t = pickList.find(x => x.id === $('pick' + side).value); if (!t) return;
  $('team' + side).value = t.name;
  $('players' + side).value = t.playing.join('\n');
  syncToss();
  UI.toast(t.name + ' loaded (Playing XI). Subs: ' + (t.subs.join(', ') || 'none'));
}
