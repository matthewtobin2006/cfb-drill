"""Turn raw CFBD plays into the two files the game loads.

    python pipeline/build_data.py

Reads  pipeline/raw/plays_*.jsonl
Writes web/data/playbook.json  real plays, grouped by call and situation
       web/data/spots.json     real late-game spots for the daily

The situation buckets here must match bucketKeys() in web/js/engine.js.
"""
import json
import random
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "pipeline" / "raw"
OUT_DIR = ROOT / "web" / "data"

MAX_PER_BUCKET = 400   # keeps the playbook small enough to ship to the browser
MIN_PER_BUCKET = 25    # thinner buckets are dropped; the engine falls back to wider ones
MAX_SPOTS = 400

# Outcome codes shared with engine.js
NORMAL, INCOMPLETE, INTERCEPTION, FUMBLE_LOST, SACK = 0, 1, 2, 3, 4


def zone(ytg):
    if ytg <= 10:
        return "gl"
    if ytg <= 20:
        return "rz"
    if ytg <= 50:
        return "opp"
    return "own"


def dist_bin(d):
    if d <= 2:
        return "s"
    if d <= 6:
        return "m"
    if d <= 10:
        return "l"
    return "x"


def bucket_keys(down, dist, ytg):
    z = zone(ytg)
    return [f"{down}|{dist_bin(dist)}|{z}", f"{down}|*|{z}", f"*|*|{z}", "*|*|*"]


CALL_KIND = {
    "inside_run": "run", "outside_left": "run", "outside_right": "run",
    "screen": "pass", "short_pass": "pass", "deep_pass": "pass", "pass": "pass",
}

RUN_TYPES = {"rush", "rushing touchdown"}
PASS_TYPES = {
    "pass reception", "pass completion", "pass incompletion", "passing touchdown",
    "pass interception return", "interception return touchdown", "pass interception",
    "sack",
}
FUMBLE_LOST_TYPES = {"fumble recovery (opponent)", "fumble return touchdown"}


def label(p):
    """Map a raw play to (call, outcome) or None if it isn't a usable snap.

    College play-by-play has no charting data, so direction and depth come from
    the play text. Runs with no direction count as inside runs. Passes with no
    depth in the text go to a generic 'pass' pool used only as a last fallback.
    """
    t = (p.get("playType") or "").lower()
    txt = (p.get("playText") or "").lower()
    if "kneel" in txt or "penalty" in t or "timeout" in t:
        return None
    if "spike" in txt:
        return None

    if t in FUMBLE_LOST_TYPES:
        outcome = FUMBLE_LOST
        is_pass = " pass " in f" {txt} "
    elif t in RUN_TYPES:
        outcome, is_pass = NORMAL, False
    elif t in PASS_TYPES:
        is_pass = True
        if t == "sack":
            outcome = SACK
        elif "interception" in t:
            outcome = INTERCEPTION
        elif t == "pass incompletion" or "incomplete" in txt:
            outcome = INCOMPLETE
        else:
            outcome = NORMAL
    else:
        return None

    if not is_pass:
        if re.search(r"\b(scramble|kneel)\b", txt):
            return None
        if "middle" in txt:
            call = "inside_run"
        elif re.search(r"\bleft (end|sideline|edge)\b", txt):
            call = "outside_left"
        elif re.search(r"\bright (end|sideline|edge)\b", txt):
            call = "outside_right"
        else:
            call = "inside_run"
        return call, outcome

    if "screen" in txt:
        call = "screen"
    elif "deep" in txt:
        call = "deep_pass"
    elif "short" in txt:
        call = "short_pass"
    else:
        call = "pass"
    return call, outcome


