/**
 * 会话账本（memory:ledger）与手写提炼池（memory:pivot）不被 `memory` 家族的批处理卷进去（P1 互审 R3）。
 *
 * - MCP consolidate_memories 与 dream 共用 neverDreamScopes 策略：名单里的 scope 不合并，家族匹配时排除名单里的兄弟
 *   （Codex NEW-2：独立入口构造引擎没传 excludeScopes，scope=memory 会把账本改成 consolidated）
 * - 两种晋升扫描在 listLimit 生效之前就排除这两个 scope（Codex NEW-3：2000 条更新的账本把合格候选挤到名额外）
 *
 * 用的 mock store 认 scope、认家族 / 精确、认 excludeScopes、按新近取前 limit 条——漏传排除会真的红。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consolidationScopePolicy, DEFAULT_DREAM_CONFIG } from "../dream-pipeline.js";
import { runToolSafely } from "../error-taxonomy.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import type { ToolRegistryDeps } from "../mcp-tool-deps.js";
import { MIN_PROMOTABLE_CONTRACT_VERSION, PROMOTION_SCAN_EXCLUDED_SCOPES, promotionScanExcludes, scanMemoryPromotions, scanSynthesisPromotions, type PromoteScanDeps, type SynthesisPromoteScanDeps } from "../memory-promotion.js";
import { cosineSimilarity } from "../multi-vector.js";
import { matchesScopeFilter, type ScopeMatchMode } from "../scope-policy.js";
import type { MemoryEntry } from "../store.js";

let prevDataDir: string | undefined;
beforeAll(() => {
  // consolidate_memories apply=true 拿 consolidate-<scope> 锁：落到临时数据目录，不进仓库的 data/locks
  prevDataDir = process.env.RECALLNEST_DATA_DIR;
  process.env.RECALLNEST_DATA_DIR = mkdtempSync(join(tmpdir(), "rn-ledger-excl-data-"));
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = prevDataDir;
});

function entry(over: Partial<MemoryEntry> & { id: string; scope: string }): MemoryEntry {
  return {
    text: `text-${over.id}`,
    vector: [1, 0, 0],
    category: "events",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: JSON.stringify({ evolution: { status: "active", accessCount: 0 } }),
    ...over,
  } as MemoryEntry;
}

/** 认 scope / 模式 / 排除、按 timestamp 新的在前取前 limit 条；记下每一行被取出过、被改过 */
function scopeAwareStore(rows: MemoryEntry[]) {
  const stored = rows.map((e) => ({ ...e }));
  const seen = new Set<string>();
  const patched: string[] = [];
  const select = (scopeFilter?: string[], mode: ScopeMatchMode = "family", excludeScopes?: string[]) =>
    stored.filter((e) => matchesScopeFilter(e.scope, scopeFilter, mode) && !(excludeScopes ?? []).includes(e.scope)).sort((a, b) => b.timestamp - a.timestamp);
  const mark = <T extends { id: string }>(xs: T[]) => { for (const x of xs) seen.add(x.id); return xs; };
  const store = {
    async list(scopeFilter?: string[], category?: string, limit = 20, offset = 0, scopeMatch: ScopeMatchMode = "family", excludeScopes?: string[]) {
      return mark(select(scopeFilter, scopeMatch, excludeScopes).filter((e) => !category || e.category === category).slice(offset, offset + limit).map((e) => ({ ...e, vector: [] as number[] })));
    },
    async getById(id: string) {
      return stored.find((e) => e.id === id) ?? null;
    },
    async vectorSearch(vec: number[], limit = 5, minScore = 0.3, scopeFilter?: string[], scopeMatch: ScopeMatchMode = "family", excludeScopes?: string[]) {
      const hits = select(scopeFilter, scopeMatch, excludeScopes).filter((e) => e.vector?.length).map((e) => ({ entry: e, score: cosineSimilarity(vec, e.vector) })).filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score).slice(0, limit);
      mark(hits.map((h) => h.entry));
      return hits;
    },
    async update(id: string, upd: Partial<MemoryEntry>) {
      const e = stored.find((x) => x.id === id);
      if (e && upd.metadata) { patched.push(id); e.metadata = upd.metadata; }
      return e ?? null;
    },
    async patchMetadataBatch(patches: Array<{ id: string; patchFn: (m: Record<string, unknown>, e: MemoryEntry) => Record<string, unknown> }>) {
      let n = 0;
      for (const { id, patchFn } of patches) {
        const e = stored.find((x) => x.id === id);
        if (!e) continue;
        patched.push(id);
        e.metadata = JSON.stringify(patchFn(JSON.parse(e.metadata || "{}") as Record<string, unknown>, e));
        n++;
      }
      return n;
    },
  };
  return { store, stored, seen, patched };
}

