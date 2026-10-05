import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuditLogger } from "../audit-log.js";
import { buildStructuredMetadata } from "../capture-engine.js";
import { runToolSafely } from "../error-taxonomy.js";
import { forgetMemory, type ForgetPinArchive, type ForgetTriggerStore } from "../forget-engine.js";
import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { archivePinAssetsForMemory, findPinAssetsForMemory, type PinAsset } from "../memory-assets.js";
import { createRetriever } from "../retriever.js";
import { MemoryStore, type MemoryEntry } from "../store.js";
import { TriggerStore } from "../trigger-store.js";

/**
 * forget 要把一条记忆从它留下痕迹的每一处都拿掉，并回头核对（2026-10-05）。
 *
 * 改之前文件头写着「传播到所有派生物（KG、pin、演化链）」，函数体里没有处理 pin 的代码，
 * 09-22 新加的 memory_triggers 侧表也没接：删掉一条记忆后，它的 trigger 行（问法原文 + 向量）
 * 和由它生成的 pin 文件都留在原处，pin 还会继续被拼进 resume_context。删完也没有任何一步回读。
 */

const cleanupPaths: string[] = [];
const originalTriggerRecall = process.env.RECALLNEST_TRIGGER_RECALL;
const originalDataDir = process.env.RECALLNEST_DATA_DIR;

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
  if (originalTriggerRecall === undefined) delete process.env.RECALLNEST_TRIGGER_RECALL;
  else process.env.RECALLNEST_TRIGGER_RECALL = originalTriggerRecall;
  if (originalDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = originalDataDir;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

const DAY = 86_400_000;

function entry(id: string, vector: number[], text: string, extraMeta: Record<string, unknown> = {}): MemoryEntry {
  const base = JSON.parse(
    buildStructuredMetadata({ source: "manual", tags: ["pinned"], capture: "test", category: "patterns", canonicalKey: `key-${id}` }),
  );
  return {
    id,
    text,
    vector,
    category: "patterns",
    scope: "memory:pivot",
    importance: 0.8,
    timestamp: Date.now() - DAY,
    metadata: JSON.stringify({ ...base, ...extraMeta }),
  };
}

const TOMATO = entry(
  "aaaaaaaa-0000-4000-8000-00000000000a",
  [1, 0, 0],
  "阳台上的番茄每周浇两次水就够，浇多了根会烂，这是去年夏天淹死三棵之后改的做法，秋天以后还要再减一次。",
);
const MINT = entry(
  "bbbbbbbb-0000-4000-8000-00000000000b",
  [1, 0, 0],
  "薄荷喜欢半阴，放在北边窗台长得最好，太晒叶子会发黄，隔两周掐一次顶才会分枝，不掐就只往上窜。",
);
const ASK_TOMATO = "番茄多久浇一次水";
const ASK_MINT = "薄荷放哪里长得好";
const QUERY_VECTORS: Record<string, number[]> = { [ASK_TOMATO]: [0, 1, 0], [ASK_MINT]: [0, 0, 1] };
const embedQuery = async (text: string) => QUERY_VECTORS[text] ?? [0.33, 0.33, 0.33];
const embedMany = async (texts: string[]) => Promise.all(texts.map(embedQuery));
const embedder = { embedQuery, embedPassage: embedQuery } as never;

function pin(id: string, memoryId: string): PinAsset {
  return {
    id,
    type: "pinned-memory",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    title: `pin of ${memoryId.slice(0, 8)}`,
    summary: "测试用 pin",
    tags: [],
    source: { memoryId, scope: "memory:pivot", timestamp: 0, metadata: {} },
    snippet: "测试用 pin 的片段",
  };
}

function writePin(dir: string, asset: PinAsset): string {
  const path = join(dir, `${asset.id}.json`);
  writeFileSync(path, JSON.stringify(asset, null, 2) + "\n");
  return path;
}

/** 内存版 store：只实现 forget 引擎用到的方法，行为可逐项替换。 */
function memoryStore(entries: MemoryEntry[]) {
  const data = new Map(entries.map((e) => [e.id, { ...e }]));
  const calls: string[] = [];
  const store = {
    data,
    calls,
    async get(id: string) {
      return data.get(id) ?? null;
    },
    async delete(id: string) {
      calls.push(`delete:${id}`);
      return data.delete(id);
    },
    async update(id: string, updates: Partial<MemoryEntry>) {
      const current = data.get(id);
      if (!current) return null;
      const next = { ...current, ...updates };
      data.set(id, next);
      return next;
    },
    async vectorSearch() {
      return [];
    },
  };
  return store;
}

function triggerStub(overrides: Partial<ForgetTriggerStore> = {}): ForgetTriggerStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteForMemory(memoryId: string) {
      deleted.push(memoryId);
      return 3;
    },
    async countForMemory() {
      return 0;
    },
    ...overrides,
  };
}

