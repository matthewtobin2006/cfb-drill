// Game engine shared by the page (game.js) and the grading worker (grader.worker.js).
// Pure functions over a plain state object, so it can be cloned and simulated fast.
//
// Field position is always `ytg`: yards to the goal line of the team with the ball.
// Rules follow college football: 40-second play clock, clock stops briefly on first
// downs only in the last 2:00 of a half, out of bounds stops the clock until the snap
// only in the last 2:00, touchback on kickoffs at the 25, two-point tries from the 3,
// overtime from the 25 with mandatory two-point tries from the 2nd OT and alternating
// two-point plays from the 3rd OT on. Check the current NCAA rulebook each season.

export const OUT = { NORMAL: 0, INCOMPLETE: 1, INT: 2, FUMBLE: 3, SACK: 4 };

export const CALLS = {
  inside_run:    { label: 'Inside run',    group: 'Run',  kind: 'run' },
  outside_left:  { label: 'Outside left',  group: 'Run',  kind: 'run' },
  outside_right: { label: 'Outside right', group: 'Run',  kind: 'run' },
  screen:        { label: 'Screen',        group: 'Pass', kind: 'pass' },
  short_pass:    { label: 'Short pass',    group: 'Pass', kind: 'pass' },
  deep_pass:     { label: 'Deep shot',     group: 'Pass', kind: 'pass' },
  // Passes whose depth the play-by-play doesn't record. Only offered when the
  // data has no short/deep split (see pipeline/build_data.py).
  pass:          { label: 'Pass',          group: 'Pass', kind: 'pass' },
  spike:         { label: 'Spike',         group: 'Clock', kind: 'spike' },
  kneel:         { label: 'Kneel',         group: 'Clock', kind: 'kneel' },
  field_goal:    { label: 'Field goal',    group: 'Kick', kind: 'fg' },
  punt:          { label: 'Punt',          group: 'Kick', kind: 'punt' },
  pat_kick:      { label: 'Kick the PAT',  group: 'Try',  kind: 'pat' },
};
export const SCRIMMAGE = ['inside_run', 'outside_left', 'outside_right', 'screen', 'short_pass', 'deep_pass', 'pass'];

// Calls the user can pick. 'pass' (depth unknown) is a fallback pool, so it is only
// offered when neither short nor deep passes exist in the data.
export function scrimmageCalls(pb) {
  return SCRIMMAGE.filter((c) => pb.calls[c] &&
    !(c === 'pass' && (pb.calls.short_pass || pb.calls.deep_pass)));
}
export const TEMPO = {
  hurry:  { label: 'No-huddle', secs: 12 },
  normal: { label: 'Huddle',    secs: 24 },
  milk:   { label: 'Milk it',   secs: 38 },
};

const PAT_RATE = 0.97;
const TWO_MIN = 120;

// ---------- random numbers (seeded, so everyone gets the same daily draws) ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------- situation buckets (must match pipeline/build_data.py) ----------
export function zone(ytg) { return ytg <= 10 ? 'gl' : ytg <= 20 ? 'rz' : ytg <= 50 ? 'opp' : 'own'; }
export function distBin(d) { return d <= 2 ? 's' : d <= 6 ? 'm' : d <= 10 ? 'l' : 'x'; }
export function bucketKeys(down, dist, ytg) {
  const z = zone(ytg);
  return [`${down}|${distBin(dist)}|${z}`, `${down}|*|${z}`, `*|*|${z}`, '*|*|*'];
}

// Draw one real play of this call from the closest situation bucket that has plays.
export function samplePlay(pb, call, s, rng) {
  const keys = bucketKeys(s.down, s.dist, s.ytg);
  const pools = CALLS[call].kind === 'pass' ? [call, 'pass'] : [call];
  for (const c of pools) {
    const byKey = pb.calls[c];
    if (!byKey) continue;
    for (const k of keys) {
      const rows = byKey[k];
      if (rows && rows.length) return rows[Math.floor(rng() * rows.length)];
    }
  }
  return [0, OUT.INCOMPLETE, 0];
}

// ---------- state ----------
export const other = (t) => (t === 'us' ? 'them' : 'us');
export const lead = (s, team) => s.score[team] - s.score[other(team)];

