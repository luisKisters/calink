import { RRule } from "rrule";

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export type EditScope = "this" | "following" | "all";

export type RRuleModel = {
  freq: Frequency;
  interval?: number;
  byday?: Weekday[];
  bymonthday?: number[];
  bysetpos?: number[];
  until?: number;
  count?: number;
};

export type RecurrenceEvent = {
  id?: string;
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
  status?: "confirmed" | "cancelled";
  sequence?: number;
  lastModified?: number;
  recurrenceId?: number;
};

export type RecurrencePatch = Partial<
  Pick<
    RecurrenceEvent,
    | "title"
    | "description"
    | "location"
    | "meetingUrl"
    | "start"
    | "end"
    | "allDay"
    | "timezone"
    | "rrule"
    | "exdates"
    | "status"
    | "recurrenceId"
  >
>;

export type RecurrenceWrite =
  | { kind: "updateSeries"; patch: RecurrencePatch }
  | { kind: "insertOverride"; event: RecurrenceEvent }
  | { kind: "insertSeries"; event: RecurrenceEvent };

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const weekdays: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const frequencies: Frequency[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

function zonedFormatter(timezone: string) {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function getZonedParts(date: Date, timezone: string): DateParts {
  const parts = zonedFormatter(timezone).formatToParts(date);
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

function utcFromParts(parts: DateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function getOffsetMs(date: Date, timezone: string): number {
  return utcFromParts(getZonedParts(date, timezone)) - date.getTime();
}

function zonedPartsToUtc(parts: DateParts, timezone: string): Date {
  let utc = utcFromParts(parts);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    utc = utcFromParts(parts) - getOffsetMs(new Date(utc), timezone);
  }
  return new Date(utc);
}

function instantToFloatingDate(ms: number, timezone: string, allDay: boolean): Date {
  if (allDay) {
    const date = new Date(ms);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  const parts = getZonedParts(new Date(ms), timezone);
  return new Date(utcFromParts(parts));
}

function floatingDateToInstant(date: Date, timezone: string, allDay: boolean): Date {
  if (allDay) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  return zonedPartsToUtc(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    },
    timezone,
  );
}

function formatUntil(untilMs: number, timezone: string, allDay: boolean): string {
  const floating = instantToFloatingDate(untilMs, timezone, allDay);
  const year = String(floating.getUTCFullYear()).padStart(4, "0");
  const month = String(floating.getUTCMonth() + 1).padStart(2, "0");
  const day = String(floating.getUTCDate()).padStart(2, "0");
  if (allDay) {
    return `${year}${month}${day}`;
  }
  const hour = String(floating.getUTCHours()).padStart(2, "0");
  const minute = String(floating.getUTCMinutes()).padStart(2, "0");
  const second = String(floating.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

export function parseRRuleString(rule: string): RRuleModel {
  const model: Partial<RRuleModel> = {};
  const pairs = rule
    .replace(/^RRULE:/iu, "")
    .split(";")
    .filter((part) => part.length > 0)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator === -1) {
        throw new Error(`Invalid RRULE part: ${part}`);
      }
      return [part.slice(0, separator).toUpperCase(), part.slice(separator + 1)] as const;
    });
  for (const [key, value] of pairs) {
    if (key === "FREQ") {
      const freq = value.toUpperCase();
      if (!frequencies.includes(freq as Frequency)) {
        throw new Error(`Unsupported RRULE frequency: ${value}`);
      }
      model.freq = freq as Frequency;
    } else if (key === "INTERVAL") {
      model.interval = Number(value);
    } else if (key === "BYDAY") {
      model.byday = value.split(",").map((day) => {
        const normalized = day.toUpperCase();
        if (!weekdays.includes(normalized as Weekday)) {
          throw new Error(`Unsupported RRULE weekday: ${day}`);
        }
        return normalized as Weekday;
      });
    } else if (key === "BYMONTHDAY") {
      model.bymonthday = value.split(",").map(Number);
    } else if (key === "BYSETPOS") {
      model.bysetpos = value.split(",").map(Number);
    } else if (key === "COUNT") {
      model.count = Number(value);
    } else if (key === "UNTIL") {
      model.until = parseRRuleUntil(value);
    }
  }
  if (model.freq === undefined) {
    throw new Error("RRULE requires FREQ");
  }
  return model as RRuleModel;
}

function parseRRuleUntil(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/u.exec(value);
  if (match === null) {
    throw new Error(`Invalid RRULE UNTIL: ${value}`);
  }
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

export function buildRRuleString(model: RRuleModel): string {
  const parts = [`FREQ=${model.freq}`];
  if (model.interval !== undefined) parts.push(`INTERVAL=${model.interval}`);
  if (model.byday !== undefined && model.byday.length > 0) parts.push(`BYDAY=${model.byday.join(",")}`);
  if (model.bymonthday !== undefined && model.bymonthday.length > 0) {
    parts.push(`BYMONTHDAY=${model.bymonthday.join(",")}`);
  }
  if (model.bysetpos !== undefined && model.bysetpos.length > 0) {
    parts.push(`BYSETPOS=${model.bysetpos.join(",")}`);
  }
  if (model.count !== undefined) parts.push(`COUNT=${model.count}`);
  if (model.until !== undefined) {
    const date = new Date(model.until);
    const year = String(date.getUTCFullYear()).padStart(4, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hour = String(date.getUTCHours()).padStart(2, "0");
    const minute = String(date.getUTCMinutes()).padStart(2, "0");
    const second = String(date.getUTCSeconds()).padStart(2, "0");
    parts.push(`UNTIL=${year}${month}${day}T${hour}${minute}${second}Z`);
  }
  return parts.join(";");
}

export function expandOccurrences(
  event: RecurrenceEvent,
  options: { from: number; to: number; limit?: number },
): Date[] {
  if (event.status === "cancelled") {
    return [];
  }
  const exdates = new Set(event.exdates);
  const limit = options.limit ?? 1000;
  if (event.rrule === undefined) {
    if (event.start >= options.from && event.start <= options.to && !exdates.has(event.start)) {
      return [new Date(event.start)];
    }
    return [];
  }
  const dtstart = instantToFloatingDate(event.start, event.timezone, event.allDay);
  const rruleOptions = RRule.parseString(event.rrule);
  const rule = new RRule({ ...rruleOptions, dtstart });
  const from = instantToFloatingDate(options.from, event.timezone, event.allDay);
  const to = instantToFloatingDate(options.to, event.timezone, event.allDay);
  const occurrences = rule.between(from, to, true);
  const result: Date[] = [];
  for (const occurrence of occurrences) {
    const instant = floatingDateToInstant(occurrence, event.timezone, event.allDay);
    const ms = instant.getTime();
    if (ms >= options.from && ms <= options.to && !exdates.has(ms)) {
      result.push(instant);
    }
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

export function applyEditScope(
  series: RecurrenceEvent,
  instanceStart: number,
  scope: EditScope,
  patch: RecurrencePatch,
): RecurrenceWrite[] {
  if (scope === "all") {
    return [{ kind: "updateSeries", patch }];
  }
  const duration = series.end === undefined ? undefined : series.end - series.start;
  if (scope === "this") {
    const nextExdates = Array.from(new Set([...series.exdates, instanceStart])).sort(
      (left, right) => left - right,
    );
    const overrideStart = patch.start ?? instanceStart;
    const overrideEnd = patch.end ?? (duration === undefined ? undefined : overrideStart + duration);
    return [
      { kind: "updateSeries", patch: { exdates: nextExdates } },
      {
        kind: "insertOverride",
        event: {
          ...series,
          ...patch,
          start: overrideStart,
          end: overrideEnd,
          rrule: undefined,
          exdates: [],
          recurrenceId: instanceStart,
        },
      },
    ];
  }
  const model = parseRRuleString(series.rrule ?? "FREQ=DAILY");
  const beforeSplitCount =
    model.count === undefined
      ? undefined
      : expandOccurrences(series, {
          from: series.start,
          to: instanceStart - 1,
          limit: model.count,
        }).length;
  const remainingCount =
    model.count === undefined || beforeSplitCount === undefined
      ? undefined
      : Math.max(model.count - beforeSplitCount, 0);
  const until = instanceStart - 1;
  const originalPatch: RecurrencePatch = {
    rrule: buildRRuleString({
      ...model,
      count: undefined,
      until: parseRRuleUntil(formatUntil(until, series.timezone, series.allDay)),
    }),
  };
  const newStart = patch.start ?? instanceStart;
  const newEnd = patch.end ?? (duration === undefined ? undefined : newStart + duration);
  return [
    { kind: "updateSeries", patch: originalPatch },
    {
      kind: "insertSeries",
      event: {
        ...series,
        ...patch,
        start: newStart,
        end: newEnd,
        rrule: buildRRuleString({
          ...model,
          count: remainingCount,
          until: undefined,
        }),
        exdates: [],
        recurrenceId: undefined,
      },
    },
  ];
}

export function getLocalWallClock(date: Date, timezone: string): DateParts {
  return getZonedParts(date, timezone);
}
