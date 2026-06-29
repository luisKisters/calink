import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  calendars: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    color: v.string(),
    timezone: v.string(),
    description: v.optional(v.string()),
    feedToken: v.string(),
    sequence: v.number(),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_feedToken", ["feedToken"]),

  events: defineTable({
    calendarId: v.id("calendars"),
    uid: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    meetingUrl: v.optional(v.string()),
    start: v.number(),
    end: v.optional(v.number()),
    allDay: v.boolean(),
    timezone: v.string(),
    rrule: v.optional(v.string()),
    exdates: v.array(v.number()),
    status: v.union(v.literal("confirmed"), v.literal("cancelled")),
    sequence: v.number(),
    lastModified: v.number(),
    recurrenceId: v.optional(v.number()),
  })
    .index("by_calendar", ["calendarId"])
    .index("by_calendar_status", ["calendarId", "status"]),

  mcpKeys: defineTable({
    ownerId: v.id("users"),
    token: v.string(),
    label: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_token", ["token"]),

  changeLog: defineTable({
    calendarId: v.id("calendars"),
    actorType: v.union(v.literal("user"), v.literal("agent"), v.literal("mcp")),
    op: v.string(),
    inverse: v.any(),
    description: v.string(),
    createdAt: v.number(),
    undone: v.boolean(),
  }).index("by_calendar", ["calendarId"]),

  rateLimits: defineTable({
    ownerId: v.id("users"),
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_owner_key", ["ownerId", "key"]),
});
