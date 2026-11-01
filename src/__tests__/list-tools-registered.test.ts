/**
 * list_tools 只列本进程实际注册过的工具。
 *
 * 复刻生产 mcp-server.ts 的注册包装器：先过 tier 闸（RECALLNEST_MCP_TIER），通过的才写进
 * toolDescriptions。tier 表直接从 mcp-server.ts 源码里读（与 contracts.test.ts 同一写法），
 * 不另抄一份，免得两边漂移。不起 MCP server、不碰数据。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z, type ZodRawShape } from "zod";

import type { ConflictCandidateStore } from "../conflict-store.js";
import type { ToolRegistryDeps, ToolTier } from "../mcp-tool-deps.js";
import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import type { SessionCheckpointStore } from "../session-store.js";
import type { WorkflowObservationStore } from "../workflow-observation-store.js";
import { memoryAuditLogger, type ToolResult } from "./helpers/mcp-tool-harness.js";

type ProcessTier = "core" | "advanced" | "full";

function readTierMap(): Record<string, ToolTier> {
  const source = readFileSync(join(import.meta.dir, "..", "mcp-server.ts"), "utf8");
  const start = source.indexOf("const TOOL_TIERS");
  const block = source.slice(start, source.indexOf("};", start));
  const tiers: Record<string, ToolTier> = {};
  for (const m of block.matchAll(/^\s*([A-Za-z0-9_]+):\s*"(core|advanced|governance)"/gm)) {
    tiers[m[1]!] = m[2] as ToolTier;
  }
  return tiers;
}

/** 与 mcp-server.ts 的 shouldRegisterTool 同一判法。 */
function passesGate(tier: ToolTier | undefined, processTier: ProcessTier): boolean {
  if (!tier) return true;
  if (processTier === "full") return true;
  if (processTier === "advanced") return tier !== "governance";
  return tier === "core";
}

function bootProcess(processTier: ProcessTier) {
  const tiers = readTierMap();
  const descriptions = new Map<string, string>();
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  const deps = {
    registerTool: (name: string, description: string, schema: unknown, handler: unknown) => {
      if (!passesGate(tiers[name], processTier)) return;
      descriptions.set(name, description);
      const parser = z.object((schema ?? {}) as ZodRawShape);
      const fn = handler as (args: Record<string, unknown>) => Promise<ToolResult>;
      handlers.set(name, (args) => fn(parser.parse(args)));
    },
    getComponents: (() => ({})) as unknown as ToolRegistryDeps["getComponents"],
    config: {} as ToolRegistryDeps["config"],
    checkpointStore: {} as SessionCheckpointStore,
    conflictStore: {} as ConflictCandidateStore,
    workflowObservationStore: {} as WorkflowObservationStore,
    auditLogger: memoryAuditLogger(),
    toolDescriptions: descriptions,
    toolTiers: tiers,
    getKGExtractor: () => null,
    getKGStore: () => null,
  } satisfies ToolRegistryDeps;
  registerCoreTools(deps);
  registerAdvancedTools(deps);
  registerGovernanceTools(deps);
  return { tiers, handlers };
}

async function listTools(processTier: ProcessTier, tier?: string): Promise<{ text: string; tiers: Record<string, ToolTier> }> {
  const { tiers, handlers } = bootProcess(processTier);
  const handler = handlers.get("list_tools");
  if (!handler) throw new Error("list_tools not registered");
  const result = await handler(tier === undefined ? {} : { tier });
  return { text: result.content.map((c) => c.text).join("\n"), tiers };
}

function listedNames(text: string): string[] {
  return [...text.matchAll(/^- ([A-Za-z0-9_]+):/gm)].map((m) => m[1]!);
}

describe("list_tools lists only tools registered in this process", () => {
  it("RECALLNEST_MCP_TIER=core: default list has no advanced tool names and no '(no description)'", async () => {
    const { text, tiers } = await listTools("core");
    const advanced = Object.keys(tiers).filter((n) => tiers[n] === "advanced");
    expect(advanced.length).toBeGreaterThan(0);
    for (const name of advanced) expect(text).not.toContain(name);
    expect(text).not.toContain("(no description)");
    const core = Object.keys(tiers).filter((n) => tiers[n] === "core");
    expect(listedNames(text).sort()).toEqual(core.sort());
    expect(text).toContain(`(${advanced.length} more tool(s) at this tier are not enabled`);
  });

  it("RECALLNEST_MCP_TIER=core: tier=full also keeps governance names out", async () => {
    const { text, tiers } = await listTools("core", "full");
    const notCore = Object.keys(tiers).filter((n) => tiers[n] !== "core");
    for (const name of notCore) expect(listedNames(text)).not.toContain(name);
    expect(text).toContain(`(${notCore.length} more tool(s) at this tier are not enabled`);
  });

  it("RECALLNEST_MCP_TIER=full: everything requested is listed with a real description, no not-enabled note", async () => {
    const { text, tiers } = await listTools("full", "full");
    expect(listedNames(text).sort()).toEqual(Object.keys(tiers).sort());
    expect(text).not.toContain("(no description)");
    expect(text).not.toContain("not enabled");
  });
});