function pinStub(overrides: Partial<ForgetPinArchive> = {}): ForgetPinArchive & { archived: string[] } {
  const archived: string[] = [];
  return {
    archived,
    archiveForMemory(memoryId: string) {
      archived.push(memoryId);
      return 1;
    },
    countForMemory() {
      return 0;
    },
    ...overrides,
  };
}

describe("forget 清掉 trigger 行，不留搜不到的后遗症（真实临时 LanceDB）", () => {
  it("被删那条的 trigger 行清空、用它的问法搜不到它；另一条的 trigger 行与可检索性不变", async () => {
    delete process.env.RECALLNEST_TRIGGER_RECALL;
    const dbPath = tempDir("rn-forget-complete-");
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    const triggers = new TriggerStore({ dbPath, vectorDim: 3 });
    await store.importEntry(TOMATO);
    await store.importEntry(MINT);
    await triggers.upsertForMemory(TOMATO.id, TOMATO.scope, [ASK_TOMATO, "番茄浇水"], embedMany);
    await triggers.upsertForMemory(MINT.id, MINT.scope, [ASK_MINT], embedMany);

    const retriever = createRetriever(store, embedder, {
      mode: "vector",
      rerank: "none",
      filterNoise: false,
      sourceDiversity: 0,
      hotnessWeight: 0,
      utilityWeight: 0,
    });
    retriever.setTriggerStore(triggers);
    const search = async (query: string) =>
      (await retriever.retrieve({ query, limit: 5, scopeFilter: ["memory:pivot"], source: "auto-recall" })).map((r) => r.entry.id);

    // 删之前：两条都能用各自的问法搜到（否则后面的「搜不到」什么也证明不了）
    expect((await search(ASK_TOMATO))[0]).toBe(TOMATO.id);
    expect((await search(ASK_MINT))[0]).toBe(MINT.id);

    const result = await forgetMemory(
      { store, triggerStore: triggers },
      { memoryId: TOMATO.id, confirm: true, reason: "test" },
    );

    expect(result.success).toBe(true);
    expect(result.triggerRowsRemoved).toBe(2);
    expect(result.verification).toEqual({ primary: "gone", triggerRowsLeft: 0, pinsLeft: null, kgTriplesLeft: null });

    const hosts = await triggers.listMemoryIds();
    expect(hosts.has(TOMATO.id)).toBe(false);
    expect(hosts.has(MINT.id)).toBe(true);
    expect(await triggers.countForMemory(MINT.id)).toBe(1);

    expect(await search(ASK_TOMATO)).not.toContain(TOMATO.id);
    expect((await search(ASK_MINT))[0]).toBe(MINT.id);
    expect((await store.getById(MINT.id))?.text).toBe(MINT.text);
  });
});

describe("TriggerStore：按宿主数行、删行", () => {
  it("countForMemory 数得准；deleteForMemory 返回删了几行，不碰别的宿主；带引号的 id 当作普通字符串", async () => {
    const triggers = new TriggerStore({ dbPath: tempDir("rn-forget-trigger-"), vectorDim: 3 });
    await triggers.upsertForMemory(TOMATO.id, TOMATO.scope, [ASK_TOMATO, "番茄浇水"], embedMany);
    await triggers.upsertForMemory(MINT.id, MINT.scope, [ASK_MINT], embedMany);

    expect(await triggers.countForMemory(TOMATO.id)).toBe(2);
    expect(await triggers.countForMemory(MINT.id)).toBe(1);
    expect(await triggers.countForMemory("no-such-memory")).toBe(0);
    expect(await triggers.countForMemory("x' OR '1'='1")).toBe(0);

    expect(await triggers.deleteForMemory("x' OR '1'='1")).toBe(0);
    expect(await triggers.deleteForMemory(TOMATO.id)).toBe(2);
    expect(await triggers.deleteForMemory(TOMATO.id)).toBe(0);
    expect(await triggers.countForMemory(TOMATO.id)).toBe(0);
    expect(await triggers.countForMemory(MINT.id)).toBe(1);
  });
});

