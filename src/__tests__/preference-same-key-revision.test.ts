import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStructuredMetadata, persistMemory } from "../capture-engine.js";
import { normalizeCanonicalKey } from "../memory-boundaries.js";
import { parseEvolution } from "../memory-evolution.js";
import { MemoryStore, deterministicId } from "../store.js";

/**
 * 显式同 key 修订偏好（2026-09-24）。
 *
 * 真实入口（MCP store_memory、HTTP /v1/store）调 persistMemory 不传 llm，Tier 3.6 判重在
 * 相似度 ≥0.92 时直接跳过——调用方带着同一个 canonicalKey 改写本 scope 已有的偏好，新版因此丢掉。
 * 修法：本 scope 已有同 key 同类别活跃行时跳过判重，由 writeDurableEntry 对这一行做全文判等与原位替换。
 * 计划与三方互审留档：sync-bridge/AI产出/2026-09-24-recallnest-同key偏好修订/（用例编号对应 plan.md §4）。
 *
 * 「进没进判重」看替身 vectorSearch 记下的 minScore：写入路径里只有 matcher 用 0.78
 * （F2 干扰预警 0.82、A-2 0.85），所以出现过 0.78 = 走了 Tier 3.6。
 */

const SCOPE = "project:revision-test";
const OTHER_SCOPE = "project:revision-other";
const KEY = "user.reply.style";
const OTHER_KEY = "user.editor.theme";
const MATCHER_MIN_SCORE = 0.78;
const F2_MIN_SCORE = 0.82;

const V1 = "User prefers long, thorough replies written as full paragraphs, with examples and a short summary at the end";
// V1 删掉一段：修订常见的形态，也是被判重吞掉最多的形态
const V2 = "User prefers long, thorough replies written as full paragraphs";

