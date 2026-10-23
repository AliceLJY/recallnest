import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuditLogger } from "../audit-log.js";
import { withLock } from "../distill-lock.js";
import { DEFAULT_DREAM_CONFIG } from "../dream-pipeline.js";
import {
  collectLedgerChunks,
  LEDGER_DOC_SCOPE,
  LEDGER_DOC_SOURCE,
  ledgerSections,
  listLedgerFiles,
  parseLedgerMarkdown,
} from "../ledger-docs.js";
import {
  collectCurrentChunks,
  guardStatePath,
  loadMemoryScopeRows,
  MEMORY_DOC_SCOPE,
  reconcileMemoryDocuments,
  rowState,
  undoMemoryReconcile,
} from "../memory-reconcile.js";
import { MemoryStore } from "../store.js";

/**
 * 会话账本的对账源（P1 ①，2026-10-23）。P0 沙箱实测记忆文件对账只认目录顶层 *.md，
 * `ledgers/YYYY-MM/<sid8>.md` 不进计划；这里钉住：账本递归收集、按节切片带出处头、
 * 进自己的 scope memory:ledger，和记忆文件对账互不下架对方的行，改写 / 删除 / 撤销照常。
 */

function ledgerMd(opts: { session?: string; source?: string; ended?: string; title?: string; solved?: string[]; unfinished?: string[]; decisions?: string[]; errors?: string[]; failure?: string } = {}): string {
  const session = opts.session ?? "abcd1234-0000-4000-8000-000000000001";
  const list = (xs: string[] | undefined) => (xs && xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- （无）");
  return [
    "---",
    `session: ${session}`,
    `source: ${opts.source ?? "cc"}`,
    "machine: null",
    `started: "2026-10-20T01:00:00.000Z"`,
    `ended: "${opts.ended ?? "2026-10-21T02:00:00.000Z"}"`,
    "trigger: auto-sweep",
    "pass: 1",
    "---",
    "",
    `# ${opts.title ?? "修好对账只认顶层的问题"}`,
    "",
    `## 解决了什么\n${list(opts.solved ?? ["对账改成按源递归读账本目录"])}`,
    "",
    `## 决定与否决\n${list(opts.decisions)}`,
    "",
    "## 经验（待确认）\n- （无）",
    "",
    `## 没做完\n${list(opts.unfinished ?? ["复测无声场"])}`,
    "",
    `## 报错（机器抽取，${opts.errors?.length ?? 0} 条）\n${list(opts.errors)}`,
    "",
    "## 当场写过的记忆（机器抽取）\n- checkpoint_session ×1",
    ...(opts.failure ? ["", `> 生成失败：${opts.failure}`] : []),
    "",
  ].join("\n");
}

describe("parseLedgerMarkdown / ledgerSections", () => {
  it("解析 frontmatter（含引号）、标题与各节", () => {
    const p = parseLedgerMarkdown(ledgerMd())!;
    expect(p.frontmatter.session).toBe("abcd1234-0000-4000-8000-000000000001");
    expect(p.frontmatter.ended).toBe("2026-10-21T02:00:00.000Z");
    expect(p.frontmatter.machine).toBe("");
    expect(p.title).toBe("修好对账只认顶层的问题");
    expect(p.sections.map((s) => s.heading)).toEqual(["解决了什么", "决定与否决", "经验（待确认）", "没做完", "报错（机器抽取，0 条）", "当场写过的记忆（机器抽取）"]);
  });

  it("不是账本形状（没有 frontmatter 或没有 session）返回 null", () => {
    expect(parseLedgerMarkdown("# README\n\n账本目录说明\n")).toBeNull();
    expect(parseLedgerMarkdown("---\ntitle: x\n---\n\n# x\n")).toBeNull();
  });

  it("只切有内容的节；跳过「当场写过的记忆」与空节；每片带出处头", () => {
    const secs = ledgerSections(parseLedgerMarkdown(ledgerMd({ decisions: ["不走 heartbeat 分叉"] }))!);
    expect(secs.map((s) => s.heading)).toEqual(["解决了什么", "决定与否决", "没做完"]);
    for (const s of secs) {
      expect(s.text.startsWith("【会话账本·机器生成｜2026-10-21｜cc｜abcd1234】修好对账只认顶层的问题\n## ")).toBe(true);
    }
    expect(secs[1].text).toContain("- 不走 heartbeat 分叉");
  });

  it("文末「> 生成失败」引用行不进切片；生成失败、正文都是（未生成）时只剩报错一节", () => {
    const md = ledgerMd({ solved: ["（未生成）"], unfinished: [], errors: ["Bash #3: exit code 2 ｜签名：ENOENT foo.json"], failure: "llm error: 429" });
    const secs = ledgerSections(parseLedgerMarkdown(md)!);
    expect(secs.map((s) => s.heading)).toEqual(["报错（机器抽取，1 条）"]);
    expect(secs[0].text).not.toContain("生成失败");
  });
});

describe("collectLedgerChunks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rn-ledger-docs-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("递归收集，文件名是相对路径；跳过点开头的目录；README 进文件名但不切片；sync-conflict 不切", () => {
    mkdirSync(join(dir, "2026-09"));
    mkdirSync(join(dir, "2026-10"));
    mkdirSync(join(dir, ".stversions"));
    writeFileSync(join(dir, "2026-09", "aaaa0001.md"), ledgerMd({ session: "aaaa0001-x" }));
    writeFileSync(join(dir, "2026-10", "bbbb0002.md"), ledgerMd({ session: "bbbb0002-x", ended: "2026-10-22T00:00:00.000Z" }));
    writeFileSync(join(dir, "2026-10", "bbbb0002.sync-conflict-20261022-000000-ABC.md"), ledgerMd({ session: "bbbb0002-x", solved: ["冲突副本"] }));
    writeFileSync(join(dir, ".stversions", "old.md"), ledgerMd({ session: "cccc0003-x" }));
    writeFileSync(join(dir, "README.md"), "# 账本目录\n");
    writeFileSync(join(dir, "2026-10", "note.txt"), "x");

    expect(listLedgerFiles(dir)).toEqual(["2026-09/aaaa0001.md", "2026-10/bbbb0002.md", "2026-10/bbbb0002.sync-conflict-20261022-000000-ABC.md", "README.md"]);
    const { chunks, fileNames } = collectLedgerChunks(dir);
    expect(fileNames.has("README.md")).toBe(true);
    expect([...new Set(chunks.map((c) => c.file))]).toEqual(["2026-09/aaaa0001.md", "2026-10/bbbb0002.md"]);
    expect(chunks.filter((c) => c.file === "2026-10/bbbb0002.md")[0].text).toContain("｜2026-10-22｜cc｜bbbb0002】");
    expect(chunks.some((c) => c.text.includes("冲突副本"))).toBe(false);
  });

  it("入库前脱敏", () => {
    mkdirSync(join(dir, "2026-10"), { recursive: true });
    const key = `sk-${"A1b2C3d4E5f6".repeat(4)}`;
    writeFileSync(join(dir, "2026-10", "dddd0004.md"), ledgerMd({ session: "dddd0004-x", solved: [`用 ${key} 调通了接口`] }));
    const { chunks } = collectLedgerChunks(dir);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.text.includes(key))).toBe(false);
  });

  it("记忆文件对账不读子目录（账本必须走自己的源）", () => {
    mkdirSync(join(dir, "ledgers", "2026-10"), { recursive: true });
    writeFileSync(join(dir, "ledgers", "2026-10", "eeee0005.md"), ledgerMd({ session: "eeee0005-x" }));
    expect(collectCurrentChunks(dir).fileNames.size).toBe(0);
    expect(collectLedgerChunks(join(dir, "ledgers")).chunks.length).toBeGreaterThan(0);
  });
});

