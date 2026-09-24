import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuditLogger } from "../audit-log.js";
import { withLock } from "../distill-lock.js";
import { buildIngestedEntry, normalizeDedupText, smartExtractBatch } from "../ingest.js";
import {
  applyMemoryReconcile,
  collectCurrentChunks,
  decideGuardAlert,
  DEFAULT_MAX_RETIRE_FLOOR,
  ForgetWatcher,
  GUARD_ALERT_INTERVAL_MS,
  guardStatePath,
  loadMemoryScopeRows,
  MEMORY_DOC_SCOPE,
  planMemoryReconcile,
  reconcileMemoryDocuments,
  resolveMaxRetire,
  rowState,
  undoMemoryReconcile,
  type CurrentChunk,
  type ExistingRow,
} from "../memory-reconcile.js";
import { deterministicId, MemoryStore, type MemoryEntry } from "../store.js";

/**
 * 记忆文件对账（2026-09-24）。方案与三方互审：sync-bridge AI产出/2026-09-24-recallnest-文档切片不下架/。
 * 前半是规划的纯函数用例（合成行，不碰库）；后半在临时目录里用真实 LanceDB 跑完整的
 * 插入 → 恢复 → 下架、提交时核对、护栏、锁、撤销。
 */

// ---------------------------------------------------------------------------
// 规划（纯函数）
// ---------------------------------------------------------------------------

function chunk(file: string, text: string): CurrentChunk {
  return { file, idx: 0, heading: "h", text, norm: normalizeDedupText(text) };
}

function row(id: string, text: string, opts: {
  status?: string;
  note?: string | null;
  consolidatedInto?: string | null;
  reconcileAction?: string;
  file?: string;
  accessCount?: number;
  timestamp?: number;
  doc?: boolean;
} = {}): ExistingRow {
  const meta: Record<string, unknown> = {
    file: opts.file ?? "a.md",
    evolution: {
      status: opts.status ?? "active",
      evolutionNote: opts.note ?? null,
      consolidatedInto: opts.consolidatedInto ?? null,
      accessCount: opts.accessCount ?? 0,
    },
  };
  if (opts.doc !== false) {
    meta.source = "memory";
    meta.boundary = { authority: "document-ingest" };
  } else {
    meta.source = "manual";
  }
  if (opts.reconcileAction) meta.reconcile = { action: opts.reconcileAction };
  return { id, scope: MEMORY_DOC_SCOPE, text, timestamp: opts.timestamp ?? 1, meta };
}

const T = (n: number) => `这是第 ${n} 段现行文字，长度足够形成一个切片，用来测试对账。`;
const OLD = (n: number) => `这是第 ${n} 段旧版文字，现行文件里已经没有了，应该被下架。`;

function plan(current: CurrentChunk[], existing: ExistingRow[], extra: { files?: string[]; forgotten?: string[]; external?: Array<[string, string]> } = {}) {
  return planMemoryReconcile({
    current,
    currentFileNames: new Set(extra.files ?? [...new Set(current.map((c) => c.file))]),
    existing,
    forgottenIds: new Set(extra.forgotten ?? []),
    externalStatus: new Map(extra.external ?? []),
  });
}

