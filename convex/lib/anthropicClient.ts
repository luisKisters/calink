"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { toolDefinitions } from "./calendarTools";

export const DEFAULT_MODEL = "claude-opus-4-8";

const extractedEventsSchema = z.object({
  events: z.array(
    z.object({
      title: z.string(),
      description: z.string().optional(),
      location: z.string().optional(),
      meetingUrl: z.string().optional(),
      startISO: z.string(),
      endISO: z.string().optional(),
      allDay: z.boolean(),
      rrule: z.string().optional(),
    }),
  ),
});

export type ExtractedEvent = z.infer<typeof extractedEventsSchema>["events"][number];

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ChatTurn = {
  text: string;
  stopReason: string | null;
  toolCalls: ToolCall[];
};

export type ModelClient = {
  extractEvents(args: {
    text: string;
    now: string;
    timezone: string;
    model?: string;
  }): Promise<ExtractedEvent[]>;
  createChatTurn(args: {
    messages: Anthropic.MessageParam[];
    model?: string;
  }): Promise<ChatTurn>;
};

export type AnthropicMessageParam = Anthropic.MessageParam;

let testClient: ModelClient | null = null;

export function setModelClientForTesting(client: ModelClient | null): void {
  testClient = client;
}

function anthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  return new Anthropic({ apiKey });
}

export function getModelClient(): ModelClient {
  if (testClient !== null) {
    return testClient;
  }
  return {
    async extractEvents(args) {
      const message = await anthropic().messages.parse({
        model: args.model ?? DEFAULT_MODEL,
        max_tokens: 2048,
        system:
          "Extract calendar events from the user's pasted text. Resolve relative dates against `now` in `timezone`. Output RRULE strings for anything described as repeating. Do not invent events.",
        messages: [
          {
            role: "user",
            content: `now: ${args.now}\ntimezone: ${args.timezone}\n\n${args.text}`,
          },
        ],
        output_config: {
          format: zodOutputFormat(extractedEventsSchema),
        },
      });
      return message.parsed_output?.events ?? [];
    },
    async createChatTurn(args) {
      const message = await anthropic().messages.create({
        model: args.model ?? DEFAULT_MODEL,
        max_tokens: 2048,
        thinking: { type: "enabled", budget_tokens: 1024 },
        tools: toolDefinitions.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: {
            ...tool.inputSchema,
            required:
              "required" in tool.inputSchema ? Array.from(tool.inputSchema.required) : undefined,
          },
        })),
        messages: args.messages,
      });
      const toolCalls: ToolCall[] = [];
      const textParts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      return {
        text: textParts.join("\n"),
        stopReason: message.stop_reason,
        toolCalls,
      };
    },
  };
}

export function toolResultMessage(toolCallId: string, content: string): Anthropic.MessageParam {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolCallId,
        content,
      },
    ],
  };
}

export function assistantToolUseMessage(turn: ChatTurn): Anthropic.MessageParam {
  return {
    role: "assistant",
    content: [
      ...(turn.text.length > 0 ? [{ type: "text" as const, text: turn.text }] : []),
      ...turn.toolCalls.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    ],
  };
}
