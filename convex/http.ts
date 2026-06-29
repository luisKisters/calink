import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { serializeCalendar } from "./lib/ics";
import { handleMcpRequest } from "./lib/mcpServer";

const http = httpRouter();

function calendarFilename(name: string): string {
  const cleaned = Array.from(name)
    .filter((char) => char !== "\\" && char !== "\"" && char !== "\r" && char !== "\n")
    .join("")
    .trim();
  return cleaned.length === 0 ? "calendar.ics" : `${cleaned}.ics`;
}

function tokenFromFeedUrl(url: string): string | null {
  const parsed = new URL(url);
  const prefix = "/feed/";
  if (!parsed.pathname.startsWith(prefix) || !parsed.pathname.endsWith(".ics")) {
    return null;
  }
  const token = parsed.pathname.slice(prefix.length, -".ics".length);
  return token.length === 0 ? null : decodeURIComponent(token);
}

http.route({
  pathPrefix: "/feed/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = tokenFromFeedUrl(request.url);
    if (token === null) {
      return new Response("Not found", { status: 404 });
    }
    const result = await ctx.runQuery(internal.feed.getByToken, { token });
    if (result === null) {
      return new Response("Not found", { status: 404 });
    }
    const body = serializeCalendar(result.calendar, result.events);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "Content-Disposition": `inline; filename="${calendarFilename(result.calendar.name)}"`,
      },
    });
  }),
});

http.route({
  path: "/mcp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    return await handleMcpRequest(ctx as ActionCtx, request);
  }),
});

http.route({
  path: "/mcp",
  method: "GET",
  handler: httpAction(async () => {
    return await Promise.resolve(
      new Response("SSE is not implemented", {
        status: 405,
        headers: { Allow: "POST" },
      }),
    );
  }),
});

export default http;