describe("pin 归档", () => {
  it("只挪来源是这条记忆的 pin；别的 pin、坏文件不动；同名不覆盖", () => {
    const root = tempDir("rn-forget-pins-");
    const pinsDir = join(root, "pins");
    const archiveDir = join(root, "archive", "forgotten-pins");
    mkdirSync(pinsDir, { recursive: true });
    const tomatoPin = writePin(pinsDir, pin("11111111-0000-4000-8000-000000000001", TOMATO.id));
    const tomatoPin2 = writePin(pinsDir, pin("22222222-0000-4000-8000-000000000002", TOMATO.id));
    const mintPin = writePin(pinsDir, pin("33333333-0000-4000-8000-000000000003", MINT.id));
    const corrupt = join(pinsDir, "44444444-0000-4000-8000-000000000004.json");
    writeFileSync(corrupt, "{ not json");
    // 归档目录里已经有一个同名文件：不能被覆盖
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "22222222-0000-4000-8000-000000000002.json"), "earlier archive");

    expect(findPinAssetsForMemory(TOMATO.id, pinsDir).map((p) => p.id).sort()).toEqual([
      "11111111-0000-4000-8000-000000000001",
      "22222222-0000-4000-8000-000000000002",
    ]);

    const moved = archivePinAssetsForMemory(TOMATO.id, { pinsDir, archiveDir });

    expect(moved).toHaveLength(2);
    for (const target of moved) expect(existsSync(target)).toBe(true);
    expect(existsSync(tomatoPin)).toBe(false);
    expect(existsSync(tomatoPin2)).toBe(false);
    expect(existsSync(mintPin)).toBe(true);
    expect(existsSync(corrupt)).toBe(true);
    expect(readFileSync(join(archiveDir, "22222222-0000-4000-8000-000000000002.json"), "utf-8")).toBe("earlier archive");
    expect(readdirSync(archiveDir)).toHaveLength(3);
    expect(findPinAssetsForMemory(TOMATO.id, pinsDir)).toEqual([]);
    expect(findPinAssetsForMemory(MINT.id, pinsDir)).toHaveLength(1);
    // 再来一次什么也不挪
    expect(archivePinAssetsForMemory(TOMATO.id, { pinsDir, archiveDir })).toEqual([]);
  });

  it("pins 目录不存在时返回空，不顺手建目录", () => {
    const root = tempDir("rn-forget-pins-missing-");
    const pinsDir = join(root, "pins");
    const archiveDir = join(root, "archive", "forgotten-pins");
    expect(findPinAssetsForMemory(TOMATO.id, pinsDir)).toEqual([]);
    expect(archivePinAssetsForMemory(TOMATO.id, { pinsDir, archiveDir })).toEqual([]);
    expect(existsSync(pinsDir)).toBe(false);
    expect(existsSync(archiveDir)).toBe(false);
  });

  it("forget 把这条记忆的 pin 挪走，别的 pin 留在原处", async () => {
    const root = tempDir("rn-forget-pins-engine-");
    const pinsDir = join(root, "pins");
    const archiveDir = join(root, "archive", "forgotten-pins");
    mkdirSync(pinsDir, { recursive: true });
    const tomatoPin = writePin(pinsDir, pin("11111111-0000-4000-8000-000000000001", TOMATO.id));
    const mintPin = writePin(pinsDir, pin("33333333-0000-4000-8000-000000000003", MINT.id));
    const store = memoryStore([TOMATO, MINT]);
    const pins: ForgetPinArchive = {
      archiveForMemory: (id) => archivePinAssetsForMemory(id, { pinsDir, archiveDir }).length,
      countForMemory: (id) => findPinAssetsForMemory(id, pinsDir).length,
    };

    const result = await forgetMemory({ store: store as never, pins }, { memoryId: TOMATO.id, confirm: true });

    expect(result.success).toBe(true);
    expect(result.pinsArchived).toBe(1);
    expect(result.verification?.pinsLeft).toBe(0);
    expect(existsSync(tomatoPin)).toBe(false);
    expect(existsSync(mintPin)).toBe(true);
    expect(readdirSync(archiveDir)).toEqual(["11111111-0000-4000-8000-000000000001.json"]);
  });
});

