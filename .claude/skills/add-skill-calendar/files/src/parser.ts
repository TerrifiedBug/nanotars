import * as ical from 'node-ical';

export interface CalendarEvent {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  allDay: boolean;
  calendar: string;
  account: string;
}

export function parseICS(
  data: string,
  calendarName: string,
  accountName: string,
): CalendarEvent[] {
  const parsed = ical.parseICS(data);
  const events: CalendarEvent[] = [];

  for (const [key, component] of Object.entries(parsed)) {
    if (!component || component.type !== 'VEVENT') continue;
    const vevent = component as ical.VEvent;
    const loc = vevent.location as unknown;
    const desc = vevent.description as unknown;
    events.push({
      uid: vevent.uid || key,
      summary: String(vevent.summary || '(no title)'),
      start: vevent.start instanceof Date ? vevent.start : new Date(vevent.start as unknown as string),
      end: vevent.end instanceof Date ? vevent.end : new Date(vevent.end as unknown as string),
      location: loc ? String(typeof loc === 'object' && loc !== null && 'val' in loc ? (loc as {val: string}).val : loc) : undefined,
      description: desc ? String(typeof desc === 'object' && desc !== null && 'val' in desc ? (desc as {val: string}).val : desc) : undefined,
      allDay: vevent.datetype === 'date',
      calendar: calendarName,
      account: accountName,
    });
  }

  return events;
}
