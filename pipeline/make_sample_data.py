"""Generate SYNTHETIC placeholder data so the game runs before real data exists.

    python pipeline/make_sample_data.py

These plays and spots are made up from rough averages. They exist only so the
site is playable on day one. The weekly GitHub Action (or running
fetch_plays.py + build_data.py yourself) replaces them with real plays.
"""
import json
import random
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "web" / "data"
NORMAL, INCOMPLETE, INTERCEPTION, FUMBLE_LOST, SACK = 0, 1, 2, 3, 4
ZONES = ["gl", "rz", "opp", "own"]
N = 300


def run(rng, mean, sd, burst, oob_rate):
    if rng.random() < 0.012:
        return [rng.randint(-2, 4), FUMBLE_LOST, 0]
    y = round(rng.gauss(mean, sd))
    if rng.random() < burst:
        y += rng.randint(10, 60)
    return [max(y, -6), NORMAL, 1 if rng.random() < oob_rate else 0]


def pass_(rng, comp, mean, sd, int_rate, sack_rate, oob_rate):
    r = rng.random()
    if r < sack_rate:
        return [-rng.randint(3, 10), SACK, 0]
    if r < sack_rate + int_rate:
        return [0, INTERCEPTION, 0]
    if rng.random() < comp:
        y = max(round(rng.gauss(mean, sd)), -3)
        if rng.random() < 0.06:
            y += rng.randint(10, 40)
        return [y, NORMAL, 1 if rng.random() < oob_rate else 0]
    return [0, INCOMPLETE, 0]


GEN = {
    "inside_run":    lambda r: run(r, 3.8, 3.2, 0.04, 0.03),
    "outside_left":  lambda r: run(r, 4.2, 4.8, 0.07, 0.22),
    "outside_right": lambda r: run(r, 4.2, 4.8, 0.07, 0.22),
    "screen":        lambda r: pass_(r, 0.85, 5, 5, 0.005, 0.01, 0.15),
    "short_pass":    lambda r: pass_(r, 0.66, 8, 4, 0.02, 0.05, 0.25),
    "deep_pass":     lambda r: pass_(r, 0.33, 23, 8, 0.06, 0.09, 0.30),
}


def main():
    rng = random.Random(7)
    calls = {}
    for call, gen in GEN.items():
        calls[call] = {f"*|*|{z}": [gen(rng) for _ in range(N)] for z in ZONES}
        calls[call]["*|*|*"] = [gen(rng) for _ in range(N)]

    spots = [
        {"id": "sample-1", "teams": {"us": "Sample State", "them": "Example Tech"},
         "clock": 118, "ytg": 75, "down": 1, "dist": 10,
         "score": {"us": 20, "them": 24}, "to": {"us": 2, "them": 2}},
        {"id": "sample-2", "teams": {"us": "Placeholder U", "them": "Demo A&M"},
         "clock": 74, "ytg": 58, "down": 1, "dist": 10,
         "score": {"us": 17, "them": 17}, "to": {"us": 1, "them": 3}},
        {"id": "sample-3", "teams": {"us": "Test College", "them": "Mock State"},
         "clock": 195, "ytg": 66, "down": 1, "dist": 10,
         "score": {"us": 27, "them": 31}, "to": {"us": 3, "them": 1}},
    ]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "playbook.json").write_text(json.dumps({
        "meta": {"source": "synthetic placeholder", "synthetic": True}, "calls": calls,
    }, separators=(",", ":")))
    (OUT_DIR / "spots.json").write_text(json.dumps({
        "meta": {"synthetic": True}, "spots": spots,
    }, indent=1))
    print("Wrote synthetic sample data to", OUT_DIR)


if __name__ == "__main__":
    main()
