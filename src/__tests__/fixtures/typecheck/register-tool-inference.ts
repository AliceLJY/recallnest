/**
 * Compiled (never run) by typecheck-strict.test.ts. Each `@ts-expect-error` below only holds
 * while a tool handler's arguments are inferred from its zod schema; if the registerTool type
 * goes back to `Parameters<McpServer["tool"]>[...]`, the arguments become implicit `any`, the
 * expectations go unused and the destructuring is flagged — either way the program has errors.
 */
import { z } from "zod";
import type { ToolRegistryDeps } from "../../../mcp-tool-deps.js";

declare const registerTool: ToolRegistryDeps["registerTool"];

registerTool(
  "fixture_tool",
  "fixture",
  { query: z.string(), limit: z.number().int().optional(), mode: z.enum(["a", "b"]) },
  async ({ query, limit, mode }) => {
    const q: string = query;
    const l: number | undefined = limit;
    const m: "a" | "b" = mode;
    // @ts-expect-error query is a string, not a number
    const wrong: number = query;
    // @ts-expect-error mode is narrowed to the enum, not any string
    const wrongMode: "c" = mode;
    return { content: [{ type: "text" as const, text: `${q}${l ?? ""}${m}${wrong}${wrongMode}` }] };
  },
);

registerTool(
  "fixture_tool_missing_arg",
  "fixture",
  { query: z.string() },
  // @ts-expect-error `limit` is not in the schema
  async ({ limit }: { limit: number }) => ({ content: [{ type: "text" as const, text: String(limit) }] }),
);
