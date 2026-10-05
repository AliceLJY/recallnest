import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexPinnedAsset } from "../asset-sync.js";
import { createAuditLogger } from "../audit-log.js";
import { buildStructuredMetadata } from "../capture-engine.js";
import { runToolSafely } from "../error-taxonomy.js";
import { forgetMemory, summarizeVerification, type ForgetPinArchive, type ForgetTriggerStore } from "../forget-engine.js";
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
 * 和由它生成的 pin 都留在原处。pin 有两半：data/pins 下的文件（list_pins 列出、resume_context
 * 拼进上下文）和主表里一行可检索的索引副本（asset-sync.ts）。删完也没有任何一步回读。
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
    async list(scopeFilter?: string[]) {
      const all = [...data.values()];
      if (!scopeFilter || scopeFilter.length === 0) return all;
      return all.filter((e) => scopeFilter.some((scope) => (scope.includes(":") ? e.scope === scope : e.scope.startsWith(scope))));
    },
  };
  return store;
}

/** 主表里一行 pin 的索引副本，形状同 asset-sync.ts 写出来的。 */
function pinIndexRow(id: string, pinId: string, originalMemoryId: string): MemoryEntry {
  return {
    id,
    text: `[Pinned Asset] pin of ${originalMemoryId.slice(0, 8)}`,
    vector: [1, 0, 0],
    category: "decision" as MemoryEntry["category"],
    scope: `asset:${pinId.slice(0, 8)}`,
    importance: 0.96,
    timestamp: Date.now() - DAY,
    metadata: JSON.stringify({ source: "asset", assetId: pinId, assetType: "pinned-memory", originalMemoryId, originalScope: "memory:pivot", tags: [] }),
  };
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
    expect(result.verification).toEqual({ primary: "gone", triggerRowsLeft: 0, pinsLeft: null, pinIndexRowsLeft: 0, kgTriplesLeft: null, unverified: [] });

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

  it("pin 在主表里的索引副本一并删掉：删前搜得到它，删后搜不到；别的 pin 的副本还在（真实临时 LanceDB）", async () => {
    const dbPath = tempDir("rn-forget-pin-index-");
    const root = tempDir("rn-forget-pin-index-files-");
    const pinsDir = join(root, "pins");
    const archiveDir = join(root, "archive", "forgotten-pins");
    mkdirSync(pinsDir, { recursive: true });
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    await store.importEntry(TOMATO);
    await store.importEntry(MINT);

    // 和 pin_memory 工具做的一样：写文件 + 调真实的 indexPinnedAsset 往主表存一行副本
    const tomatoPin = { ...pin("11111111-0000-4000-8000-000000000001", TOMATO.id), title: "番茄浇水", snippet: TOMATO.text };
    const mintPin = { ...pin("33333333-0000-4000-8000-000000000003", MINT.id), title: "薄荷摆放", snippet: MINT.text };
    const assetVectors: Record<string, number[]> = { 番茄浇水: [0, 1, 0], 薄荷摆放: [0, 0, 1] };
    const assetEmbedder = {
      embedPassage: async (text: string) => (text.includes("番茄浇水") ? assetVectors.番茄浇水 : assetVectors.薄荷摆放),
    } as never;
    for (const asset of [tomatoPin, mintPin]) {
      writePin(pinsDir, asset);
      await indexPinnedAsset(store, assetEmbedder, asset);
    }
    const pins: ForgetPinArchive = {
      archiveForMemory: (id) => archivePinAssetsForMemory(id, { pinsDir, archiveDir }).length,
      countForMemory: (id) => findPinAssetsForMemory(id, pinsDir).length,
    };
    const assetHits = async (vector: number[]) =>
      (await store.vectorSearch(vector, 5, 0.9, ["asset"])).map((r) => JSON.parse(r.entry.metadata).originalMemoryId as string);

    // 删之前：按 pin 的向量能搜到这两行副本，正文片段就在里面
    expect(await assetHits([0, 1, 0])).toEqual([TOMATO.id]);
    expect(await assetHits([0, 0, 1])).toEqual([MINT.id]);

    const result = await forgetMemory({ store, pins }, { memoryId: TOMATO.id, confirm: true });

    expect(result.success).toBe(true);
    expect(result.pinIndexRowsRemoved).toBe(1);
    expect(result.pinsArchived).toBe(1);
    expect(result.verification).toEqual({ primary: "gone", triggerRowsLeft: null, pinsLeft: 0, pinIndexRowsLeft: 0, kgTriplesLeft: null, unverified: [] });
    expect(await assetHits([0, 1, 0])).toEqual([]);
    expect(await assetHits([0, 0, 1])).toEqual([MINT.id]);
    const left = await store.list(["asset"], undefined, 100, 0);
    expect(left.map((r) => JSON.parse(r.metadata).originalMemoryId)).toEqual([MINT.id]);
    expect(left.some((r) => r.text.includes("番茄"))).toBe(false);
  });

  it("pin 文件读不了（EIO）不当作没有：查找与归档都把错误抛出来；内容不是 JSON 的才跳过", () => {
    const root = tempDir("rn-forget-pins-unreadable-");
    const pinsDir = join(root, "pins");
    const archiveDir = join(root, "archive", "forgotten-pins");
    mkdirSync(pinsDir, { recursive: true });
    const unreadable = writePin(pinsDir, pin("55555555-0000-4000-8000-000000000005", TOMATO.id));
    writeFileSync(join(pinsDir, "66666666-0000-4000-8000-000000000006.json"), "{ not json");
    mkdirSync(join(pinsDir, "a-directory.json"));

    const realReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === unreadable) {
        throw Object.assign(new Error(`EIO: i/o error, read '${unreadable}'`), { code: "EIO" });
      }
      return realReadFileSync(...args);
    }) as typeof fs.readFileSync);
    try {
      expect(() => findPinAssetsForMemory(TOMATO.id, pinsDir)).toThrow("EIO");
      expect(() => archivePinAssetsForMemory(TOMATO.id, { pinsDir, archiveDir })).toThrow("EIO");
      expect(readSpy).toHaveBeenCalledWith(unreadable, "utf-8");
      expect(existsSync(unreadable)).toBe(true);
      expect(existsSync(archiveDir)).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
    // 恢复可读之后照常找得到；坏 JSON 和同名目录都不碍事
    expect(findPinAssetsForMemory(TOMATO.id, pinsDir).map((p) => p.id)).toEqual(["55555555-0000-4000-8000-000000000005"]);
  });

  it("pin 文件读不了时 forget 中止：主行还在，不谎报没有 pin", async () => {
    const root = tempDir("rn-forget-pins-unreadable-engine-");
    const pinsDir = join(root, "pins");
    const archiveDir = join(root, "archive", "forgotten-pins");
    mkdirSync(pinsDir, { recursive: true });
    const unreadable = writePin(pinsDir, pin("55555555-0000-4000-8000-000000000005", TOMATO.id));
    const store = memoryStore([TOMATO]);
    const pins: ForgetPinArchive = {
      archiveForMemory: (id) => archivePinAssetsForMemory(id, { pinsDir, archiveDir }).length,
      countForMemory: (id) => findPinAssetsForMemory(id, pinsDir).length,
    };

    const realReadFileSync = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === unreadable) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return realReadFileSync(...args);
    }) as typeof fs.readFileSync);
    try {
      const result = await forgetMemory({ store: store as never, pins }, { memoryId: TOMATO.id, confirm: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Pin archive failed: EIO");
      expect(result.error).toContain("still active");
      expect(store.data.has(TOMATO.id)).toBe(true);
      expect(store.calls).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
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
    expect(result.error).toContain("Already done and not rolled back: 3 trigger row(s) removed.");
    // 恢复命令带上这条记忆自己的 scope：triggers-backfill 默认只扫 memory:pivot
    expect(result.error).toContain("`triggers-backfill --rebuild --apply --scope memory:pivot`");
    expect(result.triggerRowsRemoved).toBe(3);
    expect(store.data.has(TOMATO.id)).toBe(true);
    expect(store.data.get(TOMATO.id)?.metadata).toBe(TOMATO.metadata);
    expect(store.calls).toEqual([]);
    expect(kgCalls).toEqual([]);
  });

  it("恢复命令里的 scope 跟着记忆走；没删过 trigger 行就不提恢复", async () => {
    const elsewhere = { ...TOMATO, scope: "project:garden" };
    const failingPins = () => pinStub({
      archiveForMemory() {
        throw new Error("EACCES");
      },
    });

    const withTriggers = await forgetMemory(
      { store: memoryStore([elsewhere]) as never, triggerStore: triggerStub(), pins: failingPins() },
      { memoryId: elsewhere.id, confirm: true },
    );
    expect(withTriggers.error).toContain("`triggers-backfill --rebuild --apply --scope project:garden`");

    const noTriggers = await forgetMemory(
      { store: memoryStore([elsewhere]) as never, triggerStore: triggerStub({ deleteForMemory: async () => 0 }), pins: failingPins() },
      { memoryId: elsewhere.id, confirm: true },
    );
    expect(noTriggers.error).not.toContain("triggers-backfill");
    expect(noTriggers.error).not.toContain("Already done");
  });

  it("半途停下而且已经动过东西：留一条 forget_incomplete 审计，不是 forget、不带 norm=；什么都没动就不留", async () => {
    const dir = tempDir("rn-forget-incomplete-audit-");
    const logPath = join(dir, "audit.jsonl");
    const auditLogger = createAuditLogger(logPath);
    const lines = () => (existsSync(logPath) ? readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

    // 第 4 步就失败：什么都没动 → 没有审计
    await forgetMemory(
      { store: memoryStore([TOMATO]) as never, auditLogger, triggerStore: triggerStub({ deleteForMemory: async () => { throw new Error("conflict"); } }), pins: pinStub() },
      { memoryId: TOMATO.id, confirm: true },
    );
    expect(lines()).toEqual([]);

    // 第 5 步失败，但前面一行 trigger 都没删到：同样什么都没动 → 也没有审计
    await forgetMemory(
      { store: memoryStore([TOMATO]) as never, auditLogger, triggerStore: triggerStub({ deleteForMemory: async () => 0 }), pins: pinStub({ archiveForMemory() { throw new Error("EACCES"); } }) },
      { memoryId: TOMATO.id, confirm: true },
    );
    expect(lines()).toEqual([]);

    // 第 5 步失败、trigger 行已删 → 一条 forget_incomplete
    await forgetMemory(
      { store: memoryStore([TOMATO]) as never, auditLogger, triggerStore: triggerStub(), pins: pinStub({ archiveForMemory() { throw new Error("EACCES"); } }) },
      { memoryId: TOMATO.id, confirm: true },
    );
    const logged = lines();
    expect(logged).toHaveLength(1);
    expect(logged[0].operation).toBe("forget_incomplete");
    expect(logged[0].memoryId).toBe(TOMATO.id);
    expect(logged[0].details).toMatch(/^stage=pin-archive triggers=3 pins=n\/a pinIndex=0 kg=no cascade=0 breadcrumb=no error=Pin archive failed: EACCES\.$/);
    expect(logged[0].details).not.toContain("norm=");
    // 记忆文件对账只认 operation 为 forget 的行，这一条不会被它读成「已遗忘」
    expect(logged.some((l) => l.operation === "forget")).toBe(false);
  });
});

