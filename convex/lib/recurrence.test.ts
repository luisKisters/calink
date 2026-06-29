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
});
