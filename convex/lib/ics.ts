export type CalendarForIcs = {
  name: string;
  timezone: string;
  description?: string;
};

export type EventForIcs = {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  meetingUrl?: string;
  start: number;
  end?: number;
  allDay: boolean;
  timezone: string;
  rrule?: string;
  exdates: number[];
  status: "confirmed" | "cancelled";
  sequence: number;
  lastModified: number;
  recurrenceId?: number;
};

const encoder = new TextEncoder();

function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r?\n/gu, "\\n");
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function foldLine(line: string): string[] {
  const folded: string[] = [];
  let current = "";
  let limit = 75;
  for (const char of line) {
    if (byteLength(current + char) > limit) {
      folded.push(current);
      current = ` ${char}`;
      limit = 75;
    } else {
      current += char;
    }
  }
  folded.push(current);
  return folded;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function formatUtc(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function zonedParts(ms: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
    hour: Number(lookup.get("hour")),
    minute: Number(lookup.get("minute")),
    second: Number(lookup.get("second")),
  };
}

function formatZoned(ms: number, timezone: string): string {
  const parts = zonedParts(ms, timezone);
  return `${pad(parts.year, 4)}${pad(parts.month)}${pad(parts.day)}T${pad(parts.hour)}${pad(
    parts.minute,
  )}${pad(parts.second)}`;
}

function offsetMs(ms: number, timezone: string): number {
  const parts = zonedParts(ms, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - ms;
}

function formatOffset(ms: number): string {
  const sign = ms >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(Math.round(ms / 60_000));
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad(hours)}${pad(minutes)}`;
}

function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}`;
}

function addDays(ms: number, days: number): number {
  return ms + days * 24 * 60 * 60 * 1000;
}

function vtimezone(timezone: string): string[] {
  if (timezone === "UTC" || timezone === "Etc/UTC") {
    return [
      "BEGIN:VTIMEZONE",
      `TZID:${timezone}`,
      `X-LIC-LOCATION:${timezone}`,
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0000",
      "TZNAME:UTC",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
  }
  if (timezone === "Europe/Berlin") {
    return [
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "X-LIC-LOCATION:Europe/Berlin",
      "BEGIN:DAYLIGHT",
      "DTSTART:19700329T020000",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "TZNAME:CEST",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "TZNAME:CET",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
  }
  const january = offsetMs(Date.UTC(2026, 0, 1), timezone);
  const july = offsetMs(Date.UTC(2026, 6, 1), timezone);
  if (january === july) {
    return [
      "BEGIN:VTIMEZONE",
      `TZID:${timezone}`,
      `X-LIC-LOCATION:${timezone}`,
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      `TZOFFSETFROM:${formatOffset(january)}`,
      `TZOFFSETTO:${formatOffset(january)}`,
      `TZNAME:${timezone}`,
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
  }
  const standard = Math.min(january, july);
  const daylight = Math.max(january, july);
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${timezone}`,
    `X-LIC-LOCATION:${timezone}`,
    "BEGIN:DAYLIGHT",
    "DTSTART:19700301T020000",
    `TZOFFSETFROM:${formatOffset(standard)}`,
    `TZOFFSETTO:${formatOffset(daylight)}`,
    `TZNAME:${timezone}`,
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "DTSTART:19701001T020000",
    `TZOFFSETFROM:${formatOffset(daylight)}`,
    `TZOFFSETTO:${formatOffset(standard)}`,
    `TZNAME:${timezone}`,
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

function pushTextLine(lines: string[], key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    lines.push(`${key}:${escapeText(value)}`);
  }
}

function sanitizeUri(value: string): string {
  return value.replace(/[\r\n]/gu, "");
}

function pushEventDateLine(lines: string[], key: string, event: EventForIcs, ms: number): void {
  if (event.allDay) {
    lines.push(`${key};VALUE=DATE:${formatDate(ms)}`);
  } else {
    lines.push(`${key};TZID=${event.timezone}:${formatZoned(ms, event.timezone)}`);
  }
}

function eventLines(event: EventForIcs): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtc(event.lastModified)}`,
  ];
  pushEventDateLine(lines, "DTSTART", event, event.start);
  const end = event.end ?? (event.allDay ? addDays(event.start, 1) : event.start);
  pushEventDateLine(lines, "DTEND", event, end);
  lines.push(`SUMMARY:${escapeText(event.title)}`);
  pushTextLine(lines, "DESCRIPTION", event.description);
  pushTextLine(lines, "LOCATION", event.location);
  if (event.meetingUrl !== undefined && event.meetingUrl.length > 0) {
    lines.push(`URL:${sanitizeUri(event.meetingUrl)}`);
  }
  if (event.rrule !== undefined && event.rrule.length > 0) {
    lines.push(`RRULE:${event.rrule.replace(/^RRULE:/iu, "")}`);
  }
  for (const exdate of event.exdates) {
    pushEventDateLine(lines, "EXDATE", event, exdate);
  }
  if (event.recurrenceId !== undefined) {
    pushEventDateLine(lines, "RECURRENCE-ID", event, event.recurrenceId);
  }
  lines.push(`STATUS:${event.status.toUpperCase()}`);
  lines.push(`SEQUENCE:${event.sequence}`);
  lines.push(`LAST-MODIFIED:${formatUtc(event.lastModified)}`);
  lines.push("END:VEVENT");
  return lines;
}

export function serializeCalendar(calendar: CalendarForIcs, events: EventForIcs[]): string {
  const timezones = new Set([calendar.timezone, ...events.map((event) => event.timezone)]);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calink//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `X-WR-TIMEZONE:${calendar.timezone}`,
  ];
  pushTextLine(lines, "X-WR-CALDESC", calendar.description);
  for (const timezone of timezones) {
    lines.push(...vtimezone(timezone));
  }
  for (const event of events) {
    lines.push(...eventLines(event));
  }
  lines.push("END:VCALENDAR");
  return `${lines.flatMap(foldLine).join("\r\n")}\r\n`;
}
