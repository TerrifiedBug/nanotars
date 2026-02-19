---
name: calendar
description: Read and manage calendars. Use for scheduling, checking availability, creating events, or any calendar-related request. Supports Google Calendar (gog) and CalDAV (iCloud, Nextcloud, Fastmail).
allowed-tools: Bash(gog:*,node:*,curl:*)
---

# Calendar Access

## Google Calendar (gog CLI)

**IMPORTANT:** `gog calendar events` only queries ONE calendar at a time (defaults to primary). The user may have multiple calendars (e.g. F1 schedule, shared calendars). **Always query ALL calendars** when listing events:

```bash
for cal in $(gog calendar calendars --plain | tail -n+2 | cut -f1); do
  gog calendar events --from today --to "+7d" "$cal" 2>/dev/null
done
```

List calendars:
```bash
gog calendar calendars
```

Query a specific calendar by ID:
```bash
gog calendar events --from "2025-01-15" --to "2025-01-16" "CALENDAR_ID"
```

Create an event:
```bash
gog calendar create --title "Meeting" --start "2025-01-15T10:00:00" --end "2025-01-15T11:00:00" --calendar "primary"
```

## CalDAV Calendars (iCloud, Nextcloud, Fastmail)

The cal CLI is mounted at `/opt/cal-cli/` and reads CALDAV_ACCOUNTS from the environment.

List calendars:
```bash
node /opt/cal-cli/dist/index.js calendars
```

List events:
```bash
node /opt/cal-cli/dist/index.js events --from today --to "+7d"
```

## Multiple Google Accounts

If multiple Google accounts are configured, gog uses `$GOG_ACCOUNT` as the default. To target a specific account, pass `--account`:
```bash
gog calendar events --from today --to "+7d" --account user@gmail.com
```

List all available accounts:
```bash
gog auth list
```

## Tips

- Default to 7-day lookahead unless the user specifies a range
- When creating events, confirm the time and calendar with the user first
- Use ISO 8601 format for dates/times
