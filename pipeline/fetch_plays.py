"""Download FBS play-by-play from the CollegeFootballData.com API.

Usage:
    CFBD_API_KEY=... python pipeline/fetch_plays.py --years 2023 2024 2025

Writes one JSON-lines file per season to pipeline/raw/plays_<year>.jsonl,
keeping only the fields the game needs. No third-party packages required.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.collegefootballdata.com"
RAW_DIR = Path(__file__).parent / "raw"

KEEP = [
    "gameId", "driveId", "offense", "defense", "offenseScore", "defenseScore",
    "period", "clock", "offenseTimeouts", "defenseTimeouts", "yardsToGoal",
    "down", "distance", "yardsGained", "playType", "playText", "week", "season",
]


class KeyRejected(Exception):
    pass


def get(path, params, key):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise KeyRejected(f"HTTP {e.code} from {path}: the API rejected the key") from e
            if e.code == 429 and attempt < 2:
                time.sleep(10)
                continue
            raise
        except urllib.error.URLError as e:
            if attempt < 2:
                time.sleep(5)
                continue
            raise


def camel(p, name):
    """CFBD has used both camelCase and snake_case over time; accept either."""
    if name in p:
        return p[name]
    snake = "".join("_" + c.lower() if c.isupper() else c for c in name)
    return p.get(snake)


def fetch_season(year, key):
    out = RAW_DIR / f"plays_{year}.jsonl"
    n = 0
    with out.open("w") as f:
        jobs = [("regular", w) for w in range(1, 17)] + [("postseason", 1)]
        for season_type, week in jobs:
            try:
                plays = get("/plays", {
                    "year": year, "week": week, "seasonType": season_type,
                    "classification": "fbs",
                }, key)
            except urllib.error.HTTPError as e:
                print(f"  {year} {season_type} wk{week}: HTTP {e.code}, skipped", file=sys.stderr)
                continue
            if not isinstance(plays, list):
                print(f"  {year} {season_type} wk{week}: unexpected response {str(plays)[:200]}", file=sys.stderr)
                continue
            for p in plays:
                row = {k: camel(p, k) for k in KEEP}
                row["season"] = year
                row["week"] = week if season_type == "regular" else 100 + week
                f.write(json.dumps(row) + "\n")
                n += 1
            print(f"  {year} {season_type} wk{week}: {len(plays)} plays")
            time.sleep(0.5)
    print(f"{year}: {n} plays -> {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", nargs="+", type=int, required=True)
    args = ap.parse_args()
    # Pasted keys often carry a trailing space or newline, which breaks the header.
    key = (os.environ.get("CFBD_API_KEY") or "").strip().strip('"').strip("'")
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    if not key:
        sys.exit("Set CFBD_API_KEY (free key from collegefootballdata.com).")
    if any(c.isspace() for c in key):
        sys.exit("CFBD_API_KEY contains spaces or line breaks. Re-paste just the key.")
    print(f"Using a key of {len(key)} characters.")
    RAW_DIR.mkdir(exist_ok=True)
    try:
        for y in args.years:
            fetch_season(y, key)
    except KeyRejected as e:
        sys.exit(f"{e}. Check the CFBD_API_KEY secret: it should be exactly the key from the email.")
    except urllib.error.URLError as e:
        sys.exit(f"Could not reach {API}: {e.reason}")


if __name__ == "__main__":
    main()
