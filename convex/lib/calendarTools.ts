import { z } from "zod";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { applyEditScope, type RecurrenceEvent, type RecurrencePatch } from "./recurrence";

export const toolDefinitions = [
  {
    name: "list_events",
    description: "List events for the current calendar.",
    inputSchema: {
      type: "object",
      properties: {
        includeCancelled: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_event",
    description: "Create an event in the current calendar.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        meetingUrl: { type: "string" },
        startISO: { type: "string" },
        endISO: { type: "string" },
        allDay: { type: "boolean" },
        timezone: { type: "string" },
        rrule: { type: "string" },
      },
      required: ["title", "startISO", "allDay", "timezone"],
      additionalProperties: false,
    },
  },
  {
    name: "update_event",
    description: "Update an event. Recurring events support scope all, this, or following.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        scope: { type: "string", enum: ["this", "following", "all"] },
        instanceStartISO: { type: "string" },
        patch: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            location: { type: "string" },
            meetingUrl: { type: "string" },
            startISO: { type: "string" },
            endISO: { type: "string" },
            allDay: { type: "boolean" },
            timezone: { type: "string" },
            rrule: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["eventId", "scope", "patch"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_event",
    description: "Delete or cancel an event. Recurring events support scope all, this, or following.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        scope: { type: "string", enum: ["this", "following", "all"] },
        instanceStartISO: { type: "string" },
      },
      required: ["eventId", "scope"],
      additionalProperties: false,
    },
  },
] as const;

const listEventsInput = z.object({
  includeCancelled: z.boolean().optional(),
});

const createEventInput = z.object({
  title: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  meetingUrl: z.string().optional(),
  startISO: z.string(),
  endISO: z.string().optional(),
  allDay: z.boolean(),
  timezone: z.string(),
  rrule: z.string().optional(),
});

const patchInput = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  meetingUrl: z.string().optional(),
  startISO: z.string().optional(),
  endISO: z.string().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  rrule: z.string().optional(),
});

const updateEventInput = z.object({
  eventId: z.string(),
  scope: z.enum(["this", "following", "all"]),
  instanceStartISO: z.string().optional(),
  patch: patchInput,
});

const deleteEventInput = z.object({
  eventId: z.string(),
  scope: z.enum(["this", "following", "all"]),
  instanceStartISO: z.string().optional(),
});

export type ToolExecutionResult = {
  content: string;
  applied: string[];
};