interface ToolResult { content: Array<{ type: string; text: string }>; isError?: boolean }

function consolidateTool(store: unknown): (args: Record<string, unknown>) => Promise<ToolResult> {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  const deps = {
    registerTool: (name: string, _d: unknown, _s: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => { if (name === "consolidate_memories") handler = h; },
    getComponents: () => ({ store }),
    getKGStore: () => null,
    getKGExtractor: () => null,
  } as unknown as ToolRegistryDeps;
  registerGovernanceTools(deps);
  const h = handler as ((args: Record<string, unknown>) => Promise<unknown>) | null;
  if (!h) throw new Error("consolidate_memories 没注册");
  return (args) => runToolSafely("consolidate_memories", async () => h(args)) as Promise<ToolResult>;
}

/** memory 行两两几乎重合（会被合并）；账本与 pivot 行同样几乎重合、而且和 memory 行也近 */
function seededRows(): MemoryEntry[] {
  const near = (i: number) => [1, 0.001 * i, 0];
  return [
    ...[0, 1, 2].map((i) => entry({ id: `mem-${i}`, scope: "memory", vector: near(i) })),
    ...[0, 1, 2].map((i) => entry({ id: `ledger-${i}`, scope: "memory:ledger", vector: near(i + 3) })),
    ...[0, 1, 2].map((i) => entry({ id: `pivot-${i}`, scope: "memory:pivot", vector: near(i + 6) })),
  ];
}
const args = { clusterThreshold: 0.82, mergeThreshold: 0.92, maxEntries: 500 };

describe("MCP consolidate_memories 与 dream 同一套 scope 策略（R3 Codex NEW-2）", () => {
  it("scope=memory 预览：账本与 pivot 行一行都不被取出来", async () => {
    const s = scopeAwareStore(seededRows());
    const r = await consolidateTool(s.store)({ scope: "memory", ...args, apply: false });
    expect(r.isError).toBeFalsy();
    expect([...s.seen].filter((id) => !id.startsWith("mem-"))).toEqual([]);
    expect([...s.seen].some((id) => id.startsWith("mem-"))).toBe(true);
    expect(s.patched).toEqual([]);
  });

  it("scope=memory 执行：只合并 memory 行，账本与 pivot 行的 metadata 一个字都不改", async () => {
    const s = scopeAwareStore(seededRows());
    const before = new Map(s.stored.map((e) => [e.id, e.metadata]));
    const r = await consolidateTool(s.store)({ scope: "memory", ...args, apply: true });
    expect(r.content[0].text).toContain("Consolidation complete");
    expect(s.patched.filter((id) => !id.startsWith("mem-"))).toEqual([]);
    expect(s.patched.some((id) => id.startsWith("mem-"))).toBe(true);
    for (const e of s.stored) if (!e.id.startsWith("mem-")) expect(e.metadata).toBe(before.get(e.id)!);
  });

  it("scope 本身在 neverDreamScopes 里（memory:ledger / memory:pivot / checkpoint）：直接跳过，不取数", async () => {
    for (const scope of DEFAULT_DREAM_CONFIG.neverDreamScopes) {
      const s = scopeAwareStore(seededRows());
      const r = await consolidateTool(s.store)({ scope, ...args, apply: true });
      expect(r.content[0].text).toContain("never consolidated");
      expect(s.seen.size).toBe(0);
      expect(s.patched).toEqual([]);
    }
  });

  it("consolidationScopePolicy：家族匹配排除兄弟，精确匹配不排除；名单里的 scope 本身判 excluded", () => {
    expect(consolidationScopePolicy("memory")).toEqual({ excluded: false, familyExcludes: ["memory:pivot", "checkpoint", "memory:ledger"] });
    expect(consolidationScopePolicy("memory", "exact").familyExcludes).toEqual([]);
    expect(consolidationScopePolicy("memory:ledger").excluded).toBe(true);
    expect(consolidationScopePolicy("project:x")).toEqual({ excluded: false, familyExcludes: ["memory:pivot", "checkpoint", "memory:ledger"] });
  });
});

describe("晋升扫描在取数名额生效之前排除账本与 pivot（R3 Codex NEW-3）", () => {
  const synth = (): MemoryEntry => entry({
    id: "syn-good",
    scope: "memory",
    text: "换机交接的失败都同一个形状：脏工作区被当成临时状态，真相源迁走后它变成常态",
    category: "patterns",
    importance: 0.85,
    timestamp: Date.parse("2026-08-20T00:00:00.000Z"),
    metadata: JSON.stringify({
      evolution: { status: "active", version: 1, accessCount: 0 },
      cluster_insight: true,
      boundary: { layer: "evidence", authority: "distillation", conflictPolicy: "append-only", originalCategory: "patterns", note: "Dream-synthesized derivative" },
      synthesis_contract: MIN_PROMOTABLE_CONTRACT_VERSION,
      evidenceMemories: ["ev-alpha", "ev-beta"],
    }),
  });
  const evidence = ["ev-alpha", "ev-beta"].map((id, i) => entry({ id, scope: "memory", text: `第 ${i + 1} 次踩坑：换机没 push`, timestamp: Date.parse("2026-08-19T00:00:00.000Z") }));

  function deps(rows: MemoryEntry[]): SynthesisPromoteScanDeps {
    const s = scopeAwareStore(rows);
    return { store: s.store as unknown as SynthesisPromoteScanDeps["store"], promote: async () => { throw new Error("dry-run 不该写"); } };
  }

  it("2000 条更新的账本 + 2000 条更新的 pivot：合格的合成候选照样扫得到", async () => {
    const newer = Date.parse("2026-10-20T00:00:00.000Z");
    const ledger = Array.from({ length: 2000 }, (_, i) => entry({ id: `ledger-${i}`, scope: "memory:ledger", timestamp: newer + i }));
    const pivot = Array.from({ length: 2000 }, (_, i) => entry({ id: `pivot-${i}`, scope: "memory:pivot", timestamp: newer + i }));
    const baseline = await scanSynthesisPromotions(deps([synth(), ...evidence]), "memory", { dryRun: true });
    expect(baseline.candidates).toHaveLength(1);
    const crowded = await scanSynthesisPromotions(deps([synth(), ...evidence, ...ledger, ...pivot]), "memory", { dryRun: true });
    expect(crowded.candidates).toHaveLength(1);
    expect(crowded.candidates[0].seedId).toBe("syn-good");
  });

  it("降级证据扫描（events）同样不被 2000 条更新的账本挤掉", async () => {
    const downgraded = (i: number) => entry({
      id: `dg-${i}`,
      scope: "memory",
      text: `偏好提示 ${i}`,
      timestamp: Date.parse("2026-08-01T00:00:00.000Z") + i,
      metadata: JSON.stringify({ boundary: { layer: "evidence", authority: "transcript-ingest", conflictPolicy: "append-only", originalCategory: "preferences", downgradedFrom: "preferences" }, evolution: { status: "active", accessCount: 0 } }),
    });
    const newer = Date.parse("2026-10-20T00:00:00.000Z");
    const ledger = Array.from({ length: 2000 }, (_, i) => entry({ id: `ledger-${i}`, scope: "memory:ledger", timestamp: newer + i }));
    const s = scopeAwareStore([downgraded(0), downgraded(1), downgraded(2), ...ledger]);
    const d: PromoteScanDeps = {
      store: { list: s.store.list, getVectors: async (ids: string[]) => new Map(ids.map((id) => [id, [1, 0, 0]])) } as unknown as PromoteScanDeps["store"],
      promote: async () => { throw new Error("dry-run 不该写"); },
    };
    const r = await scanMemoryPromotions(d, "memory", { dryRun: true });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].occurrences).toBe(3);
  });

  it("排除名单：扫描的 scope 本身就是名单里的那个时不排除它", () => {
    expect([...PROMOTION_SCAN_EXCLUDED_SCOPES]).toEqual(["memory:ledger", "memory:pivot"]);
    expect(promotionScanExcludes("memory")).toEqual(["memory:ledger", "memory:pivot"]);
    expect(promotionScanExcludes("memory:pivot")).toEqual(["memory:ledger"]);
  });
});
