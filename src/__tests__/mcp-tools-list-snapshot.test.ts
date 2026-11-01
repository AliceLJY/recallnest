/**
 * tools/list 快照：工具名、描述、input schema 逐字钉住。
 *
 * 做法与生产 mcp-server.ts 相同：真实 McpServer，三组注册函数的 registerTool 直接走 `server.tool()`，
 * 再用 SDK 的 InMemoryTransport 接一个真实 Client 发 tools/list。schema 由 SDK 从 zod 转成 JSON Schema，
 * 所以换 zod 大版本、换 SDK 版本、换转换器，只要客户端看到的东西变了一个字节，这里就红。
 *
 * 快照文件：fixtures/mcp-tools-list.json。确认变化是有意的之后，用
 * `RECALLNEST_UPDATE_TOOLS_SNAPSHOT=1 bun test src/__tests__/mcp-tools-list-snapshot.test.ts` 重写。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ConflictCandidateStore } from "../conflict-store.js";
import type { ToolHandler, ToolRegistryDeps, ToolSchema } from "../mcp-tool-deps.js";
import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import type { SessionCheckpointStore } from "../session-store.js";
import type { WorkflowObservationStore } from "../workflow-observation-store.js";
import { memoryAuditLogger } from "./helpers/mcp-tool-harness.js";

const SNAPSHOT = join(import.meta.dir, "fixtures", "mcp-tools-list.json");

async function listAllTools(): Promise<string> {
  const server = new McpServer({ name: "recallnest", version: "snapshot" });
  const deps = {
    registerTool: <S extends ToolSchema>(name: string, description: string, schema: S, handler: ToolHandler<S>) => {
      server.tool(name, description, schema, handler);
    },
    getComponents: (() => ({})) as unknown as ToolRegistryDeps["getComponents"],
    config: {} as ToolRegistryDeps["config"],
    checkpointStore: {} as SessionCheckpointStore,
    conflictStore: {} as ConflictCandidateStore,
    workflowObservationStore: {} as WorkflowObservationStore,
    auditLogger: memoryAuditLogger(),
    toolDescriptions: new Map<string, string>(),
    toolTiers: {},
    getKGExtractor: () => null,
    getKGStore: () => null,
  } satisfies ToolRegistryDeps;
  registerCoreTools(deps);
  registerAdvancedTools(deps);
  registerGovernanceTools(deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "snapshot-client", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return JSON.stringify(tools, null, 2) + "\n";
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tools/list snapshot", () => {
  it("tool names, descriptions and input schemas are byte-identical to the committed snapshot", async () => {
    const actual = await listAllTools();
    if (process.env.RECALLNEST_UPDATE_TOOLS_SNAPSHOT === "1") writeFileSync(SNAPSHOT, actual);
    const expected = readFileSync(SNAPSHOT, "utf8");
    expect(actual).toBe(expected);
  });

  it("snapshot covers every registered tool", async () => {
    const tools = JSON.parse(await listAllTools()) as Array<{ name: string }>;
    expect(tools.length).toBe(44);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });
});
