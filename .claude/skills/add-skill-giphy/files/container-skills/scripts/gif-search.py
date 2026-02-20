#!/usr/bin/env python3
"""Search Giphy for GIFs. Returns gif and mp4 URLs."""
import json
import os
import sys
import urllib.request
import urllib.parse


def search(query, limit=3):
    api_key = os.environ.get("GIPHY_API_KEY")
    if not api_key:
        print("Error: GIPHY_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    params = urllib.parse.urlencode({
        "q": query,
        "api_key": api_key,
        "limit": limit,
        "rating": "pg-13",
        "lang": "en",
    })
    url = f"https://api.giphy.com/v1/gifs/search?{params}"

    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())

    results = []
    for item in data.get("data", []):
        images = item.get("images", {})
        gif_url = images.get("original", {}).get("url")
        mp4_url = images.get("original", {}).get("mp4")
        preview = images.get("fixed_width_small", {}).get("url", "")
        if gif_url or mp4_url:
            results.append({
                "description": item.get("title", ""),
                "gif_url": gif_url,
                "mp4_url": mp4_url,
                "preview_url": preview,
            })

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: gif-search.py <query>", file=sys.stderr)
        sys.exit(1)
    search(" ".join(sys.argv[1:]))
