import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const getByToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const calendar = await ctx.db
      .query("calendars")
      .withIndex("by_feedToken", (q) => q.eq("feedToken", token))
      .unique();
    if (calendar === null) {
      return null;
    }
    const events = await ctx.db
      .query("events")
      .withIndex("by_calendar", (q) => q.eq("calendarId", calendar._id))
      .collect();
    return { calendar, events };
  },
});
