import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { getAuthedUserId, requireOwnedCalendar, requireOwnedEvent } from "./lib/authz";
import {
  actorTypeValidator,
  eventInputValidator,
  eventPatchValidator,
} from "./lib/validators";
import { randomBase64Url } from "./lib/tokens";

type ActorType = "user" | "agent" | "mcp";
type EventInput = Infer<typeof eventInputValidator>;
type EventPatch = Infer<typeof eventPatchValidator>;

type EventSnapshot = {
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

type ChangeInverse =
  | { kind: "deleteEvent"; eventId: Id<"events"> }
  | { kind: "restoreEvent"; eventId: Id<"events">; previous: EventSnapshot };

function snapshotEvent(event: Doc<"events">): EventSnapshot {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    meetingUrl: event.meetingUrl,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    timezone: event.timezone,
    rrule: event.rrule,
    exdates: event.exdates,
    status: event.status,
    sequence: event.sequence,
    lastModified: event.lastModified,
    recurrenceId: event.recurrenceId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid undo payload: ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`Invalid undo payload: ${field}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid undo payload: ${field}`);
  }
  return value;
}

function parseSnapshot(value: unknown): EventSnapshot {
  if (!isRecord(value)) {
    throw new Error("Invalid undo payload: previous");
  }
  const status = requireString(value.status, "status");
  if (status !== "confirmed" && status !== "cancelled") {
    throw new Error("Invalid undo payload: status");
  }
  const exdatesValue = value.exdates;
  if (!Array.isArray(exdatesValue) || !exdatesValue.every((item) => typeof item === "number")) {
    throw new Error("Invalid undo payload: exdates");
  }
  return {
    title: requireString(value.title, "title"),
    description:
      value.description === undefined ? undefined : requireString(value.description, "description"),
    location: value.location === undefined ? undefined : requireString(value.location, "location"),
    meetingUrl:
      value.meetingUrl === undefined ? undefined : requireString(value.meetingUrl, "meetingUrl"),
    start: requireNumber(value.start, "start"),
    end: value.end === undefined ? undefined : requireNumber(value.end, "end"),
    allDay: requireBoolean(value.allDay, "allDay"),
    timezone: requireString(value.timezone, "timezone"),
    rrule: value.rrule === undefined ? undefined : requireString(value.rrule, "rrule"),
    exdates: exdatesValue,
    status,
    sequence: requireNumber(value.sequence, "sequence"),
    lastModified: requireNumber(value.lastModified, "lastModified"),
    recurrenceId:
      value.recurrenceId === undefined
        ? undefined
        : requireNumber(value.recurrenceId, "recurrenceId"),
  };
}

function parseInverse(value: unknown): ChangeInverse {
  if (!isRecord(value)) {
    throw new Error("Invalid undo payload");
  }
  const kind = requireString(value.kind, "kind");
  const eventId = requireString(value.eventId, "eventId") as Id<"events">;
  if (kind === "deleteEvent") {
    return { kind, eventId };
  }
  if (kind === "restoreEvent") {
    return { kind, eventId, previous: parseSnapshot(value.previous) };
  }
  throw new Error("Invalid undo payload: kind");
}

function patchFromEventPatch(patch: EventPatch, now: number): Partial<Doc<"events">> {
  const dbPatch: Partial<Doc<"events">> = {
    sequence: undefined,
    lastModified: now,
  };
  if (patch.title !== undefined) dbPatch.title = patch.title;
  if (patch.description !== undefined) dbPatch.description = patch.description;
  if (patch.location !== undefined) dbPatch.location = patch.location;
  if (patch.meetingUrl !== undefined) dbPatch.meetingUrl = patch.meetingUrl;
  if (patch.start !== undefined) dbPatch.start = patch.start;
  if (patch.end !== undefined) dbPatch.end = patch.end;
  if (patch.allDay !== undefined) dbPatch.allDay = patch.allDay;
  if (patch.timezone !== undefined) dbPatch.timezone = patch.timezone;
  if (patch.rrule !== undefined) dbPatch.rrule = patch.rrule;
  if (patch.exdates !== undefined) dbPatch.exdates = patch.exdates;
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.recurrenceId !== undefined) dbPatch.recurrenceId = patch.recurrenceId;
  return dbPatch;
}

