import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BeliefTargetMissingError } from "../belief-history.js";
import { buildStructuredMetadata, writeDurableEntry, type DurableWriteInput, type PersistMemoryDeps } from "../capture-engine.js";
import { buildConflictCandidateRecord, resolveConflictCandidate } from "../conflict-engine.js";
import { ConflictCandidateStore } from "../conflict-store.js";
import { applyPreferenceMatch } from "../preference-matcher.js";
import { pinMemory } from "../asset-sync.js";
import { registerLanguageProcessor } from "../language-hook.js";
import type { PinAsset } from "../memory-assets.js";
import { withWriteLock } from "../distill-lock.js";
import { parseEvolution } from "../memory-evolution.js";
import { deterministicId, MemoryStore, type MemoryEntry } from "../store.js";

/**
 * update() 与信念归档的跨进程竞态（2026-10-17）。照 metadata-rmw-cross-process.test.ts 的写法：两个 MemoryStore
 * 实例开同一个库当两个进程；测试先占住 store-write 锁（模拟另一个进程正在提交），这期间一个实例发起写，
 * 另一个实例绕过锁删掉或改掉那一行（delete() 本就不拿写锁，如 forget）。
 *
 * 旧实现：update() 锁外读整行、锁内 upsert，会把刚被删的行按旧样子插回来；信念替换先写历史行、再 update 原行，
 * 原行已被删时留下一条指向不存在原行的历史行。
 */

const SCOPE = "memory";
const KEY = "belief-archive-cross-process";
const OLD_TEXT = "这条偏好足够长，不会被噪声过滤当成碎片：回复时先给结论，再给理由，最后列出没做的事。";
const NEW_TEXT = "这条偏好改了：回复时先列出没做的事和原因，再给结论，理由放在最后，写得越短越好。";
const ID = "bbbbbbbb-1111-2222-3333-444444444444";

function metadataFor(category: MemoryEntry["category"]): string {
  const meta = JSON.parse(buildStructuredMetadata({ source: "manual", tags: [], capture: "test", category: category as never, canonicalKey: KEY })) as Record<string, unknown>;
  meta.evolution = { status: "active", accessCount: 0, version: 1 };
  return JSON.stringify(meta);
}

function seedEntry(id: string = ID): MemoryEntry {
  return {
    id,
    text: OLD_TEXT,
    vector: [1, 0, 0],
    category: "preferences",
    scope: SCOPE,
    importance: 0.7,
    timestamp: Date.now() - 86_400_000,
    metadata: metadataFor("preferences"),
  };
}

type RawTable = {
  query(): {
    select(cols: string[]): { toArray(): Promise<Array<Record<string, unknown>>> };
    where(w: string): { limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> } };
  };
  mergeInsert(k: string): { whenMatchedUpdateAll(): { execute(rows: unknown[]): Promise<unknown> } };
};

function tableOf(store: MemoryStore): RawTable {
  return (store as unknown as { table: RawTable }).table;
}

/** 库里所有行（id / text / metadata），绕过 list() 的任何过滤 */
async function allRows(store: MemoryStore): Promise<Array<{ id: string; text: string; metadata: string }>> {
  await store.getById(ID); // 确保已初始化
  const rows = await tableOf(store).query().select(["id", "text", "metadata"]).toArray();
  return rows.map((r) => ({ id: String(r.id), text: String(r.text), metadata: String(r.metadata ?? "{}") }));
}

function historyRows(rows: Array<{ metadata: string }>) {
  return rows.filter((r) => parseEvolution(r.metadata).status === "superseded");
}

/** 另一个「进程」直接把那一行改成下架：不拿 store-write 锁（锁正被测试占着） */
async function archiveBypassingLock(store: MemoryStore, id: string): Promise<void> {
  await store.getById(id);
  const table = tableOf(store);
  const [row] = await table.query().where(`id = '${id}'`).limit(1).toArray();
  const meta = JSON.parse(String(row.metadata)) as Record<string, unknown>;
  meta.evolution = { ...(meta.evolution as Record<string, unknown>), status: "archived", evolutionNote: "archived by another process" };
  await table.mergeInsert("id").whenMatchedUpdateAll().execute([{ ...row, vector: Array.from(row.vector as Iterable<number>), metadata: JSON.stringify(meta) }]);
}

