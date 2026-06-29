import { describe, expect, test } from "vitest";
import ICAL from "ical.js";
import { foldLine, serializeCalendar, type EventForIcs } from "./ics";

function event(overrides: Partial<EventForIcs> = {}): EventForIcs {
  return {
    uid: "event-1@calink.app",
    title: "Planning",
    start: Date.UTC(2026, 2, 30, 7),
    end: Date.UTC(2026, 2, 30, 8),
    allDay: false,
    timezone: "Europe/Berlin",
    exdates: [],
    status: "confirmed",
    sequence: 0,
    lastModified: Date.UTC(2026, 0, 1),
    ...overrides,
  };
}

describe("ics verification", () => {
  test("emits real Europe/Berlin timezone offsets instead of a UTC placeholder", () => {
    const ics = serializeCalendar(
      { name: "Work", timezone: "Europe/Berlin" },
      [event()],
    );

    expect(ics).toContain("TZID:Europe/Berlin");
    expect(ics).toContain("TZOFFSETTO:+0100");
    expect(ics).toContain("TZOFFSETTO:+0200");
  });

  test("does not allow URL values to inject new ICS properties", () => {
    const ics = serializeCalendar(
      { name: "Work", timezone: "Europe/Berlin" },
      [
        event({
          meetingUrl: "https://example.test/meet\r\nSUMMARY:Injected",
        }),
      ],
    );

    expect(ics).not.toMatch(/^SUMMARY:Injected$/m);
  });

  test("round-trips escaped text through ical.js", () => {
    const title = "Planning, Q3; path \\ notes\nline two";
    const ics = serializeCalendar(
      { name: "Work", timezone: "Europe/Berlin", description: "Team calendar" },
      [
        event({
          title,
          description: "Discuss launch",
          location: "Office, Room 1",
          meetingUrl: "https://meet.example.com/a",
          rrule: "FREQ=WEEKLY;COUNT=2",
          exdates: [Date.UTC(2026, 3, 6, 7)],
        }),
      ],
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("SUMMARY:Planning\\, Q3\\; path \\\\ notes\\nline two");

    const component = ICAL.Component.fromString(ics);
    const vevent = component.getFirstSubcomponent("vevent");
    expect(vevent).not.toBeNull();
    if (vevent === null) {
      throw new Error("Expected VEVENT");
    }
    const parsedEvent = new ICAL.Event(vevent);
    expect(parsedEvent.summary).toBe(title);
    expect(parsedEvent.location).toBe("Office, Room 1");
  });

  test("folds UTF-8 lines to 75 octets and unfolds to original content", () => {
    const long = `SUMMARY:${"Launch 🚀 ".repeat(20)}`;
    const folded = foldLine(long);
    const encoder = new TextEncoder();
    expect(folded.every((line) => encoder.encode(line).byteLength <= 75)).toBe(true);
    expect(folded.join("\r\n").replace(/\r\n /gu, "")).toBe(long);
  });

  test("emits all-day, cancelled, and recurrence override fields", () => {
    const ics = serializeCalendar({ name: "Personal", timezone: "UTC" }, [
      event({
        uid: "all-day@calink.app",
        title: "Holiday",
        start: Date.UTC(2026, 6, 4),
        end: undefined,
        allDay: true,
        timezone: "UTC",
        recurrenceId: Date.UTC(2026, 6, 4),
        status: "cancelled",
      }),
    ]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260704\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20260705\r\n");
    expect(ics).toContain("RECURRENCE-ID;VALUE=DATE:20260704\r\n");
    expect(ics).toContain("STATUS:CANCELLED\r\n");
  });
});