export function newGame(spot) {
  return {
    clock: spot.clock, poss: 'us', ytg: spot.ytg, down: spot.down || 1, dist: spot.dist || 10,
    score: { ...spot.score }, to: { ...spot.to },
    clockState: 'stopped', // 'running' | 'ready' (restarts on ready-for-play) | 'stopped' (until snap)
    phase: 'play',         // 'play' | 'pat' (kick or go for two) | 'two' (must go for two)
    ot: 0, otPoss: 0, otFirst: null, over: false,
  };
}
export function clone(s) { return { ...s, score: { ...s.score }, to: { ...s.to } }; }

// Calls the team with the ball can make right now.
export function options(s, pb) {
  const scrim = scrimmageCalls(pb);
  if (s.phase === 'pat') return ['pat_kick', ...scrim];
  if (s.phase === 'two') return scrim;
  const o = [...scrim];
  const ot = s.ot > 0;
  if (!ot && s.down < 4 && s.clockState !== 'stopped' && lead(s, s.poss) <= 0) o.push('spike');
  if (!ot && lead(s, s.poss) > 0) o.push('kneel');
  if (s.ytg + 17 <= 60) o.push('field_goal');
  if (!ot && s.down === 4 && s.ytg > 35) o.push('punt');
  return o;
}

// The defense calls timeout when it needs the clock stopped.
export function defenseTimeout(s) {
  if (s.ot || s.phase !== 'play' || s.clockState === 'stopped') return false;
  const d = other(s.poss);
  const L = lead(s, d);
  if (s.to[d] > 0 && ((L < 0 && s.clock <= 240) || (L === 0 && s.clock <= 60))) {
    s.to[d]--; s.clockState = 'stopped';
    return true;
  }
  return false;
}

// Time that runs off between plays. Returns seconds run off.
export function preSnap(s, tempo, useTO, rng) {
  if (s.ot || s.phase !== 'play' || s.over) return 0;
  if (useTO && s.to[s.poss] > 0 && s.clockState !== 'stopped') { s.to[s.poss]--; s.clockState = 'stopped'; }
  let run = 0;
  if (s.clockState === 'running') run = TEMPO[tempo].secs;
  else if (s.clockState === 'ready') run = Math.max(0, TEMPO[tempo].secs - 8);
  // A team that is behind or tied always gets the snap off; a team ahead lets it expire.
  if (lead(s, s.poss) <= 0 && s.clock >= 2) run = Math.min(run, s.clock - 1);
  run = Math.min(run, s.clock);
  s.clock -= run;
  if (s.clock <= 0) endRegulation(s, rng);
  return run;
}

// ---------- transitions ----------
function changePoss(s, newYtg, rng) {
  if (s.ot) return endOtPossession(s, rng);
  s.poss = other(s.poss);
  s.ytg = Math.max(1, Math.min(99, newYtg));
  s.down = 1; s.dist = Math.min(10, s.ytg);
  s.clockState = 'stopped';
  s.phase = 'play';
}

function kickoff(s, receiver) {
  s.poss = receiver; s.ytg = 75; s.down = 1; s.dist = 10;
  s.clockState = 'stopped'; s.phase = 'play';
}

function afterTry(s, team, rng) {
  if (s.ot) return endOtPossession(s, rng);
  kickoff(s, other(team));
}

function endRegulation(s, rng) {
  if (s.ot || s.over || s.phase !== 'play') return;
  if (s.score.us !== s.score.them) { s.over = true; return; }
  s.ot = 1; s.otPoss = 0; s.otFirst = rng() < 0.5 ? 'us' : 'them';
  setupOt(s);
}

function setupOt(s) {
  s.poss = s.otPoss === 0 ? s.otFirst : other(s.otFirst);
  s.clock = 0; s.clockState = 'stopped';
  if (s.ot >= 3) { s.phase = 'two'; s.ytg = 3; s.down = 4; s.dist = 3; return; }
  s.phase = 'play'; s.ytg = 25; s.down = 1; s.dist = 10;
}

