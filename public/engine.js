/* RPL Scorer engine - pure functions, shared by server (Node) and browser.
   A match = { id, setup, events:[], mom }. All state is derived by replaying events. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RPLEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function oversStr(balls) { return Math.floor(balls / 6) + '.' + (balls % 6); }
  function rate(runs, balls) { return balls > 0 ? (runs * 6 / balls) : 0; }
  function fix2(n) { return (Math.round(n * 100) / 100).toFixed(2); }

  function normalizeSetup(s) {
    s = s || {};
    const clean = (arr) => (Array.isArray(arr) ? arr : []).map(x => String(x || '').trim()).filter(Boolean);
    const out = {
      teamA: String(s.teamA || '').trim() || 'Team A',
      teamB: String(s.teamB || '').trim() || 'Team B',
      playersA: clean(s.playersA),
      playersB: clean(s.playersB),
      overs: parseInt(s.overs, 10) || 4,
      tossWinner: s.tossWinner === 'B' ? 'B' : 'A',
      tossChoice: s.tossChoice === 'bowl' ? 'bowl' : 'bat',
      wideRuns: s.wideRuns === undefined || s.wideRuns === '' ? 1 : Math.max(0, parseInt(s.wideRuns, 10) || 0),
      nbRuns: s.nbRuns === undefined || s.nbRuns === '' ? 1 : Math.max(0, parseInt(s.nbRuns, 10) || 0),
      maxOversPerBowler: Math.max(0, parseInt(s.maxOversPerBowler, 10) || 0),
      venue: String(s.venue || '').trim()
    };
    return out;
  }

  function validateSetup(s) {
    if (s.teamA.toLowerCase() === s.teamB.toLowerCase()) return 'Team names must be different';
    for (const [t, list] of [[s.teamA, s.playersA], [s.teamB, s.playersB]]) {
      if (list.length < 2) return t + ': need at least 2 players';
      const low = list.map(x => x.toLowerCase());
      if (new Set(low).size !== low.length) return t + ': player names must be unique';
    }
    if (s.overs < 1 || s.overs > 50) return 'Overs must be 1 to 50';
    return null;
  }

  function newInnings(setup, batKey) {
    const bowlKey = batKey === 'A' ? 'B' : 'A';
    return {
      batKey, bowlKey,
      batTeam: setup['team' + batKey], bowlTeam: setup['team' + bowlKey],
      players: setup['players' + batKey].slice(), bowlPlayers: setup['players' + bowlKey].slice(),
      started: false, done: false,
      runs: 0, wkts: 0, legal: 0,
      extras: { wd: 0, nb: 0, b: 0, lb: 0 },
      batters: {}, batOrder: [], bowlers: {}, bowlOrder: [],
      striker: null, nonStriker: null, bowler: null, lastOverBowler: null,
      thisOver: [], overLog: [], overConceded: 0,
      fow: [], part: { runs: 0, balls: 0 }, target: null, balls: 0
    };
  }

  function addBatter(inn, name) {
    if (!inn.batters[name]) { inn.batters[name] = { name, r: 0, b: 0, f4: 0, s6: 0, out: false, how: 'not out' }; inn.batOrder.push(name); }
  }
  function addBowler(inn, name) {
    if (!inn.bowlers[name]) { inn.bowlers[name] = { name, balls: 0, r: 0, w: 0, m: 0, wd: 0, nb: 0 }; inn.bowlOrder.push(name); }
  }

  function needOf(st) {
    if (st.result) return 'done';
    const inn = st.innings[st.cur];
    if (!inn.started) return 'openers';
    if (!inn.striker || !inn.nonStriker) return 'batsman';
    if (!inn.bowler) return 'bowler';
    return 'ball';
  }

  function availableBatters(inn) {
    return inn.players.filter(p => !inn.batters[p]);
  }
  function availableBowlers(st, inn) {
    const max = st.setup.maxOversPerBowler;
    return inn.bowlPlayers.filter(p => {
      if (p === inn.lastOverBowler) return false;
      if (max && inn.bowlers[p] && inn.bowlers[p].balls >= max * 6) return false;
      return true;
    });
  }

  function dismissalText(how, bowler, fielder) {
    const f = fielder ? String(fielder).trim() : '';
    switch (how) {
      case 'bowled': return 'b ' + bowler;
      case 'caught': return f ? (f === bowler ? 'c & b ' + bowler : 'c ' + f + ' b ' + bowler) : 'c ? b ' + bowler;
      case 'lbw': return 'lbw b ' + bowler;
      case 'stumped': return 'st ' + (f || '?') + ' b ' + bowler;
      case 'hitwicket': return 'hit wicket b ' + bowler;
      case 'runout': return 'run out' + (f ? ' (' + f + ')' : '');
      default: return 'out';
    }
  }
  const WKT_TYPES = ['bowled', 'caught', 'lbw', 'runout', 'stumped', 'hitwicket'];

  function finishInningsIfNeeded(st) {
    const inn = st.innings[st.cur];
    const s = st.setup;
    const allOut = inn.wkts >= inn.players.length - 1;
    const oversDone = inn.legal >= s.overs * 6;
    const chased = st.cur === 1 && inn.runs >= inn.target;
    if (!(allOut || oversDone || chased)) return;
    inn.done = true;
    if (inn.thisOver.length) { inn.overLog.push({ bowler: inn.bowler, balls: inn.thisOver.slice(), runs: inn.overConceded }); }
    inn.endReason = chased ? 'target reached' : allOut ? 'all out' : 'overs complete';
    if (st.cur === 0) {
      st.cur = 1;
      st.innings[1].target = inn.runs + 1;
    } else {
      const i1 = st.innings[0], i2 = inn;
      const maxW = i2.players.length - 1;
      if (i2.runs >= i2.target) st.result = { winner: i2.batKey, text: i2.batTeam + ' won by ' + (maxW - i2.wkts) + ' wicket' + (maxW - i2.wkts === 1 ? '' : 's'), type: 'wickets', margin: maxW - i2.wkts };
      else if (i2.runs === i1.runs) st.result = { winner: null, text: 'Match tied', type: 'tie', margin: 0 };
      else st.result = { winner: i1.batKey, text: i1.batTeam + ' won by ' + (i1.runs - i2.runs) + ' run' + (i1.runs - i2.runs === 1 ? '' : 's'), type: 'runs', margin: i1.runs - i2.runs };
    }
  }

  // Apply one event to state. Returns error string or null. Mutates st.
  function apply(st, ev) {
    const need = needOf(st);
    if (!ev || typeof ev !== 'object') return 'Bad event';
    const inn = st.innings[st.cur];
    const s = st.setup;
    if (ev.t === 'openers') {
      if (need !== 'openers') return 'Openers already set';
      const { striker, nonStriker, bowler } = ev;
      if (!inn.players.includes(striker) || !inn.players.includes(nonStriker)) return 'Pick 2 batsmen from ' + inn.batTeam;
      if (striker === nonStriker) return 'Striker and non-striker must be different';
      if (!inn.bowlPlayers.includes(bowler)) return 'Pick bowler from ' + inn.bowlTeam;
      inn.started = true;
      addBatter(inn, striker); addBatter(inn, nonStriker); addBowler(inn, bowler);
      inn.striker = striker; inn.nonStriker = nonStriker; inn.bowler = bowler;
      return null;
    }
    if (ev.t === 'batsman') {
      if (need !== 'batsman') return 'No new batsman needed now';
      if (!availableBatters(inn).includes(ev.name)) return 'This player cannot bat now';
      addBatter(inn, ev.name);
      if (!inn.striker) inn.striker = ev.name; else inn.nonStriker = ev.name;
      return null;
    }
    if (ev.t === 'bowler') {
      if (need !== 'bowler') return 'No new bowler needed now';
      if (!inn.bowlPlayers.includes(ev.name)) return 'Pick bowler from ' + inn.bowlTeam;
      if (ev.name === inn.lastOverBowler) return ev.name + ' bowled the last over. Pick another bowler';
      if (!availableBowlers(st, inn).includes(ev.name)) return ev.name + ' has finished his overs';
      addBowler(inn, ev.name);
      inn.bowler = ev.name;
      return null;
    }
    if (ev.t !== 'ball') return 'Unknown event';
    if (need !== 'ball') return need === 'done' ? 'Match is over' : 'Select ' + need + ' first';
    const kind = ev.kind;
    if (!['run', 'wide', 'nb', 'bye', 'lb', 'wicket'].includes(kind)) return 'Bad ball type';
    const runs = parseInt(ev.runs, 10) || 0;
    if (runs < 0 || runs > 7) return 'Bad runs';
    let w = null;
    if (kind === 'wicket') {
      w = ev.wkt || {};
      if (!WKT_TYPES.includes(w.how)) return 'Pick wicket type';
      if (w.how !== 'runout' && runs) return 'Runs only allowed with run out';
      if (w.how === 'runout' && !['striker', 'nonStriker'].includes(w.out)) return 'Who is run out?';
    }
    const bat = inn.batters[inn.striker];
    const bowl = inn.bowlers[inn.bowler];
    const legal = !(kind === 'wide' || kind === 'nb');
    let total = 0, conceded = 0, label = '';
    if (kind === 'run') {
      total = conceded = runs; bat.r += runs; bat.b++;
      if (runs === 4) bat.f4++; if (runs === 6) bat.s6++;
      label = String(runs);
    } else if (kind === 'wide') {
      total = conceded = s.wideRuns + runs; inn.extras.wd += total; bowl.wd++;
      label = 'Wd' + (runs ? '+' + runs : '');
    } else if (kind === 'nb') {
      total = conceded = s.nbRuns + runs; inn.extras.nb += s.nbRuns; bat.r += runs; bat.b++; bowl.nb++;
      if (runs === 4) bat.f4++; if (runs === 6) bat.s6++;
      label = 'Nb' + (runs ? '+' + runs : '');
    } else if (kind === 'bye' || kind === 'lb') {
      total = runs; inn.extras[kind === 'bye' ? 'b' : 'lb'] += runs; bat.b++;
      label = runs + (kind === 'bye' ? 'b' : 'lb');
    } else if (kind === 'wicket') {
      total = conceded = runs; bat.r += runs; bat.b++;
      label = 'W' + (runs ? '+' + runs : '');
    }
    inn.runs += total; bowl.r += conceded; inn.overConceded += conceded;
    inn.part.runs += total; if (legal) inn.part.balls++;
    if (legal) { inn.legal++; bowl.balls++; }
    inn.balls++;
    // who is out (identity before crossing)
    let outName = null;
    if (w) outName = (w.how === 'runout' && w.out === 'nonStriker') ? inn.nonStriker : inn.striker;
    if (runs % 2 === 1) { const t = inn.striker; inn.striker = inn.nonStriker; inn.nonStriker = t; }
    if (w) {
      inn.wkts++;
      const ob = inn.batters[outName];
      ob.out = true; ob.how = dismissalText(w.how, inn.bowler, w.fielder);
      if (w.how !== 'runout') bowl.w++;
      inn.fow.push({ n: inn.wkts, score: inn.runs, name: outName, over: oversStr(inn.legal) });
      inn.part = { runs: 0, balls: 0 };
      if (inn.striker === outName) inn.striker = null; else inn.nonStriker = null;
    }
    inn.thisOver.push(label);
    if (legal && inn.legal % 6 === 0) {
      if (inn.overConceded === 0) bowl.m++;
      inn.overLog.push({ bowler: inn.bowler, balls: inn.thisOver.slice(), runs: inn.overConceded });
      inn.thisOver = []; inn.overConceded = 0;
      const t = inn.striker; inn.striker = inn.nonStriker; inn.nonStriker = t;
      inn.lastOverBowler = inn.bowler; inn.bowler = null;
    }
    finishInningsIfNeeded(st);
    return null;
  }

  function compute(match, opts) {
    const setup = normalizeSetup(match.setup);
    const first = setup.tossChoice === 'bat' ? setup.tossWinner : (setup.tossWinner === 'A' ? 'B' : 'A');
    const second = first === 'A' ? 'B' : 'A';
    const st = { id: match.id, created: match.created, setup, first, cur: 0, result: null, errors: [],
      innings: [newInnings(setup, first), newInnings(setup, second)] };
    const events = match.events || [];
    for (let i = 0; i < events.length; i++) {
      const err = apply(st, events[i]);
      if (err) { st.errors.push({ i, err }); if (opts && opts.strict) throw new Error(err); }
    }
    st.need = needOf(st);
    st.eventCount = events.length;
    const inn = st.innings[st.cur];
    st.availBatters = availableBatters(inn);
    st.availBowlers = availableBowlers(st, inn);
    for (const x of st.innings) {
      x.oversText = oversStr(x.legal);
      x.crr = fix2(rate(x.runs, x.legal));
      x.extrasTotal = x.extras.wd + x.extras.nb + x.extras.b + x.extras.lb;
      for (const n of x.batOrder) { const b = x.batters[n]; b.sr = b.b ? fix2(b.r * 100 / b.b) : '0.00'; }
      for (const n of x.bowlOrder) { const b = x.bowlers[n]; b.oversText = oversStr(b.balls); b.econ = fix2(rate(b.r, b.balls)); }
    }
    const i2 = st.innings[1];
    if (st.cur === 1 && !st.result) {
      st.chase = { target: i2.target, need: i2.target - i2.runs, ballsLeft: setup.overs * 6 - i2.legal };
      st.chase.rrr = st.chase.ballsLeft > 0 ? fix2(st.chase.need * 6 / st.chase.ballsLeft) : '-';
    }
    st.status = st.result ? 'done' : (events.length ? 'live' : 'new');
    if (st.result) st.momSuggest = momPoints(st);
    st.mom = match.mom || null;
    st.abandoned = !!match.abandoned;
    return st;
  }

  // Man of the Match points formula
  function momPoints(st) {
    const P = {};
    const get = (team, teamName, name) => {
      const k = team + ':' + name;
      if (!P[k]) P[k] = { key: k, team, teamName, name, pts: 0, parts: [], r: 0, b: 0, w: 0 };
      return P[k];
    };
    const add = (p, n, why) => { if (n) { p.pts += n; p.parts.push((n > 0 ? '+' : '') + n + ' ' + why); } };
    for (const inn of st.innings) {
      for (const n of inn.batOrder) {
        const b = inn.batters[n], p = get(inn.batKey, inn.batTeam, n);
        p.r += b.r; p.b += b.b;
        add(p, b.r, 'runs (' + b.r + ')');
        add(p, b.f4, 'for ' + b.f4 + ' four(s)');
        add(p, b.s6 * 2, 'for ' + b.s6 + ' six(es)');
        if (b.b >= 5) {
          const sr = b.r * 100 / b.b;
          if (sr >= 200) add(p, 10, 'SR ' + sr.toFixed(0) + ' (200+)');
          else if (sr >= 150) add(p, 5, 'SR ' + sr.toFixed(0) + ' (150+)');
        }
        if (b.r >= 50) add(p, 10, 'fifty bonus'); else if (b.r >= 30) add(p, 5, '30+ bonus');
      }
      for (const n of inn.bowlOrder) {
        const b = inn.bowlers[n], p = get(inn.bowlKey, inn.bowlTeam, n);
        p.w += b.w;
        add(p, b.w * 20, 'for ' + b.w + ' wicket(s)');
        if (b.w >= 3) add(p, 10, '3+ wickets bonus');
        add(p, b.m * 10, 'for ' + b.m + ' maiden(s)');
        if (b.balls >= 6) {
          const ec = b.r * 6 / b.balls;
          if (ec <= 4) add(p, 10, 'economy ' + ec.toFixed(2) + ' (<=4)');
          else if (ec <= 6) add(p, 5, 'economy ' + ec.toFixed(2) + ' (<=6)');
          else if (ec >= 12) add(p, -5, 'economy ' + ec.toFixed(2) + ' (12+)');
        }
      }
    }
    // fielding: catches / stumpings / run outs from dismissal text
    for (const inn of st.innings) {
      for (const n of inn.batOrder) {
        const h = inn.batters[n].how;
        let f = null, why = '';
        let m;
        if ((m = /^c & b (.+)$/.exec(h))) { f = m[1]; why = 'catch'; }
        else if ((m = /^c (.+) b .+$/.exec(h)) && m[1] !== '?') { f = m[1]; why = 'catch'; }
        else if ((m = /^st (.+) b .+$/.exec(h)) && m[1] !== '?') { f = m[1]; why = 'stumping'; }
        else if ((m = /^run out \((.+)\)$/.exec(h))) { f = m[1]; why = 'run out'; }
        if (f && inn.bowlPlayers.includes(f)) add(get(inn.bowlKey, inn.bowlTeam, f), 5, why);
      }
    }
    if (st.result && st.result.winner) {
      for (const k in P) if (P[k].team === st.result.winner) add(P[k], 10, 'winning team');
    }
    return Object.values(P).sort((a, b) => b.pts - a.pts || b.r - a.r || b.w - a.w);
  }

  function summaryText(st) {
    const s = st.setup, L = [];
    L.push('🏏 RPL - Rohidas Premier League');
    L.push(s.teamA + ' vs ' + s.teamB + ' (' + s.overs + ' overs)' + (s.venue ? ' @ ' + s.venue : ''));
    L.push('Toss: ' + s['team' + s.tossWinner] + ', chose to ' + s.tossChoice);
    st.innings.forEach((inn, i) => {
      if (!inn.started) return;
      L.push('');
      L.push((i + 1) + ') ' + inn.batTeam + ': ' + inn.runs + '/' + inn.wkts + ' (' + inn.oversText + ' ov)');
      for (const n of inn.batOrder) { const b = inn.batters[n]; L.push('  ' + n + ' ' + b.r + '(' + b.b + ')' + (b.out ? ' - ' + b.how : '*')); }
      L.push('  Extras ' + inn.extrasTotal + ' (wd ' + inn.extras.wd + ', nb ' + inn.extras.nb + ', b ' + inn.extras.b + ', lb ' + inn.extras.lb + ')');
      L.push('  Bowling:');
      for (const n of inn.bowlOrder) { const b = inn.bowlers[n]; L.push('  ' + n + ' ' + b.oversText + '-' + b.m + '-' + b.r + '-' + b.w); }
    });
    L.push('');
    if (st.result) L.push('Result: ' + st.result.text);
    else if (st.chase) L.push(st.innings[1].batTeam + ' need ' + st.chase.need + ' runs in ' + st.chase.ballsLeft + ' balls');
    if (st.mom) L.push('Man of the Match: ' + st.mom.name + ' (' + st.mom.teamName + ')');
    return L.join('\n');
  }

  return { compute, apply, normalizeSetup, validateSetup, momPoints, summaryText, oversStr, WKT_TYPES };
});
