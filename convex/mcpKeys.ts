import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthedUserId } from "./lib/authz";
import { maskSecret, randomBase64Url } from "./lib/tokens";

export const createMcpKey = mutation({
  args: { label: v.string() },
  handler: async (ctx, { label }): Promise<{ id: Id<"mcpKeys">; token: string }> => {
    const ownerId = await getAuthedUserId(ctx);
    const token = randomBase64Url(32);
    const id = await ctx.db.insert("mcpKeys", {
      ownerId,
      token,
      label,
      createdAt: Date.now(),
    });
    return { id, token };
  },
});

export const listMcpKeys = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getAuthedUserId(ctx);
    const keys = await ctx.db
      .query("mcpKeys")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    return keys.map((key) => ({
      id: key._id,
      label: key.label,
      maskedToken: maskSecret(key.token),
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
    }));
  },
});

export const revokeMcpKey = mutation({
  args: { keyId: v.id("mcpKeys") },
  handler: async (ctx, { keyId }) => {
    const ownerId = await getAuthedUserId(ctx);
    const key = await ctx.db.get(keyId);
    if (key === null || key.ownerId !== ownerId) {
      throw new Error("MCP key not found");
    }
    await ctx.db.delete(keyId);
  },
});

export const getByToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    return await ctx.db
      .query("mcpKeys")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
  },
});

export const stampUsed = internalMutation({
  args: { keyId: v.id("mcpKeys") },
  handler: async (ctx, { keyId }) => {
    await ctx.db.patch(keyId, { lastUsedAt: Date.now() });
  },
});
