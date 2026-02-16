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
    if (component.type !== 'VEVENT') continue;
    const vevent = component as ical.VEvent;
    events.push({
      uid: vevent.uid || key,
      summary: vevent.summary || '(no title)',
      start: vevent.start instanceof Date ? vevent.start : new Date(vevent.start as unknown as string),
      end: vevent.end instanceof Date ? vevent.end : new Date(vevent.end as unknown as string),
      location: vevent.location || undefined,
      description: vevent.description || undefined,
      allDay: vevent.datetype === 'date',
      calendar: calendarName,
      account: accountName,
    });
  }

  return events;
}
