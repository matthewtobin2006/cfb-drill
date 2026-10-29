// The page: loads today's spot, runs the drive, asks the worker to grade each call.
import {
  CALLS, TEMPO, newGame, clone, options, defenseTimeout, userSnap, autoSnap,
  mulberry32, hashString, lead,
} from './engine.js';

const SIMS_PER_OPTION = 2500;
const GRADE_EMOJI = { green: '🟩', yellow: '🟨', orange: '🟧', red: '🟥', none: '⬜' };
const STORE_KEY = 'cfbdrill:v1';
const $ = (id) => document.getElementById(id);

let pb, spot, s, rng, worker, dateKey, practice = false;
let tempo = 'normal';
let snapNo = 0;
const graded = []; // { call, grade, delta }
let evalId = 0;

// ---------- storage (best effort: private windows can block it) ----------
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { results: {}, streak: 0, last: null }; }
  catch { return { results: {}, streak: 0, last: null }; }
}
function saveStore(st) { try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch { /* ignore */ } }

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayNumber(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// ---------- rendering ----------
const fmtClock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
const ordinal = (n) => ['', '1st', '2nd', '3rd', '4th'][n] || `${n}th`;

function spotText(st) {
  const fromOwnGoal = 100 - st.ytg;
  if (st.ytg === 50) return 'midfield';
  return fromOwnGoal < 50 ? `own ${fromOwnGoal}` : `opp ${st.ytg}`;
}

function renderBoard() {
  $('usName').textContent = spot.teams.us;
  $('themName').textContent = spot.teams.them;
  $('usPts').textContent = s.score.us;
  $('themPts').textContent = s.score.them;
  for (const side of ['us', 'them']) {
    const el = $(`${side}To`);
    el.innerHTML = [0, 1, 2].map((i) => `<i class="${i < s.to[side] ? '' : 'used'}"></i>`).join('');
    el.parentElement.classList.toggle('poss', s.poss === side && !s.over);
  }
  $('clock').textContent = s.ot ? '—' : fmtClock(s.clock);
  $('period').textContent = s.ot ? `Overtime ${s.ot}` : '4th quarter';
  let sit;
  if (s.over) sit = 'Final';
  else if (s.phase === 'pat') sit = 'Touchdown! Kick the PAT or go for two from the 3';
  else if (s.phase === 'two') sit = 'Two-point play from the 3';
  else {
    const who = s.poss === 'us' ? spot.teams.us : spot.teams.them;
    const toGo = s.dist >= s.ytg ? 'Goal' : s.dist;
    sit = `${who} ball · ${ordinal(s.down)} & ${toGo} at the ${spotText(s)}`;
  }
  $('situation').textContent = sit;
  renderField();
}

function renderField() {
  // 0..120 wide: our end zone 0-10, field 10-110, their end zone 110-120. We attack right.
  const ballX = 10 + (s.poss === 'us' ? 100 - s.ytg : s.ytg);
  const dir = s.poss === 'us' ? 1 : -1;
  const lineToGain = ballX + dir * Math.min(s.dist, s.ytg);
  let lines = '';
  for (let x = 10; x <= 110; x += 10) lines += `<line x1="${x}" y1="0" x2="${x}" y2="30" stroke="rgba(255,255,255,.35)" stroke-width="${x === 60 ? .5 : .3}"/>`;
  for (let x = 20; x <= 100; x += 10) {
    const yd = x <= 60 ? x - 10 : 110 - x;
    lines += `<text x="${x}" y="27" font-size="3" fill="rgba(255,255,255,.55)" text-anchor="middle" font-family="Barlow Condensed">${yd}</text>`;
  }
  const showDrive = !s.over && s.phase === 'play';
  $('field').innerHTML = `
    <rect x="0" y="0" width="120" height="30" fill="var(--turf)"/>
    ${[0, 1, 2, 3, 4].map((i) => `<rect x="${10 + i * 20}" y="0" width="10" height="30" fill="var(--turf-2)"/>`).join('')}
    <rect x="0" y="0" width="10" height="30" fill="var(--board)"/>
    <rect x="110" y="0" width="10" height="30" fill="var(--board)"/>
    <text x="5" y="15" font-size="3" fill="var(--board-ink)" text-anchor="middle" dominant-baseline="middle" transform="rotate(-90 5 15)" font-family="Barlow Condensed">${esc(spot.teams.us).toUpperCase()}</text>
    <text x="115" y="15" font-size="3" fill="var(--board-ink)" text-anchor="middle" dominant-baseline="middle" transform="rotate(90 115 15)" font-family="Barlow Condensed">${esc(spot.teams.them).toUpperCase()}</text>
    ${lines}
    ${showDrive ? `<line x1="${ballX}" y1="0" x2="${ballX}" y2="30" stroke="#5aa2ff" stroke-width=".5"/>` : ''}
    ${showDrive && lineToGain > 10 && lineToGain < 110 ? `<line x1="${lineToGain}" y1="0" x2="${lineToGain}" y2="30" stroke="var(--accent)" stroke-width=".5"/>` : ''}
    ${s.over ? '' : `<ellipse cx="${ballX}" cy="14" rx="1.6" ry="1" fill="#8a4b22" stroke="#fff" stroke-width=".2"/>`}
  `;
}

function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function addLog(html, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = html;
  $('log').prepend(li);
}

function describe(ev, before) {
  const who = ev.team === 'us' ? spot.teams.us : spot.teams.them;
  const callName = ev.call ? CALLS[ev.call].label : '';
  const when = before.ot ? `OT${before.ot}` : fmtClock(Math.max(0, before.clock - (ev.runoff || 0)));
  return { who, callName, when };
}

// ---------- controls ----------
function renderControls() {
  const opts = options(s, pb);
  const inPlay = s.phase === 'play' && !s.ot;
  $('tempoRow').hidden = !inPlay;
  $('tempoRow').innerHTML = Object.entries(TEMPO).map(([k, t]) =>
    `<button role="radio" aria-checked="${k === tempo}" data-tempo="${k}">${t.label}</button>`).join('');
  $('tempoRow').querySelectorAll('button').forEach((b) => b.onclick = () => { tempo = b.dataset.tempo; renderControls(); });

  const canTO = inPlay && s.clockState !== 'stopped' && s.to.us > 0;
  $('toToggle').hidden = !canTO;
  if (!canTO) $('useTO').checked = false;

  const groups = {};
  for (const c of opts) {
    let g = CALLS[c].group;
    if (s.phase !== 'play' && CALLS[c].kind !== 'pat') g = 'Go for two';
    (groups[g] ||= []).push(c);
  }
  $('calls').innerHTML = Object.entries(groups).map(([g, cs]) =>
    `<div class="group"><h3>${g}</h3><div class="btns">${cs.map((c) =>
      `<button class="call" data-call="${c}">${CALLS[c].label}</button>`).join('')}</div></div>`).join('');
  $('calls').querySelectorAll('.call').forEach((b) => b.onclick = () => makeCall(b.dataset.call));
  $('controls').hidden = false;
}

function evalInWorker(state, opts, useTO) {
  const id = ++evalId;
  return new Promise((resolve) => {
    const onMsg = (e) => {
      if (e.data.type === 'eval' && e.data.id === id) { worker.removeEventListener('message', onMsg); resolve(e.data.res); }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({
      type: 'eval', id, state, opts, tempo, useTO, n: SIMS_PER_OPTION,
      seed: hashString(`${dateKey}|${spot.id}|grade|${snapNo}`),
    });
  });
}

async function makeCall(call) {
  $('controls').hidden = true;
  $('thinking').hidden = false;
  const useTO = $('useTO').checked;
  const opts = options(s, pb);
  const before = clone(s);
  const res = await evalInWorker(before, opts, useTO);
  $('thinking').hidden = true;

  const mine = res.find((r) => r.call === call);
  const best = res.reduce((a, b) => (b.wp > a.wp ? b : a));
  graded.push({ call, grade: mine.grade, delta: mine.delta });

  const ev = userSnap(s, call, tempo, useTO, pb, rng);
  snapNo++;
  $('useTO').checked = false;

  const { callName, when } = describe(ev, before);
  const why = mine.grade === 'none'
    ? 'Nothing you could call here changed the win chance much.'
    : mine.call === best.call || mine.grade === 'green'
      ? `Win chance with this call: ${(mine.wp * 100).toFixed(1)}%. Best available.`
      : `Win chance with this call: ${(mine.wp * 100).toFixed(1)}%. Best was ${CALLS[best.call].label} at ${(best.wp * 100).toFixed(1)}% (−${mine.delta.toFixed(1)}).`;
  addLog(`${GRADE_EMOJI[mine.grade]} <b>${callName}</b>: ${esc(ev.result)}
    <div class="meta">${when}${ev.runoff ? ` · ${ev.runoff}s ran off before the snap` : ''}${useTO ? ' · timeout' : ''}</div>
    <div class="why">${why}</div>`, `g-${mine.grade}`);
  renderBoard();
  await runUntilOurSnap();
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Let the other team play their possession, then hand control back.
async function runUntilOurSnap() {
  while (!s.over && s.poss === 'them') {
    await pause(650);
    const before = clone(s);
    const ev = autoSnap(s, pb, rng);
    const { who, callName, when } = describe(ev, before);
    addLog(`<b>${esc(who)}</b>${callName ? ` · ${callName}` : ''}: ${esc(ev.result)}
      <div class="meta">${when}${ev.defTO ? ` · ${esc(spot.teams.us)} timeout` : ''}</div>`, 'them');
    renderBoard();
  }
  if (s.over) return finish();
  if (defenseTimeout(s)) {
    addLog(`<b>${esc(spot.teams.them)} calls timeout</b><div class="meta">${fmtClock(s.clock)}</div>`, 'note');
    renderBoard();
  }
  renderControls();
}

// ---------- end of game ----------
function finish() {
  $('controls').hidden = true;
  renderBoard();
  const won = s.score.us > s.score.them;
  const counted = graded.filter((g) => g.grade !== 'none');
  const lost = counted.reduce((a, g) => a + g.delta, 0);
  const greens = counted.filter((g) => g.grade === 'green').length;
  const squares = graded.map((g) => GRADE_EMOJI[g.grade]).join('');
  const realLine = spot.real
    ? `The real ${esc(spot.teams.us)} ${spot.real.won ? 'won' : 'lost'} this one, ${esc(spot.real.final)}.`
    : '';

  if (!practice) {
    const st = loadStore();
    if (!st.results[dateKey]) {
      const yesterday = localDateKey(new Date(Date.now() - 86400000));
      st.streak = st.last === yesterday ? st.streak + 1 : 1;
      st.last = dateKey;
      st.results[dateKey] = { won, squares, lost: +lost.toFixed(1), final: `${s.score.us}-${s.score.them}` };
      saveStore(st);
    }
    showStreak();
  }

  const shareText = `CFB Drill ${practice ? '(practice)' : dateKey}\n${spot.teams.us} ${won ? 'W' : 'L'} ${s.score.us}-${s.score.them}\n${squares}\nWin chance given up: ${lost.toFixed(1)}\n${location.origin}${location.pathname}`;
  $('end').innerHTML = `
    <h2>${won ? 'You won it' : 'You lost it'}</h2>
    <div class="final">${esc(spot.teams.us)} ${s.score.us}, ${esc(spot.teams.them)} ${s.score.them}${s.ot ? ` (${s.ot}OT)` : ''}</div>
    <div class="squares">${squares || '—'}</div>
    <div class="stats">
      <div class="stat"><b>${greens}/${counted.length}</b><span>best calls</span></div>
      <div class="stat"><b>${lost.toFixed(1)}</b><span>win-chance points given up</span></div>
    </div>
    <p>${realLine}</p>
    <button id="shareBtn">Copy result</button>
    <button class="ghost" id="practiceBtn">Practice drive</button>`;
  $('end').hidden = false;
  $('shareBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(shareText); $('shareBtn').textContent = 'Copied'; }
    catch { prompt('Copy your result:', shareText); }
  };
  $('practiceBtn').onclick = () => startPractice();
}

function showStreak() {
  const st = loadStore();
  if (st.streak > 0) { $('streak').hidden = false; $('streak').textContent = `🔥 ${st.streak}-day streak`; }
}

// ---------- start ----------
function start(theSpot, seedStr) {
  spot = theSpot;
  s = newGame(spot);
  rng = mulberry32(hashString(seedStr));
  snapNo = 0; graded.length = 0; tempo = 'normal';
  $('log').innerHTML = ''; $('end').hidden = true;
  const down = lead(s, 'us') < 0 ? `down ${-lead(s, 'us')}` : lead(s, 'us') === 0 ? 'tied' : `up ${lead(s, 'us')}`;
  addLog(`<b>${esc(spot.teams.us)}</b> ball, ${down}, ${fmtClock(s.clock)} left in the 4th.
    <div class="meta">${spot.season ? `${spot.season}, week ${spot.week}` : 'Sample spot'}</div>`, 'note');
  renderBoard();
  renderControls();
}

function startPractice() {
  practice = true;
  const pick = Math.floor(Math.random() * spotList.length);
  start(spotList[pick], `practice|${Date.now()}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let spotList;
async function init() {
  const [pbRes, spotsRes] = await Promise.all([fetch('data/playbook.json'), fetch('data/spots.json')]);
  pb = await pbRes.json();
  const spotsData = await spotsRes.json();
  spotList = spotsData.spots;
  if (pb.meta?.synthetic || spotsData.meta?.synthetic) {
    $('notice').hidden = false;
    $('notice').textContent = 'Sample data: these plays and spots are placeholders. Real college plays load after the first data update.';
  }
  worker = new Worker(new URL('./grader.worker.js', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'init', playbook: pb });

  dateKey = localDateKey();
  showStreak();
  const forced = new URLSearchParams(location.search).get('spot');
  practice = forced != null; // ?spot=N is for testing and never counts as the daily
  const idx = forced != null ? Number(forced) % spotList.length : dayNumber(dateKey) % spotList.length;
  start(spotList[idx], `${dateKey}|${spotList[idx].id}`);

  const done = loadStore().results[dateKey];
  if (done && forced == null) {
    $('controls').hidden = true;
    addLog(`You already played today's drive: ${done.squares} (${done.won ? 'W' : 'L'} ${done.final}). Come back tomorrow, or play a practice drive.`, 'note');
    $('end').hidden = false;
    $('end').innerHTML = `<button id="practiceBtn">Practice drive</button>`;
    $('practiceBtn').onclick = () => startPractice();
  }
}

init().catch((err) => {
  $('situation').textContent = 'Could not load the game data.';
  console.error(err);
});
