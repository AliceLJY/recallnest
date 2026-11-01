import { describe, expect, it } from "bun:test";

import { runToolSafely } from "../error-taxonomy.js";
import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import type { ToolRegistryDeps } from "../mcp-tool-deps.js";
import { distillSession, normalizeDistillMessages, type DistillInputMessage } from "../session-distiller.js";

/**
 * tsc strict (2026-11-01) exposed two mismatches between the distill_session MCP schema and
 * distillSession():
 *  1. the schema accepts `content` as a list of blocks, distillSession only handles strings —
 *     redactSecrets(blocks) threw "out.replace is not a function";
 *  2. getComponents() gives `llm: LLMClient | null`, distillSession dereferenced it unconditionally.
 * The handler is captured through the real registerAdvancedTools and wrapped in runToolSafely the
 * way mcp-server.ts does, so these cases see the same isError behaviour as production.
 */

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function captureDistillHandler(llm: unknown): (args: Record<string, unknown>) => Promise<ToolResult> {
  let captured: ((args: Record<string, unknown>) => Promise<ToolResult>) | null = null;
  const deps = {
    registerTool: (name: string, _desc: string, _schema: unknown, handler: (args: unknown) => unknown) => {
      if (name === "distill_session") {
        captured = (args) => runToolSafely(name, async () => handler(args)) as Promise<ToolResult>;
      }
    },
    getComponents: () => ({ store: {}, embedder: {}, llm }),
    conflictStore: {},
    workflowObservationStore: {},
    getKGExtractor: () => null,
    getKGStore: () => null,
  } as unknown as ToolRegistryDeps;
  registerAdvancedTools(deps);
  if (!captured) throw new Error("distill_session was not registered");
  return captured;
}

function blockMessages(count: number): DistillInputMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [
      { type: "text", text: `turn ${i}: deploy step ${i}` },
      ...(i % 2 === 1 ? [{ type: "tool_use" as const, name: "Bash", input: { command: `echo ${i}` } }] : []),
    ],
  }));
}

describe("normalizeDistillMessages", () => {
  it("flattens blocks in order and leaves string content alone", () => {
    const out = normalizeDistillMessages([
      { role: "user", content: "plain text" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "tool_use", name: "Read", input: { path: "a.ts" } },
          { type: "tool_result", tool_use_id: "t1", content: "file body" },
          { type: "text" },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: "user", content: "plain text" },
      { role: "assistant", content: 'first\n[tool_use:Read] {"path":"a.ts"}\nfile body' },
    ]);
  });
});

describe("distill_session MCP tool", () => {
  it("accepts block-list content (the schema allows it) and sends text to the summary prompt", async () => {
    const prompts: string[] = [];
    const llm = {
      chatLong: async (...args: unknown[]) => {
        prompts.push(args.map(String).join("\n"));
        return "";
      },
    };
    const handler = captureDistillHandler(llm);
    const result = await handler({ messages: blockMessages(8), scope: "test:distill-blocks", preserveRecent: 2, keepRecentTools: 5, persist: false });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Microcompact:");
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("turn 0: deploy step 0");
    expect(prompts[0]).toContain("[tool_use:Bash]");
    expect(prompts[0]).not.toContain("[object Object]");
  });

  it("with no LLM configured, says so when a summary is needed", async () => {
    const handler = captureDistillHandler(null);
    const result = await handler({ messages: blockMessages(8), scope: "test:distill-nollm", preserveRecent: 2, keepRecentTools: 5, persist: false });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("needs an LLM client");
  });

  it("with no LLM configured, still succeeds when every message is in the preserved window", async () => {
    const handler = captureDistillHandler(null);
    const result = await handler({ messages: blockMessages(2), scope: "test:distill-nollm-short", preserveRecent: 6, keepRecentTools: 5, persist: false });
    expect(result.isError).toBeUndefined();
  });
});

describe("distillSession with a null llm", () => {
  it("throws the explicit error, not a null dereference", async () => {
    const messages = normalizeDistillMessages(blockMessages(8));
    await expect(distillSession(messages, { llm: null } as Parameters<typeof distillSession>[1], { preserveRecent: 2, persist: false }))
      .rejects.toThrow("needs an LLM client");
  });
});