describe("删后回读", () => {
  it("delete 说成功、行却还读得到 → forget 报失败，并交代已经动过什么、这一行现在是什么状态", async () => {
    const dir = tempDir("rn-forget-present-audit-");
    const logPath = join(dir, "audit.jsonl");
    const store = memoryStore([TOMATO]);
    store.delete = async (id: string) => {
      store.calls.push(`delete:${id}`);
      return true; // 说删了，其实没删
    };

    const result = await forgetMemory(
      { store: store as never, auditLogger: createAuditLogger(logPath), triggerStore: triggerStub(), pins: pinStub() },
      { memoryId: TOMATO.id, confirm: true, reason: "test" },
    );

    expect(store.calls).toEqual([`delete:${TOMATO.id}`]);
    expect(result.success).toBe(false);
    expect(result.verification?.primary).toBe("present");
    expect(result.error).toContain("still readable");
    // 这条路径上派生物已经清掉、行已被标成 archived：报错里逐项写明，不让调用方以为什么都没发生
    expect(result.error).toContain('Already done and not rolled back: 3 trigger row(s) removed; 1 pin file(s) archived; row marked archived with a "forgotten:" note.');
    expect(result.error).toContain("default recall skips it");
    expect(result.error).toContain("Run forget again to finish.");
    expect(result.triggerRowsRemoved).toBe(3);
    expect(result.pinsArchived).toBe(1);
    // 行确实还在，而且确实被改过了
    const left = JSON.parse(store.data.get(TOMATO.id)!.metadata);
    expect(left.evolution.status).toBe("archived");
    expect(left.evolution.evolutionNote).toBe("forgotten: test");
    // 审计：一条 forget_incomplete，没有 forget
    const logged = readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(logged.map((l) => l.operation)).toEqual(["forget_incomplete"]);
    expect(logged[0].details).toMatch(/^stage=read-back triggers=3 pins=1 pinIndex=0 kg=no cascade=0 breadcrumb=yes error=Delete reported success/);
  });

  it("delete 抛错 → 同样交代已经动过什么，留 forget_incomplete 审计", async () => {
    const dir = tempDir("rn-forget-delete-throws-");
    const logPath = join(dir, "audit.jsonl");
    const store = memoryStore([TOMATO]);
    store.delete = async () => {
      throw new Error("commit conflict");
    };
    const kgStore = { deleteBySource: async () => {} };

    const result = await forgetMemory(
      { store: store as never, kgStore: kgStore as never, auditLogger: createAuditLogger(logPath), triggerStore: triggerStub(), pins: pinStub() },
      { memoryId: TOMATO.id, confirm: true },
    );

    expect(result.success).toBe(false);
    expect(result.verification).toBeUndefined();
    expect(result.error).toContain("Delete failed: commit conflict.");
    expect(result.error).toContain('3 trigger row(s) removed; 1 pin file(s) archived; KG cleanup ran; row marked archived with a "forgotten:" note');
    expect(result.error).toContain("Run forget again to finish.");
    expect(store.data.has(TOMATO.id)).toBe(true);
    const logged = readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(logged.map((l) => l.operation)).toEqual(["forget_incomplete"]);
    expect(logged[0].details).toMatch(/^stage=delete triggers=3 pins=1 pinIndex=0 kg=ran cascade=0 breadcrumb=yes error=Delete failed: commit conflict\.$/);
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
    expect(result.verification?.unverified).toEqual(["primary"]);
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
    // pin 那一层是「查不了」，不是「没接」：两者的数都是 null，靠 unverified 分开
    expect(result.verification).toEqual({ primary: "gone", triggerRowsLeft: 2, pinsLeft: null, pinIndexRowsLeft: 0, kgTriplesLeft: 3, unverified: ["pins"] });
  });

  it("一句话的回读结论：干净 / 有残留 / 没查成 / 主行还在", () => {
    const base = { primary: "gone" as const, triggerRowsLeft: 0, pinsLeft: 0, pinIndexRowsLeft: 0, kgTriplesLeft: 0, unverified: [] };
    expect(summarizeVerification(base)).toBe("clean");
    expect(summarizeVerification({ ...base, triggerRowsLeft: null, pinsLeft: null, kgTriplesLeft: null })).toBe("clean"); // 没接的层不算没查成
    expect(summarizeVerification({ ...base, pinIndexRowsLeft: 1 })).toBe("leftovers");
    expect(summarizeVerification({ ...base, triggerRowsLeft: null, unverified: ["triggers"] })).toBe("unverified");
    expect(summarizeVerification({ ...base, primary: "unverified", unverified: ["primary"] })).toBe("unverified");
    expect(summarizeVerification({ ...base, kgTriplesLeft: 2, unverified: ["pins"] })).toBe("leftovers");
    expect(summarizeVerification({ ...base, primary: "present" })).toBe("present");
  });

  it("没接 trigger 表、pin、KG 时照旧能删，回读只核主行，其余记 null", async () => {
    const store = memoryStore([TOMATO]);

    const result = await forgetMemory({ store: store as never }, { memoryId: TOMATO.id, confirm: true });

    expect(result.success).toBe(true);
    expect(result.triggerRowsRemoved).toBeNull();
    expect(result.pinsArchived).toBeNull();
    expect(result.pinIndexRowsRemoved).toBe(0);
    expect(result.verification).toEqual({ primary: "gone", triggerRowsLeft: null, pinsLeft: null, pinIndexRowsLeft: 0, kgTriplesLeft: null, unverified: [] });
  });

  it("mock 库里有这条记忆的 pin 索引副本：一并删掉并计数，别人的不动", async () => {
    const mine = pinIndexRow("cccccccc-0000-4000-8000-00000000000c", "11111111-0000-4000-8000-000000000001", TOMATO.id);
    const theirs = pinIndexRow("dddddddd-0000-4000-8000-00000000000d", "33333333-0000-4000-8000-000000000003", MINT.id);
    const store = memoryStore([TOMATO, MINT, mine, theirs]);

    const result = await forgetMemory({ store: store as never }, { memoryId: TOMATO.id, confirm: true });

    expect(result.success).toBe(true);
    expect(result.pinIndexRowsRemoved).toBe(1);
    expect(store.calls).toEqual([`delete:${mine.id}`, `delete:${TOMATO.id}`]);
    expect([...store.data.keys()].sort()).toEqual([MINT.id, theirs.id].sort());
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
    expect(line.details).toMatch(/^norm=[0-9a-f]{16} tier=durable triggers=3 pins=1 pinIndex=0 verify=clean cascade=0 reason=r+$/);
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

  // pin 归档一律注入替身：工具默认用的是真实的 data/pins，测试不该去读它、更不该有机会挪它里面的文件。
  function captureForget(getComponents: () => unknown, forgetPins: ForgetPinArchive = pinStub()): Handler {
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
      forgetPins,
    } as never);
    return handlers.get("forget_memory")!;
  }

  it("干净删完：逐项报数，回读结果写在明处；trigger 表和 pin 归档都真的被调到了", async () => {
    const store = memoryStore([TOMATO]);
    const triggerStore = triggerStub();
    const pins = pinStub();
    const forget = captureForget(() => ({ store, triggerStore }), pins);

    const r = await forget({ memoryId: TOMATO.id, confirm: true, reason: "test" });

    expect(r.isError).toBeUndefined();
    const text = r.content[0].text;
    expect(text.split("\n")[0]).toBe(`✅ Memory ${TOMATO.id.slice(0, 8)} forgotten.`);
    expect(text).toContain("Trigger rows removed: 3");
    expect(text).toContain("Pins archived: 1 (index rows removed: 0)");
    expect(text).toContain("Read-back: gone (left: trigger rows 0, pin files 0, pin index rows 0, KG triples n/a)");
    expect(triggerStore.deleted).toEqual([TOMATO.id]);
    expect(pins.archived).toEqual([TOMATO.id]);
    expect(store.data.has(TOMATO.id)).toBe(false);
  });

  it("回读数出残留：第一行不打勾，写明剩了什么", async () => {
    const store = memoryStore([TOMATO]);
    const forget = captureForget(() => ({ store, triggerStore: triggerStub({ countForMemory: async () => 2 }) }));

    const r = await forget({ memoryId: TOMATO.id, confirm: true });

    const text = r.content[0].text;
    expect(text.split("\n")[0]).toBe(`⚠️ Memory ${TOMATO.id.slice(0, 8)} forgotten, but the read-back found leftovers: trigger rows 2.`);
  });

  it("某一层回读查不了：主行没了也不打勾，写明哪一层没查成", async () => {
    const store = memoryStore([TOMATO]);
    const triggerStore = triggerStub({
      async countForMemory() {
        throw new Error("table read failed");
      },
    });
    const forget = captureForget(() => ({ store, triggerStore }));

    const r = await forget({ memoryId: TOMATO.id, confirm: true });

    expect(r.isError).toBeUndefined();
    const text = r.content[0].text;
    expect(text.split("\n")[0]).toBe(`⚠️ Memory ${TOMATO.id.slice(0, 8)} deleted, but the read-back could not check: triggers.`);
    expect(text).toContain("trigger rows n/a");
    expect(store.data.has(TOMATO.id)).toBe(false);
  });

  it("没接 trigger 表（旧调用形态）：照常删，对应行写 n/a，照样算干净", async () => {
    const store = memoryStore([TOMATO]);
    const forget = captureForget(() => ({ store }));

    const r = await forget({ memoryId: TOMATO.id, confirm: true });

    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n")[0].startsWith("✅")).toBe(true);
    expect(r.content[0].text).toContain("Trigger rows removed: n/a");
  });

  it("失败时工具抛出的错误带着已经动过什么", async () => {
    const store = memoryStore([TOMATO]);
    store.delete = async () => {
      throw new Error("commit conflict");
    };
    const forget = captureForget(() => ({ store, triggerStore: triggerStub() }));

    const r = await forget({ memoryId: TOMATO.id, confirm: true });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Delete failed: commit conflict.");
    expect(r.content[0].text).toContain("3 trigger row(s) removed");
    expect(r.content[0].text).toContain("Run forget again to finish.");
  });
});