// 替身保留 any：MemoryStore 行形状的一部分由 store 自己补（timestamp 等），与 belief-history.test.ts 同写法
function createHarness(options: { withVectorSearch?: boolean; withConflictStore?: boolean; llmMode?: "SKIP" | "MERGE" } = {}) {
  const { withVectorSearch = true, withConflictStore = false, llmMode } = options;
  const rows: any[] = [];
  const hiddenFromList = new Set<string>();
  const vectorSearchMinScores: number[] = [];
  const counts = { list: 0, dedupDecision: 0, synthesizeFragments: 0 };
  const conflicts: any[] = [];
  const triggerCalls: Array<{ memoryId: string; texts: string[] }> = [];
  let clock = 1_700_000_000_000;

  const put = (row: any) => {
    const index = rows.findIndex((item) => item.id === row.id);
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  };

  const store: Record<string, unknown> = {
    async store(entry: any) {
      clock += 1;
      const stored = {
        ...entry,
        id: entry.id ?? deterministicId(entry.scope, entry.text),
        timestamp: clock,
        metadata: entry.metadata || "{}",
      };
      put(stored);
      return { ...stored };
    },
    async upsert(entry: any) {
      put({ ...entry });
      return entry;
    },
    // 与真实 store.list 一致：整表按 timestamp 倒序后再截断（src/store.ts:784），不带向量。
    // hiddenFromList 模拟「被挤出最近 CANONICAL_SCAN_LIMIT 行的扫描窗口」；getById 照样查得到。
    async list(_scopeFilter?: string[], category?: string, limit = 20, offset = 0) {
      counts.list += 1;
      return rows
        .filter((row) => !hiddenFromList.has(row.id))
        .filter((row) => !category || row.category === category)
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((row) => ({ ...row, vector: [] }))
        .slice(offset, offset + limit);
    },
    async getById(id: string) {
      const row = rows.find((item) => item.id === id);
      return row ? { ...row } : null;
    },
    async update(id: string, updates: any) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return null;
      rows[index] = { ...rows[index], ...updates, timestamp: updates.timestamp ?? rows[index].timestamp };
      return { ...rows[index] };
    },
  };

  if (withVectorSearch) {
    // 分数一律 0.95：只要走进 matcher 且本 scope 有活跃偏好候选，无 LLM 分支必判 skip（≥0.92）。
    store.vectorSearch = async (_vector: number[], limit: number, minScore: number, scopes?: string[]) => {
      vectorSearchMinScores.push(minScore);
      return rows
        .filter((row) => !scopes || scopes.includes(row.scope))
        .slice(0, limit)
        .map((row) => ({ entry: { ...row }, score: 0.95 }));
    };
  }

  const deps: Record<string, unknown> = {
    store,
    embedder: {
      async embedPassage(text: string) {
        return [text.length, 1, 0];
      },
    },
    noisePrototypeBank: null,
    triggerStore: {
      async upsertForMemory(memoryId: string, _scope: string, texts: readonly string[]) {
        triggerCalls.push({ memoryId, texts: [...texts] });
        return texts.length;
      },
    },
  };

  if (withConflictStore) {
    deps.conflictStore = {
      async save(record: any) {
        conflicts.push(record);
        return record;
      },
      async replace(record: any) {
        const index = conflicts.findIndex((item) => item.conflictId === record.conflictId);
        if (index >= 0) conflicts[index] = record;
        else conflicts.push(record);
        return record;
      },
      async getOpenByFingerprint(fingerprint: string) {
        return conflicts.find((item) => item.status === "open" && item.fingerprint === fingerprint) || null;
      },
      async getLatestByFingerprint(fingerprint: string) {
        return conflicts.find((item) => item.fingerprint === fingerprint) || null;
      },
    };
  }

  if (llmMode) {
    deps.llm = {
      async assessImportance() {
        return null;
      },
      async dedupDecision() {
        counts.dedupDecision += 1;
        return { action: llmMode, reason: "stub" };
      },
      async synthesizeFragments() {
        counts.synthesizeFragments += 1;
        return "merged by stub";
      },
      async generateCoreSummary() {
        return null;
      },
    };
  }

  async function write(text: string, extra: Record<string, unknown> = {}) {
    return await persistMemory(deps as any, {
      text,
      category: "preferences",
      scope: SCOPE,
      source: "manual",
      canonicalKey: KEY,
      ...(llmMode ? { importance: 0.8 } : {}),
      ...extra,
    });
  }

  /** 直接放一行 durable 活跃记录（用来造 persistMemory 造不出来的历史状态，比如同 key 不同 id）。 */
  function seed(row: { id: string; text: string; category: string; scope: string; canonicalKey: string }) {
    clock += 1;
    rows.push({
      id: row.id,
      text: row.text,
      vector: [row.text.length, 1, 0],
      category: row.category,
      scope: row.scope,
      importance: 0.7,
      timestamp: clock,
      metadata: buildStructuredMetadata({
        source: "manual",
        tags: [],
        capture: "test_seed",
        category: row.category as any,
        canonicalKey: normalizeCanonicalKey(row.canonicalKey),
      }),
    });
  }

  function find(id: string) {
    return rows.find((row) => row.id === id);
  }

  function resetProbes() {
    vectorSearchMinScores.length = 0;
    counts.list = 0;
    counts.dedupDecision = 0;
    counts.synthesizeFragments = 0;
  }

  return {
    deps,
    rows,
    hiddenFromList,
    counts,
    conflicts,
    triggerCalls,
    write,
    seed,
    find,
    resetProbes,
    enteredMatcher: () => vectorSearchMinScores.includes(MATCHER_MIN_SCORE),
    enteredF2: () => vectorSearchMinScores.includes(F2_MIN_SCORE),
  };
}

function metadataWithout(metadata: string, field: string): Record<string, unknown> {
  const parsed = JSON.parse(metadata) as Record<string, unknown>;
  delete parsed[field];
  return parsed;
}