function endOtPossession(s, rng) {
  s.otPoss++;
  if (s.otPoss >= 2) {
    if (s.score.us !== s.score.them) { s.over = true; return; }
    s.ot++; s.otPoss = 0; s.otFirst = other(s.otFirst);
  }
  setupOt(s);
}

function tick(s, secs, rng) {
  if (s.ot || s.over) return;
  s.clock = Math.max(0, s.clock - secs);
}

// Play one snap of `call` for the team with the ball. Mutates s, returns a short event.
export function resolve(s, call, pb, rng) {
  const team = s.poss;
  const kind = CALLS[call].kind;
  const ev = { team, call, yards: 0, result: '', points: 0 };

  // ----- tries after a touchdown, and OT two-point plays -----
  if (s.phase === 'pat' || s.phase === 'two') {
    if (kind === 'pat') {
      const good = rng() < PAT_RATE;
      if (good) { s.score[team] += 1; ev.points = 1; }
      ev.result = good ? 'PAT good' : 'PAT no good';
    } else {
      const t = { ...s, down: 4, dist: 3, ytg: 3 };
      const [y, out] = samplePlay(pb, call, t, rng);
      const good = (out === OUT.NORMAL && y >= 3);
      if (good) { s.score[team] += 2; ev.points = 2; }
      ev.yards = y; ev.result = good ? 'Two-point try good' : 'Two-point try fails';
    }
    afterTry(s, team, rng);
    if (!s.ot && s.clock <= 0) endRegulation(s, rng);
    return ev;
  }

  // ----- clock plays and kicks -----
  if (kind === 'spike') {
    tick(s, 1, rng); s.down++; s.clockState = 'stopped'; ev.result = 'Spiked, clock stopped';
    return finish(s, ev, rng);
  }
  if (kind === 'kneel') {
    tick(s, 2, rng); s.ytg = Math.min(99, s.ytg + 1); s.dist += 1; s.down++; s.clockState = 'running';
    ev.yards = -1; ev.result = 'Kneel';
    if (s.down > 4) { ev.result = 'Kneel, turnover on downs'; changePoss(s, 100 - s.ytg, rng); }
    return finish(s, ev, rng);
  }
  if (kind === 'fg') {
    const d = s.ytg + 17;
    const p = 1 / (1 + Math.exp(-(5.07 - 0.095 * d)));
    tick(s, 5, rng);
    if (rng() < p) {
      s.score[team] += 3; ev.points = 3; ev.result = `${d}-yard field goal is good`;
      if (s.ot) endOtPossession(s, rng); else kickoff(s, other(team));
    } else {
      ev.result = `${d}-yard field goal is no good`;
      changePoss(s, Math.min(80, 100 - s.ytg), rng);
    }
    return finish(s, ev, rng);
  }
  if (kind === 'punt') {
    tick(s, 8, rng);
    const net = Math.round(36 + rng() * 12);
    const land = s.ytg - net;
    ev.result = land <= 0 ? 'Punt, touchback' : `Punt, net ${net}`;
    changePoss(s, land <= 0 ? 80 : 100 - land, rng);
    return finish(s, ev, rng);
  }

  // ----- scrimmage play: a real play of this call from the same kind of spot -----
  const [y, out, oob] = samplePlay(pb, call, s, rng);
  ev.yards = y;
  tick(s, out === OUT.INCOMPLETE || out === OUT.SACK ? 5 : 6, rng);

  if (out === OUT.INCOMPLETE) {
    s.clockState = 'stopped'; ev.result = 'Incomplete';
    s.down++;
    if (s.down > 4) { ev.result = 'Incomplete, turnover on downs'; changePoss(s, 100 - s.ytg, rng); }
    return finish(s, ev, rng);
  }
  if (out === OUT.INT) {
    const air = call === 'deep_pass' ? 22 : call === 'screen' ? 1 : 8;
    const spot = s.ytg - air;
    ev.yards = 0; ev.result = 'Intercepted';
    changePoss(s, spot <= 0 ? 75 : 100 - spot, rng);
    return finish(s, ev, rng);
  }
  if (out === OUT.FUMBLE) {
    const spot = s.ytg - y;
    ev.result = 'Fumble, lost';
    changePoss(s, spot <= 0 ? 75 : 100 - spot, rng);
    return finish(s, ev, rng);
  }

  const newYtg = s.ytg - y;
  if (newYtg <= 0) {
    ev.yards = s.ytg; s.score[team] += 6; ev.points = 6; ev.result = 'Touchdown';
    s.phase = s.ot >= 2 ? 'two' : 'pat';
    s.ytg = 3; s.down = 4; s.dist = 3; s.clockState = 'stopped';
    return ev; // the try happens even with 0:00 left
  }
  if (newYtg >= 100) {
    s.score[other(team)] += 2; ev.result = 'Safety';
    if (s.ot) { endOtPossession(s, rng); return ev; }
    s.poss = other(team); s.ytg = 60; s.down = 1; s.dist = 10; s.clockState = 'stopped';
    return finish(s, ev, rng);
  }
  const first = y >= s.dist;
  s.ytg = newYtg;
  if (oob) s.clockState = (s.clock <= TWO_MIN) ? 'stopped' : 'ready';
  else if (first && s.clock <= TWO_MIN) s.clockState = 'ready';
  else s.clockState = 'running';
  if (out === OUT.SACK) ev.result = `Sacked for ${-y}`;
  else ev.result = `${y >= 0 ? 'Gain of' : 'Loss of'} ${Math.abs(y)}${oob ? ', out of bounds' : ''}`;
  if (first) {
    s.down = 1; s.dist = Math.min(10, s.ytg); ev.result += ', first down';
  } else {
    s.down++; s.dist -= y;
    if (s.down > 4) { ev.result += ', turnover on downs'; changePoss(s, 100 - s.ytg, rng); }
  }
  return finish(s, ev, rng);
}

