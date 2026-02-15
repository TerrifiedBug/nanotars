---
name: commute
description: Check travel time and distance between locations using Waze live traffic data. Use for commute times, journey planning, or whenever someone asks how long it takes to get somewhere.
allowed-tools: Bash(curl:*,jq:*)
---

# Travel Time with Waze

Get live traffic-based travel times using the Waze routing API (no API key needed).

## Two-Step Process

### Step 1: Geocode addresses to coordinates

```bash
# Geocode an address (use row-SearchServer for EU/UK/AU, SearchServer for US)
curl -s -G "https://www.waze.com/row-SearchServer/mozi" \
  --data-urlencode "q=Oxford, UK" \
  --data-urlencode "lang=eng" \
  --data-urlencode "origin=livemap" \
  -H "User-Agent: Mozilla/5.0" \
  -H "Referer: https://www.waze.com/" | jq '.[0] | {name, lat: .location.lat, lon: .location.lon}'
```

### Step 2: Get route with travel time

```bash
# Use coordinates from step 1 (format: x:LONGITUDE y:LATITUDE)
curl -s -G "https://routing-livemap-row.waze.com/RoutingManager/routingRequest" \
  --data-urlencode "from=x:START_LON y:START_LAT" \
  --data-urlencode "to=x:END_LON y:END_LAT" \
  --data-urlencode "at=0" \
  --data-urlencode "returnJSON=true" \
  --data-urlencode "returnGeometries=false" \
  --data-urlencode "returnInstructions=false" \
  --data-urlencode "timeout=60000" \
  --data-urlencode "nPaths=3" \
  --data-urlencode "options=AVOID_TRAILS:t,AVOID_TOLL_ROADS:f,AVOID_FERRIES:f" \
  -H "User-Agent: Mozilla/5.0" \
  -H "Referer: https://www.waze.com/" | jq '{
    routes: [.alternatives[] | {
      name: .response.routeName,
      time_minutes: ([.response.results[].crossTime] | add / 60 | . * 100 | round / 100),
      distance_km: ([.response.results[].length] | add / 1000 | . * 100 | round / 100)
    }]
  }'
```

## Regional Servers

| Region | Search Server | Routing Server |
|--------|--------------|----------------|
| EU/UK/AU | `www.waze.com/row-SearchServer/mozi` | `routing-livemap-row.waze.com` |
| US/Canada | `www.waze.com/SearchServer/mozi` | `routing-livemap-am.waze.com` |
| Israel | `www.waze.com/il-SearchServer/mozi` | `routing-livemap-il.waze.com` |

Default to EU/UK servers unless the user's location suggests otherwise.

## Route Options

Add to the `options` parameter:
- `AVOID_TOLL_ROADS:t` — avoid tolls
- `AVOID_FERRIES:t` — avoid ferries
- `AVOID_TRAILS:t` — avoid unpaved roads

## Response Parsing

The routing response contains `alternatives[]`, each with `response.results[]` segments:
- `crossTime` — travel time for segment (seconds, includes live traffic)
- `crossTimeWithoutRealTime` — average time without live traffic
- `length` — segment distance (meters)

Sum all segments for total time/distance.

## Important Notes

- **Headers required**: Always include `User-Agent` and `Referer` headers or requests will be blocked
- **NaN values**: Response JSON may contain bare `NaN` values. Pipe through `sed 's/NaN/"NaN"/g'` before `jq` if parsing fails
- **Coordinates format**: Waze uses `x:longitude y:latitude` (note: longitude first!)
- **nPaths**: Set to 3 to show alternative routes with different times

## Remembering Locations

When the user tells you their home, work, or other frequent locations, save them to your CLAUDE.md memory so you can look up travel times without asking each time. Example format:

```
## Saved Locations
- Home: Oxford, UK (lat: 51.752, lon: -1.258)
- Work: London, UK (lat: 51.507, lon: -0.128)
```