describe("显式同 key 修订偏好：跳过 Tier 3.6，走版本链（无 LLM，与 MCP / HTTP 同形）", () => {
  it("T1 本 scope 已有同 key 行、新文本删掉一段 → 原位更新，旧版进历史，不进判重", async () => {
    const h = createHarness();
    const first = await h.write(V1);
    expect(first.disposition).toBe("stored");
    h.resetProbes();

    const revised = await h.write(V2);

    expect(revised.disposition).toBe("updated");
    expect(revised.id).toBe(first.id);
    expect(h.find(first.id).text).toBe(V2);
    expect(parseEvolution(h.find(first.id).metadata).version).toBe(2);

    const history = h.rows.filter((row) => row.id !== first.id);
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe(V1);
    expect(parseEvolution(history[0].metadata).status).toBe("superseded");
    expect(parseEvolution(history[0].metadata).supersededBy).toBe(first.id);
    expect(h.enteredMatcher()).toBe(false);
  });

  it("T3 同 key、新文本与旧文本规范化后全等、不带 triggers → deduped，目标行 metadata 逐字不变", async () => {
    const h = createHarness();
    const first = await h.write(V1);
    const before = JSON.stringify(h.find(first.id));
    h.resetProbes();

    const again = await h.write(`   ${V1.toUpperCase()}   `);

    expect(again.disposition).toBe("deduped");
    expect(again.id).toBe(first.id);
    expect(h.rows).toHaveLength(1);
    expect(JSON.stringify(h.find(first.id))).toBe(before);
    expect(h.enteredMatcher()).toBe(false);
  });

  it("T3b 同 T3 但带 triggers → deduped，正文与版本链不变，metadata 只有 triggers 字段变化（既有回填）", async () => {
    const h = createHarness();
    const first = await h.write(V1);
    const before = h.find(first.id);
    const beforeEvo = parseEvolution(before.metadata);

    const again = await h.write(V1, { triggers: ["她喜欢什么样的回复", "回复写多长合适"] });

    expect(again.disposition).toBe("deduped");
    const after = h.find(first.id);
    expect(after.text).toBe(V1);
    const afterEvo = parseEvolution(after.metadata);
    expect(afterEvo.version).toBe(beforeEvo.version);
    expect(afterEvo.supersedes).toBe(beforeEvo.supersedes);
    expect(afterEvo.supersededBy).toBe(beforeEvo.supersededBy);
    expect(JSON.parse(after.metadata).triggers).toEqual(["她喜欢什么样的回复", "回复写多长合适"]);
    expect(metadataWithout(after.metadata, "triggers")).toEqual(metadataWithout(before.metadata, "triggers"));
    expect(h.triggerCalls.map((call) => call.memoryId)).toEqual([first.id]);
  });

  it("T3c 同 key 全文相同、本 scope 另有 5 条相近活跃行 → deduped 且不进 F2，任何一行的 metadata 都不变", async () => {
    // 原版在 Tier 3.6 就返回，这类写入碰不到 F2；修订路径若放它走到 F2，替身里 6 条相近活跃行会让 F2
    // 把最弱一条标 pending_review（实施后 Codex 审查在真实临时库复现）。
    const h = createHarness();
    const first = await h.write(V1);
    for (let i = 0; i < 5; i++) {
      h.seed({
        id: deterministicId(SCOPE, `seed-${i}`),
        text: `User prefers replies variant ${i} with worked examples and a closing summary`,
        category: "preferences",
        scope: SCOPE,
        canonicalKey: `user.reply.variant.${i}`,
      });
    }
    const before = JSON.stringify(h.rows);
    h.resetProbes();

    const again = await h.write(V1);

    expect(again.disposition).toBe("deduped");
    expect(again.id).toBe(first.id);
    expect(JSON.stringify(h.rows)).toBe(before);
    expect(h.enteredF2()).toBe(false);
    expect(h.enteredMatcher()).toBe(false);
  });

  it("T4 显式新 key（本 scope 无同 key 行）、与已有偏好相似 → 照旧判重", async () => {
    const h = createHarness();
    await h.write(V1, { canonicalKey: OTHER_KEY });
    h.resetProbes();

    const result = await h.write(V2, { canonicalKey: "user.reply.length" });

    expect(result.disposition).toBe("deduped");
    expect(h.enteredMatcher()).toBe(true);
  });

  it("T5 不带显式 key 的近重复 → 照旧判重", async () => {
    const h = createHarness();
    await h.write(V1, { canonicalKey: OTHER_KEY });
    h.resetProbes();

    const result = await h.write(V2, { canonicalKey: undefined });

    expect(result.disposition).toBe("deduped");
    expect(h.enteredMatcher()).toBe(true);
  });

  it("T6 同 key 活跃行只在别的 scope → 照旧判重，别的 scope 那行逐字不变", async () => {
    const h = createHarness();
    const elsewhere = await h.write(V1, { scope: OTHER_SCOPE });
    await h.write("User prefers a dark editor theme with high contrast colours", { canonicalKey: OTHER_KEY });
    const elsewhereBefore = JSON.stringify(h.find(elsewhere.id));
    h.resetProbes();

    const result = await h.write(V2);

    expect(result.disposition).toBe("deduped");
    expect(h.enteredMatcher()).toBe(true);
    expect(JSON.stringify(h.find(elsewhere.id))).toBe(elsewhereBefore);
  });

  it("T7 本 scope 同 key 行的类别不是 preferences → 照旧判重", async () => {
    const h = createHarness();
    await h.write("Reply style guide maintained by the user for all projects", { category: "entities" });
    await h.write("User prefers a dark editor theme with high contrast colours", { canonicalKey: OTHER_KEY });
    h.resetProbes();

    const result = await h.write(V2);

    expect(result.disposition).toBe("deduped");
    expect(h.enteredMatcher()).toBe(true);
  });

  it("T8a 同 key 行在扫描窗口外、全文相同 → deduped，版本号、supersedes 与 metadata 逐字不变", async () => {
    const h = createHarness();
    const first = await h.write(V1);
    await h.write(V2); // 先修订一次，让版本链非平凡（version 2、supersedes 指向历史行）
    h.hiddenFromList.add(first.id);
    const before = JSON.stringify(h.find(first.id));
    const rowCount = h.rows.length;
    h.resetProbes();

    const again = await h.write(V2);

    expect(again.disposition).toBe("deduped");
    expect(again.id).toBe(first.id);
    expect(h.rows).toHaveLength(rowCount);
    expect(JSON.stringify(h.find(first.id))).toBe(before);
    expect(parseEvolution(h.find(first.id).metadata).version).toBe(2);
    expect(h.enteredMatcher()).toBe(false);
  });

  it("T8b 同 key 行在扫描窗口外、文本不同 → updated，历史行存在，版本号 +1", async () => {
    const h = createHarness();
    const first = await h.write(V1);
    h.hiddenFromList.add(first.id);
    const beforeVersion = parseEvolution(h.find(first.id).metadata).version;
    h.resetProbes();

    const revised = await h.write(V2);

    expect(revised.disposition).toBe("updated");
    expect(revised.id).toBe(first.id);
    const live = h.find(first.id);
    expect(live.text).toBe(V2);
    const liveEvo = parseEvolution(live.metadata);
    expect(liveEvo.version).toBe(beforeVersion + 1);
    const history = h.find(liveEvo.supersedes as string);
    expect(history.text).toBe(V1);
    expect(parseEvolution(history.metadata).status).toBe("superseded");
    expect(parseEvolution(history.metadata).supersededBy).toBe(first.id);
    expect(h.enteredMatcher()).toBe(false);
  });

  it("T9 A、B 两个 scope 都有同 key 行（B 更新）→ 只改 A；A 写成 B 的原文也照样改 A，不被 B 判重", async () => {
    const h = createHarness();
    // 两行直接放：经 persistMemory 在 B 写同 key，会被写入端不分 scope 的同 key 匹配落到 A 行上
    // （既有缺陷，挂 open-loops「writeDurableEntry 同 key 匹配不分 scope」，本轮不修），这个状态只能造出来。
    const aId = deterministicId(SCOPE, normalizeCanonicalKey(KEY));
    const bId = deterministicId(OTHER_SCOPE, normalizeCanonicalKey(KEY));
    const bText = "Scope B: user prefers terse bullet lists in replies";
    h.seed({ id: aId, text: "Scope A: user prefers replies in full narrative paragraphs", category: "preferences", scope: SCOPE, canonicalKey: KEY });
    h.seed({ id: bId, text: bText, category: "preferences", scope: OTHER_SCOPE, canonicalKey: KEY });
    const bBefore = JSON.stringify(h.find(bId));

    const revised = await h.write("Scope A: user prefers replies in short narrative paragraphs");
    expect(revised.disposition).toBe("updated");
    expect(revised.id).toBe(aId);
    expect(h.find(aId).text).toBe("Scope A: user prefers replies in short narrative paragraphs");
    expect(JSON.stringify(h.find(bId))).toBe(bBefore);

    const copied = await h.write(bText);
    expect(copied.disposition).toBe("updated");
    expect(copied.id).toBe(aId);
    expect(h.find(aId).text).toBe(bText);
    expect(JSON.stringify(h.find(bId))).toBe(bBefore);
  });

  it("T11a 同 scope 同 key 同时有 preferences 行与其他类别活跃行 → 不当修订，同文输入照旧返回 conflict", async () => {
    const h = createHarness({ withVectorSearch: false, withConflictStore: true });
    const prefId = deterministicId(SCOPE, normalizeCanonicalKey(KEY));
    h.seed({ id: prefId, text: V1, category: "preferences", scope: SCOPE, canonicalKey: KEY });
    h.seed({ id: "11111111-1111-4111-8111-111111111111", text: "Reply style guide entity", category: "entities", scope: SCOPE, canonicalKey: KEY });
    const prefBefore = JSON.stringify(h.find(prefId));

    const result = await h.write(V1);

    expect(result.disposition).toBe("conflict");
    expect(h.conflicts).toHaveLength(1);
    expect(JSON.stringify(h.find(prefId))).toBe(prefBefore);
  });

  it("T11b 同上的历史状态、有 vectorSearch → 照旧进判重，不走修订", async () => {
    const h = createHarness({ withConflictStore: true });
    const prefId = deterministicId(SCOPE, normalizeCanonicalKey(KEY));
    h.seed({ id: prefId, text: V1, category: "preferences", scope: SCOPE, canonicalKey: KEY });
    h.seed({ id: "11111111-1111-4111-8111-111111111111", text: "Reply style guide entity", category: "entities", scope: SCOPE, canonicalKey: KEY });

    await h.write(V2);

    expect(h.enteredMatcher()).toBe(true);
    expect(h.find(prefId).text).toBe(V1);
  });
});