def num(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def timeouts(v):
    """Timeouts left, 0-3. The source sometimes has blanks or negative numbers."""
    t = num(v)
    return t if t is not None and 0 <= t <= 3 else 2


def clock_secs(c):
    if isinstance(c, dict):
        return (num(c.get("minutes"), 0) or 0) * 60 + (num(c.get("seconds"), 0) or 0)
    return None


def load_plays():
    plays = []
    for f in sorted(RAW_DIR.glob("plays_*.jsonl")):
        with f.open() as fh:
            plays.extend(json.loads(line) for line in fh if line.strip())
    return plays


def build_playbook(plays, rng):
    rows_in = []
    for p in plays:
        down, dist, ytg = num(p.get("down")), num(p.get("distance")), num(p.get("yardsToGoal"))
        if down not in (1, 2, 3, 4) or dist is None or ytg is None or not 1 <= ytg <= 99:
            continue
        lab = label(p)
        if not lab:
            continue
        call, outcome = lab
        yards = num(p.get("yardsGained"), 0)
        txt = (p.get("playText") or "").lower()
        oob = 1 if "out of bounds" in txt or "ran out" in txt else 0
        rows_in.append((call, down, dist, ytg, [yards, outcome, oob]))

    # Sacks and interceptions rarely say how deep the throw was meant to go, so they
    # land in the generic 'pass' pool. Without help, the short and deep pools would have
    # no sacks or picks at all. Give each one a chance to join them equal to the share of
    # passes whose depth is known, so their rates there match the overall rates.
    passes = sum(1 for r in rows_in if CALL_KIND.get(r[0]) == "pass")
    depth_known = sum(1 for r in rows_in if r[0] in ("short_pass", "deep_pass", "screen"))
    share = depth_known / passes if passes else 0
    n_short = sum(1 for r in rows_in if r[0] == "short_pass")
    n_deep = sum(1 for r in rows_in if r[0] == "deep_pass")
    p_short = n_short / (n_short + n_deep) if n_short + n_deep else 0.5

    buckets = defaultdict(lambda: defaultdict(list))
    for call, down, dist, ytg, row in rows_in:
        targets = [call]
        if call == "pass" and row[1] in (SACK, INTERCEPTION) and rng.random() < share:
            targets.append("short_pass" if rng.random() < p_short else "deep_pass")
        for c in targets:
            for k in bucket_keys(down, dist, ytg):
                buckets[c][k].append(row)
    labeled = len(rows_in)

    calls = {}
    for call, by_key in buckets.items():
        calls[call] = {}
        for k, rows in by_key.items():
            if len(rows) < MIN_PER_BUCKET and k != "*|*|*":
                continue
            if len(rows) > MAX_PER_BUCKET:
                rows = rng.sample(rows, MAX_PER_BUCKET)
            calls[call][k] = rows
    return calls, labeled


def build_spots(plays):
    """Late fourth-quarter possessions where the offense trails by one score."""
    by_game = defaultdict(list)
    for p in plays:
        by_game[p.get("gameId")].append(p)

    spots = []
    for gid, gp in by_game.items():
        # final score from the last play that has scores
        final = None
        for p in reversed(gp):
            if p.get("offenseScore") is not None:
                final = {p["offense"]: num(p["offenseScore"], 0), p["defense"]: num(p["defenseScore"], 0)}
                break
        if not final:
            continue
        prev_off = None
        for p in gp:
            off = p.get("offense")
            new_poss = off != prev_off
            prev_off = off
            if not new_poss or num(p.get("period")) != 4:
                continue
            secs = clock_secs(p.get("clock"))
            down, dist, ytg = num(p.get("down")), num(p.get("distance")), num(p.get("yardsToGoal"))
            os_, ds = num(p.get("offenseScore")), num(p.get("defenseScore"))
            if None in (secs, down, dist, ytg, os_, ds) or down != 1:
                continue
            margin = os_ - ds
            if not (30 <= secs <= 240 and -8 <= margin <= -1 and 20 <= ytg <= 85):
                continue
            won = final.get(off, 0) > final.get(p.get("defense"), 0)
            spots.append({
                "id": f"{gid}-{p.get('driveId')}",
                "season": p.get("season"),
                "week": p.get("week"),
                "teams": {"us": off, "them": p.get("defense")},
                "clock": secs,
                "ytg": ytg, "down": 1, "dist": min(dist, ytg),
                "score": {"us": os_, "them": ds},
                "to": {"us": timeouts(p.get("offenseTimeouts")), "them": timeouts(p.get("defenseTimeouts"))},
                "real": {"won": won, "final": f"{final.get(off, 0)}-{final.get(p.get('defense'), 0)}"},
            })
            break  # one spot per game
    spots.sort(key=lambda s: (s["season"], s["week"], s["id"]))
    return spots[-MAX_SPOTS:]


def main():
    rng = random.Random(2026)
    plays = load_plays()
    if not plays:
        raise SystemExit("No raw plays found. Run pipeline/fetch_plays.py first.")
    calls, labeled = build_playbook(plays, rng)
    spots = build_spots(plays)
    seasons = sorted({p.get("season") for p in plays})
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "playbook.json").write_text(json.dumps({
        "meta": {"source": "CollegeFootballData.com", "seasons": seasons,
                 "plays": labeled, "synthetic": False},
        "calls": calls,
    }, separators=(",", ":")))
    (OUT_DIR / "spots.json").write_text(json.dumps({
        "meta": {"synthetic": False, "seasons": seasons}, "spots": spots,
    }, separators=(",", ":")))
    print(f"playbook: {labeled} labeled plays across {len(calls)} calls")
    print(f"spots: {len(spots)}")


if __name__ == "__main__":
    main()