function finish(s, ev, rng) {
  if (!s.ot && s.phase === 'play' && s.clock <= 0) endRegulation(s, rng);
  return ev;
}

// ---------- a "typical college play-caller", used for the other team and in simulations ----------
function canKneelOut(s) {
  const k = 5 - s.down;
  const d = s.to[other(s.poss)];
  const slots = (s.clockState !== 'stopped' ? 1 : 0) + (k - 1);
  const burn = 2 * k + 38 * Math.max(0, slots - d);
  return burn >= s.clock;
}

function scrimmageCall(s, pb, rng, L, late) {
  let pPass = 0.48;
  if (s.dist >= 8) pPass += 0.2;
  if (s.dist <= 2) pPass -= 0.25;
  if (late && L < 0) pPass += 0.3;
  if (late && L > 0) pPass -= 0.3;
  pPass = Math.min(0.95, Math.max(0.05, pPass));
  let call;
  if (s.phase !== 'play' ? rng() < 0.6 : rng() < pPass) {
    const desperate = late && L < 0 && s.clock <= 20 && s.ytg > 30;
    const r = rng();
    call = r < (desperate ? 0.8 : 0.22) ? 'deep_pass' : r < (desperate ? 0.85 : 0.37) ? 'screen' : 'short_pass';
  } else {
    const r = rng();
    call = r < 0.55 ? 'inside_run' : r < 0.775 ? 'outside_left' : 'outside_right';
  }
  if (pb.calls[call]) return call;
  const sameKind = scrimmageCalls(pb).filter((c) => CALLS[c].kind === CALLS[call].kind);
  return sameKind[Math.floor(rng() * sameKind.length)] || scrimmageCalls(pb)[0];
}

