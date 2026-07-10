/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  setModelClientForTesting,
  type ChatTurn,
  type ModelClient,
} from "./lib/anthropicClient";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

function createHarness() {
  return convexTest({ schema, modules });
}

async function createUser(
  t: ReturnType<typeof createHarness>,
  name: string,
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", { name, email: `${name}@example.com` });
  });
}

function asUser(t: ReturnType<typeof createHarness>, userId: Id<"users">) {
  return t.withIdentity({ subject: `${userId}|session`, issuer: "https://convex.test" });
}

async function createCalendar(t: ReturnType<typeof createHarness>, userId: Id<"users">) {
  return await asUser(t, userId).mutation(api.calendars.create, {
    name: "Work",
    color: "#1f7a6d",
    timezone: "Europe/Berlin",
  });
}

async function createEvent(
  t: ReturnType<typeof createHarness>,
  userId: Id<"users">,
  calendarId: Id<"calendars">,
) {
  return await asUser(t, userId).mutation(api.events.create, {
    calendarId,
    event: {
      title: "Planning",
      start: Date.UTC(2026, 5, 1, 7),
      end: Date.UTC(2026, 5, 1, 8),
      allDay: false,
      timezone: "Europe/Berlin",
      exdates: [],
    },
  });
}

describe("Convex backend", () => {
  test("requires auth for public functions", async () => {
    const t = createHarness();
    await expect(t.query(api.calendars.list)).rejects.toThrow("Authentication required");
  });

  test("creates calendars with unique feed tokens and round-trips event CRUD", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const first = await createCalendar(t, userId);
    const second = await asUser(t, userId).mutation(api.calendars.create, {
      name: "Home",
      color: "#8f3d3d",
      timezone: "America/New_York",
    });
    const firstFeed = await asUser(t, userId).query(api.calendars.getFeedInfo, {
      calendarId: first,
    });
    const secondFeed = await asUser(t, userId).query(api.calendars.getFeedInfo, {
      calendarId: second,
    });
    expect(firstFeed.token).not.toBe(secondFeed.token);

    const eventId = await createEvent(t, userId, first);
    await asUser(t, userId).mutation(api.events.update, {
      eventId,
      patch: { title: "Updated planning" },
    });
    const events = await asUser(t, userId).query(api.events.listByCalendar, {
      calendarId: first,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Updated planning");
  });

  test("prevents cross-tenant calendar and event access", async () => {
    const t = createHarness();
    const alice = await createUser(t, "alice");
    const bob = await createUser(t, "bob");
    const calendarId = await createCalendar(t, alice);
    const eventId = await createEvent(t, alice, calendarId);

    await expect(
      asUser(t, bob).query(api.events.listByCalendar, { calendarId }),
    ).rejects.toThrow("Calendar not found");
    await expect(
      asUser(t, bob).mutation(api.events.update, { eventId, patch: { title: "Nope" } }),
    ).rejects.toThrow("Calendar not found");
    await expect(asUser(t, bob).mutation(api.events.remove, { eventId })).rejects.toThrow(
      "Calendar not found",
    );
    await expect(asUser(t, bob).mutation(api.calendars.remove, { calendarId })).rejects.toThrow(
      "Calendar not found",
    );
  });

  test("undo reverts updates and soft deletes", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const calendarId = await createCalendar(t, userId);
    const eventId = await createEvent(t, userId, calendarId);
    await asUser(t, userId).mutation(api.events.update, {
      eventId,
      patch: { title: "New title" },
    });
    await asUser(t, userId).mutation(api.events.undo, { calendarId });
    let events = await asUser(t, userId).query(api.events.listByCalendar, {
      calendarId,
      includeCancelled: true,
    });
    expect(events[0]?.title).toBe("Planning");

    await asUser(t, userId).mutation(api.events.remove, { eventId });
    events = await asUser(t, userId).query(api.events.listByCalendar, {
      calendarId,
      includeCancelled: true,
    });
    expect(events[0]?.status).toBe("cancelled");
    await asUser(t, userId).mutation(api.events.undo, { calendarId });
    events = await asUser(t, userId).query(api.events.listByCalendar, {
      calendarId,
      includeCancelled: true,
    });
    expect(events[0]?.status).toBe("confirmed");
  });

  test("serves feed by token and returns generic 404 for unknown tokens", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const calendarId = await createCalendar(t, userId);
    await createEvent(t, userId, calendarId);
    const feed = await asUser(t, userId).query(api.calendars.getFeedInfo, { calendarId });
    const response = await t.fetch(`/feed/${feed.token}.ics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/calendar");
    const body = await response.text();
    expect(body.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);

    const missing = await t.fetch("/feed/not-a-real-token.ics");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not found");
  });

  test("MCP initializes, lists tools, creates events, and enforces bearer ownership", async () => {
    const t = createHarness();
    const alice = await createUser(t, "alice");
    const bob = await createUser(t, "bob");
    const calendarId = await createCalendar(t, alice);
    const { token } = await asUser(t, alice).mutation(api.mcpKeys.createMcpKey, {
      label: "agent",
    });
    const bobKey = await asUser(t, bob).mutation(api.mcpKeys.createMcpKey, {
      label: "other",
    });

    const unauthorized = await t.fetch("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(unauthorized.status).toBe(401);

    const initialized = await t.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });

    const listed = await t.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listedBody = (await listed.json()) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string; properties: unknown } }> };
    };
    expect(listedBody.result.tools).toHaveLength(8);
    for (const toolDef of listedBody.result.tools) {
      expect(toolDef.inputSchema).toBeDefined();
      expect(toolDef.inputSchema.type).toBe("object");
    }

    const created = await t.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "create_event",
          arguments: {
            calendarId,
            title: "MCP event",
            startISO: "2026-06-01T07:00:00.000Z",
            allDay: false,
            timezone: "Europe/Berlin",
          },
        },
      }),
    });
    expect(await created.json()).toMatchObject({ result: { isError: false } });

    const crossTenant = await t.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${bobKey.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_feed_url", arguments: { calendarId } },
      }),
    });
    expect(await crossTenant.json()).toMatchObject({ result: { isError: true } });
  });

  test("MCP returns JSON-RPC errors for malformed requests and unknown methods", async () => {
    const t = createHarness();
    const alice = await createUser(t, "alice");
    const { token } = await asUser(t, alice).mutation(api.mcpKeys.createMcpKey, {
      label: "test",
    });

    const malformedBody = await t.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json {{{",
    });
    const malformedResult = (await malformedBody.json()) as { error: { code: number } };
    expect(malformedResult.error.code).toBe(-32700);

    const unknownMethod = await t.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown/method" }),
    });
    const unknownResult = (await unknownMethod.json()) as { error: { code: number } };
    expect(unknownResult.error.code).toBe(-32601);

    const invalidRpc = await t.fetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ notJsonRpc: true }),
    });
    const invalidResult = (await invalidRpc.json()) as { error: { code: number } };
    expect(invalidResult.error.code).toBe(-32600);
  });

  test("mcpKeys management: list returns masked tokens, revoke deletes the key", async () => {
    const t = createHarness();
    const alice = await createUser(t, "alice");
    const { id: keyId, token } = await asUser(t, alice).mutation(api.mcpKeys.createMcpKey, {
      label: "mykey",
    });

    const listed = await asUser(t, alice).query(api.mcpKeys.listMcpKeys);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.label).toBe("mykey");
    expect(listed[0]?.maskedToken).not.toBe(token);
    expect(listed[0]?.maskedToken).toContain("...");

    await asUser(t, alice).mutation(api.mcpKeys.revokeMcpKey, { keyId });
    const afterRevoke = await asUser(t, alice).query(api.mcpKeys.listMcpKeys);
    expect(afterRevoke).toHaveLength(0);
  });

  test("AI extraction uses a mocked model, writes events, and undo works", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const calendarId = await createCalendar(t, userId);
    const seenPrompts: Array<{ now: string; timezone: string }> = [];
    const fakeClient: ModelClient = {
      extractEvents(args) {
        seenPrompts.push({ now: args.now, timezone: args.timezone });
        return Promise.resolve([
          {
            title: "Lunch",
            startISO: "2026-06-01T10:00:00.000Z",
            endISO: "2026-06-01T11:00:00.000Z",
            allDay: false,
          },
        ]);
      },
      createChatTurn(): Promise<ChatTurn> {
        return Promise.resolve({ text: "unused", stopReason: "end_turn", toolCalls: [] });
      },
    };
    setModelClientForTesting(fakeClient);
    try {
      const result = await asUser(t, userId).action(api.ai.extractEvents, {
        calendarId,
        text: "Lunch tomorrow 12-13",
        now: "2026-05-31T08:00:00.000Z",
        timezone: "Europe/Berlin",
      });
      expect(result.created).toHaveLength(1);
      expect(seenPrompts).toEqual([
        { now: "2026-05-31T08:00:00.000Z", timezone: "Europe/Berlin" },
      ]);
      let events = await asUser(t, userId).query(api.events.listByCalendar, { calendarId });
      expect(events[0]?.title).toBe("Lunch");
      await asUser(t, userId).mutation(api.events.undo, { calendarId });
      events = await asUser(t, userId).query(api.events.listByCalendar, { calendarId });
      expect(events).toHaveLength(0);
    } finally {
      setModelClientForTesting(null);
    }
  });

  test("AI chat auto-applies tool calls and refuses cross-tenant calls before the model", async () => {
    const t = createHarness();
    const alice = await createUser(t, "alice");
    const bob = await createUser(t, "bob");
    const calendarId = await createCalendar(t, alice);
    let turns = 0;
    let modelCalls = 0;
    const fakeClient: ModelClient = {
      extractEvents() {
        return Promise.resolve([]);
      },
      createChatTurn(): Promise<ChatTurn> {
        modelCalls += 1;
        turns += 1;
        if (turns === 1) {
          return Promise.resolve({
            text: "",
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "tool-1",
                name: "create_event",
                input: {
                  title: "Chat-created",
                  startISO: "2026-06-02T07:00:00.000Z",
                  allDay: false,
                  timezone: "Europe/Berlin",
                },
              },
            ],
          });
        }
        return Promise.resolve({ text: "Done", stopReason: "end_turn", toolCalls: [] });
      },
    };
    setModelClientForTesting(fakeClient);
    try {
      const chatResult = await asUser(t, alice).action(api.ai.chat, {
        calendarId,
        messages: [{ role: "user", content: "Add it" }],
      });
      expect(chatResult).toMatchObject({ text: "Done" });
      expect(chatResult.applied).toHaveLength(1);
      const events = await asUser(t, alice).query(api.events.listByCalendar, { calendarId });
      expect(events[0]?.title).toBe("Chat-created");

      modelCalls = 0;
      await expect(
        asUser(t, bob).action(api.ai.chat, {
          calendarId,
          messages: [{ role: "user", content: "List events" }],
        }),
      ).rejects.toThrow("Calendar not found");
      expect(modelCalls).toBe(0);
    } finally {
      setModelClientForTesting(null);
    }
  });

  test("AI chat create_event appends to changeLog and undo reverts it", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const calendarId = await createCalendar(t, userId);
    let turns = 0;
    const fakeClient: ModelClient = {
      extractEvents() {
        return Promise.resolve([]);
      },
      createChatTurn(): Promise<ChatTurn> {
        turns += 1;
        if (turns === 1) {
          return Promise.resolve({
            text: "",
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "tool-1",
                name: "create_event",
                input: {
                  title: "Undoable event",
                  startISO: "2026-07-01T09:00:00.000Z",
                  allDay: false,
                  timezone: "UTC",
                },
              },
            ],
          });
        }
        return Promise.resolve({ text: "Created.", stopReason: "end_turn", toolCalls: [] });
      },
    };
    setModelClientForTesting(fakeClient);
    try {
      const chatResult = await asUser(t, userId).action(api.ai.chat, {
        calendarId,
        messages: [{ role: "user", content: "Add a meeting" }],
      });
      expect(chatResult.applied).toHaveLength(1);
      expect(chatResult.applied[0]).toMatch(/^create:/);

      const changeLogEntry = await t.run(async (ctx) => {
        return await ctx.db
          .query("changeLog")
          .withIndex("by_calendar", (q) => q.eq("calendarId", calendarId))
          .order("desc")
          .first();
      });
      expect(changeLogEntry).not.toBeNull();
      expect(changeLogEntry?.actorType).toBe("agent");
      expect(changeLogEntry?.op).toBe("create");

      await asUser(t, userId).mutation(api.events.undo, { calendarId });
      const events = await asUser(t, userId).query(api.events.listByCalendar, { calendarId });
      expect(events).toHaveLength(0);
    } finally {
      setModelClientForTesting(null);
    }
  });

  test("AI chat update_event scope:this produces override row and exdate on original", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const calendarId = await createCalendar(t, userId);

    const recurringEventId = await asUser(t, userId).mutation(api.events.create, {
      calendarId,
      event: {
        title: "Weekly standup",
        start: Date.UTC(2026, 5, 1, 9, 0, 0),
        end: Date.UTC(2026, 5, 1, 9, 30, 0),
        allDay: false,
        timezone: "UTC",
        rrule: "FREQ=WEEKLY;COUNT=4",
        exdates: [],
      },
    });

    const instanceStartISO = "2026-06-08T09:00:00.000Z";
    let turns = 0;
    const fakeClient: ModelClient = {
      extractEvents() {
        return Promise.resolve([]);
      },
      createChatTurn(): Promise<ChatTurn> {
        turns += 1;
        if (turns === 1) {
          return Promise.resolve({
            text: "",
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "tool-2",
                name: "update_event",
                input: {
                  eventId: recurringEventId,
                  scope: "this",
                  instanceStartISO,
                  patch: { title: "Standup (retitled)" },
                },
              },
            ],
          });
        }
        return Promise.resolve({ text: "Updated.", stopReason: "end_turn", toolCalls: [] });
      },
    };
    setModelClientForTesting(fakeClient);
    try {
      const chatResult = await asUser(t, userId).action(api.ai.chat, {
        calendarId,
        messages: [{ role: "user", content: "Rename second standup" }],
      });
      expect(chatResult.applied).toHaveLength(2);

      const allEvents = await asUser(t, userId).query(api.events.listByCalendar, {
        calendarId,
        includeCancelled: true,
      });
      const original = allEvents.find((e) => e._id === recurringEventId);
      expect(original?.exdates).toContain(Date.parse(instanceStartISO));

      const override = allEvents.find(
        (e) => e._id !== recurringEventId && e.recurrenceId !== undefined,
      );
      expect(override).toBeDefined();
      expect(override?.title).toBe("Standup (retitled)");
      expect(override?.recurrenceId).toBe(Date.parse(instanceStartISO));
    } finally {
      setModelClientForTesting(null);
    }
  });

  test("rate limiter trips within a window", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const first = await t.mutation(internal.rateLimits.consume, {
      ownerId: userId,
      key: "test",
      limit: 1,
    });
    const second = await t.mutation(internal.rateLimits.consume, {
      ownerId: userId,
      key: "test",
      limit: 1,
    });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });

  test("extractEvents rate limit trips after limit is exhausted", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const calendarId = await createCalendar(t, userId);
    const fakeClient: ModelClient = {
      extractEvents() {
        return Promise.resolve([]);
      },
      createChatTurn(): Promise<ChatTurn> {
        return Promise.resolve({ text: "", stopReason: "end_turn", toolCalls: [] });
      },
    };
    setModelClientForTesting(fakeClient);
    try {
      for (let i = 0; i < 10; i += 1) {
        await t.mutation(internal.rateLimits.consume, {
          ownerId: userId,
          key: "ai_extract",
          limit: 10,
        });
      }
      await expect(
        asUser(t, userId).action(api.ai.extractEvents, {
          calendarId,
          text: "Meeting at 3pm",
          now: "2026-06-01T00:00:00.000Z",
          timezone: "UTC",
        }),
      ).rejects.toThrow("Rate limit exceeded");
    } finally {
      setModelClientForTesting(null);
    }
  });

  test("rate limiter resets an expired window without leaving duplicate rows", async () => {
    const t = createHarness();
    const userId = await createUser(t, "alice");
    const first = await t.mutation(internal.rateLimits.consume, {
      ownerId: userId,
      key: "rollover",
      limit: 2,
    });
    expect(first.allowed).toBe(true);

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("rateLimits")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", userId).eq("key", "rollover"))
        .unique();
      if (row === null) {
        throw new Error("Expected rate-limit row");
      }
      await ctx.db.patch(row._id, { windowStart: row.windowStart - 120_000 });
    });

    const second = await t.mutation(internal.rateLimits.consume, {
      ownerId: userId,
      key: "rollover",
      limit: 2,
    });
    expect(second.allowed).toBe(true);

    await expect(
      t.mutation(internal.rateLimits.consume, {
        ownerId: userId,
        key: "rollover",
        limit: 2,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });
});
