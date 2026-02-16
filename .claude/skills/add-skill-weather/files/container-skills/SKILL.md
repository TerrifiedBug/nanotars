---
name: weather
description: Get weather forecasts and current conditions for any location. Use whenever weather is asked about or relevant.
allowed-tools: Bash(curl:*)
---

# Weather Lookup

Use curl for quick weather lookups (no API key needed):

```bash
curl -s "wttr.in/CityName?format=3"          # One-line summary
curl -s "wttr.in/CityName?format=%l:+%c+%t+%h+%w"  # Compact
curl -s "wttr.in/CityName?T"                  # Full forecast
```

Tips:
- URL-encode spaces (`New+York`)
- `?m` metric, `?u` USCS
- `?1` today only, `?0` current only

Fallback (JSON): `curl -s "https://api.open-meteo.com/v1/forecast?latitude=LAT&longitude=LON&current_weather=true"`
