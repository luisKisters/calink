import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

export const prune = internalMutation({
  args: {
    cancelledRetentionDays: v.optional(v.number()),
    maxChangeLogPerCalendar: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const retentionDays = args.cancelledRetentionDays ?? 30;
    const maxChangeLogPerCalendar = args.maxChangeLogPerCalendar ?? 200;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const cancelledEvents = await ctx.db
      .query("events")
      .filter((q) =>
        q.and(q.eq(q.field("status"), "cancelled"), q.lt(q.field("lastModified"), cutoff)),
      )
      .collect();
    for (const event of cancelledEvents) {
      await ctx.db.delete(event._id);
    }

    const changes = await ctx.db.query("changeLog").collect();
    const byCalendar = new Map<string, Doc<"changeLog">[]>();
    for (const change of changes) {
      const bucket = byCalendar.get(change.calendarId) ?? [];
      bucket.push(change);
      byCalendar.set(change.calendarId, bucket);
    }
    for (const bucket of byCalendar.values()) {
      const stale = bucket
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(maxChangeLogPerCalendar);
      for (const change of stale) {
        await ctx.db.delete(change._id);
      }
    }
    return { prunedEvents: cancelledEvents.length };
  },
});
