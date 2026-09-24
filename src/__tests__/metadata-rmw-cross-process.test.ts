import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStructuredMetadata } from "../capture-engine.js";
import { withWriteLock } from "../distill-lock.js";
import { createRetriever } from "../retriever.js";
import { MemoryStore, type MemoryEntry } from "../store.js";

/**
 * 元数据读改写要在写锁内读最新行（2026-09-24，记忆文件对账上线前代码单审点名的旧竞态）。
 * 两个 MemoryStore 实例开同一个库，当作两个进程：测试先占住 store-write 锁（模拟另一个进程正在提交），
 * 这期间一个实例发起访问计数的读改写，另一个实例绕过锁把那一行改成下架；放锁后，下架必须还在、计数也加上了。
 * 旧实现在锁外读、锁内按旧读数整行写回，会把下架盖回活跃。
 */

const TEXT = "这条正文足够长，不会被噪声过滤当成碎片：讲的是记忆文件对账把旧版切片下架之后，别的进程不能拿旧读数把它写回活跃。";
const ID = "aaaaaaaa-1111-2222-3333-444444444444";

function seedEntry(): MemoryEntry {
  const meta = JSON.parse(buildStructuredMetadata({ source: "manual", tags: [], capture: "test", category: "events", canonicalKey: "rmw-cross-process" })) as Record<string, unknown>;
  meta.evolution = { status: "active", accessCount: 0 };
  return {
    id: ID,
    text: TEXT,
    vector: [1, 0, 0],
    category: "events",
    scope: "memory",
    importance: 0.7,
    timestamp: Date.now() - 86_400_000,
    metadata: JSON.stringify(meta),
  };
}

/** 另一个「进程」直接提交一次改动：不拿 store-write 锁（锁正被测试占着），就像它的提交恰好落在别人的读与写之间 */
async function archiveBypassingLock(store: MemoryStore, id: string): Promise<void> {
  await store.getById(id); // 确保已初始化
  const table = (store as unknown as { table: { query(): { where(w: string): { limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> } } }; mergeInsert(k: string): { whenMatchedUpdateAll(): { execute(rows: unknown[]): Promise<unknown> } } } }).table;
  const [row] = await table.query().where(`id = '${id}'`).limit(1).toArray();
  const meta = JSON.parse(String(row.metadata)) as Record<string, unknown>;
  meta.evolution = { ...(meta.evolution as Record<string, unknown>), status: "archived", evolutionNote: "archived by another process" };
  await table.mergeInsert("id").whenMatchedUpdateAll().execute([{ ...row, vector: Array.from(row.vector as Iterable<number>), metadata: JSON.stringify(meta) }]);
}

async function evolutionOf(store: MemoryStore, id: string): Promise<Record<string, unknown>> {
  const entry = await store.getById(id);
  return (JSON.parse(entry!.metadata ?? "{}").evolution ?? {}) as Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("元数据读改写在写锁内读最新行（跨进程）", () => {
  const dirs: string[] = [];
  let originalDataDir: string | undefined;
  beforeAll(() => {
    originalDataDir = process.env.RECALLNEST_DATA_DIR;
  });
  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
    else process.env.RECALLNEST_DATA_DIR = originalDataDir;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), "rn-rmw-"));
    dirs.push(root);
    process.env.RECALLNEST_DATA_DIR = root; // 锁目录跟着它走
    const dbPath = join(root, "lancedb");
    const a = new MemoryStore({ dbPath, vectorDim: 3 });
    const b = new MemoryStore({ dbPath, vectorDim: 3 });
    await a.storeBatch([seedEntry()]);
    return { a, b };
  }

  it("patchMetadata：读改写期间别的进程提交的下架不会被盖掉", async () => {
    const { a, b } = await setup();
    let pending: Promise<unknown> | undefined;
    await withWriteLock("store-write", async () => {
      pending = a.patchMetadata(ID, (meta) => {
        meta.accessCount = (typeof meta.accessCount === "number" ? meta.accessCount : 0) + 1;
        return meta;
      });
      await sleep(200); // 让旧实现有时间在锁外先读
      await archiveBypassingLock(b, ID);
    });
    await pending;
    const entry = await a.getById(ID);
    const meta = JSON.parse(entry!.metadata ?? "{}") as Record<string, unknown>;
    expect((meta.evolution as Record<string, unknown>).status).toBe("archived");
    expect(meta.accessCount).toBe(1);
  });

  it("检索后的访问计数：检索与写回之间别的进程提交的下架不会被盖掉", async () => {
    const { a, b } = await setup();
    const embedder = { async embedQuery() { return [1, 0, 0]; }, async embedPassage() { return [1, 0, 0]; } } as never;
    const retriever = createRetriever(a, embedder, {
      mode: "vector",
      rerank: "none",
      filterNoise: false,
      sourceDiversity: 0,
      hotnessWeight: 0,
      utilityWeight: 0,
    });
    await withWriteLock("store-write", async () => {
      const results = await retriever.retrieve({ query: "对账下架之后别的进程能不能写回活跃", limit: 5, scopeFilter: ["memory"] });
      expect(results.map((r) => r.entry.id)).toContain(ID); // 前提：检索时这一行还活跃、被返回了
      await sleep(200);
      await archiveBypassingLock(b, ID);
    });
    let evo: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      evo = await evolutionOf(a, ID);
      if (typeof evo.accessCount === "number" && evo.accessCount >= 1) break;
      await sleep(50);
    }
    expect(evo.accessCount).toBe(1);
    expect(evo.status).toBe("archived");
    expect(evo.evolutionNote).toBe("archived by another process");
  });
});
