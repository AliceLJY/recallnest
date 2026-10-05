import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStructuredMetadata } from "../capture-engine.js";
import { dedupCheck } from "../ingest.js";
import { LLMClient } from "../llm-client.js";
import { MemoryStore } from "../store.js";

/**
 * 导入去重不许删已有记忆（2026-10-05）。
 *
 * 起因：`dedupCheck` 的候选不分 scope，分数落在软硬阈值之间时问模型，而提示词给了模型
 * 「可以在 actions 里标记删除」的能力，七处导入调用点原样执行 `store.delete`——不写审计、
 * 不记日志、错误吞掉。2026-09-22T16:38:03Z 记忆文件导入就这样删掉了当天手写进
 * memory:pivot 的一条偏好（f5b67b51），11 秒后同一轮导入写入了内容相近的文档切片。
 * 到 10-05 核对时，显式存过、不在主表、又没有 forget 记录的手写 pivot 记忆有 17 条。
 */

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

const DAY = 86_400_000;

function entry(id: string, scope: string, vector: number[], text: string) {
  const base = JSON.parse(
    buildStructuredMetadata({ source: "manual", tags: ["pinned"], capture: "test", category: "preferences", canonicalKey: `key-${id}` }),
  );
  return {
    id,
    text,
    vector,
    category: "preferences" as const,
    scope,
    importance: 0.8,
    timestamp: Date.now() - DAY,
    metadata: JSON.stringify(base),
  };
}

// 进来的切片向量是 [1,0,0]。两条已有记忆与它的余弦分别是 0.85、0.80，
// 换成 dedupCheck 用的分数（1 / (1 + 余弦距离)）是 0.870、0.833：都在软阈值 0.78 之上、硬阈值 0.92 之下，
// 正是「拿不准、去问模型」的那一段。
const INCOMING_VECTOR = [1, 0, 0];
const PIVOT = entry(
  "0a1b2c3d-0000-4000-8000-000000000001",
  "memory:pivot",
  [0.85, Math.sqrt(1 - 0.85 * 0.85), 0],
  "泡绿茶的水温定在八十度上下：水太烫茶汤发苦、叶子也烫熟了，这是连着试了三回之后定下来的做法。",
);
const OTHER = entry(
  "0e0e0e0e-0000-4000-8000-000000000002",
  "memory",
  [0.8, 0, 0.6],
  "红茶可以直接用刚烧开的水冲，闷上三分钟再出汤，茶味更厚，和绿茶的泡法正好相反。",
);
// 不含日期、文件操作、「记住」「别再」这类词：那些会走另一条不读 actions 的分支，测不到这条路。
const INCOMING_TEXT = "绿茶用八十度左右的水来泡，茶汤清而不苦，滚水冲下去味道就发涩。";

describe("导入去重不删已有记忆", () => {
  it("模型返回「删掉第 1 条已有记忆」时，dedupCheck 不产出任何删除指令，库里的行原样还在", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "rn-dedup-no-deletes-"));
    cleanupPaths.push(dbPath);
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    await store.importEntry(PIVOT);
    await store.importEntry(OTHER);

    let deleteCalls = 0;
    const realDelete = store.delete.bind(store);
    (store as unknown as { delete: typeof store.delete }).delete = async (...args: Parameters<typeof store.delete>) => {
      deleteCalls += 1;
      return realDelete(...args);
    };

    const seenCandidates: string[][] = [];
    const llm = {
      async dedupDecisionMulti(_text: string, candidates: Array<{ id: string; text: string }>) {
        seenCandidates.push(candidates.map((c) => c.id));
        return {
          action: "CREATE",
          reason: "讲的是另一件事",
          actions: [{ match_index: 1, action: "delete", reason: "被新记忆取代" }],
        };
      },
      async dedupDecision() {
        return { action: "CREATE", reason: "" };
      },
    };

    const decision = await dedupCheck(store, INCOMING_VECTOR, INCOMING_TEXT, llm as never);

    // 前提成立：确实走到了问模型那一步，而且排第 1 的候选就是 memory:pivot 那条
    expect(seenCandidates).toEqual([[PIVOT.id, OTHER.id]]);
    expect(decision.action).toBe("store");
    // 返回里只有去重结论，没有任何指向已有记忆的动作
    expect(Object.keys(decision).sort()).toEqual(["action", "reason"]);
    expect(deleteCalls).toBe(0);
    expect((await store.getById(PIVOT.id))?.text).toBe(PIVOT.text);
    expect((await store.getById(OTHER.id))?.text).toBe(OTHER.text);
  });

  it("模型判 SKIP 或 MERGE 并附带删除动作时，同样不产出删除指令", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "rn-dedup-no-deletes-"));
    cleanupPaths.push(dbPath);
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    await store.importEntry(PIVOT);
    await store.importEntry(OTHER);

    for (const [action, expected] of [["SKIP", "skip"], ["MERGE", "store"]] as const) {
      const llm = {
        async dedupDecisionMulti() {
          return { action, reason: "", actions: [{ match_index: 2, action: "delete", reason: "过时" }] };
        },
        async dedupDecision() {
          return { action, reason: "" };
        },
      };
      const decision = await dedupCheck(store, INCOMING_VECTOR, INCOMING_TEXT, llm as never);
      expect(decision.action).toBe(expected);
      expect("secondaryDeletes" in decision).toBe(false);
    }
    expect(await store.getById(PIVOT.id)).not.toBeNull();
    expect(await store.getById(OTHER.id)).not.toBeNull();
  });

  it("导入模块的源码里没有任何 .delete( 调用", () => {
    // 导入只该新增和跳过。以后谁要在这条路上删行，先过这一条，再去看文件头写的那次事故。
    const source = readFileSync(join(import.meta.dir, "..", "ingest.ts"), "utf-8");
    expect(source.match(/\.delete\(/g)).toBeNull();
  });
});

describe("多候选去重的提示词与解析", () => {
  function client(reply: string, seen: { system: string }): LLMClient {
    const llm = new LLMClient({
      apiKey: "test-key-not-a-real-credential",
      model: "qwen-turbo",
      baseURL: "http://127.0.0.1:9",
      timeoutMs: 1_000,
    });
    (llm as unknown as { chat: (system: string, user: string) => Promise<string | null> }).chat = async (system) => {
      seen.system = system;
      return reply;
    };
    return llm;
  }

  const CANDIDATES = [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", text: "甲：一条已有记忆" },
    { id: "bbbbbbbb-0000-4000-8000-000000000002", text: "乙：另一条已有记忆" },
  ];

  it("模型照旧返回 actions 也不会被带出来", async () => {
    const seen = { system: "" };
    const llm = client(
      JSON.stringify({ action: "CREATE", match_index: 1, reason: "不同的事", actions: [{ match_index: 2, action: "delete", reason: "被新记忆取代" }] }),
      seen,
    );
    const decision = await llm.dedupDecisionMulti("一条新进来的切片", CANDIDATES);
    expect(decision.action).toBe("CREATE");
    expect(decision.reason).toBe("不同的事");
    expect(Object.keys(decision).sort()).toEqual(["action", "reason"]);
  });

  it("提示词不再给模型删除已有记忆的能力", async () => {
    const seen = { system: "" };
    const llm = client(JSON.stringify({ action: "SKIP", match_index: 1, reason: "同一件事" }), seen);
    await llm.dedupDecisionMulti("一条新进来的切片", CANDIDATES);
    expect(seen.system).toContain("CREATE");
    expect(seen.system).not.toContain("删除");
    expect(seen.system).not.toContain("actions");
    expect(seen.system.toLowerCase()).not.toContain("delete");
  });
});
