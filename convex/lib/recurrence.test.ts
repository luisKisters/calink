import { describe, expect, test } from "vitest";
import {
  applyEditScope,
  buildRRuleString,
  expandOccurrences,
  getLocalWallClock,
  parseRRuleString,
  type RecurrenceEvent,
} from "./recurrence";

const hour = 60 * 60 * 1000;
const day = 24 * hour;

function isoDates(dates: Date[]): string[] {
  return dates.map((date) => date.toISOString());
}

describe("recurrence verification", () => {
  test("keeps Europe/Berlin weekly events at the same wall-clock hour across spring DST", () => {
    const event: RecurrenceEvent = {
      title: "Standup",
      start: Date.UTC(2026, 1, 23, 8),
      end: Date.UTC(2026, 1, 23, 9),
      allDay: false,
      timezone: "Europe/Berlin",
      rrule: "FREQ=WEEKLY;COUNT=8",
      exdates: [],
    };

    const occurrences = expandOccurrences(event, {
      from: Date.UTC(2026, 1, 1),
      to: Date.UTC(2026, 3, 30),
    });

    expect(occurrences).toHaveLength(8);
    expect(
      occurrences.map((occurrence) => getLocalWallClock(occurrence, "Europe/Berlin").hour),
    ).toEqual(Array.from({ length: 8 }, () => 9));
  });

  test("following split of COUNT-limited series does not create extra occurrences", () => {
    const series: RecurrenceEvent = {
      title: "Daily focus",
      start: Date.UTC(2026, 0, 1, 9),
      end: Date.UTC(2026, 0, 1, 10),
      allDay: false,
      timezone: "UTC",
      rrule: "FREQ=DAILY;COUNT=5",
      exdates: [],
    };
    const original = isoDates(
      expandOccurrences(series, {
        from: series.start,
        to: series.start + 10 * day,
      }),
    );

    const writes = applyEditScope(series, series.start + 2 * day, "following", {
      title: "Daily focus shifted",
    });
    const seriesPatch = writes.find((write) => write.kind === "updateSeries");
    const inserted = writes.find((write) => write.kind === "insertSeries");

    expect(seriesPatch?.kind).toBe("updateSeries");
    expect(inserted?.kind).toBe("insertSeries");
    if (seriesPatch?.kind !== "updateSeries" || inserted?.kind !== "insertSeries") {
      throw new Error("Expected split writes");
    }

    const afterSplit = isoDates([
      ...expandOccurrences(
        { ...series, ...seriesPatch.patch },
        { from: series.start, to: series.start + 10 * day },
      ),
      ...expandOccurrences(inserted.event, {
        from: series.start,
        to: series.start + 10 * day,
      }),
    ]).sort();

    expect(afterSplit).toEqual(original);
  });

  test("expands weekdays, monthly nth weekday, EXDATE, and all-day rules", () => {
    const weekdays = expandOccurrences(
      {
        title: "Workout",
        start: Date.UTC(2026, 2, 23, 8),
        end: Date.UTC(2026, 2, 23, 9),
        allDay: false,
        timezone: "Europe/Berlin",
        rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5",
        exdates: [],
      },
      { from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 3, 15) },
    );
    expect(weekdays).toHaveLength(5);

    const secondTuesday = expandOccurrences(
      {
        title: "Billing",
        start: Date.UTC(2026, 0, 13, 8),
        end: Date.UTC(2026, 0, 13, 9),
        allDay: false,
        timezone: "Europe/Berlin",
        rrule: "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;COUNT=3",
        exdates: [],
      },
      { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 3, 1) },
    );
    expect(secondTuesday.map((date) => getLocalWallClock(date, "Europe/Berlin").day)).toEqual([
      13, 10, 10,
    ]);

    const allDay = expandOccurrences(
      {
        title: "OOO",
        start: Date.UTC(2026, 5, 1),
        allDay: true,
        timezone: "Europe/Berlin",
        rrule: "FREQ=DAILY;COUNT=3",
        exdates: [Date.UTC(2026, 5, 2)],
      },
      { from: Date.UTC(2026, 5, 1), to: Date.UTC(2026, 5, 5) },
    );
    expect(allDay.map((date) => date.toISOString().slice(0, 10))).toEqual([
      "2026-06-01",
      "2026-06-03",
    ]);
  });

  test("parses and rebuilds typed RRULE models", () => {
    const model = parseRRuleString("FREQ=MONTHLY;INTERVAL=2;BYDAY=TU;BYSETPOS=2;COUNT=4");
    expect(buildRRuleString(model)).toBe("FREQ=MONTHLY;INTERVAL=2;BYDAY=TU;BYSETPOS=2;COUNT=4");
  });

  test("this-only edit creates one EXDATE and one override", () => {
    const series: RecurrenceEvent = {
      title: "Standup",
      start: Date.UTC(2026, 2, 23, 8),
      end: Date.UTC(2026, 2, 23, 9),
      allDay: false,
      timezone: "Europe/Berlin",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      exdates: [],
    };
    const instanceStart = Date.UTC(2026, 3, 6, 7);
    const writes = applyEditScope(series, instanceStart, "this", {
      title: "Moved standup",
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      kind: "updateSeries",
      patch: { exdates: [instanceStart] },
    });
    expect(writes[1]).toMatchObject({
      kind: "insertOverride",
      event: { title: "Moved standup", recurrenceId: instanceStart },
    });
  });

  test("every-2-weeks rule expands with correct interval", () => {
    const event: RecurrenceEvent = {
      title: "Biweekly sync",
      start: Date.UTC(2026, 0, 5, 14),
      end: Date.UTC(2026, 0, 5, 15),
      allDay: false,
      timezone: "UTC",
      rrule: "FREQ=WEEKLY;INTERVAL=2;COUNT=4",
      exdates: [],
    };
    const occurrences = expandOccurrences(event, {
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 2, 1),
    });
    expect(occurrences).toHaveLength(4);
    // Jan 5, Jan 19, Feb 2, Feb 16 — each exactly 14 days apart
    for (let i = 1; i < occurrences.length; i++) {
      expect(occurrences[i].getTime() - occurrences[i - 1].getTime()).toBe(14 * day);
    }
  });

  test("monthly by day number (BYMONTHDAY) expands correctly", () => {
    const event: RecurrenceEvent = {
      title: "Pay rent",
      start: Date.UTC(2026, 0, 15, 9),
      end: Date.UTC(2026, 0, 15, 10),
      allDay: false,
      timezone: "UTC",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3",
      exdates: [],
    };
    const occurrences = expandOccurrences(event, {
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 3, 30),
    });
    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((d) => d.getUTCDate())).toEqual([15, 15, 15]);
    // Jan, Feb, Mar
    expect(occurrences.map((d) => d.getUTCMonth())).toEqual([0, 1, 2]);
  });

  test("yearly recurrence expands correctly", () => {
    const event: RecurrenceEvent = {
      title: "Annual review",
      start: Date.UTC(2024, 5, 15, 10),
      end: Date.UTC(2024, 5, 15, 11),
      allDay: false,
      timezone: "UTC",
      rrule: "FREQ=YEARLY;COUNT=3",
      exdates: [],
    };
    const occurrences = expandOccurrences(event, {
      from: Date.UTC(2024, 0, 1),
      to: Date.UTC(2027, 11, 31),
    });
    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((d) => d.getUTCFullYear())).toEqual([2024, 2025, 2026]);
    expect(occurrences.map((d) => d.getUTCMonth())).toEqual([5, 5, 5]);
    expect(occurrences.map((d) => d.getUTCDate())).toEqual([15, 15, 15]);
  });

  test("UNTIL terminates series at the right boundary (inclusive)", () => {
    const event: RecurrenceEvent = {
      title: "Daily standup",
      start: Date.UTC(2026, 0, 1, 9),
      end: Date.UTC(2026, 0, 1, 10),
      allDay: false,
      timezone: "UTC",
      rrule: "FREQ=DAILY;UNTIL=20260105T090000Z",
      exdates: [],
    };
    const occurrences = expandOccurrences(event, {
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 0, 31),
    });
    expect(occurrences).toHaveLength(5);
    expect(occurrences[4].toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  test("keeps Europe/Berlin weekly events at the same wall-clock hour across autumn DST", () => {
    // DST ends last Sunday of October in Berlin (Oct 25, 2026): clocks fall back from 03:00 to 02:00
    const event: RecurrenceEvent = {
      title: "Evening standup",
      // Sep 7, 2026 at 09:00 Europe/Berlin = 07:00 UTC (CEST, UTC+2)
      start: Date.UTC(2026, 8, 7, 7),
      end: Date.UTC(2026, 8, 7, 8),
      allDay: false,
      timezone: "Europe/Berlin",
      rrule: "FREQ=WEEKLY;COUNT=8",
      exdates: [],
    };
    const occurrences = expandOccurrences(event, {
      from: Date.UTC(2026, 8, 1),
      to: Date.UTC(2026, 10, 30),
    });
    expect(occurrences).toHaveLength(8);
    // All occurrences should be at 09:00 local time in Berlin regardless of DST offset
    expect(
      occurrences.map((occurrence) => getLocalWallClock(occurrence, "Europe/Berlin").hour),
    ).toEqual(Array.from({ length: 8 }, () => 9));
  });

  test("all-scope edit updates series directly without insertions", () => {
    const series: RecurrenceEvent = {
      title: "Weekly review",
      start: Date.UTC(2026, 0, 5, 10),
      end: Date.UTC(2026, 0, 5, 11),
      allDay: false,
      timezone: "UTC",
      rrule: "FREQ=WEEKLY;COUNT=10",
      exdates: [],
    };
    const writes = applyEditScope(series, series.start, "all", { title: "Weekly retrospective" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "updateSeries", patch: { title: "Weekly retrospective" } });
  });

  test("following split with UNTIL-based series preserves the original occurrence set", () => {
    const series: RecurrenceEvent = {
      title: "Morning run",
      start: Date.UTC(2026, 0, 1, 6),
      end: Date.UTC(2026, 0, 1, 7),
      allDay: false,
      timezone: "UTC",
      rrule: "FREQ=DAILY;UNTIL=20260110T060000Z",
      exdates: [],
    };
    const window = { from: series.start, to: Date.UTC(2026, 0, 31) };
    const original = isoDates(expandOccurrences(series, window));

    const splitAt = Date.UTC(2026, 0, 5, 6);
    const writes = applyEditScope(series, splitAt, "following", { title: "Evening run" });
    const updateWrite = writes.find((w) => w.kind === "updateSeries");
    const insertWrite = writes.find((w) => w.kind === "insertSeries");
    expect(updateWrite?.kind).toBe("updateSeries");
    expect(insertWrite?.kind).toBe("insertSeries");
    if (updateWrite?.kind !== "updateSeries" || insertWrite?.kind !== "insertSeries") {
      throw new Error("Expected split writes");
    }

    const afterSplit = isoDates([
      ...expandOccurrences({ ...series, ...updateWrite.patch }, window),
      ...expandOccurrences(insertWrite.event, window),
    ]).sort();

    expect(afterSplit).toEqual(original);
  });

  test("limit parameter caps expanded occurrences", () => {
    const event: RecurrenceEvent = {
      title: "Infinite daily",
      start: Date.UTC(2026, 0, 1, 9),
      allDay: false,
      timezone: "UTC",
      rrule: "FREQ=DAILY",
      exdates: [],
    };
    const occurrences = expandOccurrences(event, {
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 11, 31),
      limit: 5,
    });
    expect(occurrences).toHaveLength(5);
  });
});
