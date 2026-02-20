#!/usr/bin/env python3
"""Fetch upcoming CS2 matches from Liquipedia via esports-ics."""

import argparse
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

BASE_URL = "https://ics.snwfdhmp.com/matches.ics"
LIQUIPEDIA_URL = "https://liquipedia.net/counterstrike/Liquipedia:Matches"


def build_feed_url(team=None, competition=None, no_tbd=False):
    params = {"url": LIQUIPEDIA_URL}
    if team:
        params["teams_regex"] = team
    if competition:
        params["competition_regex"] = competition
    if no_tbd:
        params["ignore_tbd"] = "true"
    return f"{BASE_URL}?{urllib.parse.urlencode(params)}"


def fetch_matches(days=1, team=None, competition=None, no_tbd=False):
    url = build_feed_url(team=team, competition=competition, no_tbd=no_tbd)
    req = urllib.request.Request(url, headers={"User-Agent": "nanoclaw-cs2"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        ics = resp.read().decode("utf-8")

    events = ics.split("BEGIN:VEVENT")[1:]
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(days=days)

    matches = []
    for ev in events:
        summary = ""
        dtstart = ""
        for line in ev.splitlines():
            if line.startswith("SUMMARY:"):
                summary = line.split(":", 1)[1]
            elif line.startswith("DTSTART:"):
                dtstart = line.split(":", 1)[1]
        try:
            dt = datetime.strptime(dtstart, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if now - timedelta(hours=2) <= dt <= cutoff:
            matches.append((dt, summary))

    matches.sort()
    return matches


def main():
    parser = argparse.ArgumentParser(description="Fetch upcoming CS2 matches")
    parser.add_argument("days", nargs="?", type=int, default=1,
                        help="Number of days to look ahead (default: 1)")
    parser.add_argument("--team", "-t", help="Filter by team name (regex)")
    parser.add_argument("--competition", "-c", help="Filter by competition (regex)")
    parser.add_argument("--no-tbd", action="store_true",
                        help="Hide matches with TBD/unannounced teams")
    args = parser.parse_args()

    matches = fetch_matches(
        days=args.days,
        team=args.team,
        competition=args.competition,
        no_tbd=args.no_tbd,
    )

    if not matches:
        print(f"No upcoming CS2 matches in the next {args.days} day(s).")
    else:
        for dt, summary in matches:
            t = dt.strftime("%a %d %b %H:%M UTC")
            print(f"{t} | {summary}")


if __name__ == "__main__":
    main()
