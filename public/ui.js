/* Shared rendering for public + admin pages */
window.UI = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function chip(l) {
    let c = '';
    if (/^W(?!d)/.test(l)) c = 'cw'; else if (l === '4') c = 'c4'; else if (l === '6') c = 'c6'; else if (/^(Wd|Nb)|b$|lb$/.test(l)) c = 'cx';
    return '<span class="chip ' + c + '">' + esc(l) + '</span>';
  }
  function live(st) {
    if (!st) return '<div class="card"><h2>No match yet</h2><div class="mut">Score will show here when the match starts.</div></div>';
    const s = st.setup, inn = st.innings[st.cur];
    let h = '<div class="card">';
    h += '<div class="row"><div class="mut">' + esc(s.teamA) + ' vs ' + esc(s.teamB) + ' · ' + s.overs + ' overs</div>' +
      (st.result ? '<span class="pill">FINISHED</span>' : st.abandoned ? '<span class="pill">STOPPED</span>' : st.status === 'live' ? '<span class="pill live">● LIVE</span>' : '<span class="pill">NOT STARTED</span>') + '</div>';
    if (st.result) {
      h += '<div class="result" style="margin-top:8px">🏆 ' + esc(st.result.text) + '</div>';
      if (st.mom) h += '<div class="mom">⭐ Man of the Match: ' + esc(st.mom.name) + ' (' + esc(st.mom.teamName) + ')</div>';
      st.innings.forEach(x => { h += '<div class="row" style="margin-top:8px"><b>' + esc(x.batTeam) + '</b><b>' + x.runs + '/' + x.wkts + ' <span class="mut">(' + x.oversText + ')</span></b></div>'; });
      return h + '</div>';
    }
    h += '<div class="team" style="margin-top:6px">' + esc(inn.batTeam) + ' batting' + (st.cur === 1 ? ' (2nd innings)' : '') + '</div>';
    h += '<div class="row"><div class="score">' + inn.runs + '/' + inn.wkts + ' <small>(' + inn.oversText + '/' + s.overs + ')</small></div><div style="text-align:right"><div class="mut">Run rate</div><b>' + inn.crr + '</b></div></div>';
    if (st.cur === 1) {
      const i1 = st.innings[0];
      h += '<div class="mut">' + esc(i1.batTeam) + ': ' + i1.runs + '/' + i1.wkts + ' (' + i1.oversText + ')</div>';
      if (st.chase) h += '<div class="chase">Target ' + st.chase.target + ' · Need ' + st.chase.need + ' runs in ' + st.chase.ballsLeft + ' balls · Req. RR ' + st.chase.rrr + '</div>';
    }
    if (inn.started) {
      h += '<table style="margin-top:8px"><tr><th>Batsman</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr>';
      [inn.striker, inn.nonStriker].forEach((n, i) => {
        if (!n) { h += '<tr><td class="mut">(new batsman)</td><td></td><td></td><td></td><td></td><td></td></tr>'; return; }
        const b = inn.batters[n];
        h += '<tr><td' + (i === 0 ? ' class="strk"' : '') + '>' + esc(n) + (i === 0 ? ' 🏏' : '') + '</td><td><b>' + b.r + '</b></td><td>' + b.b + '</td><td>' + b.f4 + '</td><td>' + b.s6 + '</td><td>' + b.sr + '</td></tr>';
      });
      h += '</table>';
      const bn = inn.bowler || (inn.overLog.length ? inn.lastOverBowler : null);
      if (bn && inn.bowlers[bn]) {
        const b = inn.bowlers[bn];
        h += '<table><tr><th>Bowler' + (inn.bowler ? '' : ' (last over)') + '</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr><tr><td>' + esc(bn) + '</td><td>' + b.oversText + '</td><td>' + b.m + '</td><td>' + b.r + '</td><td>' + b.w + '</td><td>' + b.econ + '</td></tr></table>';
      }
      h += '<div class="row" style="margin-top:8px"><span class="mut">This over</span><span class="mut">Partnership: <b style="color:var(--txt)">' + inn.part.runs + ' (' + inn.part.balls + ')</b></span></div>';
      h += '<div class="chips" id="thisOver">' + (inn.thisOver.length ? inn.thisOver.map(chip).join('') : '<span class="mut">-</span>') + '</div>';
    } else if (st.cur === 1) {
      h += '<div class="mut" style="margin-top:6px">Innings break. 2nd innings starting soon.</div>';
    }
    return h + '</div>';
  }
  function inningsCard(inn, idx) {
    if (!inn.started) return '';
    let h = '<div class="card"><div class="row"><h2>' + (idx + 1) + '. ' + esc(inn.batTeam) + '</h2><h2>' + inn.runs + '/' + inn.wkts + ' <span class="mut">(' + inn.oversText + ' ov)</span></h2></div>';
    h += '<table><tr><th>Batting</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr>';
    for (const n of inn.batOrder) {
      const b = inn.batters[n];
      const how = b.out ? b.how : ((n === inn.striker || n === inn.nonStriker) && !inn.done ? 'batting' : 'not out');
      h += '<tr><td>' + esc(n) + (b.out ? '' : '*') + '<span class="how">' + esc(how) + '</span></td><td><b>' + b.r + '</b></td><td>' + b.b + '</td><td>' + b.f4 + '</td><td>' + b.s6 + '</td><td>' + b.sr + '</td></tr>';
    }
    const dnb = inn.players.filter(p => !inn.batters[p]);
    h += '</table><div class="mut" style="margin-top:6px">Extras: <b>' + inn.extrasTotal + '</b> (wd ' + inn.extras.wd + ', nb ' + inn.extras.nb + ', b ' + inn.extras.b + ', lb ' + inn.extras.lb + ')</div>';
    h += '<div class="mut">Total: <b>' + inn.runs + '/' + inn.wkts + '</b> in ' + inn.oversText + ' overs (RR ' + inn.crr + ')</div>';
    if (dnb.length) h += '<div class="mut">Yet to bat: ' + dnb.map(esc).join(', ') + '</div>';
    if (inn.fow.length) h += '<h3>Fall of wickets</h3><div class="mut">' + inn.fow.map(f => f.score + '-' + f.n + ' (' + esc(f.name) + ', ' + f.over + ' ov)').join(', ') + '</div>';
    h += '<h3>Bowling</h3><table><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr>';
    for (const n of inn.bowlOrder) { const b = inn.bowlers[n]; h += '<tr><td>' + esc(n) + '<span class="how">wd ' + b.wd + ', nb ' + b.nb + '</span></td><td>' + b.oversText + '</td><td>' + b.m + '</td><td>' + b.r + '</td><td><b>' + b.w + '</b></td><td>' + b.econ + '</td></tr>'; }
    h += '</table>';
    if (inn.overLog.length) h += '<h3>Over by over</h3>' + inn.overLog.map((o, i) => '<div class="mut" style="margin:4px 0">Ov ' + (i + 1) + ' (' + esc(o.bowler) + ', ' + o.runs + ' r): ' + o.balls.map(esc).join(' ') + '</div>').join('');
    return h + '</div>';
  }
  function scorecard(st) {
    if (!st) return '<div class="card mut">No scorecard yet.</div>';
    const s = st.setup;
    let h = '<div class="card"><b>' + esc(s.teamA) + ' vs ' + esc(s.teamB) + '</b><div class="mut">' + s.overs + ' overs · Toss: ' + esc(s['team' + s.tossWinner]) + ' chose to ' + s.tossChoice + (s.venue ? ' · ' + esc(s.venue) : '') + ' · ' + new Date(st.created).toLocaleString('en-IN') + '</div>';
    if (st.result) h += '<div class="result" style="margin-top:8px">' + esc(st.result.text) + '</div>';
    if (st.mom) h += '<div class="mom">⭐ Man of the Match: ' + esc(st.mom.name) + ' (' + esc(st.mom.teamName) + ')</div>';
    h += '</div>' + st.innings.map(inningsCard).join('');
    if (st.mom && st.momSuggest) { const p = st.momSuggest.find(x => x.key === st.mom.key); if (p) h += '<div class="card"><h3>MoM points: ' + esc(p.name) + ' = ' + p.pts + '</h3><div class="mut">' + p.parts.map(esc).join('<br>') + '</div></div>'; }
    return h;
  }
  function matchList(list) {
    if (!list.length) return '<div class="card mut">No matches yet.</div>';
    return list.map(m => '<div class="card match" data-mid="' + esc(m.id) + '"><div class="row"><b>' + esc(m.teamA) + ' vs ' + esc(m.teamB) + '</b><span class="pill' + (m.status === 'live' ? ' live' : '') + '">' + esc(m.status.toUpperCase()) + '</span></div><div class="mut">' + new Date(m.created).toLocaleString('en-IN') + '</div>' +
      m.scores.map(s => '<div>' + esc(s) + '</div>').join('') + (m.result ? '<div><b>' + esc(m.result) + '</b></div>' : '') + (m.mom ? '<div class="mut">⭐ MoM: ' + esc(m.mom) + '</div>' : '') + '<div class="mut">Tap for full scorecard</div></div>').join('');
  }
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2500);
  }
  async function share(st) {
    if (!st) return;
    const text = RPLEngine.summaryText(st);
    try { if (navigator.share) { await navigator.share({ title: 'RPL Score', text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('Copied! Paste in WhatsApp'); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Copied! Paste in WhatsApp'); } catch (_) { prompt('Copy this:', text); } ta.remove(); }
  }
  function connect(onState, onStatus) {
    let es;
    function open() {
      es = new EventSource('/api/stream');
      es.addEventListener('update', e => onState(JSON.parse(e.data)));
      es.onopen = () => onStatus && onStatus(true);
      es.onerror = () => onStatus && onStatus(false);
    }
    open();
    return () => es && es.close();
  }
  return { esc, live, scorecard, matchList, toast, share, connect };
})();