async function appendChange(
  ctx: MutationCtx,
  args: {
    calendarId: Id<"calendars">;
    actorType: ActorType;
    op: "create" | "update" | "delete" | "bulk";
    inverse: ChangeInverse;
    description: string;
  },
): Promise<Id<"changeLog">> {
  return await ctx.db.insert("changeLog", {
    calendarId: args.calendarId,
    actorType: args.actorType,
    op: args.op,
    inverse: args.inverse,
    description: args.description,
    createdAt: Date.now(),
    undone: false,
  });
}

async function createEventForOwner(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  calendarId: Id<"calendars">,
  event: EventInput,
  actorType: ActorType,
): Promise<Id<"events">> {
  const calendar = await requireOwnedCalendar(ctx, calendarId, ownerId);
  const now = Date.now();
  const eventId = await ctx.db.insert("events", {
    calendarId,
    uid: `${randomBase64Url(16)}@calink.app`,
    title: event.title,
    description: event.description,
    location: event.location,
    meetingUrl: event.meetingUrl,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    timezone: event.timezone,
    rrule: event.rrule,
    exdates: event.exdates ?? [],
    status: "confirmed",
    sequence: 0,
    lastModified: now,
    recurrenceId: event.recurrenceId,
  });
  await ctx.db.patch(calendarId, { sequence: calendar.sequence + 1 });
  await appendChange(ctx, {
    calendarId,
    actorType,
    op: "create",
    inverse: { kind: "deleteEvent", eventId },
    description: `Created ${event.title}`,
  });
  return eventId;
}

async function updateEventForOwner(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  eventId: Id<"events">,
  patch: EventPatch,
  actorType: ActorType,
): Promise<void> {
  const { event, calendar } = await requireOwnedEvent(ctx, eventId, ownerId);
  const now = Date.now();
  const dbPatch = patchFromEventPatch(patch, now);
  dbPatch.sequence = event.sequence + 1;
  await ctx.db.patch(eventId, dbPatch);
  await ctx.db.patch(event.calendarId, { sequence: calendar.sequence + 1 });
  await appendChange(ctx, {
    calendarId: event.calendarId,
    actorType,
    op: "update",
    inverse: { kind: "restoreEvent", eventId, previous: snapshotEvent(event) },
    description: `Updated ${event.title}`,
  });
}

async function deleteEventForOwner(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  eventId: Id<"events">,
  actorType: ActorType,
): Promise<void> {
  const { event, calendar } = await requireOwnedEvent(ctx, eventId, ownerId);
  if (event.status === "cancelled") {
    return;
  }
  await ctx.db.patch(eventId, {
    status: "cancelled",
    sequence: event.sequence + 1,
    lastModified: Date.now(),
  });
  await ctx.db.patch(event.calendarId, { sequence: calendar.sequence + 1 });
  await appendChange(ctx, {
    calendarId: event.calendarId,
    actorType,
    op: "delete",
    inverse: { kind: "restoreEvent", eventId, previous: snapshotEvent(event) },
    description: `Deleted ${event.title}`,
  });
}

async function undoForOwner(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  calendarId: Id<"calendars">,
): Promise<Id<"changeLog"> | null> {
  const calendar = await requireOwnedCalendar(ctx, calendarId, ownerId);
  const change = await ctx.db
    .query("changeLog")
    .withIndex("by_calendar", (q) => q.eq("calendarId", calendarId))
    .order("desc")
    .filter((q) => q.eq(q.field("undone"), false))
    .first();
  if (change === null) {
    return null;
  }
  const inverse = parseInverse(change.inverse as unknown);
  if (inverse.kind === "deleteEvent") {
    const event = await ctx.db.get(inverse.eventId);
    if (event !== null && event.calendarId === calendarId) {
      await ctx.db.delete(inverse.eventId);
    }
  } else {
    const event = await ctx.db.get(inverse.eventId);
    if (event !== null && event.calendarId === calendarId) {
      await ctx.db.patch(inverse.eventId, inverse.previous);
    }
  }
  await ctx.db.patch(calendarId, { sequence: calendar.sequence + 1 });
  await ctx.db.patch(change._id, { undone: true });
  return change._id;
}

