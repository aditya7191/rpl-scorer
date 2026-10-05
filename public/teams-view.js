/* Public year-wise registered teams list (used on the home page and /teams). No mobiles, no payment info. */
window.TeamsView = function (root, opts) {
  opts = opts || {};
  const esc = RC.esc;
  root.innerHTML = '<div class="card"><div class="toolbar"><label style="margin:0" for="tvYear">Year</label><select id="tvYear"></select>' +
    '<input id="tvQ" type="search" placeholder="Search team or player"></div><div class="mut" id="tvSummary" style="margin-top:8px"></div></div><div id="tvList"></div>';
  const $ = (id) => root.querySelector('#' + id);
  let data = null;
  function render() {
    const q = $('tvQ').value.trim().toLowerCase();
    const teams = data.teams.filter(t => !q || [t.name, t.captain, t.vc].concat(t.playing, t.subs).some(x => x.toLowerCase().includes(q)));
    const players = data.teams.reduce((a, t) => a + t.count, 0);
    $('tvSummary').textContent = data.teams.length + ' team' + (data.teams.length === 1 ? '' : 's') + ' registered in ' + data.year + (data.season ? ' (' + data.season + ')' : '') + ' · ' + players + ' players';
    $('tvList').innerHTML = teams.length ? teams.map(t => '<div class="card tteam"><div class="row"><h2>' + esc(t.name) + '</h2><span class="pill">' + esc(t.regNo) + '</span></div>' +
      '<div class="mut">Captain: <b style="color:var(--txt)">' + esc(t.captain) + '</b> · VC: <b style="color:var(--txt)">' + esc(t.vc) + '</b> · ' + t.count + ' players</div>' +
      '<h3>Playing XI (' + t.playing.length + ')</h3><ol class="list2">' + t.playing.map((p, i) => '<li>' + esc(p) + (i === 0 ? ' (C)' : i === 1 ? ' (VC)' : '') + '</li>').join('') + '</ol>' +
      (t.subs.length ? '<h3>Substitutes (' + t.subs.length + ')</h3><ol class="list2" start="' + (t.playing.length + 1) + '">' + t.subs.map(p => '<li>' + esc(p) + '</li>').join('') + '</ol>' : '') + '</div>').join('')
      : '<div class="card mut">' + (q ? 'No match for your search.' : 'No teams registered for ' + data.year + ' yet.') + '</div>';
  }
  async function load(year) {
    data = await RC.getJSON('/api/reg/teams?year=' + encodeURIComponent(year));
    if (opts.syncUrl) { const u = new URL(location.href); u.searchParams.set('year', data.year); history.replaceState(null, '', u); }
    render();
  }
  async function init() {
    const y = await RC.getJSON('/api/reg/years');
    const want = parseInt(new URLSearchParams(location.search).get('year'), 10) || null;
    const years = y.years.map(x => x.year);
    if (want && !years.includes(want)) years.push(want);
    years.sort((a, b) => b - a);
    $('tvYear').innerHTML = years.map(v => { const c = (y.years.find(x => x.year === v) || { count: 0 }).count; return '<option value="' + v + '">' + v + ' (' + c + ' team' + (c === 1 ? '' : 's') + ')</option>'; }).join('');
    $('tvYear').value = String(want || y.current);
    $('tvYear').onchange = () => load($('tvYear').value);
    $('tvQ').oninput = render;
    await load($('tvYear').value);
  }
  const ready = init().catch(e => { $('tvList').innerHTML = '<div class="card err">Could not load teams. ' + esc(e.message) + '</div>'; });
  return { ready, reload: () => load($('tvYear').value) };
};