describe("T12 扫描次数：显式 key 的偏好写入只扫一遍整表", () => {
  it("修订、目标在扫描窗口内 → 1 次", async () => {
    const h = createHarness();
    await h.write(V1);
    h.resetProbes();
    const revised = await h.write(V2);
    expect(revised.disposition).toBe("updated");
    expect(h.counts.list).toBe(1);
  });

  it("新 key 走 CREATE（有 vectorSearch）→ 1 次", async () => {
    const h = createHarness();
    const created = await h.write(V1);
    expect(created.disposition).toBe("stored");
    expect(h.counts.list).toBe(1);
  });

  it("新 key 走 CREATE（无 vectorSearch）→ 1 次", async () => {
    const h = createHarness({ withVectorSearch: false });
    const created = await h.write(V1);
    expect(created.disposition).toBe("stored");
    expect(h.counts.list).toBe(1);
  });

  it("修订、目标在扫描窗口外经 getById 命中 → 1 次", async () => {
    const h = createHarness();
    const first = await h.write(V1);
    h.hiddenFromList.add(first.id);
    h.resetProbes();
    const revised = await h.write(V2);
    expect(revised.disposition).toBe("updated");
    expect(h.counts.list).toBe(1);
  });
});

describe("带 LLM 的调用方：修订同样不交给 LLM 判重", () => {
  it("T1-L dedupDecision 会判 SKIP 的替身 → 仍原位更新，LLM 判重与合成都没被调用", async () => {
    const h = createHarness({ llmMode: "SKIP" });
    const first = await h.write(V1);
    h.resetProbes();

    const revised = await h.write(V2);

    expect(revised.disposition).toBe("updated");
    expect(revised.id).toBe(first.id);
    expect(h.find(first.id).text).toBe(V2);
    expect(h.counts.dedupDecision).toBe(0);
    expect(h.counts.synthesizeFragments).toBe(0);
  });

  it("T2-L dedupDecision 会判 MERGE 的替身 → 仍原位更新为新原文（不是合成文本）", async () => {
    const h = createHarness({ llmMode: "MERGE" });
    const first = await h.write(V1);
    h.resetProbes();

    const revised = await h.write(V2);

    expect(revised.disposition).toBe("updated");
    expect(h.find(first.id).text).toBe(V2);
    expect(h.counts.dedupDecision).toBe(0);
    expect(h.counts.synthesizeFragments).toBe(0);
  });
});

