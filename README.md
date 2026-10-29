# CFB Drill

A daily college football play-calling game. Every day everyone gets the same real
late-game spot: the real score, clock, field position and timeouts. You call the plays.

- **Every snap is a real play.** Your call draws a real college play of that call type
  from the same kind of situation (down, distance, field zone).
- **Every call is graded on win chance.** Before the result is shown, the game plays out
  the rest of the game thousands of times for every option you had and compares your
  call with the best one: 🟩 best or within 0.5 points, 🟨 within 2, 🟧 within 5,
  🟥 more than 5 worse. A good call that doesn't work is still a good call.

Inspired by [Two-Minute Drill](https://2mindrills.com/) (NFL). Not affiliated with the
NCAA, any conference or any school; no logos are used.

## How it's organized

```
web/                      the site (static, no build step)
  index.html, style.css
  js/engine.js            rules, clock, overtime, play sampling, the "typical coach",
                          game simulation and grading; shared by page and worker
  js/grader.worker.js     runs the grading simulations off the main thread
  js/game.js              the page: today's spot, controls, log, end card, streak
  data/playbook.json      real plays grouped by call and situation
  data/spots.json         real late-game spots for the daily

pipeline/                 Python, no third-party packages
  fetch_plays.py          download FBS play-by-play from CollegeFootballData.com
  build_data.py           label calls, bucket plays, pick spots -> web/data/
  make_sample_data.py     SYNTHETIC placeholder data so the site runs on day one

.github/workflows/
  deploy.yml              publish web/ to GitHub Pages
  update-data.yml         every Sunday: fetch, rebuild, commit new data
```

## Setup

1. **Turn on Pages:** repo Settings → Pages → Source: **GitHub Actions**. The next push
   (or running the "Deploy site" workflow by hand) publishes the site.
2. **Add your API key:** get a free key at collegefootballdata.com, then add it as a
   repo secret named `CFBD_API_KEY` (Settings → Secrets and variables → Actions).
3. **Load real data:** Actions tab → "Update play data" → Run workflow. After that it
   runs every Sunday on its own and the site redeploys.

Until step 3 the site runs on synthetic sample data and says so in a banner.

## Running locally

```
python3 -m http.server 8000 --directory web       # then open http://localhost:8000
CFBD_API_KEY=... python3 pipeline/fetch_plays.py --years 2023 2024 2025
python3 pipeline/build_data.py
```

Add `?spot=3` to the URL to play a specific spot (never counts as the daily).

## How the engine works

1. **Situation buckets.** Plays are grouped by `down | distance bin | field zone`
   (`s` ≤2, `m` ≤6, `l` ≤10, `x` 11+; zones `gl` ≤10, `rz` ≤20, `opp` ≤50, `own`).
   When a bucket is thin, the engine falls back to wider ones (`down|*|zone`, then
   `*|*|zone`, then everything). Keep `bucketKeys` in engine.js and build_data.py in sync.
2. **Labeling calls.** College play-by-play has no charting data, so direction and depth
   come from the play text ("up the middle", "left end", "deep", "short", "screen").
   Runs with no direction count as inside runs; passes with no depth go to a generic
   `pass` pool used only as a fallback.
3. **The typical coach** (`policy` in engine.js) calls plays for the other team and for
   both teams in simulations: pass/run mix by down, distance, score and clock; kneels when
   the clock can be run out; field goals, punts and fourth-down tries; timeouts late.
4. **Grading.** For every option, the engine plays the rest of the game 2,500 times with
   the same random sequences for each option (common random numbers), so the differences
   between options are much less noisy than the raw win chances.
5. **College rules** in the engine: 40-second play clock, first-down clock stops only in
   the last 2:00, out of bounds stops the clock until the snap only in the last 2:00,
   kickoff touchbacks at the 25, two-point tries from the 3, overtime from the 25 with
   mandatory two-point tries from the 2nd OT and two-point plays from the 3rd. Check the
   NCAA rulebook each season; rules change.

## Ideas for next steps

- Condition plays on team strength (talent gaps matter far more in college).
- Percentile against thousands of simulated coaches, and a "you coached like…" match.
- Leaderboard and cross-device streaks with a small backend (Cloudflare Workers + D1).
- Defense calls when the other team has the ball, and grading timeouts and tempo.
- Survivor mode: random real fourth quarters back to back.