export function policy(s, pb, rng) {
  const team = s.poss, L = lead(s, team), t = s.clock, ot = s.ot > 0;
  const late = !ot && t <= 300;
  if (s.phase === 'pat') {
    const goForTwo = !ot && t <= 900 && [-2, -5, -10, 1, 5].includes(L);
    return { call: goForTwo ? scrimmageCall(s, pb, rng, L, late) : 'pat_kick', tempo: 'normal' };
  }
  if (s.phase === 'two') return { call: scrimmageCall(s, pb, rng, L, late), tempo: 'normal' };
  if (!ot && L > 0 && canKneelOut(s)) return { call: 'kneel', tempo: 'milk' };

  const tempo = (L < 0 && late) || (L === 0 && t <= 120) ? 'hurry' : (L > 0 && late ? 'milk' : 'normal');
  // save timeouts for the end: most coaches burn them inside the last 45 seconds
  const useTO = !ot && L <= 0 && t <= 45 && s.clockState !== 'stopped' && s.to[team] > 0;
  const fgOk = s.ytg + 17 <= 52;

  if (!ot && fgOk && L >= -3 && L <= 0 && t <= 8) return { call: 'field_goal', tempo, useTO };
  if (!ot && L < 0 && late && t <= 30 && s.clockState === 'running' && s.to[team] === 0 && s.down < 4) {
    return { call: 'spike', tempo: 'hurry' };
  }
  if (s.down === 4) {
    const needTD = L <= -4;
    if (fgOk && !(needTD && (late || ot))) return { call: 'field_goal', tempo, useTO };
    const goForIt = ot || (late && L < 0) || (s.dist <= 2 && s.ytg <= 55 && rng() < 0.4);
    if (!goForIt && s.ytg > 35) return { call: 'punt', tempo, useTO };
  }
  return { call: scrimmageCall(s, pb, rng, L, late), tempo, useTO };
}

// One full snap by the typical play-caller (defense timeout, runoff, play).
export function autoSnap(s, pb, rng) {
  const defTO = defenseTimeout(s);
  const dec = policy(s, pb, rng);
  const runoff = preSnap(s, dec.tempo, dec.useTO, rng);
  if (s.over) return { team: s.poss, call: null, result: 'Time expires', runoff, defTO };
  const ev = resolve(s, dec.call, pb, rng);
  ev.runoff = runoff; ev.defTO = defTO;
  return ev;
}

// Play the rest of the game out. Returns 1 if "us" wins, 0 if not.
export function simulateToEnd(s, pb, rng) {
  for (let i = 0; i < 500 && !s.over; i++) autoSnap(s, pb, rng);
  return s.score.us > s.score.them ? 1 : s.score.us === s.score.them ? 0.5 : 0;
}

// The user's snap: their tempo/timeout choice, then the call.
export function userSnap(s, call, tempo, useTO, pb, rng) {
  const runoff = preSnap(s, tempo, useTO, rng);
  if (s.over) return { team: s.poss, call, result: 'Time expires before the snap', runoff };
  const ev = resolve(s, call, pb, rng);
  ev.runoff = runoff;
  return ev;
}

// Win chance for "us" after each option, by simulating the rest of the game n times.
// Every option is played against the same n random sequences (common random numbers),
// which makes the differences between options much less noisy than the raw win chances.
export function evaluate(s0, opts, tempo, useTO, pb, seed, n) {
  const res = opts.map((call) => ({ call, out: new Float32Array(n), wp: 0 }));
  for (let i = 0; i < n; i++) {
    const subSeed = (seed + Math.imul(i + 1, 0x9E3779B1)) >>> 0;
    for (const r of res) {
      const rng = mulberry32(subSeed);
      const s = clone(s0);
      userSnap(s, r.call, tempo, useTO, pb, rng);
      r.out[i] = simulateToEnd(s, pb, rng);
    }
  }
  for (const r of res) r.wp = r.out.reduce((a, b) => a + b, 0) / n;
  const best = res.reduce((a, b) => (b.wp > a.wp ? b : a));
  const spread = (best.wp - Math.min(...res.map((r) => r.wp))) * 100;
  return res.map((r) => {
    // standard error of the paired difference with the best option, in points
    let m = 0, v = 0;
    for (let i = 0; i < n; i++) m += best.out[i] - r.out[i];
    m /= n;
    for (let i = 0; i < n; i++) { const d = best.out[i] - r.out[i] - m; v += d * d; }
    const se = Math.sqrt(v / Math.max(1, n - 1) / n) * 100;
    const delta = (best.wp - r.wp) * 100;
    return { call: r.call, wp: r.wp, delta, se, grade: gradeOf(delta, se, spread) };
  });
}

// Green / yellow / orange / red, in points of win chance behind the best option.
// Green also covers options the simulation can't tell apart from the best.
export function gradeOf(delta, se, spread) {
  if (spread < 1) return 'none';
  if (delta <= 0.5 || delta <= se) return 'green';
  if (delta <= 2) return 'yellow';
  if (delta <= 5) return 'orange';
  return 'red';
}