function parseIso(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ${field}`);
  }
  return ms;
}

function eventInputFromTool(input: z.infer<typeof createEventInput>) {
  return {
    title: input.title,
    description: input.description,
    location: input.location,
    meetingUrl: input.meetingUrl,
    start: parseIso(input.startISO, "startISO"),
    end: input.endISO === undefined ? undefined : parseIso(input.endISO, "endISO"),
    allDay: input.allDay,
    timezone: input.timezone,
    rrule: input.rrule,
    exdates: [],
  };
}

function patchFromTool(input: z.infer<typeof patchInput>): RecurrencePatch {
  return {
    title: input.title,
    description: input.description,
    location: input.location,
    meetingUrl: input.meetingUrl,
    start: input.startISO === undefined ? undefined : parseIso(input.startISO, "patch.startISO"),
    end: input.endISO === undefined ? undefined : parseIso(input.endISO, "patch.endISO"),
    allDay: input.allDay,
    timezone: input.timezone,
    rrule: input.rrule,
  };
}

function recurrenceEventFromDoc(event: {
  _id: Id<"events">;
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
}): RecurrenceEvent {
  return {
    id: event._id,
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

function eventInputFromRecurrence(event: RecurrenceEvent) {
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
    recurrenceId: event.recurrenceId,
  };
}

export async function executeCalendarTool(
  ctx: ActionCtx,
  args: {
    ownerId: Id<"users">;
    calendarId: Id<"calendars">;
    name: string;
    input: unknown;
    actorType: "agent" | "mcp";
  },
): Promise<ToolExecutionResult> {
  if (args.name === "list_events") {
    const input = listEventsInput.parse(args.input);
    const events = await ctx.runQuery(internal.events.listForOwner, {
      ownerId: args.ownerId,
      calendarId: args.calendarId,
      includeCancelled: input.includeCancelled,
    });
    return { content: JSON.stringify(events), applied: [] };
  }
  if (args.name === "create_event") {
    const input = createEventInput.parse(args.input);
    const eventId = await ctx.runMutation(internal.events.applyCreate, {
      ownerId: args.ownerId,
      calendarId: args.calendarId,
      event: eventInputFromTool(input),
      actorType: args.actorType,
    });
    return { content: JSON.stringify({ eventId }), applied: [`create:${eventId}`] };
  }
  if (args.name === "update_event") {
    const input = updateEventInput.parse(args.input);
    const eventId = input.eventId as Id<"events">;
    if (input.scope === "all") {
      await ctx.runMutation(internal.events.applyUpdate, {
        ownerId: args.ownerId,
        eventId,
        patch: patchFromTool(input.patch),
        actorType: args.actorType,
      });
      return { content: JSON.stringify({ eventId, updated: true }), applied: [`update:${eventId}`] };
    }
    const instanceStart =
      input.instanceStartISO === undefined
        ? undefined
        : parseIso(input.instanceStartISO, "instanceStartISO");
    if (instanceStart === undefined) {
      throw new Error("instanceStartISO is required for recurring scoped edits");
    }
    const event = await ctx.runQuery(internal.events.getForOwner, {
      ownerId: args.ownerId,
      eventId,
    });
    const writes = applyEditScope(
      recurrenceEventFromDoc(event),
      instanceStart,
      input.scope,
      patchFromTool(input.patch),
    );
    const applied: string[] = [];
    for (const write of writes) {
      if (write.kind === "updateSeries") {
        await ctx.runMutation(internal.events.applyUpdate, {
          ownerId: args.ownerId,
          eventId,
          patch: write.patch,
          actorType: args.actorType,
        });
        applied.push(`update:${eventId}`);
      } else {
        const newEventId = await ctx.runMutation(internal.events.applyCreate, {
          ownerId: args.ownerId,
          calendarId: args.calendarId,
          event: eventInputFromRecurrence(write.event),
          actorType: args.actorType,
        });
        applied.push(`create:${newEventId}`);
      }
    }
    return { content: JSON.stringify({ eventId, scoped: input.scope }), applied };
  }
  if (args.name === "delete_event") {
    const input = deleteEventInput.parse(args.input);
    const eventId = input.eventId as Id<"events">;
    if (input.scope === "all") {
      await ctx.runMutation(internal.events.applyDelete, {
        ownerId: args.ownerId,
        eventId,
        actorType: args.actorType,
      });
      return { content: JSON.stringify({ eventId, deleted: true }), applied: [`delete:${eventId}`] };
    }
    const instanceStart =
      input.instanceStartISO === undefined
        ? undefined
        : parseIso(input.instanceStartISO, "instanceStartISO");
    if (instanceStart === undefined) {
      throw new Error("instanceStartISO is required for recurring scoped deletes");
    }
    if (input.scope === "this") {
      const event = await ctx.runQuery(internal.events.getForOwner, {
        ownerId: args.ownerId,
        eventId,
      });
      await ctx.runMutation(internal.events.applyUpdate, {
        ownerId: args.ownerId,
        eventId,
        patch: { exdates: Array.from(new Set([...event.exdates, instanceStart])) },
        actorType: args.actorType,
      });
      return { content: JSON.stringify({ eventId, excluded: instanceStart }), applied: [`update:${eventId}`] };
    }
    const event = await ctx.runQuery(internal.events.getForOwner, {
      ownerId: args.ownerId,
      eventId,
    });
    const writes = applyEditScope(recurrenceEventFromDoc(event), instanceStart, "following", {
      status: "cancelled",
    });
    for (const write of writes) {
      if (write.kind === "updateSeries") {
        await ctx.runMutation(internal.events.applyUpdate, {
          ownerId: args.ownerId,
          eventId,
          patch: write.patch,
          actorType: args.actorType,
        });
      }
    }
    return { content: JSON.stringify({ eventId, splitAt: instanceStart }), applied: [`update:${eventId}`] };
  }
  throw new Error(`Unknown tool: ${args.name}`);
}
