---
name: trains
description: Query UK National Rail live departure boards, arrivals, delays, and train services. Use when asked about train times, departures, arrivals, delays, platforms, or "when is the next train" for UK railways.
allowed-tools: Bash(python3:*),WebFetch
---

# UK Trains

Query National Rail for live train departures and arrivals. Run `/add-trains` on the host to configure the API token for full functionality.

## Method Selection

Check if `NATIONAL_RAIL_TOKEN` is set:

```bash
python3 -c "import os; print('API' if os.environ.get('NATIONAL_RAIL_TOKEN') else 'SCRAPE')"
```

- **API** -> Use the Darwin API commands below (structured JSON, reliable)
- **SCRAPE** -> Use the WebFetch fallback below (less reliable, use as last resort)

## Darwin API (preferred)

```bash
# Departures from a station
python3 /workspace/skills/trains/scripts/trains.py departures DID
python3 /workspace/skills/trains/scripts/trains.py departures DID to PAD --rows 5

# Arrivals at a station
python3 /workspace/skills/trains/scripts/trains.py arrivals PAD
python3 /workspace/skills/trains/scripts/trains.py arrivals PAD from DID

# Station search
python3 /workspace/skills/trains/scripts/trains.py search paddington
```

### Response Format

JSON with:
- `locationName`, `crs` - Station info
- `messages[]` - Service alerts
- `trainServices[]` - List of trains:
  - `std`/`sta` - Scheduled departure/arrival time
  - `etd`/`eta` - Expected time ("On time", "Delayed", or actual time)
  - `platform` - Platform number
  - `operator` - Train operating company
  - `carriages` - Number of coaches
  - `isCancelled`, `cancelReason`, `delayReason` - Disruption info
  - `destination[].name` / `origin[].name` - Route endpoints

### Getting Arrival Times

To show both departure and arrival times, make two calls:
1. `departures DID to PAD` -- get departure times
2. `arrivals PAD from DID` -- get arrival times
Match services by the numeric prefix in serviceID.

## WebFetch Fallback (no API token)

When `NATIONAL_RAIL_TOKEN` is not set, use WebFetch to scrape the National Rail website:

```
WebFetch https://www.nationalrail.co.uk/live-trains/departures/{FROM}/{TO}
```

Examples:
- Departures from Didcot to Paddington: `https://www.nationalrail.co.uk/live-trains/departures/DID/PAD`
- Departures from Paddington to Didcot: `https://www.nationalrail.co.uk/live-trains/departures/PAD/DID`

Extract train times, status (on time/delayed/cancelled), and platform numbers from the page content. This method is less reliable than the API -- data may be incomplete or hard to parse.

## Station Codes

Use 3-letter CRS codes. Common ones:
- `DID` = Didcot Parkway
- `PAD` = London Paddington
- `RDG` = Reading
- `OXF` = Oxford
- `SWI` = Swindon
- `EUS` = London Euston
- `KGX` = London Kings Cross
- `VIC` = London Victoria
- `WAT` = London Waterloo
- `BHM` = Birmingham New Street
- `MAN` = Manchester Piccadilly

Use `search` (API mode) to find any station code.

## WhatsApp Message Template

```
{Origin} -> {Destination}

*{dep} -> {arr}* | Plt {platform} | {coaches} coaches
{status}
```

Status indicators:
- On time
- Delayed (exp {time})
- Cancelled -- {reason}
