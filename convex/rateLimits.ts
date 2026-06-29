import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const DEFAULT_WINDOW_MS = 60_000;

export const consume = internalMutation({
  args: {
    ownerId: v.id("users"),
    key: v.string(),
    limit: v.number(),
    windowMs: v.optional(v.number()),
  },
  handler: async (ctx, { ownerId, key, limit, windowMs }) => {
    const now = Date.now();
    const windowSize = windowMs ?? DEFAULT_WINDOW_MS;
    const existingRows = await ctx.db
      .query("rateLimits")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .collect();
    const [existing, ...duplicates] = existingRows;
    for (const duplicate of duplicates) {
      await ctx.db.delete(duplicate._id);
    }
    if (existing === undefined) {
      await ctx.db.insert("rateLimits", {
        ownerId,
        key,
        windowStart: now,
        count: 1,
      });
      return { allowed: true, remaining: limit - 1 };
    }
    if (now - existing.windowStart >= windowSize) {
      await ctx.db.patch(existing._id, {
        windowStart: now,
        count: 1,
      });
      return { allowed: true, remaining: limit - 1 };
    }
    if (existing.count >= limit) {
      return { allowed: false, remaining: 0 };
    }
    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return { allowed: true, remaining: limit - existing.count - 1 };
  },
});
