import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStructuredMetadata } from "../capture-engine.js";
import { createRetriever } from "../retriever.js";
import { MemoryStore, type MemoryEntry } from "../store.js";

/**
 * 检索端默认 filterNoise: true，写入端不跑噪声过滤（2026-11-01）。
 * 一条正文里夹着一行 ISO 时间戳日志的复盘，改前被「裸时间戳」规则（带 /m）整条判成噪声：
 * 存得进库、cosine 0.97 却从结果里消失，只剩一条弱干扰项。这里用真实临时 LanceDB + 假嵌入器端到端核对。
 */

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const DAY = 86_400_000;

function entry(id: string, vector: number[], text: string): MemoryEntry {
  return {
    id,
    text,
    vector,
    category: "events",
    scope: "memory:pivot",
    importance: 0.7,
    timestamp: Date.now() - DAY,
    metadata: buildStructuredMetadata({ source: "manual", capture: "test", category: "events" }),
  };
}

const QUERY = "ingest 凌晨失败的根因";
const QUERY_VECTOR = [1, 0, 0];
// cosine(LOG_RETRO, QUERY) = 0.97
const LOG_RETRO = entry(
  "aaaaaaaa-0000-4000-8000-0000000000a1",
  [0.97, Math.sqrt(1 - 0.97 * 0.97), 0],
  "复盘：ingest 在凌晨失败。日志如下：\n2026-10-05T16:38:03Z ERROR commit conflict\n根因是 delete 不持锁，两个进程同时提交时后一个撞冲突。修法：delete 走写锁。",
);
const DISTRACTOR = entry(
  "bbbbbbbb-0000-4000-8000-0000000000b2",
  [0.6, 0.8, 0],
  "周末整理了阳台，番茄每周浇两次水，薄荷挪到北边窗台。",
);

const embedQuery = async (text: string) => (text === QUERY ? QUERY_VECTOR : [0, 0, 1]);
const embedder = { embedQuery, embedPassage: embedQuery } as never;

describe("检索端噪声过滤不吞带日志行的真记忆（真实临时 LanceDB）", () => {
  it("带一行时间戳日志的复盘照常被搜到且排第 1，默认 filterNoise 开着", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "rn-noise-retrieval-"));
    cleanup.push(dbPath);
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    await store.importEntry(LOG_RETRO);
    await store.importEntry(DISTRACTOR);

    const retriever = createRetriever(store, embedder, {
      mode: "vector",
      rerank: "none",
      filterNoise: true,
      sourceDiversity: 0,
      hotnessWeight: 0,
      utilityWeight: 0,
    });
    const ids = (await retriever.retrieve({ query: QUERY, limit: 5, scopeFilter: ["memory:pivot"], source: "manual" }))
      .map((r) => r.entry.id);

    expect(ids[0]).toBe(LOG_RETRO.id);
  });
});
