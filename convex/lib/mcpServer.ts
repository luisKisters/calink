import { z } from "zod";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { executeCalendarTool } from "./calendarTools";

const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

const calendarIdInput = z.object({
  calendarId: z.string(),
});

const createCalendarInput = z.object({
  name: z.string(),
  color: z.string(),
  timezone: z.string(),
  description: z.string().optional(),
});

const eventToolInput = z.object({
  calendarId: z.string(),
  includeCancelled: z.boolean().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  meetingUrl: z.string().optional(),
  startISO: z.string().optional(),
  endISO: z.string().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  rrule: z.string().optional(),
  eventId: z.string().optional(),
  scope: z.enum(["this", "following", "all"]).optional(),
  instanceStartISO: z.string().optional(),
  patch: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      meetingUrl: z.string().optional(),
      startISO: z.string().optional(),
      endISO: z.string().optional(),
      allDay: z.boolean().optional(),
      timezone: z.string().optional(),
      rrule: z.string().optional(),
    })
    .optional(),
});

function tool(
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, unknown>,
) {
  return { name, title, description, inputSchema };
}

const mcpTools = [
  tool("list_calendars", "List Calendars", "List calendars owned by the MCP key owner.", {
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  tool("create_calendar", "Create Calendar", "Create a new calendar.", {
    type: "object",
    properties: {
      name: { type: "string" },
      color: { type: "string" },
      timezone: { type: "string" },
      description: { type: "string" },
    },
    required: ["name", "color", "timezone"],
    additionalProperties: false,
  }),
  tool("get_feed_url", "Get Feed URL", "Return the iCalendar feed URL for a calendar.", {
    type: "object",
    properties: { calendarId: { type: "string" } },
    required: ["calendarId"],
    additionalProperties: false,
  }),
  tool("list_events", "List Events", "List events for a calendar.", {
    type: "object",
    properties: {
      calendarId: { type: "string" },
      includeCancelled: { type: "boolean" },
    },
    required: ["calendarId"],
    additionalProperties: false,
  }),
  tool("create_event", "Create Event", "Create an event in a calendar.", {
    type: "object",
    properties: {
      calendarId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      meetingUrl: { type: "string" },
      startISO: { type: "string" },
      endISO: { type: "string" },
      allDay: { type: "boolean" },
      timezone: { type: "string" },
      rrule: { type: "string" },
    },
    required: ["calendarId", "title", "startISO", "allDay", "timezone"],
    additionalProperties: false,
  }),
  tool("update_event", "Update Event", "Update an event or recurring scope.", {
    type: "object",
    properties: {
      calendarId: { type: "string" },
      eventId: { type: "string" },
      scope: { type: "string", enum: ["this", "following", "all"] },
      instanceStartISO: { type: "string" },
      patch: { type: "object" },
    },
    required: ["calendarId", "eventId", "scope", "patch"],
    additionalProperties: false,
  }),
  tool("delete_event", "Delete Event", "Cancel an event or recurring scope.", {
    type: "object",
    properties: {
      calendarId: { type: "string" },
      eventId: { type: "string" },
      scope: { type: "string", enum: ["this", "following", "all"] },
      instanceStartISO: { type: "string" },
    },
    required: ["calendarId", "eventId", "scope"],
    additionalProperties: false,
  }),
  tool("undo", "Undo", "Undo the latest calendar change.", {
    type: "object",
    properties: { calendarId: { type: "string" } },
    required: ["calendarId"],
    additionalProperties: false,
  }),
] as const;

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  throw new Error("Invalid JSON-RPC id");
}

function parseRpcRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    throw new Error("Invalid JSON-RPC request");
  }
  return {
    jsonrpc: "2.0",
    id: parseId(value.id),
    method: value.method,
    params: value.params,
  };
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token.length === 0 ? null : token;
}

function siteOrigin(request: Request): string {
  return new URL(request.url).origin;
}

function parseToolCallParams(params: unknown): { name: string; arguments: unknown } {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new Error("Invalid tools/call params");
  }
  return {
    name: params.name,
    arguments: params.arguments,
  };
}

