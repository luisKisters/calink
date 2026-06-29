"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { getAuthedUserId } from "./lib/authz";
import {
  assistantToolUseMessage,
  getModelClient,
  toolResultMessage,
  type ChatMessage,
  type AnthropicMessageParam,
} from "./lib/anthropicClient";
import { executeCalendarTool } from "./lib/calendarTools";

function parseIso(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ${field}`);
  }
  return ms;
}

async function consumeRateLimit(
  ctx: ActionCtx,
  ownerId: Id<"users">,
  key: string,
  limit: number,
): Promise<void> {
  const result = await ctx.runMutation(internal.rateLimits.consume, {
    ownerId,
    key,
    limit,
  });
  if (!result.allowed) {
    throw new Error("Rate limit exceeded");
  }
}

export const extractEvents = action({
  args: {
    calendarId: v.id("calendars"),
    text: v.string(),
    now: v.string(),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    const ownerId = await getAuthedUserId(ctx);
    await ctx.runQuery(internal.calendars.getForOwner, {
      ownerId,
      calendarId: args.calendarId,
    });
    await consumeRateLimit(ctx, ownerId, "ai_extract", 10);
    const extracted = await getModelClient().extractEvents({
      text: args.text,
      now: args.now,
      timezone: args.timezone,
    });
    const created: Id<"events">[] = [];
    for (const event of extracted) {
      const eventId = await ctx.runMutation(internal.events.applyCreate, {
        ownerId,
        calendarId: args.calendarId,
        event: {
          title: event.title,
          description: event.description,
          location: event.location,
          meetingUrl: event.meetingUrl,
          start: parseIso(event.startISO, "startISO"),
          end: event.endISO === undefined ? undefined : parseIso(event.endISO, "endISO"),
          allDay: event.allDay,
          timezone: args.timezone,
          rrule: event.rrule,
          exdates: [],
        },
        actorType: "agent",
      });
      created.push(eventId);
    }
    return { created, events: extracted };
  },
});

export const chat = action({
  args: {
    calendarId: v.id("calendars"),
    messages: v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ text: string; applied: string[] }> => {
    const ownerId = await getAuthedUserId(ctx);
    await ctx.runQuery(internal.calendars.getForOwner, {
      ownerId,
      calendarId: args.calendarId,
    });
    await consumeRateLimit(ctx, ownerId, "ai_chat", 20);
    const client = getModelClient();
    const messages: AnthropicMessageParam[] = args.messages.map((message: ChatMessage) => ({
      role: message.role,
      content: message.content,
    }));
    const applied: string[] = [];
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const turn = await client.createChatTurn({ messages });
      if (turn.stopReason !== "tool_use" || turn.toolCalls.length === 0) {
        return { text: turn.text, applied };
      }
      messages.push(assistantToolUseMessage(turn));
      for (const toolCall of turn.toolCalls) {
        const result = await executeCalendarTool(ctx, {
          ownerId,
          calendarId: args.calendarId,
          name: toolCall.name,
          input: toolCall.input,
          actorType: "agent",
        });
        applied.push(...result.applied);
        messages.push(toolResultMessage(toolCall.id, result.content));
      }
    }
    throw new Error("AI tool loop exceeded iteration limit");
  },
});
