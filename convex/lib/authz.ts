import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";

type AuthedCtx = QueryCtx | MutationCtx | ActionCtx;
type DbCtx = QueryCtx | MutationCtx;

export async function getAuthedUserId(ctx: AuthedCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Authentication required");
  }
  return userId;
}

export async function requireOwnedCalendar(
  ctx: DbCtx,
  calendarId: Id<"calendars">,
  ownerId?: Id<"users">,
): Promise<Doc<"calendars">> {
  const resolvedOwnerId = ownerId ?? (await getAuthedUserId(ctx));
  const calendar = await ctx.db.get(calendarId);
  if (calendar === null || calendar.ownerId !== resolvedOwnerId) {
    throw new Error("Calendar not found");
  }
  return calendar;
}

export async function requireOwnedEvent(
  ctx: DbCtx,
  eventId: Id<"events">,
  ownerId?: Id<"users">,
): Promise<{ event: Doc<"events">; calendar: Doc<"calendars"> }> {
  const event = await ctx.db.get(eventId);
  if (event === null) {
    throw new Error("Event not found");
  }
  const calendar = await requireOwnedCalendar(ctx, event.calendarId, ownerId);
  return { event, calendar };
}
