import { v } from "convex/values";

export const actorTypeValidator = v.union(
  v.literal("user"),
  v.literal("agent"),
  v.literal("mcp"),
);

export const eventStatusValidator = v.union(
  v.literal("confirmed"),
  v.literal("cancelled"),
);

export const eventInputValidator = v.object({
  title: v.string(),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  meetingUrl: v.optional(v.string()),
  start: v.number(),
  end: v.optional(v.number()),
  allDay: v.boolean(),
  timezone: v.string(),
  rrule: v.optional(v.string()),
  exdates: v.optional(v.array(v.number())),
  recurrenceId: v.optional(v.number()),
});

export const eventPatchValidator = v.object({
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  meetingUrl: v.optional(v.string()),
  start: v.optional(v.number()),
  end: v.optional(v.number()),
  allDay: v.optional(v.boolean()),
  timezone: v.optional(v.string()),
  rrule: v.optional(v.string()),
  exdates: v.optional(v.array(v.number())),
  status: v.optional(eventStatusValidator),
  recurrenceId: v.optional(v.number()),
});

export const editScopeValidator = v.union(
  v.literal("this"),
  v.literal("following"),
  v.literal("all"),
);