function structuredContent(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function executeMcpTool(
  ctx: ActionCtx,
  request: Request,
  ownerId: Id<"users">,
  name: string,
  input: unknown,
) {
  if (name === "list_calendars") {
    return await ctx.runQuery(internal.calendars.listForOwner, { ownerId });
  }
  if (name === "create_calendar") {
    const parsed = createCalendarInput.parse(input);
    const calendarId = await ctx.runMutation(internal.calendars.createForOwner, {
      ownerId,
      name: parsed.name,
      color: parsed.color,
      timezone: parsed.timezone,
      description: parsed.description,
    });
    return { calendarId };
  }
  if (name === "get_feed_url") {
    const parsed = calendarIdInput.parse(input);
    const calendar = await ctx.runQuery(internal.calendars.getForOwner, {
      ownerId,
      calendarId: parsed.calendarId as Id<"calendars">,
    });
    return {
      url: `${siteOrigin(request)}/feed/${encodeURIComponent(calendar.feedToken)}.ics`,
    };
  }
  if (name === "undo") {
    const parsed = calendarIdInput.parse(input);
    const changeId = await ctx.runMutation(internal.events.undoForActor, {
      ownerId,
      calendarId: parsed.calendarId as Id<"calendars">,
    });
    return { changeId };
  }
  if (
    name === "list_events" ||
    name === "create_event" ||
    name === "update_event" ||
    name === "delete_event"
  ) {
    const parsed = eventToolInput.parse(input);
    const { calendarId, ...rest } = parsed;
    const result = await executeCalendarTool(ctx, {
      ownerId,
      calendarId: calendarId as Id<"calendars">,
      name,
      input: rest,
      actorType: "mcp",
    });
    const parsedContent = structuredContent(result.content);
    return parsedContent.ok ? parsedContent.value : { text: result.content };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleRpc(
  ctx: ActionCtx,
  request: Request,
  rpc: JsonRpcRequest,
  ownerId: Id<"users">,
): Promise<JsonRpcResponse | null> {
  const id = rpc.id ?? null;
  if (rpc.id === undefined && rpc.method.startsWith("notifications/")) {
    return null;
  }
  if (rpc.method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "calink", title: "Calink", version: "0.1.0" },
    });
  }
  if (rpc.method === "tools/list") {
    return rpcResult(id, { tools: mcpTools });
  }
  if (rpc.method === "tools/call") {
    const params = parseToolCallParams(rpc.params);
    const known = mcpTools.some((toolDefinition) => toolDefinition.name === params.name);
    if (!known) {
      return rpcError(id, -32602, `Unknown tool: ${params.name}`);
    }
    try {
      const result = await executeMcpTool(ctx, request, ownerId, params.name, params.arguments);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      return rpcResult(id, {
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `Method not found: ${rpc.method}`);
}

export async function handleMcpRequest(ctx: ActionCtx, request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (token === null) {
    return new Response("Unauthorized", { status: 401 });
  }
  const key = await ctx.runQuery(internal.mcpKeys.getByToken, { token });
  if (key === null) {
    return new Response("Unauthorized", { status: 401 });
  }
  await ctx.runMutation(internal.mcpKeys.stampUsed, { keyId: key._id });
  const rate = await ctx.runMutation(internal.rateLimits.consume, {
    ownerId: key.ownerId,
    key: "mcp",
    limit: 120,
  });
  if (!rate.allowed) {
    return responseJson(rpcError(null, -32000, "Rate limit exceeded"), 429);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return responseJson(rpcError(null, -32700, "Parse error"));
  }
  const inputs = Array.isArray(body) ? body : [body];
  if (Array.isArray(body) && body.length === 0) {
    return responseJson(rpcError(null, -32600, "Invalid request"));
  }
  const responses: JsonRpcResponse[] = [];
  for (const input of inputs) {
    try {
      const rpc = parseRpcRequest(input);
      const response = await handleRpc(ctx, request, rpc, key.ownerId);
      if (response !== null) {
        responses.push(response);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid request";
      responses.push(rpcError(null, -32600, message));
    }
  }
  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }
  return responseJson(Array.isArray(body) ? responses : responses[0]);
}
