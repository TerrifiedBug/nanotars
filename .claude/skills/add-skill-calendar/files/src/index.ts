#!/usr/bin/env node

import { loadAccounts, listCalendars, getEvents, createEvent, deleteEvent } from './client';

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const booleanFlags = new Set(['all-day']);

function getPositionalAfterCommand(): string | undefined {
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (!booleanFlags.has(args[i].slice(2))) {
        i++; // skip flag value (but not for boolean flags)
      }
      continue;
    }
    return args[i];
  }
  return undefined;
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    console.log(`CalDAV Calendar CLI

Usage:
  cal calendars [--account NAME]
  cal events [CALENDAR] --from ISO --to ISO [--account NAME]
  cal create CALENDAR --title TEXT --start ISO --end ISO [--location TEXT] [--description TEXT] [--rrule RULE] [--all-day] [--account NAME]
  cal delete CALENDAR --title TEXT [--account NAME]

Options for create:
  --all-day       Create an all-day event. --start and --end should be dates (YYYY-MM-DD).
                  For a single all-day event, --end should be the NEXT day.
  --rrule RULE    Add a recurrence rule (iCalendar RRULE format).
                  Examples: "FREQ=WEEKLY;BYDAY=TU", "FREQ=MONTHLY;BYMONTHDAY=1"

Examples:
  cal calendars
  cal calendars --account iCloud
  cal events --from 2024-01-01T00:00:00Z --to 2024-01-02T00:00:00Z
  cal events "Personal" --from 2024-01-01T00:00:00Z --to 2024-01-02T00:00:00Z
  cal create "Personal" --title "Dentist" --start 2024-03-01T10:00:00Z --end 2024-03-01T11:00:00Z
  cal create "Work" --title "Meeting" --start 2024-03-01T14:00:00Z --end 2024-03-01T15:00:00Z --location "Room 3"
  cal create "Work" --title "Office Day" --start 2026-02-17 --end 2026-02-18 --all-day --rrule "FREQ=WEEKLY;BYDAY=TU"
  cal delete "Work" --title "Office Day"

Environment:
  CALDAV_ACCOUNTS  JSON array of CalDAV account configs
                   [{"name":"iCloud","serverUrl":"https://caldav.icloud.com","user":"...","pass":"..."}]`);
    process.exit(0);
  }

  const accounts = loadAccounts();
  const accountFilter = getFlag('account');

  const filtered = accountFilter
    ? accounts.filter((a) => a.name.toLowerCase() === accountFilter.toLowerCase())
    : accounts;

  if (accountFilter && filtered.length === 0) {
    console.error(`No account found matching "${accountFilter}"`);
    console.error(`Available accounts: ${accounts.map((a) => a.name).join(', ')}`);
    process.exit(1);
  }

  if (command === 'calendars') {
    for (const account of filtered) {
      const calendars = await listCalendars(account);
      for (const cal of calendars) {
        console.log(`[${cal.account}] ${cal.displayName}`);
      }
    }
  } else if (command === 'events') {
    const from = getFlag('from');
    const to = getFlag('to');
    if (!from || !to) {
      console.error('Error: --from and --to are required for events command');
      console.error('Example: cal events --from 2024-01-01T00:00:00Z --to 2024-01-02T00:00:00Z');
      process.exit(1);
    }

    const calendarName = getPositionalAfterCommand();
    const allEvents = [];

    for (const account of filtered) {
      const events = await getEvents(account, from, to, calendarName);
      allEvents.push(...events);
    }

    // Sort by start time
    allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

    for (const event of allEvents) {
      const startStr = event.allDay
        ? event.start.toISOString().slice(0, 10)
        : event.start.toISOString();
      const endStr = event.allDay
        ? event.end.toISOString().slice(0, 10)
        : event.end.toISOString();
      let line = `${startStr} - ${endStr}  ${event.summary}`;
      if (event.location) line += `  @ ${event.location}`;
      line += `  [${event.account}/${event.calendar}]`;
      console.log(line);
    }

    if (allEvents.length === 0) {
      console.log('No events found in the specified time range.');
    }
  } else if (command === 'create') {
    const calendarName = getPositionalAfterCommand();
    const title = getFlag('title');
    const start = getFlag('start');
    const end = getFlag('end');
    const location = getFlag('location');
    const description = getFlag('description');

    const allDay = hasFlag('all-day');
    const rrule = getFlag('rrule');

    if (!calendarName || !title || !start || !end) {
      console.error('Error: CALENDAR, --title, --start, and --end are required');
      console.error('Example: cal create "Personal" --title "Dentist" --start 2024-03-01T10:00:00Z --end 2024-03-01T11:00:00Z');
      process.exit(1);
    }

    // Use first matching account (or first account if no filter)
    const account = filtered[0];
    const ok = await createEvent(account, calendarName, title, start, end, {
      location,
      description,
      allDay,
      rrule,
    });
    if (!ok) process.exit(1);
  } else if (command === 'delete') {
    const calendarName = getPositionalAfterCommand();
    const title = getFlag('title');

    if (!calendarName || !title) {
      console.error('Error: CALENDAR and --title are required');
      console.error('Example: cal delete "Personal" --title "Dentist"');
      process.exit(1);
    }

    const account = filtered[0];
    const ok = await deleteEvent(account, calendarName, title);
    if (!ok) process.exit(1);
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Use "cal --help" for usage information.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
