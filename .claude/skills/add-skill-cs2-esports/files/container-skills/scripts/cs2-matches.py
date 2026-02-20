#!/usr/bin/env python3
"""Fetch upcoming CS2 matches from Liquipedia via esports-ics."""

import sys
import urllib.request
from datetime import datetime, timezone, timedelta

FEED_URL = "https://ics.snwfdhmp.com/matches.ics?url=https%3A%2F%2Fliquipedia.net%2Fcounterstrike%2FLiquipedia%3AMatches"

def fetch_matches(days=2):
    req = urllib.request.Request(FEED_URL, headers={"User-Agent": "nanoclaw-cs2"})
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
    days = 2
    if len(sys.argv) > 1:
        try:
            days = int(sys.argv[1])
        except ValueError:
            print(f"Usage: {sys.argv[0]} [days]", file=sys.stderr)
            sys.exit(1)

    matches = fetch_matches(days)
    if not matches:
        print(f"No upcoming CS2 matches in the next {days} day(s).")
    else:
        for dt, summary in matches:
            t = dt.strftime("%a %d %b %H:%M UTC")
            print(f"{t} | {summary}")

if __name__ == "__main__":
    main()