describe("planMemoryReconcile", () => {
  it("现行文本有一条活跃行：保留，不动", () => {
    const p = plan([chunk("a.md", T(1))], [row("k1", T(1))]);
    expect(p.keep).toBe(1);
    expect(p.insert).toHaveLength(0);
    expect(p.retire).toHaveLength(0);
    expect(p.reactivate).toHaveLength(0);
  });

  it("旧版切片按原因下架：文件还在 / 文件已删 / 冲突副本", () => {
    const p = plan([chunk("a.md", T(1))], [
      row("k1", T(1)),
      row("o1", OLD(1), { file: "a.md" }),
      row("o2", OLD(2), { file: "gone.md" }),
      row("o3", OLD(3), { file: "a.sync-conflict-20260901-123456-ABCDEFG.md" }),
    ], { files: ["a.md", "a.sync-conflict-20260901-123456-ABCDEFG.md"] });
    const byId = Object.fromEntries(p.retire.map((r) => [r.id, r.reason]));
    expect(byId).toEqual({ o1: "not-in-current-files", o2: "orphan-file", o3: "sync-conflict-file" });
  });

  it("同文多条活跃行：留原文逐字相同的那条，其余文档切片下架", () => {
    const exact = T(1);
    const spaced = `  ${T(1)}  `; // 规范化后相同、原文不同
    const p = plan([chunk("a.md", exact)], [row("spaced", spaced, { accessCount: 9 }), row("exact", exact)]);
    expect(p.retire.map((r) => [r.id, r.reason])).toEqual([["spaced", "duplicate-text"]]);
  });

  it("同文多条活跃行且原文都不逐字相同：留访问多的，再比时间早的", () => {
    const p1 = plan([chunk("a.md", T(1))], [row("x", ` ${T(1)}`, { accessCount: 1 }), row("y", `${T(1)} `, { accessCount: 5 })]);
    expect(p1.retire.map((r) => r.id)).toEqual(["x"]);
    const p2 = plan([chunk("a.md", T(1))], [row("x", ` ${T(1)}`, { timestamp: 5 }), row("y", `${T(1)} `, { timestamp: 2 })]);
    expect(p2.retire.map((r) => r.id)).toEqual(["x"]);
  });

  it("不是文档切片的行（手动写入等）永不下架，哪怕文本不在现行文件里", () => {
    const p = plan([chunk("a.md", T(1))], [row("k1", T(1)), row("manual", OLD(1), { doc: false })]);
    expect(p.retire).toHaveLength(0);
  });

  it("库里没有的现行文本：插入，id 是确定性 id", () => {
    const p = plan([chunk("a.md", T(1)), chunk("a.md", T(2))], [row("k1", T(1))]);
    expect(p.insert.map((i) => i.id)).toEqual([deterministicId(MEMORY_DOC_SCOPE, T(2))]);
  });

  it("合并链完好（目标活跃、本轮不下架）：算已有代表，不插不恢复", () => {
    const p = plan([chunk("a.md", T(1)), chunk("a.md", T(2))], [
      row("target", T(2)),
      row("member", T(1), { status: "consolidated", consolidatedInto: "target" }),
    ]);
    expect(p.representedByConsolidation).toBe(1);
    expect(p.insert).toHaveLength(0);
    expect(p.reactivate).toHaveLength(0);
  });

  it("合并目标在别的 scope 且活跃：同样算完好", () => {
    const p = plan([chunk("a.md", T(1))], [row("member", T(1), { status: "consolidated", consolidatedInto: "elsewhere" })], { external: [["elsewhere", "active"]] });
    expect(p.representedByConsolidation).toBe(1);
  });

  it("合并目标本轮要被下架：恢复被合并的那一行，并标明链是本轮断的（互审 C1）", () => {
    const p = plan([chunk("a.md", T(1))], [
      row("target", OLD(1)),
      row("member", T(1), { status: "consolidated", consolidatedInto: "target" }),
    ]);
    expect(p.retire.map((r) => r.id)).toEqual(["target"]);
    expect(p.reactivate).toEqual([expect.objectContaining({ id: "member", kind: "broken-consolidation", targetRetiredThisRun: true })]);
  });

  it("合并目标早已不活跃或不存在：恢复，且不算本轮断的", () => {
    const p = plan([chunk("a.md", T(1)), chunk("a.md", T(2))], [
      row("gone-target-member", T(1), { status: "consolidated", consolidatedInto: "missing" }),
      row("archived-target", OLD(9), { status: "archived" }),
      row("member2", T(2), { status: "consolidated", consolidatedInto: "archived-target" }),
    ]);
    expect(p.reactivate.map((r) => [r.id, r.targetRetiredThisRun])).toEqual([["gone-target-member", false], ["member2", false]]);
  });

  it("对账下架过、文本又回到现行文件：恢复那一行，不另插", () => {
    const p = plan([chunk("a.md", T(1))], [row("r1", T(1), { status: "archived", note: "memory-reconcile: not-in-current-files", reconcileAction: "retired" })]);
    expect(p.reactivate).toEqual([expect.objectContaining({ id: "r1", kind: "reconcile-retired" })]);
    expect(p.insert).toHaveLength(0);
  });

  it("forget 过的文本：不补回，也不恢复同文的对账下架行（forget 判定排在恢复之前）", () => {
    const text = T(1);
    const p = plan([chunk("a.md", text)], [
      row("r-spaced", ` ${text}`, { status: "archived", note: "memory-reconcile: duplicate-text", reconcileAction: "retired" }),
    ], { forgotten: [deterministicId(MEMORY_DOC_SCOPE, text)] });
    expect(p.exceptionForgotten).toBe(1);
    expect(p.reactivate).toHaveLength(0);
    expect(p.insert).toHaveLength(0);
  });

  it("带 forgotten: 标记还没删掉的行：同样按 forget 处理", () => {
    const p = plan([chunk("a.md", T(1))], [row("f1", T(1), { status: "archived", note: "forgotten: user asked" })]);
    expect(p.exceptionForgotten).toBe(1);
    expect(p.insert).toHaveLength(0);
  });

  it("只剩被别的机制下架的同文行（GC 归档等）：不推翻，也不另插（例外②）", () => {
    const p = plan([chunk("a.md", T(1))], [row("gc1", T(1), { status: "archived" }), row("sup", ` ${T(1)}`, { status: "superseded" })]);
    expect(p.exceptionOtherInactive).toBe(1);
    expect(p.exceptionOtherInactiveIds.sort()).toEqual(["gc1", "sup"]);
    expect(p.insert).toHaveLength(0);
    expect(p.reactivate).toHaveLength(0);
  });

  it("统计：活跃文档切片数与涉及文件数只算活跃的文档切片", () => {
    const p = plan([chunk("a.md", T(1))], [
      row("k1", T(1), { file: "a.md" }),
      row("o1", OLD(1), { file: "b.md" }),
      row("gc", OLD(2), { file: "c.md", status: "archived" }),
      row("manual", OLD(3), { file: "d.md", doc: false }),
    ]);
    expect(p.activeDocRows).toBe(2);
    expect(p.filesWithActiveDocRows).toBe(2);
  });
});