describe("dream 不碰账本 scope", () => {
  it("memory:ledger 在 neverDreamScopes 里", () => {
    expect(DEFAULT_DREAM_CONFIG.neverDreamScopes).toContain(LEDGER_DOC_SCOPE);
  });
});

// ---------------------------------------------------------------------------
// 真实 LanceDB：账本源与记忆文件源各管各的 scope
// ---------------------------------------------------------------------------

function vec(text: string): number[] {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [1, (h % 97) / 97 + 0.01, ((h >> 7) % 89) / 89 + 0.01];
}

describe("账本对账 真实 LanceDB", () => {
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

  let root: string, dataDir: string, memDir: string, ledgerDir: string, store: MemoryStore, auditPath: string;
  const embedder = { embedBatchPassage: async (texts: string[]) => texts.map(vec) };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rn-ledger-reconcile-"));
    tmpDirs.push(root);
    dataDir = join(root, "data");
    memDir = join(root, "memory");
    ledgerDir = join(memDir, "ledgers");
    mkdirSync(dataDir);
    mkdirSync(join(ledgerDir, "2026-10"), { recursive: true });
    process.env.RECALLNEST_DATA_DIR = dataDir;
    auditPath = join(dataDir, "audit.jsonl");
    store = new MemoryStore({ dbPath: join(dataDir, "lancedb"), vectorDim: 3 });
    writeFileSync(join(memDir, "feedback_x.md"), "## 一条记忆\n\n改完当场提交推送，不攒到收尾再一起推，这一句只为凑够切片长度。\n");
  });

  function run(source: "memory" | "ledger", opts: { apply?: boolean } = {}) {
    return reconcileMemoryDocuments({
      store,
      embedder,
      llm: null,
      auditLogger: createAuditLogger(auditPath),
      memDir: source === "ledger" ? ledgerDir : memDir,
      dataDir,
      explicitPath: true,
      apply: opts.apply ?? true,
      source: source === "ledger" ? LEDGER_DOC_SOURCE : undefined,
    });
  }

  async function activeRows(scope: string) {
    return (await loadMemoryScopeRows(store, scope)).filter((r) => rowState(r.meta).status === "active");
  }

  it("账本进 memory:ledger、文件名是相对路径；记忆文件对账一行账本都不碰，反过来也一样", async () => {
    writeFileSync(join(ledgerDir, "2026-10", "abcd1234.md"), ledgerMd({ decisions: ["参数 CC idleMinutes=60"] }));
    const mem1 = await run("memory");
    expect(mem1.applied!.inserted).toBe(1);
    const led1 = await run("ledger");
    expect(led1.plan!.currentFiles).toBe(1);
    expect(led1.applied!.inserted).toBe(3); // 解决了什么 / 决定与否决 / 没做完
    const ledgerRows = await activeRows(LEDGER_DOC_SCOPE);
    expect(ledgerRows.length).toBe(3);
    for (const r of ledgerRows) {
      expect(r.meta.source).toBe(LEDGER_DOC_SCOPE);
      expect(r.meta.file).toBe("2026-10/abcd1234.md");
    }
    expect(led1.journalPath!.includes("ledger-reconcile-")).toBe(true);

    // 再各跑一轮：谁也不下架对方的行
    const mem2 = await run("memory");
    expect(mem2.plan!.retire.length).toBe(0);
    expect(mem2.plan!.insert.length).toBe(0);
    const led2 = await run("ledger");
    expect(led2.plan!.retire.length).toBe(0);
    expect(led2.plan!.insert.length).toBe(0);
    expect((await activeRows(MEMORY_DOC_SCOPE)).length).toBe(1);
    expect((await activeRows(LEDGER_DOC_SCOPE)).length).toBe(3);

    // 不带冒号按 memory 查（家族匹配）两种都出来；精确查 memory:ledger 只出账本
    const family = await store.listPage({ scopeFilter: [MEMORY_DOC_SCOPE], limit: 100 });
    expect(new Set(family.map((e) => e.scope))).toEqual(new Set([MEMORY_DOC_SCOPE, LEDGER_DOC_SCOPE]));
    const exact = await store.listPage({ scopeFilter: [LEDGER_DOC_SCOPE], scopeMatch: "exact", limit: 100 });
    expect(exact.every((e) => e.scope === LEDGER_DOC_SCOPE)).toBe(true);
  });

  it("账本改写（第二遍 pass）：变了的节插新片、旧片下架，没变的节保留", async () => {
    const file = join(ledgerDir, "2026-10", "abcd1234.md");
    writeFileSync(file, ledgerMd());
    await run("ledger");
    const before = await activeRows(LEDGER_DOC_SCOPE);
    const solvedId = before.find((r) => r.text.includes("## 解决了什么"))!.id;
    writeFileSync(file, ledgerMd({ unfinished: [], solved: ["对账改成按源递归读账本目录", "复测无声场做完"] }));
    const r = await run("ledger");
    expect(r.applied!.inserted).toBe(1);
    expect(r.applied!.retired).toBe(2); // 旧的「解决了什么」与「没做完」
    const after = await activeRows(LEDGER_DOC_SCOPE);
    expect(after.length).toBe(1);
    expect(after[0].id).not.toBe(solvedId);
    expect(after[0].text).toContain("复测无声场做完");
    const retired = (await loadMemoryScopeRows(store, LEDGER_DOC_SCOPE)).filter((x) => rowState(x.meta).status === "archived");
    expect(retired.map((x) => (x.meta.reconcile as Record<string, unknown>).reason).sort()).toEqual(["not-in-current-files", "not-in-current-files"]);
  });

  it("账本文件删掉：它的片以 orphan-file 下架；护栏状态与日志按源分开；按日志撤销用账本源", async () => {
    const keep = join(ledgerDir, "2026-10", "aaaa0001.md");
    const gone = join(ledgerDir, "2026-10", "bbbb0002.md");
    writeFileSync(keep, ledgerMd({ session: "aaaa0001-x" }));
    writeFileSync(gone, ledgerMd({ session: "bbbb0002-x", solved: ["另一场会话做成的事"] }));
    await run("ledger");
    rmSync(gone);
    const r = await run("ledger");
    expect(r.plan!.retire.every((x) => x.reason === "orphan-file" && x.file === "2026-10/bbbb0002.md")).toBe(true);
    expect(r.applied!.retired).toBe(2);
    expect((await activeRows(LEDGER_DOC_SCOPE)).length).toBe(2);

    const journals = readdirSync(join(dataDir, "reconcile-journals")).filter((f) => f.startsWith("ledger-reconcile-"));
    expect(journals.length).toBe(2);
    expect(existsSync(guardStatePath(dataDir, "memory-reconcile"))).toBe(false);

    const undo = await undoMemoryReconcile({ store, auditLogger: createAuditLogger(auditPath) }, r.journalPath!, { auditPath, source: LEDGER_DOC_SOURCE });
    expect(undo.restored).toBe(2);
    expect((await activeRows(LEDGER_DOC_SCOPE)).length).toBe(4);
    const audit = readFileSync(auditPath, "utf-8");
    expect(audit).toContain(`"scope":"${LEDGER_DOC_SCOPE}"`);
  });

  it("撤销账本插入时按 memory:ledger 查合并依赖：别的账本行合并进了它，就保留它（R1 Codex #6）", async () => {
    writeFileSync(join(ledgerDir, "2026-10", "abcd1234.md"), ledgerMd());
    const r = await run("ledger");
    const rows = await activeRows(LEDGER_DOC_SCOPE);
    const target = rows.find((x) => x.text.includes("## 解决了什么"))!;
    const member = rows.find((x) => x.text.includes("## 没做完"))!;
    // 对账之后有人把另一片账本合并进了 target
    await store.patchMetadataBatch([{ id: member.id, patchFn: (meta) => {
      const evo = (meta.evolution && typeof meta.evolution === "object" ? meta.evolution : {}) as Record<string, unknown>;
      meta.evolution = { ...evo, status: "consolidated", consolidatedInto: target.id };
      return meta;
    } }]);
    const undo = await undoMemoryReconcile({ store, auditLogger: createAuditLogger(auditPath) }, r.journalPath!, { auditPath, source: LEDGER_DOC_SOURCE });
    expect(undo.skippedDependency).toContain(target.id);
    expect(rowState((await loadMemoryScopeRows(store, LEDGER_DOC_SCOPE)).find((x) => x.id === target.id)!.meta).status).toBe("active");
  });

  it("锁按源分开：记忆文件对账正在跑时账本照跑，账本对账自己的锁被占才跳过", async () => {
    writeFileSync(join(ledgerDir, "2026-10", "abcd1234.md"), ledgerMd());
    let inner: Awaited<ReturnType<typeof run>> | null = null;
    await withLock("memory-reconcile", async () => {
      inner = await run("ledger");
    }, { onBusy: "skip" });
    expect(inner!.ran).toBe(true);
    let skipped: Awaited<ReturnType<typeof run>> | null = null;
    await withLock("ledger-reconcile", async () => {
      skipped = await run("ledger");
    }, { onBusy: "skip" });
    expect(skipped!.ran).toBe(false);
    expect(skipped!.skippedReason).toContain("另一轮对账或撤销");
  });

  it("只看计划不写库", async () => {
    writeFileSync(join(ledgerDir, "2026-10", "abcd1234.md"), ledgerMd());
    const r = await run("ledger", { apply: false });
    expect(r.plan!.insert.length).toBe(2);
    expect((await loadMemoryScopeRows(store, LEDGER_DOC_SCOPE)).length).toBe(0);
  });
});