describe("失败时不留半截：清理没做成就不删主行", () => {
  it("trigger 清理抛错 → forget 失败，主行还在，pin、KG、级联都没被碰", async () => {
    const store = memoryStore([TOMATO, MINT]);
    const pins = pinStub();
    const kgCalls: string[] = [];
    const kgStore = { deleteBySource: async (id: string) => void kgCalls.push(id) };
    const triggerStore = triggerStub({
      async deleteForMemory() {
        throw new Error("commit conflict");
      },
    });

    const result = await forgetMemory(
      { store: store as never, kgStore: kgStore as never, triggerStore, pins },
      { memoryId: TOMATO.id, confirm: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("commit conflict");
    expect(result.error).toContain("Nothing was deleted");
    expect(store.data.has(TOMATO.id)).toBe(true);
    expect(store.data.get(TOMATO.id)?.metadata).toBe(TOMATO.metadata);
    expect(store.calls).toEqual([]);
    expect(pins.archived).toEqual([]);
    expect(kgCalls).toEqual([]);
  });

  it("pin 归档抛错 → forget 失败，主行还在，KG 没被碰；错误里说明 trigger 行已清、怎么补回", async () => {
    const store = memoryStore([TOMATO]);
    const kgCalls: string[] = [];
    const kgStore = { deleteBySource: async (id: string) => void kgCalls.push(id) };
    const triggerStore = triggerStub();
    const pins = pinStub({
      archiveForMemory() {
        throw new Error("EACCES");
      },
    });

    const result = await forgetMemory(
      { store: store as never, kgStore: kgStore as never, triggerStore, pins },
      { memoryId: TOMATO.id, confirm: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("EACCES");
    expect(result.error).toContain("triggers-backfill --rebuild");
    expect(result.triggerRowsRemoved).toBe(3);
    expect(store.data.has(TOMATO.id)).toBe(true);
    expect(store.calls).toEqual([]);
    expect(kgCalls).toEqual([]);
  });
});

describe("删后回读", () => {
  it("delete 说成功、行却还读得到 → forget 报失败，不报已遗忘", async () => {
    const store = memoryStore([TOMATO]);
    store.delete = async (id: string) => {
      store.calls.push(`delete:${id}`);
      return true; // 说删了，其实没删
    };

    const result = await forgetMemory({ store: store as never }, { memoryId: TOMATO.id, confirm: true });

    expect(store.calls).toEqual([`delete:${TOMATO.id}`]);
    expect(result.success).toBe(false);
    expect(result.verification?.primary).toBe("present");
    expect(result.error).toContain("still readable");
  });

  it("回读本身读不了 → 如实标 unverified，不冒充已核对", async () => {
    const store = memoryStore([TOMATO]);
    let reads = 0;
    store.get = async (id: string) => {
      reads += 1;
      if (reads > 1) throw new Error("table read failed");
      return store.data.get(id) ?? null;
    };

    const result = await forgetMemory({ store: store as never }, { memoryId: TOMATO.id, confirm: true });

    expect(result.success).toBe(true);
    expect(result.verification?.primary).toBe("unverified");
  });

  it("回读数出残留 → 结果里如实带出；数不了的那一层是 null", async () => {
    const store = memoryStore([TOMATO]);
    const triggerStore = triggerStub({ countForMemory: async () => 2 });
    const pins = pinStub({
      countForMemory() {
        throw new Error("EIO");
      },
    });
    const kgStore = {
      deleteBySource: async () => {},
      getTriplesBySourceMemories: async (ids: string[]) => new Map([[ids[0], [{}, {}, {}]]]),
    };

    const result = await forgetMemory(
      { store: store as never, kgStore: kgStore as never, triggerStore, pins },
      { memoryId: TOMATO.id, confirm: true },
    );

    expect(result.success).toBe(true);
    expect(result.verification).toEqual({ primary: "gone", triggerRowsLeft: 2, pinsLeft: null, kgTriplesLeft: 3 });
  });

  it("没接 trigger 表、pin、KG 时照旧能删，回读只核主行，其余记 null", async () => {
    const store = memoryStore([TOMATO]);

    const result = await forgetMemory({ store: store as never }, { memoryId: TOMATO.id, confirm: true });

    expect(result.success).toBe(true);
    expect(result.triggerRowsRemoved).toBeNull();
    expect(result.pinsArchived).toBeNull();
    expect(result.verification).toEqual({ primary: "gone", triggerRowsLeft: null, pinsLeft: null, kgTriplesLeft: null });
  });

  it("审计行以 norm= 开头，triggers / pins / verify / cascade 排在 reason 之前（reason 长了会被截断）", async () => {
    const dir = tempDir("rn-forget-audit-");
    const logPath = join(dir, "audit.jsonl");
    const auditLogger = createAuditLogger(logPath);
    const store = memoryStore([TOMATO]);

    await forgetMemory(
      { store: store as never, auditLogger, triggerStore: triggerStub(), pins: pinStub() },
      { memoryId: TOMATO.id, confirm: true, reason: "r".repeat(190) },
    );

    const line = readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.operation === "forget");
    expect(line.details).toMatch(/^norm=[0-9a-f]{16} tier=durable triggers=3 pins=1 verify=gone cascade=0 reason=r+$/);
    expect(line.details).toHaveLength(200); // 被截断的是 reason 的尾巴，前面的字段一个不少
  });
});

describe("文件头与函数体写的是同一套步骤", () => {
  it("编号连续，逐条对得上", () => {
    const source = readFileSync(join(import.meta.dir, "..", "forget-engine.ts"), "utf-8");
    const label = (text: string) => text.split(/ — | \(|（|：/)[0].trim();

    const headerEnd = source.indexOf("*/");
    const header = [...source.slice(0, headerEnd).matchAll(/^ \* (\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), label: label(m[2]) }));

    const bodyStart = source.indexOf("export async function forgetMemory");
    const bodyEnd = source.indexOf("export interface ForgetByScopeResult");
    expect(bodyStart).toBeGreaterThan(0);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = [...source.slice(bodyStart, bodyEnd).matchAll(/^\s*\/\/ (\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), label: label(m[2]) }));

    expect(header.length).toBeGreaterThanOrEqual(10);
    expect(header.map((s) => s.n)).toEqual(header.map((_, i) => i + 1));
    expect(body).toEqual(header);
    // 文件头不再许诺函数体里没有的东西
    for (const step of header) expect(step.label.length).toBeGreaterThan(0);
    expect(header.map((s) => s.label)).toContain("Trigger rows");
    expect(header.map((s) => s.label)).toContain("Pin archive");
    expect(header.map((s) => s.label)).toContain("Read-back");
  });
});

describe("forget_memory 工具的输出", () => {
  interface ToolResult {
    content: { type: string; text: string }[];
    isError?: boolean;
  }
  type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

  function captureForget(getComponents: () => unknown): Handler {
    // 工具内部用默认路径建审计日志（<数据目录>/audit.jsonl）：指到临时目录，别写进真实日志
    process.env.RECALLNEST_DATA_DIR = tempDir("rn-forget-tool-");
    const handlers = new Map<string, Handler>();
    registerAdvancedTools({
      registerTool: (name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
        handlers.set(name, (args) => runToolSafely(name, async () => handler(args)) as Promise<ToolResult>);
      },
      getComponents,
      conflictStore: {},
      workflowObservationStore: {},
      getKGExtractor: () => null,
      getKGStore: () => null,
    } as never);
    return handlers.get("forget_memory")!;
  }

  it("干净删完：逐项报数，回读结果写在明处", async () => {
    const store = memoryStore([TOMATO]);
    const forget = captureForget(() => ({ store, triggerStore: triggerStub() }));

    const r = await forget({ memoryId: TOMATO.id, confirm: true, reason: "test" });

    expect(r.isError).toBeUndefined();
    const text = r.content[0].text;
    expect(text.split("\n")[0]).toBe(`✅ Memory ${TOMATO.id.slice(0, 8)} forgotten.`);
    expect(text).toContain("Trigger rows removed: 3");
    expect(text).toContain("Pins archived: 0");
    expect(text).toContain("Read-back: gone");
    expect(store.data.has(TOMATO.id)).toBe(false);
  });

  it("回读数出残留：第一行不打勾，写明剩了什么", async () => {
    const store = memoryStore([TOMATO]);
    const forget = captureForget(() => ({ store, triggerStore: triggerStub({ countForMemory: async () => 2 }) }));

    const r = await forget({ memoryId: TOMATO.id, confirm: true });

    const text = r.content[0].text;
    expect(text.split("\n")[0].startsWith("✅")).toBe(false);
    expect(text).toContain("trigger rows 2");
  });

  it("没接 trigger 表（旧调用形态）：照常删，对应行写 n/a", async () => {
    const store = memoryStore([TOMATO]);
    const forget = captureForget(() => ({ store }));

    const r = await forget({ memoryId: TOMATO.id, confirm: true });

    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Trigger rows removed: n/a");
  });
});