describe("resolveMaxRetire", () => {
  const saved = process.env.RECALLNEST_MEMORY_RECONCILE_MAX_RETIRE;
  afterAll(() => {
    if (saved === undefined) delete process.env.RECALLNEST_MEMORY_RECONCILE_MAX_RETIRE;
    else process.env.RECALLNEST_MEMORY_RECONCILE_MAX_RETIRE = saved;
  });

  it("默认 max(300, 活跃文档切片的 25%)；显式参数优先于环境变量", () => {
    delete process.env.RECALLNEST_MEMORY_RECONCILE_MAX_RETIRE;
    expect(resolveMaxRetire(100)).toBe(DEFAULT_MAX_RETIRE_FLOOR);
    expect(resolveMaxRetire(3229)).toBe(808);
    process.env.RECALLNEST_MEMORY_RECONCILE_MAX_RETIRE = "50";
    expect(resolveMaxRetire(3229)).toBe(50);
    expect(resolveMaxRetire(3229, 6000)).toBe(6000);
    process.env.RECALLNEST_MEMORY_RECONCILE_MAX_RETIRE = "";
    expect(resolveMaxRetire(3229)).toBe(808);
  });
});

describe("ForgetWatcher", () => {
  it("只读新追加的完整行；半行等写完再算；文件变短就从头重读", () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-forget-watch-"));
    try {
      const path = join(dir, "audit.jsonl");
      const ev = (id: string, scope = MEMORY_DOC_SCOPE) => JSON.stringify({ operation: "forget", scope, memoryId: id, actor: "manual" });
      writeFileSync(path, `${ev("a")}\n${ev("x", "cc:foo")}\n${JSON.stringify({ operation: "store", scope: MEMORY_DOC_SCOPE, memoryId: "s" })}\n`);
      const w = new ForgetWatcher(path);
      expect([...w.ids]).toEqual(["a"]);
      const half = ev("b");
      appendFileSync(path, half.slice(0, 20));
      expect([...w.refresh()]).toEqual(["a"]);
      appendFileSync(path, `${half.slice(20)}\n`);
      expect([...w.refresh()].sort()).toEqual(["a", "b"]);
      truncateSync(path, 0);
      writeFileSync(path, `${ev("c")}\n`);
      expect([...w.refresh()].sort()).toEqual(["a", "b", "c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decideGuardAlert", () => {
  it("同一原因 24 小时内只报一次；原因变了立刻报；护栏解除清掉状态", () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-guard-"));
    try {
      const cap = { reason: "cap" as const, detail: "x" };
      expect(decideGuardAlert(dir, cap, 1_000)).toBe(true);
      expect(decideGuardAlert(dir, cap, 2_000)).toBe(false);
      expect(decideGuardAlert(dir, { reason: "insert-failed", detail: "y" }, 3_000)).toBe(true);
      expect(decideGuardAlert(dir, { reason: "insert-failed", detail: "y" }, 3_000 + GUARD_ALERT_INTERVAL_MS)).toBe(true);
      expect(decideGuardAlert(dir, null, 5_000)).toBe(false);
      expect(existsSync(guardStatePath(dir))).toBe(false);
      expect(decideGuardAlert(dir, cap, 6_000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 真实 LanceDB
// ---------------------------------------------------------------------------

function vec(text: string): number[] {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [1, (h % 97) / 97 + 0.01, ((h >> 7) % 89) / 89 + 0.01];
}

interface Env {
  root: string;
  dataDir: string;
  memDir: string;
  store: MemoryStore;
  embedder: { embedBatchPassage(texts: string[]): Promise<number[][]> };
  auditPath: string;
  auditLogger: ReturnType<typeof createAuditLogger>;
}

describe("memory-reconcile 真实 LanceDB", () => {
  const tmpDirs: string[] = [];
  let originalDataDir: string | undefined;

  beforeAll(() => {
    originalDataDir = process.env.RECALLNEST_DATA_DIR;
  });
  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
    else process.env.RECALLNEST_DATA_DIR = originalDataDir;
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  let env: Env;
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "rn-reconcile-"));
    tmpDirs.push(root);
    const dataDir = join(root, "data");
    const memDir = join(root, "memory");
    mkdirSync(dataDir);
    mkdirSync(memDir);
    // 锁按 RECALLNEST_DATA_DIR 解析（distill-lock.ts locksDir），与对账的 dataDir 指向同一处
    process.env.RECALLNEST_DATA_DIR = dataDir;
    const auditPath = join(dataDir, "audit.jsonl");
    env = {
      root,
      dataDir,
      memDir,
      store: new MemoryStore({ dbPath: join(dataDir, "lancedb"), vectorDim: 3 }),
      embedder: { embedBatchPassage: async (texts: string[]) => texts.map(vec) },
      auditPath,
      auditLogger: createAuditLogger(auditPath),
    };
  });

  // parseMarkdown 只收正文超过 30 个字符的小节，统一补一句凑够长度
  const PAD = "（这一句只为凑够切片的最小长度。）";
  function writeMem(file: string, sections: Array<[string, string]>): void {
    writeFileSync(join(env.memDir, file), sections.map(([h, body]) => `## ${h}\n\n${body}${PAD}\n`).join("\n"));
  }

  function chunksOf(file: string): CurrentChunk[] {
    return collectCurrentChunks(env.memDir).chunks.filter((c) => c.file === file);
  }

  async function seed(rows: Array<{ text: string; file: string; scope?: string }>): Promise<string[]> {
    const extractions = await smartExtractBatch(rows.map((r) => r.text), null);
    await env.store.storeBatch(rows.map((r, i) => {
      const scope = r.scope ?? MEMORY_DOC_SCOPE;
      const built = buildIngestedEntry({ source: "memory", scope, text: r.text, vector: vec(r.text), extraction: extractions[i], file: r.file, heading: "h" });
      return { ...built, category: built.category as MemoryEntry["category"] };
    }));
    return rows.map((r) => deterministicId(r.scope ?? MEMORY_DOC_SCOPE, r.text));
  }

  async function patch(id: string, fn: (meta: Record<string, unknown>) => void): Promise<void> {
    await env.store.patchMetadataBatch([{ id, patchFn: (meta) => { fn(meta); return meta; } }]);
  }

  function setEvolution(meta: Record<string, unknown>, evo: Record<string, unknown>): void {
    const current = meta.evolution && typeof meta.evolution === "object" ? (meta.evolution as Record<string, unknown>) : {};
    meta.evolution = { ...current, ...evo };
  }

  async function metaOf(id: string): Promise<Record<string, unknown>> {
    const entry = await env.store.getById(id);
    expect(entry).not.toBeNull();
    return JSON.parse(entry!.metadata) as Record<string, unknown>;
  }

  async function stateOf(id: string) {
    return rowState(await metaOf(id));
  }

  function run(opts: { apply?: boolean; maxRetire?: number; embedder?: Env["embedder"]; explicitPath?: boolean; memDir?: string } = {}) {
    return reconcileMemoryDocuments({
      store: env.store,
      embedder: opts.embedder ?? env.embedder,
      llm: null,
      auditLogger: env.auditLogger,
      memDir: opts.memDir ?? env.memDir,
      dataDir: env.dataDir,
      explicitPath: opts.explicitPath ?? true,
      apply: opts.apply ?? true,
      maxRetire: opts.maxRetire,
    });
  }

  function journalLines(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /** 端到端场景：各类情形各一段，返回相关 id */
  async function buildScenario() {
    writeMem("a.md", [["Keep", "这一段一直没改过，库里已有同文的活跃切片，应当原样保留。"], ["New", "这一段是新写的，库里还没有，应当插入一条新切片。"]]);
    writeMem("b.md", [
      ["Reverted", "这一段曾被改掉、后来又改回来了，库里有一条对账下架过的同文切片。"],
      ["Chained", "这一段在库里只剩一条被 dream 合并进旧版切片的行，合并目标会被下架。"],
      ["GcArchived", "这一段在库里只有一条被 GC 归档的同文行，对账不推翻它。"],
    ]);
    const [keep, fresh] = chunksOf("a.md");
    const [reverted, chained, gcArchived] = chunksOf("b.md");
    const oldA = "[Keep] 这一段是 a.md 的旧版本，现行文件里已经没有了，应当被下架。";
    const oldTarget = "[Chained] 这一段是 dream 合并时选中的旧版代表，现行文件里已经没有了。";
    const orphan = "[Gone] 这个切片来自一个已经删掉的文件，应当按 orphan-file 下架。";
    const [keepId, oldAId, revertedId, chainedId, targetId, gcId, orphanId] = await seed([
      { text: keep.text, file: "a.md" },
      { text: oldA, file: "a.md" },
      { text: reverted.text, file: "b.md" },
      { text: chained.text, file: "b.md" },
      { text: oldTarget, file: "b.md" },
      { text: gcArchived.text, file: "b.md" },
      { text: orphan, file: "gone.md" },
    ]);
    const [pivotId] = await seed([{ text: oldA, file: "a.md", scope: "memory:pivot" }]);
    await patch(revertedId, (m) => {
      setEvolution(m, { status: "archived", evolutionNote: "memory-reconcile: not-in-current-files", validUntil: 123 });
      m.reconcile = { v: 1, action: "retired", reason: "not-in-current-files" };
    });
    await patch(chainedId, (m) => setEvolution(m, { status: "consolidated", consolidatedInto: targetId }));
    await patch(gcId, (m) => setEvolution(m, { status: "archived" }));
    return { keep, fresh, reverted, chained, gcArchived, keepId, oldAId, revertedId, chainedId, targetId, gcId, orphanId, pivotId, freshId: deterministicId(MEMORY_DOC_SCOPE, fresh.text) };
  }

  it("前提：种进去的行与旧导入写出的同形（source memory、document-ingest）", async () => {
    const [id] = await seed([{ text: "[X] 一段足够长的文字，用来确认种子行的元数据形状和旧导入一致。", file: "x.md" }]);
    const meta = await metaOf(id);
    expect(meta.source).toBe("memory");
    expect((meta.boundary as Record<string, unknown>).authority).toBe("document-ingest");
  });

  it("端到端：插入 → 恢复 → 下架各就各位，第二轮无事可做", async () => {
    const s = await buildScenario();
    const pivotBefore = (await env.store.getById(s.pivotId))!.metadata;
    const keepBefore = (await env.store.getById(s.keepId))!.metadata;

    const out = await run();
    expect(out.ran).toBe(true);
    expect(out.guard).toBeNull();
    expect(out.alert).toBe(false);
    expect(out.applied).toMatchObject({ inserted: 1, reactivatedReconcileRetired: 1, reactivatedBrokenConsolidation: 1, retired: 3, retireSkippedStateChanged: 0, reactivateSkippedStateChanged: 0 });
    expect(out.plan!.exceptionOtherInactive).toBe(1);

    const fresh = await metaOf(s.freshId);
    expect(rowState(fresh).status).toBe("active");
    expect((fresh.reconcile as Record<string, unknown>).action).toBe("inserted");
    expect(fresh.file).toBe("a.md");
    expect((fresh.boundary as Record<string, unknown>).authority).toBe("document-ingest");

    expect(await stateOf(s.revertedId)).toMatchObject({ status: "active", evolutionNote: null, reconcileAction: "reactivated" });
    const chained = await metaOf(s.chainedId);
    expect(rowState(chained)).toMatchObject({ status: "active", consolidatedInto: null, reconcileAction: "reactivated" });
    expect(((chained.reconcile as Record<string, unknown>).prev as Record<string, unknown>).consolidatedInto).toBe(s.targetId);

    for (const [id, reason] of [[s.oldAId, "not-in-current-files"], [s.targetId, "not-in-current-files"], [s.orphanId, "orphan-file"]] as const) {
      expect(await stateOf(id)).toMatchObject({ status: "archived", evolutionNote: `memory-reconcile: ${reason}`, reconcileAction: "retired" });
    }
    expect(await stateOf(s.gcId)).toMatchObject({ status: "archived", reconcileAction: null });
    expect((await env.store.getById(s.keepId))!.metadata).toBe(keepBefore);
    expect((await env.store.getById(s.pivotId))!.metadata).toBe(pivotBefore);

    // 日志按「插入 → 恢复 → 下架」的顺序落（互审 N3）
    const lines = journalLines(out.journalPath!).filter((l) => typeof l.action === "string");
    const lastOf = (a: string) => lines.map((l) => l.action).lastIndexOf(a);
    const firstOf = (a: string) => lines.map((l) => l.action).indexOf(a);
    expect(lastOf("insert")).toBeLessThan(firstOf("reactivate"));
    expect(lastOf("reactivate")).toBeLessThan(firstOf("retire"));
    for (const l of lines.filter((x) => x.action !== "insert")) {
      expect(l.before).toBeDefined();
      expect(l.after).toBeDefined();
    }
    // 审计里每条下架有一条 archive 事件
    const audit = readFileSync(env.auditPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const archived = audit.filter((e) => e.operation === "archive" && String(e.details).startsWith("memory-reconcile:")).map((e) => e.memoryId);
    expect(archived.sort()).toEqual([s.oldAId, s.targetId, s.orphanId].sort());

    const again = await run();
    expect(again.applied).toMatchObject({ inserted: 0, retired: 0, reactivatedReconcileRetired: 0, reactivatedBrokenConsolidation: 0 });
    expect(again.plan!.keep).toBe(4);
  });

  it("只看计划（dry-run）不写库、不持锁、不留日志与护栏状态", async () => {
    const s = await buildScenario();
    const before = await loadMemoryScopeRows(env.store);
    await withLock("gc-run", async () => {
      const out = await run({ apply: false });
      expect(out.ran).toBe(true);
      expect(out.mode).toBe("dry-run");
      expect(out.plan!.insert).toHaveLength(1);
      expect(out.plan!.retire).toHaveLength(3);
    });
    const after = await loadMemoryScopeRows(env.store);
    expect(after.map((r) => [r.id, JSON.stringify(r.meta)]).sort()).toEqual(before.map((r) => [r.id, JSON.stringify(r.meta)]).sort());
    expect(existsSync(join(env.dataDir, "reconcile-journals"))).toBe(false);
    expect(existsSync(guardStatePath(env.dataDir))).toBe(false);
    expect(await env.store.getById(s.freshId)).toBeNull();
  });

  it("提交时状态已变的行跳过：规划后被 GC 归档的不再盖上对账标记，被别人恢复的不再动", async () => {
    const s = await buildScenario();
    const { chunks, fileNames } = collectCurrentChunks(env.memDir);
    const p = planMemoryReconcile({ current: chunks, currentFileNames: fileNames, existing: await loadMemoryScopeRows(env.store), forgottenIds: new Set() });
    await patch(s.oldAId, (m) => setEvolution(m, { status: "archived" })); // 模拟 GC：只改 status
    await patch(s.revertedId, (m) => setEvolution(m, { status: "active", evolutionNote: null }));
    const res = await applyMemoryReconcile({ store: env.store, embedder: env.embedder, llm: null, auditLogger: env.auditLogger }, p, { runId: "t", journalPath: null, retireAllowed: true });
    expect(res.retireSkippedStateChanged).toBe(1);
    expect(res.reactivateSkippedStateChanged).toBe(1);
    expect(await stateOf(s.oldAId)).toMatchObject({ status: "archived", evolutionNote: null, reconcileAction: null });
    expect(await stateOf(s.revertedId)).toMatchObject({ status: "active", reconcileAction: "retired" });
  });

  it("规划后别的写方先插了同一个 id：不覆盖（互审 C2 / K3）", async () => {
    const s = await buildScenario();
    const { chunks, fileNames } = collectCurrentChunks(env.memDir);
    const p = planMemoryReconcile({ current: chunks, currentFileNames: fileNames, existing: await loadMemoryScopeRows(env.store), forgottenIds: new Set() });
    await env.store.storeBatch([{ id: s.freshId, text: s.fresh.text, vector: vec(s.fresh.text), category: "facts", scope: MEMORY_DOC_SCOPE, importance: 0.5, metadata: JSON.stringify({ source: "someone-else", marker: 42 }) }]);
    const res = await applyMemoryReconcile({ store: env.store, embedder: env.embedder, llm: null }, p, { runId: "t", journalPath: null, retireAllowed: true });
    expect(res.inserted).toBe(0);
    expect(res.insertSkippedExisting).toBe(1);
    expect((await metaOf(s.freshId)).marker).toBe(42);
  });

  it("规划之后才 forget 的段落：插入前重读审计日志，不补回（互审 C3）", async () => {
    const s = await buildScenario();
    const watcher = new ForgetWatcher(env.auditPath);
    const { chunks, fileNames } = collectCurrentChunks(env.memDir);
    const p = planMemoryReconcile({ current: chunks, currentFileNames: fileNames, existing: await loadMemoryScopeRows(env.store), forgottenIds: new Set(watcher.ids) });
    expect(p.insert.map((i) => i.id)).toEqual([s.freshId]);
    env.auditLogger.log({ operation: "forget", scope: MEMORY_DOC_SCOPE, memoryId: s.freshId, actor: "manual", details: "forgotten after planning" });
    const res = await applyMemoryReconcile({ store: env.store, embedder: env.embedder, llm: null }, p, { runId: "t", journalPath: null, retireAllowed: true, forgetWatcher: watcher });
    expect(res.insertSkippedForgotten).toBe(1);
    expect(res.inserted).toBe(0);
    expect(await env.store.getById(s.freshId)).toBeNull();
  });

  it("下架超上限：只插入与恢复（因目标本轮下架而断的合并链不恢复），同因 24 小时内只报一次警", async () => {
    const s = await buildScenario();
    const out = await run({ maxRetire: 1 });
    expect(out.guard?.reason).toBe("cap");
    expect(out.alert).toBe(true);
    expect(out.applied).toMatchObject({ inserted: 1, reactivatedReconcileRetired: 1, reactivatedBrokenConsolidation: 0, retired: 0 });
    expect(await stateOf(s.chainedId)).toMatchObject({ status: "consolidated", consolidatedInto: s.targetId });
    expect((await stateOf(s.oldAId)).status).toBe("active");

    const again = await run({ maxRetire: 1 });
    expect(again.guard?.reason).toBe("cap");
    expect(again.alert).toBe(false);

    const released = await run({ maxRetire: 10 });
    expect(released.guard).toBeNull();
    expect(released.applied).toMatchObject({ retired: 3, reactivatedBrokenConsolidation: 1 });
    expect(existsSync(guardStatePath(env.dataDir))).toBe(false);
  });

  it("记忆目录明显不对（文件数不到有活跃切片的文件数一半）：整轮不写", async () => {
    await seed(["a", "b", "c", "d"].map((f) => ({ text: `[${f}] 这是 ${f}.md 的一段文字，足够长，用来构造有活跃切片的文件。`, file: `${f}.md` })));
    writeMem("only.md", [["Only", "目录里只剩这一个文件，看起来像是路径配错了，不能据此下架别的。"]]);
    const before = await loadMemoryScopeRows(env.store);
    const out = await run();
    expect(out.guard?.reason).toBe("dir-sanity");
    expect(out.alert).toBe(true);
    expect(out.applied).toBeNull();
    const after = await loadMemoryScopeRows(env.store);
    expect(after.map((r) => JSON.stringify(r.meta)).sort()).toEqual(before.map((r) => JSON.stringify(r.meta)).sort());
  });

  it("有段落嵌入失败：该文件的旧切片本轮不下架，别的文件照下，重复文本照下", async () => {
    writeMem("a.md", [["Fail", "FAILME 这一段嵌入会失败，所以 a.md 的旧切片这一轮不能下架。"], ["Dup", "这一段在库里有两条规范化后相同的活跃切片，多余的那条照下。"]]);
    writeMem("b.md", [["Fine", "b.md 这一段库里已经有了，b.md 的旧切片可以照常下架。"]]);
    const [, dup] = chunksOf("a.md");
    const [fine] = chunksOf("b.md");
    const [, oldAId, dupSpacedId, , oldBId] = await seed([
      { text: dup.text, file: "a.md" },
      { text: "[Fail] a.md 的旧版本，现行文件里没有了。", file: "a.md" },
      { text: `  ${dup.text}`, file: "a.md" },
      { text: fine.text, file: "b.md" },
      { text: "[Fine] b.md 的旧版本，现行文件里没有了。", file: "b.md" },
    ]);
    const failing = { embedBatchPassage: async (texts: string[]) => texts.map((t) => (t.includes("FAILME") ? [] : vec(t))) };
    const out = await run({ embedder: failing });
    expect(out.guard?.reason).toBe("insert-failed");
    expect(out.alert).toBe(true);
    expect(out.applied).toMatchObject({ inserted: 0, insertPending: 1, retireDeferredPendingInsert: 1, retired: 2 });
    expect((await stateOf(oldAId)).status).toBe("active");
    expect(await stateOf(dupSpacedId)).toMatchObject({ status: "archived", evolutionNote: "memory-reconcile: duplicate-text" });
    expect((await stateOf(oldBId)).status).toBe("archived");
  });

  it("整批嵌入抛错：记为待插入，不下架任何非重复切片", async () => {
    const s = await buildScenario();
    const throwing = { embedBatchPassage: async () => { throw new Error("embedding api down"); } };
    const out = await run({ embedder: throwing });
    expect(out.guard?.reason).toBe("insert-failed");
    expect(out.applied!.insertErrors[0]).toContain("embedding api down");
    // a.md 有待插入段落 → a.md 的旧切片不下；b.md 与已删文件的照下
    expect((await stateOf(s.oldAId)).status).toBe("active");
    expect((await stateOf(s.targetId)).status).toBe("archived");
    expect((await stateOf(s.orphanId)).status).toBe("archived");
  });

  it("dream 合并或 GC 正在跑（锁被占用）：整轮跳过，不写", async () => {
    const s = await buildScenario();
    for (const key of ["consolidate-memory", "gc-run", "memory-reconcile"]) {
      let out: Awaited<ReturnType<typeof run>> | undefined;
      await withLock(key, async () => {
        out = await run();
      });
      expect(out!.ran).toBe(false);
      expect(out!.skippedReason).toContain(key);
    }
    expect(await env.store.getById(s.freshId)).toBeNull();
    expect((await stateOf(s.oldAId)).status).toBe("active");
    // 锁都放掉了：再跑一次能正常执行
    expect((await run()).ran).toBe(true);
  });

  it("撤销：按日志逐条写回，后做的先撤；期间被改过的跳过", async () => {
    const s = await buildScenario();
    const before = {
      oldA: await stateOf(s.oldAId),
      reverted: await stateOf(s.revertedId),
      chained: await stateOf(s.chainedId),
    };
    const out = await run();
    // 撤销前，别的写方又动了一条被下架的行
    await patch(s.orphanId, (m) => setEvolution(m, { status: "active" }));

    const undo = await undoMemoryReconcile({ store: env.store, auditLogger: env.auditLogger }, out.journalPath!);
    expect(undo.restored).toBe(4); // oldA、target 两条下架 + 两条恢复
    expect(undo.insertsRetired).toBe(1);
    expect(undo.skippedConflict).toEqual([s.orphanId]);
    expect(existsSync(undo.undoJournalPath)).toBe(true);

    expect(await stateOf(s.oldAId)).toMatchObject({ status: before.oldA.status, evolutionNote: null, reconcileAction: null });
    expect(await stateOf(s.revertedId)).toMatchObject(before.reverted);
    expect(await stateOf(s.chainedId)).toMatchObject(before.chained);
    expect(await stateOf(s.freshId)).toMatchObject({ status: "archived", evolutionNote: "memory-reconcile: undo-insert" });
    expect((await stateOf(s.orphanId)).status).toBe("active");
  });

  it("不是显式路径 / 目录不存在：拒绝执行", async () => {
    await expect(run({ explicitPath: false })).rejects.toThrow("显式配置");
    await expect(run({ memDir: join(env.root, "nope") })).rejects.toThrow("记忆目录不存在");
  });

  it("入库文本先脱敏（F-3b），id 按脱敏后的文本算，与旧导入一致", async () => {
    const fakeToken = `gh${"p"}_${"A".repeat(24)}`;
    writeMem("s.md", [["Secret", `这一段里夹着一个看起来像令牌的串 ${fakeToken}，入库前必须脱敏。`]]);
    const out = await run();
    expect(out.applied!.inserted).toBe(1);
    const [c] = chunksOf("s.md");
    expect(c.text).toContain("[REDACTED");
    expect(c.text).not.toContain(fakeToken);
    const stored = await env.store.getById(deterministicId(MEMORY_DOC_SCOPE, c.text));
    expect(stored!.text).toBe(c.text);
    expect(readdirSync(env.memDir)).toEqual(["s.md"]);
  });
});