/**
 * 让 store 在第 n 次 mergeInsert 的 execute 之前先执行 hook（n 从 1 起数）。
 * 用来确定性地复现「锁内写完历史行、更新原行之前，另一个进程用不拿锁的 delete() 删了原行」。
 */
function runBeforeWrite(store: MemoryStore, n: number, hook: () => Promise<void>): void {
  const holder = store as unknown as { table: Record<string, unknown> };
  const table = holder.table;
  const original = table.mergeInsert as (on: string) => unknown;
  let count = 0;
  const wrap = (builder: unknown): unknown => new Proxy(builder as object, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;
      if (prop === "execute") {
        return async (...args: unknown[]) => {
          count += 1;
          if (count === n) await hook();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (...args: unknown[]) => wrap((value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
  table.mergeInsert = (on: string) => wrap(original.call(table, on));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function depsFor(store: MemoryStore): PersistMemoryDeps {
  return {
    store,
    embedder: { async embedPassage() { return [0, 1, 0]; } },
  };
}

function revisionInput(overrides: Partial<DurableWriteInput> = {}): DurableWriteInput {
  return {
    text: NEW_TEXT,
    vector: [0, 1, 0],
    category: "preferences",
    scope: SCOPE,
    importance: 0.8,
    metadata: metadataFor("preferences"),
    canonicalKey: KEY,
    source: "manual",
    ...overrides,
  };
}

describe("update() 与信念归档在写锁内读最新行（跨进程）", () => {
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

  async function setup(seed: MemoryEntry = seedEntry()) {
    const root = mkdtempSync(join(tmpdir(), "rn-update-archive-"));
    dirs.push(root);
    process.env.RECALLNEST_DATA_DIR = root; // 锁目录跟着它走
    const dbPath = join(root, "lancedb");
    const a = new MemoryStore({ dbPath, vectorDim: 3 });
    const b = new MemoryStore({ dbPath, vectorDim: 3 });
    await a.storeBatch([seed]);
    return { a, b };
  }

  it("① update()：等锁期间别的进程 delete() 了这一行 → 返回 null、行不被插回来", async () => {
    const { a, b } = await setup();
    let pending: Promise<MemoryEntry | null> | undefined;
    await withWriteLock("store-write", async () => {
      pending = a.update(ID, { importance: 0.9 });
      await sleep(200); // 让旧实现有时间在锁外先读
      await b.delete(ID);
    });
    expect(await pending!).toBeNull();
    expect(await a.getById(ID)).toBeNull();
    expect(await b.getById(ID)).toBeNull();
    expect(await allRows(a)).toHaveLength(0);
  });

  it("①b update()：锁内读完、写回之前行被删掉 → 返回 null、行不被插回来", async () => {
    const { a, b } = await setup();
    await a.getById(ID);
    runBeforeWrite(a, 1, async () => { await b.delete(ID); });
    expect(await a.update(ID, { importance: 0.9 })).toBeNull();
    expect(await allRows(a)).toHaveLength(0);
  });

  it("①c update()：8 位前缀照常解析；锁内按完整 id 重读，行已删同样返回 null", async () => {
    const { a, b } = await setup();
    const updated = await a.update(ID.slice(0, 8), { importance: 0.9 });
    expect(updated?.id).toBe(ID);
    expect((await a.getById(ID))?.importance).toBeCloseTo(0.9);

    let pending: Promise<MemoryEntry | null> | undefined;
    await withWriteLock("store-write", async () => {
      pending = a.update(ID.slice(0, 8), { importance: 0.5 });
      await sleep(200);
      await b.delete(ID);
    });
    expect(await pending!).toBeNull();
    expect(await allRows(a)).toHaveLength(0);
  });

  it("② update()：等锁期间别的进程改了 metadata（下架）→ 基于锁内最新行写回，下架不被盖掉；updates 只改 importance", async () => {
    const { a, b } = await setup();
    let pending: Promise<MemoryEntry | null> | undefined;
    await withWriteLock("store-write", async () => {
      pending = a.update(ID, { importance: 0.9 });
      await sleep(200);
      await archiveBypassingLock(b, ID);
    });
    const result = await pending!;
    expect(result?.importance).toBeCloseTo(0.9);
    const entry = await a.getById(ID);
    expect(entry?.importance).toBeCloseTo(0.9);
    const evo = parseEvolution(entry!.metadata);
    expect(evo.status).toBe("archived");
    expect(evo.evolutionNote).toBe("archived by another process");
  });

  it("②b update()：updates 显式给了 metadata 时以调用方为准（不是读改写，同字段覆盖是预期行为）", async () => {
    const { a, b } = await setup();
    const explicit = metadataFor("preferences");
    let pending: Promise<MemoryEntry | null> | undefined;
    await withWriteLock("store-write", async () => {
      pending = a.update(ID, { metadata: explicit });
      await sleep(200);
      await archiveBypassingLock(b, ID);
    });
    await pending;
    expect(parseEvolution((await a.getById(ID))!.metadata).status).toBe("active");
  });

  it("③ 信念替换：找到旧行之后、拿到锁之前它被别的进程删掉 → 抛 BeliefTargetMissingError，不留历史行、原行不被插回", async () => {
    const { a, b } = await setup();
    const latest = (await a.list([SCOPE]))[0]; // 模拟 writeDurableEntry 扫描拿到的 latest（list 不带向量）
    expect(latest.id).toBe(ID);
    let pending: Promise<unknown> | undefined;
    await withWriteLock("store-write", async () => {
      pending = writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [latest] }));
      pending.catch(() => undefined);
      await sleep(200); // 让旧实现有时间在锁外先写历史行（它的写会卡在锁上，新实现卡在重读之前）
      await b.delete(ID);
    });
    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BeliefTargetMissingError);
    expect((caught as BeliefTargetMissingError).memoryId).toBe(ID);
    expect(await allRows(a)).toHaveLength(0);
  });

  it("③b 信念替换：锁内写完历史行、更新原行之前原行被删 → 撤掉这条历史行，库里什么都不留", async () => {
    const { a, b } = await setup();
    const latest = (await a.getById(ID))!;
    runBeforeWrite(a, 2, async () => { await b.delete(ID); }); // 第 1 次写是历史行，第 2 次是原行
    await expect(writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [latest] }))).rejects.toBeInstanceOf(BeliefTargetMissingError);
    expect(await allRows(a)).toHaveLength(0);
  });

  it("③c 确定性 id 分支：行在锁内重读时已被删 → 不把已删内容写成历史行，新内容作为新行写入", async () => {
    const targetId = deterministicId(SCOPE, KEY);
    const { a, b } = await setup(seedEntry(targetId));
    let pending: Promise<Awaited<ReturnType<typeof writeDurableEntry>>> | undefined;
    await withWriteLock("store-write", async () => {
      // precomputedMatches 为空：扫描没看到它（窗口外的旧行），走按确定性 id 直查那一支
      pending = writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [] }));
      await sleep(200);
      await b.delete(targetId);
    });
    const result = await pending!;
    expect(result.disposition).toBe("stored");
    expect(result.supersededPrevious).toBe(false);
    const rows = await allRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(targetId);
    expect(rows[0].text).toBe(NEW_TEXT);
    expect(rows.some((r) => r.text === OLD_TEXT)).toBe(false);
  });

  it("④ 正常路径：latest-wins 修订原行 id 不变、内容变新、恰好一条 superseded 历史行", async () => {
    const { a } = await setup();
    const latest = (await a.list([SCOPE]))[0];
    const result = await writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [latest] }));
    expect(result.disposition).toBe("updated");
    expect(result.supersededPrevious).toBe(true);
    expect(result.entry.id).toBe(ID);

    const rows = await allRows(a);
    expect(rows).toHaveLength(2);
    const canonical = rows.find((r) => r.id === ID)!;
    expect(canonical.text).toBe(NEW_TEXT);
    const history = historyRows(rows);
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe(OLD_TEXT);
    expect(parseEvolution(history[0].metadata).supersededBy).toBe(ID);
    const canonicalEvo = parseEvolution(canonical.metadata);
    expect(canonicalEvo.status).toBe("active");
    expect(canonicalEvo.supersedes).toBe(history[0].id);
    expect(canonicalEvo.version).toBe(2);
    // 历史行带着旧向量（锁内重读的行），不是重新嵌入的
    const full = await a.getById(history[0].id);
    expect(full?.vector).toEqual([1, 0, 0]);
  });

  it("④b 正常路径：确定性 id 分支同样原位修订，恰好一条历史行", async () => {
    const targetId = deterministicId(SCOPE, KEY);
    const { a } = await setup(seedEntry(targetId));
    const result = await writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [] }));
    expect(result.disposition).toBe("stored");
    expect(result.supersededPrevious).toBe(true);
    const rows = await allRows(a);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === targetId)?.text).toBe(NEW_TEXT);
    const history = historyRows(rows);
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe(OLD_TEXT);
  });

  it("④c 等锁期间别的进程改了原行正文 → 归档的是锁内读到的那一版", async () => {
    const { a, b } = await setup();
    const latest = (await a.list([SCOPE]))[0];
    const concurrentText = "另一个进程刚改过的版本：回复时只给结论，不要理由，也不要列没做的事。";
    let pending: Promise<unknown> | undefined;
    await withWriteLock("store-write", async () => {
      pending = writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [latest] }));
      await sleep(200);
      await b.getById(ID); // 初始化 b 的表句柄
      const table = tableOf(b);
      const [row] = await table.query().where(`id = '${ID}'`).limit(1).toArray();
      await table.mergeInsert("id").whenMatchedUpdateAll().execute([{ ...row, vector: Array.from(row.vector as Iterable<number>), text: concurrentText }]);
    });
    await pending;
    const rows = await allRows(a);
    const history = historyRows(rows);
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe(concurrentText);
    expect(rows.find((r) => r.id === ID)?.text).toBe(NEW_TEXT);
  });
  it("⑤ 冲突裁决 accept_incoming：等锁期间原行被删 → 抛 BeliefTargetMissingError，不留历史行，冲突仍是 open", async () => {
    const { a, b } = await setup();
    const conflictDir = mkdtempSync(join(tmpdir(), "rn-update-archive-conflicts-"));
    dirs.push(conflictDir);
    const conflictStore = new ConflictCandidateStore(conflictDir);
    const record = buildConflictCandidateRecord({
      canonicalKey: KEY,
      category: "preferences",
      fingerprint: `${KEY}--${ID}--incoming`,
      reason: "canonical_key_conflicts_with_existing_durable",
      existing: { memoryId: ID, text: OLD_TEXT, category: "preferences", scope: SCOPE, importance: 0.7, metadata: metadataFor("preferences"), canonicalKey: KEY },
      incoming: { text: NEW_TEXT, category: "preferences", scope: SCOPE, importance: 0.8, metadata: metadataFor("preferences"), source: "manual" },
    });
    await conflictStore.save(record);

    let pending: Promise<unknown> | undefined;
    await withWriteLock("store-write", async () => {
      pending = resolveConflictCandidate(
        { store: a, embedder: { async embedPassage() { return [0, 1, 0]; } }, conflictStore },
        { conflictId: record.conflictId, resolution: "accept_incoming" },
      );
      pending.catch(() => undefined);
      await sleep(200);
      await b.delete(ID);
    });
    await expect(pending!).rejects.toBeInstanceOf(BeliefTargetMissingError);
    expect(await allRows(a)).toHaveLength(0);
    expect((await conflictStore.getById(record.conflictId))?.status).toBe("open");
  });

  it("⑥ 偏好合并：等锁期间目标被删 → 不算已处理（调用方照旧新建），不留历史行、目标不被插回", async () => {
    const { a, b } = await setup();
    let pending: Promise<{ handled: boolean }> | undefined;
    await withWriteLock("store-write", async () => {
      pending = applyPreferenceMatch(
        { action: "merge", mergeTargetId: ID, mergedText: NEW_TEXT, reason: "test" },
        a,
        SCOPE,
        { embedder: { async embedPassage() { return [0, 1, 0]; } } },
      );
      await sleep(200);
      await b.delete(ID);
    });
    expect((await pending!).handled).toBe(false);
    expect(await allRows(a)).toHaveLength(0);
  });

  it("⑥b 偏好合并正常路径：原位改写、恰好一条历史行", async () => {
    const { a } = await setup();
    const result = await applyPreferenceMatch(
      { action: "merge", mergeTargetId: ID, mergedText: NEW_TEXT, reason: "test" },
      a,
      SCOPE,
      { embedder: { async embedPassage() { return [0, 1, 0]; } } },
    );
    expect(result.handled).toBe(true);
    const rows = await allRows(a);
    expect(rows.find((r) => r.id === ID)?.text).toBe(NEW_TEXT);
    expect(historyRows(rows).map((r) => r.text)).toEqual([OLD_TEXT]);
  });
  // ── owner review 之后的修复（2026-10-17）────────────────────────────────────────────

  it("R1 确定性 id 分支：拿锁之前别的进程已写入同一段正文（带自己的版本链）→ deduped，版本链不被抹掉、不再 store()", async () => {
    const targetId = deterministicId(SCOPE, KEY);
    const { a, b } = await setup(seedEntry(targetId));
    let pending: Promise<Awaited<ReturnType<typeof writeDurableEntry>>> | undefined;
    await withWriteLock("store-write", async () => {
      pending = writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [] }));
      await sleep(200); // A 已在锁外看到旧正文，正等锁
      await b.getById(targetId);
      const table = tableOf(b);
      const [row] = await table.query().where(`id = '${targetId}'`).limit(1).toArray();
      const meta = JSON.parse(String(row.metadata)) as Record<string, unknown>;
      meta.evolution = { status: "active", version: 5, supersedes: "history-written-by-b", validFrom: Date.now() };
      await table.mergeInsert("id").whenMatchedUpdateAll().execute([{ ...row, vector: Array.from(row.vector as Iterable<number>), text: NEW_TEXT, metadata: JSON.stringify(meta) }]);
    });
    const result = await pending!;
    expect(result.disposition).toBe("deduped");
    expect(result.entry.id).toBe(targetId);
    const rows = await allRows(a);
    expect(rows).toHaveLength(1);
    const evo = parseEvolution(rows[0].metadata);
    expect(evo.version).toBe(5);
    expect(evo.supersedes).toBe("history-written-by-b");
  });

  it("R2 时间取在锁内：等锁期间别的进程刚完成一次替换 → 历史行 validFrom ≤ validUntil，原行 timestamp 不倒退", async () => {
    const { a, b } = await setup();
    const latest = (await a.list([SCOPE]))[0];
    let bTimestamp = 0;
    let pending: Promise<Awaited<ReturnType<typeof writeDurableEntry>>> | undefined;
    await withWriteLock("store-write", async () => {
      pending = writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [latest] }));
      await sleep(200); // A 已经开始（旧实现在这时就取了 now），正等锁
      // B 在这期间完成一次替换：正文换新、timestamp 与 validFrom 取它提交的那一刻
      await b.getById(ID);
      const table = tableOf(b);
      const [row] = await table.query().where(`id = '${ID}'`).limit(1).toArray();
      bTimestamp = Date.now();
      const meta = JSON.parse(String(row.metadata)) as Record<string, unknown>;
      meta.evolution = { status: "active", version: 2, validFrom: bTimestamp };
      await table.mergeInsert("id").whenMatchedUpdateAll().execute([{ ...row, vector: Array.from(row.vector as Iterable<number>), text: "B 刚替换进去的版本：回复只给结论。", timestamp: bTimestamp, metadata: JSON.stringify(meta) }]);
    });
    await pending;
    const rows = await allRows(a);
    const [history] = historyRows(rows);
    const histEvo = parseEvolution(history.metadata);
    expect(histEvo.validFrom).toBe(bTimestamp);
    expect(histEvo.validFrom).toBeLessThanOrEqual(histEvo.validUntil!);
    const canonical = (await a.getById(ID))!;
    expect(canonical.timestamp).toBeGreaterThanOrEqual(bTimestamp);
    expect(parseEvolution(canonical.metadata).validFrom).toBe(histEvo.validUntil!);
    expect(canonical.timestamp).toBe(histEvo.validUntil!);
  });

  it("R2b 连续两次替换中间夹着时钟偏前的另一台机器：时间点不早于锁内行自己的 timestamp / validFrom", async () => {
    const { a, b } = await setup();
    const skewed = Date.now() + 60_000; // 另一台机器的时钟快了一分钟
    await b.getById(ID);
    const table = tableOf(b);
    const [row] = await table.query().where(`id = '${ID}'`).limit(1).toArray();
    const meta = JSON.parse(String(row.metadata)) as Record<string, unknown>;
    meta.evolution = { status: "active", version: 2, validFrom: skewed };
    await table.mergeInsert("id").whenMatchedUpdateAll().execute([{ ...row, vector: Array.from(row.vector as Iterable<number>), timestamp: skewed, metadata: JSON.stringify(meta) }]);

    const first = await writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [(await a.getById(ID))!] }));
    expect(first.entry.timestamp).toBeGreaterThanOrEqual(skewed);
    const second = await writeDurableEntry(depsFor(a), revisionInput({ text: "第三版：回复先给结论，再列风险，理由放最后。", precomputedMatches: [(await a.getById(ID))!] }));
    expect(second.entry.timestamp).toBeGreaterThanOrEqual(first.entry.timestamp);
    for (const h of historyRows(await allRows(a))) {
      const evo = parseEvolution(h.metadata);
      expect(evo.validFrom).toBeLessThanOrEqual(evo.validUntil!);
    }
  });

  it("R4 历史行的 language / fts_text 按正文重算：旧行带着迁移占位（en / 原文）也不照抄", async () => {
    const { a } = await setup(); // storeBatch 不传 language / fts_text → 落库为 "en" / 原文，与生产里的迁移占位相同
    registerLanguageProcessor({
      detectLanguage: (text) => (/[\u4e00-\u9fff]/.test(text) ? "zh" : "en"),
      tokenizeForFts: (text, lang) => (lang === "zh" ? Array.from(text).join(" ") : text),
    });
    try {
      const latest = (await a.list([SCOPE]))[0];
      await writeDurableEntry(depsFor(a), revisionInput({ precomputedMatches: [latest] }));
    } finally {
      // language-hook 没有注销接口：换回与「未注册」等价的直通实现
      registerLanguageProcessor({ detectLanguage: () => "en", tokenizeForFts: (text) => text });
    }
    const rows = await tableOf(a).query().select(["id", "text", "metadata", "language", "fts_text"]).toArray();
    const history = rows.filter((r) => parseEvolution(String(r.metadata)).status === "superseded");
    expect(history).toHaveLength(1);
    expect(history[0].language).toBe("zh");
    expect(history[0].fts_text).toBe(Array.from(OLD_TEXT).join(" "));
  });

  it("R5 原行在两次写之间消失、撤掉历史行又失败 → 记日志，仍返回 missing", async () => {
    const { a, b } = await setup();
    await a.getById(ID);
    runBeforeWrite(a, 2, async () => { await b.delete(ID); });
    (a as unknown as { table: { delete(where: string): Promise<void> } }).table.delete = async () => { throw new Error("disk full"); };
    const result = await a.replaceWithArchivedVersion(ID, (current) => ({
      history: { ...current, id: "cccccccc-1111-2222-3333-444444444444", metadata: "{}" },
      updates: { text: NEW_TEXT },
    }));
    expect(result.status).toBe("missing");
  });

  it("R3 pin：等锁期间记忆被删 → 返回 null，不写 pin 文件、不建索引副本", async () => {
    const { a, b } = await setup();
    const entry = (await a.getById(ID))!;
    const saved: PinAsset[] = [];
    let pending: ReturnType<typeof pinMemory> | undefined;
    await withWriteLock("store-write", async () => {
      pending = pinMemory(a, { async embedPassage() { return [0, 0, 1]; } } as never, entry, undefined, {}, (asset) => { saved.push(asset); return "/dev/null"; });
      await sleep(200);
      await b.delete(ID);
    });
    expect(await pending!).toBeNull();
    expect(saved).toHaveLength(0);
    expect(await allRows(a)).toHaveLength(0);
  });

  it("R3b pin 正常路径：pin 按 update() 返回的行生成（importance 已提到 0.95），并建一条索引副本", async () => {
    const { a } = await setup();
    const entry = (await a.getById(ID))!;
    const saved: PinAsset[] = [];
    const pinned = await pinMemory(a, { async embedPassage() { return [0, 0, 1]; } } as never, entry, undefined, { title: "t" }, (asset) => { saved.push(asset); return "/dev/null"; });
    expect(pinned?.entry.importance).toBeCloseTo(0.95);
    expect(saved).toHaveLength(1);
    expect(saved[0].source.memoryId).toBe(ID);
    expect(saved[0].retrieval.score).toBeCloseTo(0.95);
    expect(await allRows(a)).toHaveLength(2);
  });

  it("R3c pin 的三个入口（MCP / CLI / UI）都走 pinMemory，不再各自写 pin 文件", () => {
    for (const file of ["mcp-tools-advanced.ts", "cli.ts", "ui-server.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(source).toContain("pinMemory(store, embedder, entry, scopeSelection.scopeFilter");
      expect(source).not.toContain("savePinAsset(");
      expect(source).not.toContain("indexPinnedAsset(");
    }
  });
});