export const listByCalendar = query({
  args: {
    calendarId: v.id("calendars"),
    includeCancelled: v.optional(v.boolean()),
  },
  handler: async (ctx, { calendarId, includeCancelled }) => {
    await requireOwnedCalendar(ctx, calendarId);
    const events = await ctx.db
      .query("events")
      .withIndex("by_calendar", (q) => q.eq("calendarId", calendarId))
      .collect();
    return includeCancelled ? events : events.filter((event) => event.status !== "cancelled");
  },
});

export const create = mutation({
  args: { calendarId: v.id("calendars"), event: eventInputValidator },
  handler: async (ctx, { calendarId, event }): Promise<Id<"events">> => {
    const ownerId = await getAuthedUserId(ctx);
    return await createEventForOwner(ctx, ownerId, calendarId, event, "user");
  },
});

export const update = mutation({
  args: { eventId: v.id("events"), patch: eventPatchValidator },
  handler: async (ctx, { eventId, patch }) => {
    const ownerId = await getAuthedUserId(ctx);
    await updateEventForOwner(ctx, ownerId, eventId, patch, "user");
  },
});

export const remove = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const ownerId = await getAuthedUserId(ctx);
    await deleteEventForOwner(ctx, ownerId, eventId, "user");
  },
});

export const undo = mutation({
  args: { calendarId: v.id("calendars") },
  handler: async (ctx, { calendarId }): Promise<Id<"changeLog"> | null> => {
    const ownerId = await getAuthedUserId(ctx);
    return await undoForOwner(ctx, ownerId, calendarId);
  },
});

export const listForOwner = internalQuery({
  args: {
    ownerId: v.id("users"),
    calendarId: v.id("calendars"),
    includeCancelled: v.optional(v.boolean()),
  },
  handler: async (ctx, { ownerId, calendarId, includeCancelled }) => {
    await requireOwnedCalendar(ctx, calendarId, ownerId);
    const events = await ctx.db
      .query("events")
      .withIndex("by_calendar", (q) => q.eq("calendarId", calendarId))
      .collect();
    return includeCancelled ? events : events.filter((event) => event.status !== "cancelled");
  },
});

export const getForOwner = internalQuery({
  args: { ownerId: v.id("users"), eventId: v.id("events") },
  handler: async (ctx, { ownerId, eventId }) => {
    const { event } = await requireOwnedEvent(ctx, eventId, ownerId);
    return event;
  },
});

export const applyCreate = internalMutation({
  args: {
    ownerId: v.id("users"),
    calendarId: v.id("calendars"),
    event: eventInputValidator,
    actorType: actorTypeValidator,
  },
  handler: async (ctx, { ownerId, calendarId, event, actorType }): Promise<Id<"events">> => {
    return await createEventForOwner(ctx, ownerId, calendarId, event, actorType);
  },
});

export const applyUpdate = internalMutation({
  args: {
    ownerId: v.id("users"),
    eventId: v.id("events"),
    patch: eventPatchValidator,
    actorType: actorTypeValidator,
  },
  handler: async (ctx, { ownerId, eventId, patch, actorType }) => {
    await updateEventForOwner(ctx, ownerId, eventId, patch, actorType);
  },
});

export const applyDelete = internalMutation({
  args: {
    ownerId: v.id("users"),
    eventId: v.id("events"),
    actorType: actorTypeValidator,
  },
  handler: async (ctx, { ownerId, eventId, actorType }) => {
    await deleteEventForOwner(ctx, ownerId, eventId, actorType);
  },
});

export const undoForActor = internalMutation({
  args: { ownerId: v.id("users"), calendarId: v.id("calendars") },
  handler: async (ctx, { ownerId, calendarId }): Promise<Id<"changeLog"> | null> => {
    return await undoForOwner(ctx, ownerId, calendarId);
  },
});