describe("T10 真实 LanceDB（临时目录，不碰生产库）", () => {
  const tmpDirs: string[] = [];
  let originalDataDir: string | undefined;

  beforeAll(() => {
    // 锁文件按 RECALLNEST_DATA_DIR 解析（distill-lock.ts locksDir），隔离到临时目录
    originalDataDir = process.env.RECALLNEST_DATA_DIR;
    process.env.RECALLNEST_DATA_DIR = mkdtempSync(join(tmpdir(), "rn-same-key-datadir-"));
    tmpDirs.push(process.env.RECALLNEST_DATA_DIR);
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
    else process.env.RECALLNEST_DATA_DIR = originalDataDir;
    while (tmpDirs.length > 0) {
      try {
        rmSync(tmpDirs.pop()!, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  afterEach(() => {
    // 各用例的库目录在这里清；datadir 留到 afterAll
    while (tmpDirs.length > 1) {
      try {
        rmSync(tmpDirs.pop()!, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function makeDeps() {
    const dir = mkdtempSync(join(tmpdir(), "rn-same-key-db-"));
    tmpDirs.push(dir);
    // 库放子目录：store 把活动计数写在库目录旁边（store.ts activityStatsPath），这样也落在临时目录里
    const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
    const deps = {
      store,
      embedder: {
        async embedPassage(text: string) {
          return [1, (text.length % 7) + 1, 0.5];
        },
      },
      noisePrototypeBank: null,
    };
    return { store, deps };
  }

  function write(deps: unknown, text: string, scope = SCOPE) {
    return persistMemory(deps as any, { text, category: "preferences", scope, source: "manual", canonicalKey: KEY });
  }

  it("目标被 1000+ 条更新的行挤出扫描窗口：同文重存 deduped 且版本链不变，异文原位修订、版本号 +1", async () => {
    const { store, deps } = makeDeps();
    const first = await write(deps, V1);
    expect(first.disposition).toBe("stored");

    await Bun.sleep(5);
    await store.storeBatch(
      Array.from({ length: 1005 }, (_, i) => ({
        text: `filler row ${i} for pushing the target out of the canonical scan window`,
        vector: [0, 0, 1],
        category: "events" as const,
        scope: "project:filler",
        importance: 0.3,
        metadata: "{}",
      })),
    );
    // 前提自检：目标确实不在最近 1000 行里，否则这条用例测的不是窗口外
    const window = await store.list(undefined, undefined, 1000, 0);
    expect(window.some((entry) => entry.id === first.id)).toBe(false);

    const before = await store.getById(first.id);
    const again = await write(deps, V1);
    expect(again.disposition).toBe("deduped");
    expect(again.id).toBe(first.id);
    const afterDedup = await store.getById(first.id);
    expect(afterDedup!.metadata).toBe(before!.metadata);

    const revised = await write(deps, V2);
    expect(revised.disposition).toBe("updated");
    expect(revised.id).toBe(first.id);
    const live = await store.getById(first.id);
    expect(live!.text).toBe(V2);
    const liveEvo = parseEvolution(live!.metadata);
    expect(liveEvo.version).toBe(parseEvolution(before!.metadata).version + 1);
    const history = await store.getById(liveEvo.supersedes as string);
    expect(history!.text).toBe(V1);
    expect(parseEvolution(history!.metadata).status).toBe("superseded");
    expect(parseEvolution(history!.metadata).supersededBy).toBe(first.id);
  }, 60_000);

  it("本 scope 另有 5 条相近活跃行时，同 key 全文重存不进 F2：6 行的 metadata 全部逐字不变", async () => {
    const { store } = makeDeps();
    // 所有文本同一个向量：F2（≥0.82、≥5 条）若被放进来必定出手
    const deps = { store, embedder: { async embedPassage() { return [1, 0, 0]; } }, noisePrototypeBank: null };
    const first = await write(deps, V1);
    expect(first.disposition).toBe("stored");
    for (let i = 0; i < 5; i++) {
      await store.store({
        id: deterministicId(SCOPE, `seed-${i}`),
        text: `User prefers replies variant ${i} with worked examples and a closing summary`,
        vector: [1, 0, 0],
        category: "preferences",
        scope: SCOPE,
        importance: 0.7,
        metadata: buildStructuredMetadata({
          source: "manual",
          tags: [],
          capture: "test_seed",
          category: "preferences",
          canonicalKey: normalizeCanonicalKey(`user.reply.variant.${i}`),
        }),
      });
    }
    const snapshot = async () =>
      JSON.stringify((await store.list([SCOPE], undefined, 100, 0)).map((entry) => [entry.id, entry.metadata]).sort());
    const before = await snapshot();

    const again = await write(deps, V1);

    expect(again.disposition).toBe("deduped");
    expect(again.id).toBe(first.id);
    expect(await snapshot()).toBe(before);
  }, 60_000);

  it("两个 scope 写同 key：修订其中一个，另一个逐字不变；写成另一个的原文也不被它判重", async () => {
    const { store, deps } = makeDeps();
    const a = await write(deps, "Scope A: user prefers replies in full narrative paragraphs", SCOPE);
    expect(a.disposition).toBe("stored");
    // B 行直接落库，理由同 T9：经 persistMemory 写 B 会落到 A 行上（既有缺陷，本轮不修）
    const bText = "Scope B: user prefers terse bullet lists in replies";
    const b = await store.store({
      id: deterministicId(OTHER_SCOPE, normalizeCanonicalKey(KEY)),
      text: bText,
      vector: [1, 2, 0.5],
      category: "preferences",
      scope: OTHER_SCOPE,
      importance: 0.7,
      metadata: buildStructuredMetadata({
        source: "manual",
        tags: [],
        capture: "test_seed",
        category: "preferences",
        canonicalKey: normalizeCanonicalKey(KEY),
      }),
    });
    const bBefore = await store.getById(b.id);

    const revised = await write(deps, "Scope A: user prefers replies in short narrative paragraphs", SCOPE);
    expect(revised.disposition).toBe("updated");
    expect(revised.id).toBe(a.id);

    const copied = await write(deps, bText, SCOPE);
    expect(copied.disposition).toBe("updated");
    expect(copied.id).toBe(a.id);
    expect((await store.getById(a.id))!.text).toBe(bText);

    const bAfter = await store.getById(b.id);
    expect(bAfter!.text).toBe(bBefore!.text);
    expect(bAfter!.metadata).toBe(bBefore!.metadata);
  }, 60_000);
});
