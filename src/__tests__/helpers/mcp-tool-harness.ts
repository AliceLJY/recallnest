/**
 * 共用的 MCP 工具 handler 捕获 harness（测试专用，不进发布包：package.json 的 files 排除了 __tests__）。
 *
 * 做法：把 register{Core,Advanced,Governance}Tools 交给一个注入式 registerTool，捕获真实 handler，
 * 并照生产 mcp-server.ts 的 registerTool 那样用 runToolSafely 包一层，测试看到的 isError 行为与生产一致，
 * 不必起 MCP server。schema 校验（zod 默认值）在生产里由 SDK 先跑；这里用 `z.object(schema).parse`
 * 复刻，所以用例可以只传必填字段，拿到的参数与生产 handler 收到的一样。
 *
 * 两种用法：
 * - `captureTools(register, { getComponents })`：只关心 handler 怎么处理某个替身返回值（错误透出那类）。
 * - `createToolHarness()`：临时目录里的真实 LanceDB + 真实 TriggerStore + 本地假向量 + 临时目录里的
 *   checkpoint / conflict 存储，审计写进内存。把 RECALLNEST_DATA_DIR 指到临时目录（noise prototype bank
 *   的默认路径按它算），收尾时恢复，真实的 data/ 一个字节都不碰。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type ZodRawShape } from "zod";

import type { AuditEntry, AuditLogger } from "../../audit-log.js";
import { ConflictCandidateStore } from "../../conflict-store.js";
import { runToolSafely } from "../../error-taxonomy.js";
import type { ToolRegistryDeps } from "../../mcp-tool-deps.js";
import { resetSharedNoisePrototypeBank } from "../../noise-prototype-bank.js";
import { SessionCheckpointStore } from "../../session-store.js";
import { MemoryStore } from "../../store.js";
import { TriggerStore } from "../../trigger-store.js";
import type { WorkflowObservationStore } from "../../workflow-observation-store.js";

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
export type CapturedHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
export type RegisterFn = (deps: ToolRegistryDeps) => void;

type ComponentsShape = ReturnType<ToolRegistryDeps["getComponents"]>;

export interface CaptureOptions {
  /** 替身组件：只需给出被测 handler 用到的字段。 */
  getComponents?: () => Partial<ComponentsShape> | Record<string, unknown>;
  checkpointStore?: SessionCheckpointStore;
  conflictStore?: ConflictCandidateStore;
  auditLogger?: AuditLogger;
  /** 给了就把每个工具注册时的描述写进去（断言工具描述用）。 */
  descriptions?: Map<string, string>;
}

/** 测试用审计记录器：只记在内存里，不落盘。 */
export function memoryAuditLogger(): AuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    log(entry) {
      entries.push({ ...entry, timestamp: new Date().toISOString() } as AuditEntry);
    },
    getRecent(limit = 50) {
      return entries.slice(-limit).reverse();
    },
    exportAll() {
      return [...entries];
    },
    count() {
      return entries.length;
    },
  };
}

/** 捕获一组注册函数里的全部 handler，按生产的 runToolSafely 包装并先跑 schema 解析。 */
export function captureTools(
  register: RegisterFn | RegisterFn[],
  options: CaptureOptions = {},
): Map<string, CapturedHandler> {
  const handlers = new Map<string, CapturedHandler>();
  const workflowObservationStore = {
    save: async (record: unknown) => record,
  } as unknown as WorkflowObservationStore;
  const deps = {
    registerTool: (name: string, description: string, schema: unknown, handler: unknown) => {
      options.descriptions?.set(name, description);
      const parser = z.object((schema ?? {}) as ZodRawShape);
      const fn = handler as (args: Record<string, unknown>) => unknown;
      handlers.set(name, (args) =>
        runToolSafely(name, async () => fn(parser.parse(args)) as Promise<ToolResult>) as Promise<ToolResult>,
      );
    },
    getComponents: (options.getComponents ?? (() => ({}))) as unknown as ToolRegistryDeps["getComponents"],
    config: {} as ToolRegistryDeps["config"],
    checkpointStore: options.checkpointStore ?? ({} as SessionCheckpointStore),
    conflictStore: options.conflictStore ?? ({} as ConflictCandidateStore),
    workflowObservationStore,
    auditLogger: options.auditLogger ?? memoryAuditLogger(),
    toolDescriptions: new Map<string, string>(),
    toolTiers: {},
    saveBrief: () => "synthetic-brief-path",
    savePin: () => "synthetic-pin-path",
    getKGExtractor: () => null,
    getKGStore: () => null,
  } satisfies ToolRegistryDeps;
  for (const fn of Array.isArray(register) ? register : [register]) fn(deps);
  return handlers;
}

/** 所有正文同一个向量：同类别的第二条相近写入必被判重（相似度 1）。 */
export const SAME_VECTOR = [1, 0, 0];

/** 本地假嵌入器：handler 会调到的四个方法都给，全部返回同一个 3 维向量。 */
export const fakeEmbedder = {
  dimensions: 3,
  embedPassage: async (_text: string) => SAME_VECTOR,
  embedQuery: async (_text: string) => SAME_VECTOR,
  embedBatchPassage: async (texts: string[]) => texts.map(() => SAME_VECTOR),
  embedBatchQuery: async (texts: string[]) => texts.map(() => SAME_VECTOR),
};

export interface ToolHarness {
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** 回执正文（第一段 text）；handler 报错时把错误文字一起带出，方便看出为什么。 */
  text(name: string, args: Record<string, unknown>): Promise<string>;
  store: MemoryStore;
  triggerStore: TriggerStore;
  checkpointStore: SessionCheckpointStore;
  conflictStore: ConflictCandidateStore;
  audit: AuditEntry[];
  /** 某个 scope 下主表里的行数（精确匹配 scope）。 */
  rowCount(scope: string): Promise<number>;
  cleanup(): void;
}

export function createToolHarness(register: RegisterFn | RegisterFn[]): ToolHarness {
  const dir = mkdtempSync(join(tmpdir(), "rn-tool-harness-"));
  const previousDataDir = process.env.RECALLNEST_DATA_DIR;
  process.env.RECALLNEST_DATA_DIR = join(dir, "data");
  resetSharedNoisePrototypeBank();

  const dbPath = join(dir, "db");
  const store = new MemoryStore({ dbPath, vectorDim: 3 });
  const triggerStore = new TriggerStore({ dbPath, vectorDim: 3 });
  const checkpointStore = new SessionCheckpointStore(join(dir, "checkpoints"));
  const conflictStore = new ConflictCandidateStore(join(dir, "conflicts"));
  const audit = memoryAuditLogger();
  const components = { store, triggerStore, embedder: fakeEmbedder, llm: null };

  const handlers = captureTools(register, {
    getComponents: () => components,
    checkpointStore,
    conflictStore,
    auditLogger: audit,
  });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`tool not registered: ${name}`);
    return handler(args);
  }

  return {
    call,
    async text(name, args) {
      const result = await call(name, args);
      const body = result.content.map((c) => c.text).join("\n");
      return result.isError ? `ERROR: ${body}` : body;
    },
    store,
    triggerStore,
    checkpointStore,
    conflictStore,
    audit: audit.entries,
    rowCount: async (scope) => (await store.list([scope], undefined, 200, 0, "exact")).length,
    cleanup() {
      if (previousDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
      else process.env.RECALLNEST_DATA_DIR = previousDataDir;
      resetSharedNoisePrototypeBank();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
