import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { getAuthedUserId, requireOwnedCalendar } from "./lib/authz";
import { maskSecret, randomBase64Url } from "./lib/tokens";

async function createUniqueFeedToken(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomBase64Url(20);
    const existing = await ctx.db
      .query("calendars")
      .withIndex("by_feedToken", (q) => q.eq("feedToken", token))
      .unique();
    if (existing === null) {
      return token;
    }
  }
  throw new Error("Could not generate unique feed token");
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getAuthedUserId(ctx);
    return await ctx.db
      .query("calendars")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    color: v.string(),
    timezone: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"calendars">> => {
    const ownerId = await getAuthedUserId(ctx);
    const now = Date.now();
    return await ctx.db.insert("calendars", {
      ownerId,
      name: args.name,
      color: args.color,
      timezone: args.timezone,
      description: args.description,
      feedToken: await createUniqueFeedToken(ctx),
      sequence: 0,
      createdAt: now,
    });
  },
});

export const listForOwner = internalQuery({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    return await ctx.db
      .query("calendars")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
  },
});

export const getForOwner = internalQuery({
  args: { ownerId: v.id("users"), calendarId: v.id("calendars") },
  handler: async (ctx, { ownerId, calendarId }) => {
    return await requireOwnedCalendar(ctx, calendarId, ownerId);
  },
});

export const createForOwner = internalMutation({
  args: {
    ownerId: v.id("users"),
    name: v.string(),
    color: v.string(),
    timezone: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"calendars">> => {
    return await ctx.db.insert("calendars", {
      ownerId: args.ownerId,
      name: args.name,
      color: args.color,
      timezone: args.timezone,
      description: args.description,
      feedToken: await createUniqueFeedToken(ctx),
      sequence: 0,
      createdAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { calendarId: v.id("calendars"), name: v.string() },
  handler: async (ctx, { calendarId, name }) => {
    await requireOwnedCalendar(ctx, calendarId);
    await ctx.db.patch(calendarId, { name });
  },
});

export const recolor = mutation({
  args: { calendarId: v.id("calendars"), color: v.string() },
  handler: async (ctx, { calendarId, color }) => {
    await requireOwnedCalendar(ctx, calendarId);
    await ctx.db.patch(calendarId, { color });
  },
});

export const setTimezone = mutation({
  args: { calendarId: v.id("calendars"), timezone: v.string() },
  handler: async (ctx, { calendarId, timezone }) => {
    await requireOwnedCalendar(ctx, calendarId);
    await ctx.db.patch(calendarId, { timezone });
  },
});

export const regenerateFeedToken = mutation({
  args: { calendarId: v.id("calendars") },
  handler: async (ctx, { calendarId }): Promise<{ feedToken: string }> => {
    const calendar = await requireOwnedCalendar(ctx, calendarId);
    const feedToken = await createUniqueFeedToken(ctx);
    await ctx.db.patch(calendarId, {
      feedToken,
      sequence: calendar.sequence + 1,
    });
    return { feedToken };
  },
});

export const remove = mutation({
  args: { calendarId: v.id("calendars") },
  handler: async (ctx, { calendarId }) => {
    await requireOwnedCalendar(ctx, calendarId);
    const events = await ctx.db
      .query("events")
      .withIndex("by_calendar", (q) => q.eq("calendarId", calendarId))
      .collect();
    const changes = await ctx.db
      .query("changeLog")
      .withIndex("by_calendar", (q) => q.eq("calendarId", calendarId))
      .collect();
    for (const event of events) {
      await ctx.db.delete(event._id);
    }
    for (const change of changes) {
      await ctx.db.delete(change._id);
    }
    await ctx.db.delete(calendarId);
  },
});

export const getFeedInfo = query({
  args: { calendarId: v.id("calendars") },
  handler: async (ctx, { calendarId }): Promise<{ token: string; maskedToken: string }> => {
    const calendar = await requireOwnedCalendar(ctx, calendarId);
    return {
      token: calendar.feedToken,
      maskedToken: maskSecret(calendar.feedToken),
    };
  },
});

export type CalendarDoc = Doc<"calendars">;
