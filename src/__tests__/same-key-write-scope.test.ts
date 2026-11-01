import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  persistMemory,
  persistWorkflowPattern,
  promoteMemory,
  writeDurableEntry,
  type PersistMemoryDeps,
} from "../capture-engine.js";
import { ConflictCandidateStore } from "../conflict-store.js";
import { extractCanonicalKey, normalizeCanonicalKey } from "../memory-boundaries.js";
import { parseEvolution } from "../memory-evolution.js";
import { PIVOT_SCOPE, persistPivotCandidate } from "../pivot-apply.js";
import { MemoryStore, deterministicId, type MemoryEntry } from "../store.js";

/**
 * 同 key 写入要看 scope（2026-11-01）。
 *
 * deterministicId(scope, key) 让两个 scope 的同 key 各是一行；而写入端的同 key 扫描
 * （capture-engine.ts findCanonicalMatches）原先扫所有 scope，于是：
 *   - 在 B 里第一次写某个 key、A 已有同 key：B 返回 updated，改写的是 A 的行，B 一行都没有；
 *   - 全文相同的写入在 B 返回 A 那一行的 deduped（events 也是），回执的 scope 是 A；
 *   - 同标题的 workflow pattern（key 由标题生成）在两个项目之间互相覆盖；
 *   - 跨类别同 key 会拿 A 的行在 B 开冲突。
 * 这里全部用临时目录里的真实 LanceDB + 假嵌入器，不碰生产库。
 */

const A = "project:scope-a";
const B = "project:scope-b";

const tmpDirs: string[] = [];
let originalDataDir: string | undefined;

beforeAll(() => {
  // 锁文件按 RECALLNEST_DATA_DIR 解析，隔离到临时目录
  originalDataDir = process.env.RECALLNEST_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "rn-scope-key-datadir-"));
  process.env.RECALLNEST_DATA_DIR = dataDir;
  tmpDirs.push(dataDir);
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = originalDataDir;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  // datadir 留到 afterAll
  while (tmpDirs.length > 1) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDeps(options: { withConflictStore?: boolean } = {}): { store: MemoryStore; deps: PersistMemoryDeps } {
  const dir = mkdtempSync(join(tmpdir(), "rn-scope-key-db-"));
  tmpDirs.push(dir);
  // 库放子目录：活动计数写在库目录旁边，也落在临时目录里
  const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
  const deps: PersistMemoryDeps = {
    store,
    embedder: {
      async embedPassage(text: string) {
        return [1, (text.length % 7) + 1, 0.5];
      },
    },
    noisePrototypeBank: null,
    ...(options.withConflictStore ? { conflictStore: new ConflictCandidateStore(join(dir, "conflicts")) } : {}),
  };
  return { store, deps };
}

interface RowSnapshot {
  id: string;
  text: string;
  scope: string;
  category: string;
  timestamp: number;
  metadata: string;
}

function snapshot(entry: MemoryEntry | null): RowSnapshot | null {
  if (!entry) return null;
  return {
    id: entry.id,
    text: entry.text,
    scope: entry.scope,
    category: entry.category,
    timestamp: entry.timestamp,
    metadata: entry.metadata ?? "",
  };
}

/** 某个 scope 里某个 key 的活跃行（belief 历史行 status=superseded，不算） */
async function activeRowsWithKey(store: MemoryStore, scope: string, key: string): Promise<MemoryEntry[]> {
  const rows = await store.list([scope], undefined, 1000, 0, "exact");
  return rows.filter((row) =>
    row.scope === scope &&
    extractCanonicalKey(row.metadata) === key &&
    parseEvolution(row.metadata).status === "active");
}

/** 一条 cc:* 的 evidence 行，给 promoteMemory 当来源。 */
async function seedEvidence(store: MemoryStore, text: string, session: string): Promise<MemoryEntry> {
  return store.store({
    text,
    vector: [1, 2, 3],
    category: "events",
    scope: `cc:${session}`,
    importance: 0.5,
    metadata: JSON.stringify({
      source: "cc",
      boundary: {
        layer: "evidence",
        authority: "transcript-ingest",
        conflictPolicy: "append-only",
        originalCategory: "preferences",
      },
    }),
  });
}

describe("① B scope 首写同 key：A 的行不动，B 新增一行", () => {
  it("entities / key laptop：B 返回 stored、行在 B；A 的行逐字段不变", async () => {
    const { store, deps } = makeDeps();
    const a = await persistMemory(deps, {
      text: "Work laptop is a 14-inch MacBook Pro with 36GB memory",
      category: "entities", scope: A, source: "manual", canonicalKey: "laptop",
    });
    expect(a.disposition).toBe("stored");
    expect(a.id).toBe(deterministicId(A, "laptop"));
    const aBefore = snapshot(await store.getById(a.id));

    const b = await persistMemory(deps, {
      text: "Home laptop is a ThinkPad X1 Carbon running Fedora",
      category: "entities", scope: B, source: "manual", canonicalKey: "laptop",
    });
    expect(b.disposition).toBe("stored");
    expect(b.resolvedScope).toBe(B);
    expect(b.id).toBe(deterministicId(B, "laptop"));
    expect(b.id).not.toBe(a.id);

    expect(snapshot(await store.getById(a.id))).toEqual(aBefore);
    const bRow = await store.getById(b.id);
    expect(bRow!.scope).toBe(B);
    expect(bRow!.text).toBe("Home laptop is a ThinkPad X1 Carbon running Fedora");
    expect((await activeRowsWithKey(store, A, "laptop")).length).toBe(1);
    expect((await activeRowsWithKey(store, B, "laptop")).length).toBe(1);
  }, 60_000);

  it("跨类别同 key：A 的 entities 不让 B 的 preferences 进冲突，B 照常写入", async () => {
    const { store, deps } = makeDeps({ withConflictStore: true });
    const a = await persistMemory(deps, {
      text: "Primary editor installed on the work machine is Neovim 0.10",
      category: "entities", scope: A, source: "manual", canonicalKey: "editor",
    });
    const aBefore = snapshot(await store.getById(a.id));

    const b = await persistMemory(deps, {
      text: "User prefers VS Code with the vim extension for this project",
      category: "preferences", scope: B, source: "manual", canonicalKey: "editor",
    });
    expect(b.disposition).toBe("stored");
    expect(b.conflictId).toBeUndefined();
    expect(b.resolvedScope).toBe(B);
    expect(b.id).toBe(deterministicId(B, "editor"));
    expect(snapshot(await store.getById(a.id))).toEqual(aBefore);
  }, 60_000);
});

describe("② 同文写入在另一 scope 不被判 deduped，各 scope 各一行", () => {
  it("events（只追加的类别）：B 返回 stored、回执 scope 是 B，B 里查得到", async () => {
    const { store, deps } = makeDeps();
    const text = "Released version 3.2.0 to production after the migration dry run passed";
    const a = await persistMemory(deps, { text, category: "events", scope: A, source: "manual" });
    expect(a.disposition).toBe("stored");
    const aBefore = snapshot(await store.getById(a.id));

    const b = await persistMemory(deps, { text, category: "events", scope: B, source: "manual" });
    expect(b.disposition).toBe("stored");
    expect(b.resolvedScope).toBe(B);
    expect(b.id).not.toBe(a.id);
    expect(snapshot(await store.getById(a.id))).toEqual(aBefore);

    const inB = await store.list([B], undefined, 100, 0, "exact");
    expect(inB.filter((row) => row.text === text).length).toBe(1);
    const inA = await store.list([A], undefined, 100, 0, "exact");
    expect(inA.filter((row) => row.text === text).length).toBe(1);
  }, 60_000);

  it("preferences（默认 key）：B 返回 stored，不返回 A 的行", async () => {
    const { store, deps } = makeDeps();
    const text = "User prefers answers in Chinese with English technical terms kept as is";
    const a = await persistMemory(deps, { text, category: "preferences", scope: A, source: "manual" });
    expect(a.disposition).toBe("stored");
    const aBefore = snapshot(await store.getById(a.id));

    const b = await persistMemory(deps, { text, category: "preferences", scope: B, source: "manual" });
    expect(b.disposition).toBe("stored");
    expect(b.resolvedScope).toBe(B);
    expect(b.id).not.toBe(a.id);
    expect((await store.getById(b.id))!.scope).toBe(B);
    expect(snapshot(await store.getById(a.id))).toEqual(aBefore);
  }, 60_000);

  it("preferences（显式 key，走同 key 修订判定那条路）：B 返回 stored、行在 B", async () => {
    const { store, deps } = makeDeps();
    const text = "User prefers tabs over spaces for indentation in shell scripts";
    const a = await persistMemory(deps, { text, category: "preferences", scope: A, source: "manual", canonicalKey: "indent.style" });
    expect(a.disposition).toBe("stored");
    const aBefore = snapshot(await store.getById(a.id));

    const b = await persistMemory(deps, { text, category: "preferences", scope: B, source: "manual", canonicalKey: "indent.style" });
    expect(b.disposition).toBe("stored");
    expect(b.resolvedScope).toBe(B);
    expect(b.id).toBe(deterministicId(B, normalizeCanonicalKey("indent.style")));
    expect(snapshot(await store.getById(a.id))).toEqual(aBefore);
  }, 60_000);
});

describe("③ 同标题 workflow pattern 在两个 project scope 互不覆盖", () => {
  function pattern(scope: string, steps: string[]) {
    return {
      title: "Release checklist",
      trigger: "Before tagging a new release of the project",
      steps,
      outcome: "The release goes out without a missed step",
      tools: ["git"],
      scope,
      tags: [],
    };
  }

  it("A、B 各一行；之后改 A 只动 A", async () => {
    const { store, deps } = makeDeps();
    const a = await persistWorkflowPattern(deps, pattern(A, ["Run bun test", "Bump version in package.json", "Tag and push"]));
    expect(a.disposition).toBe("stored");
    const aBefore = snapshot(await store.getById(a.id));

    const b = await persistWorkflowPattern(deps, pattern(B, ["Run cargo test", "Update CHANGELOG", "Publish crate"]));
    expect(b.canonicalKey).toBe(a.canonicalKey);
    expect(b.disposition).toBe("stored");
    expect(b.resolvedScope).toBe(B);
    expect(b.id).not.toBe(a.id);
    expect(snapshot(await store.getById(a.id))).toEqual(aBefore);
    expect((await store.getById(b.id))!.text).toContain("Run cargo test");
    const bBefore = snapshot(await store.getById(b.id));

    // 同 scope 内照旧 latest-wins：改 A 的步骤原位更新 A，B 不动
    const a2 = await persistWorkflowPattern(deps, pattern(A, ["Run bun test", "Run tsc", "Bump version in package.json", "Tag and push"]));
    expect(a2.disposition).toBe("updated");
    expect(a2.id).toBe(a.id);
    expect((await store.getById(a.id))!.text).toContain("Run tsc");
    expect(snapshot(await store.getById(b.id))).toEqual(bBefore);
  }, 60_000);
});

describe("④ 同 scope 内同 key 修订与改前一致", () => {
  it("entities：stored → 异文 updated（原位、版本 +1、留历史行）→ 同文 deduped", async () => {
    const { store, deps } = makeDeps();
    const v1 = "Work laptop is a 14-inch MacBook Pro with 36GB memory";
    const v2 = "Work laptop is a 16-inch MacBook Pro with 64GB memory";
    const first = await persistMemory(deps, { text: v1, category: "entities", scope: A, source: "manual", canonicalKey: "laptop" });
    expect(first.disposition).toBe("stored");
    const before = await store.getById(first.id);

    const revised = await persistMemory(deps, { text: v2, category: "entities", scope: A, source: "manual", canonicalKey: "laptop" });
    expect(revised.disposition).toBe("updated");
    expect(revised.id).toBe(first.id);
    const live = await store.getById(first.id);
    expect(live!.text).toBe(v2);
    const evo = parseEvolution(live!.metadata);
    expect(evo.version).toBe(parseEvolution(before!.metadata).version + 1);
    const history = await store.getById(evo.supersedes as string);
    expect(history!.text).toBe(v1);
    expect(parseEvolution(history!.metadata).status).toBe("superseded");

    const liveBefore = snapshot(live);
    const again = await persistMemory(deps, { text: v2, category: "entities", scope: A, source: "manual", canonicalKey: "laptop" });
    expect(again.disposition).toBe("deduped");
    expect(again.id).toBe(first.id);
    expect(snapshot(await store.getById(first.id))).toEqual(liveBefore);
    expect((await activeRowsWithKey(store, A, "laptop")).length).toBe(1);
  }, 60_000);

  it("B 里有更新的同 key 行时，修订 A 改的是 A 的行，不是全库最新那一行", async () => {
    const { store, deps } = makeDeps();
    const a = await persistMemory(deps, { text: "Deploy target is the staging cluster in eu-west", category: "entities", scope: A, source: "manual", canonicalKey: "deploy.target" });
    await Bun.sleep(5);
    const b = await persistMemory(deps, { text: "Deploy target is a single VPS behind Caddy", category: "entities", scope: B, source: "manual", canonicalKey: "deploy.target" });
    expect(b.disposition).toBe("stored");
    const bBefore = snapshot(await store.getById(b.id));

    await Bun.sleep(5);
    const a2 = await persistMemory(deps, { text: "Deploy target is the production cluster in eu-west", category: "entities", scope: A, source: "manual", canonicalKey: "deploy.target" });
    expect(a2.disposition).toBe("updated");
    expect(a2.id).toBe(a.id);
    expect(a2.resolvedScope).toBe(A);
    expect((await store.getById(a.id))!.text).toBe("Deploy target is the production cluster in eu-west");
    expect(snapshot(await store.getById(b.id))).toEqual(bBefore);
  }, 60_000);

  it("events 同 scope 同文照旧 deduped；同 scope 跨类别同 key 照旧进冲突", async () => {
    const { store, deps } = makeDeps({ withConflictStore: true });
    const text = "Migrated the CI runner to the new self-hosted machine";
    const e1 = await persistMemory(deps, { text, category: "events", scope: A, source: "manual" });
    const e2 = await persistMemory(deps, { text, category: "events", scope: A, source: "manual" });
    expect(e1.disposition).toBe("stored");
    expect(e2.disposition).toBe("deduped");
    expect(e2.id).toBe(e1.id);

    const ent = await persistMemory(deps, { text: "Build server hostname is ci-runner-02", category: "entities", scope: A, source: "manual", canonicalKey: "ci.runner" });
    const entBefore = snapshot(await store.getById(ent.id));
    const pref = await persistMemory(deps, { text: "User prefers CI to run on the self-hosted runner only", category: "preferences", scope: A, source: "manual", canonicalKey: "ci.runner" });
    expect(pref.disposition).toBe("conflict");
    expect(pref.conflictId).toBeDefined();
    expect(pref.id).toBe(ent.id);
    expect(snapshot(await store.getById(ent.id))).toEqual(entBefore);
  }, 60_000);
});

describe("两层过滤各自钉住", () => {
  it("writeDurableEntry 收到混进别的 scope 的 precomputedMatches：照样只看本 scope，B 新增一行", async () => {
    const { store, deps } = makeDeps();
    const text = "Primary database is Postgres 16 on the managed instance";
    const a = await persistMemory(deps, { text, category: "entities", scope: A, source: "manual", canonicalKey: "db.primary" });
    const aRow = await store.getById(a.id);
    const aBefore = snapshot(aRow);

    const metadata = JSON.parse(aRow!.metadata ?? "{}") as Record<string, unknown>;
    const result = await writeDurableEntry(deps, {
      text,
      vector: [1, 2, 0.5],
      category: "entities",
      scope: B,
      importance: 0.7,
      metadata: JSON.stringify({ ...metadata, evolution: undefined }),
      canonicalKey: "db.primary",
      source: "manual",
      precomputedMatches: [aRow!],
    });
    expect(result.disposition).toBe("stored");
    expect(result.entry.scope).toBe(B);
    expect(result.entry.id).toBe(deterministicId(B, "db.primary"));
    expect(snapshot(await store.getById(a.id))).toEqual(aBefore);
  }, 60_000);

  it("显式 key 偏好修订：B 里有同 key 的别的类别，不妨碍 A 的同 key 修订走版本链", async () => {
    const { store, deps } = makeDeps({ withConflictStore: true });
    const v1 = "User prefers dark theme in every editor and terminal";
    const v2 = "User prefers dark theme in editors but a light terminal";
    const a = await persistMemory(deps, { text: v1, category: "preferences", scope: A, source: "manual", canonicalKey: "theme" });
    expect(a.disposition).toBe("stored");
    const b = await persistMemory(deps, { text: "Theme package installed is catppuccin mocha", category: "entities", scope: B, source: "manual", canonicalKey: "theme" });
    expect(b.disposition).toBe("stored");

    let matcherCalls = 0;
    const spyStore = new Proxy(store, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop === "vectorSearch") {
          return (...args: Parameters<MemoryStore["vectorSearch"]>) => {
            if (args[2] === 0.78) matcherCalls += 1;
            return target.vectorSearch(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const revised = await persistMemory({ ...deps, store: spyStore }, { text: v2, category: "preferences", scope: A, source: "manual", canonicalKey: "theme" });
    expect(revised.disposition).toBe("updated");
    expect(revised.id).toBe(a.id);
    // 走的是同 key 修订，不是 Tier 3.6 判重（matcher 用 minScore 0.78）
    expect(matcherCalls).toBe(0);
    expect((await store.getById(a.id))!.text).toBe(v2);
  }, 60_000);
});

describe("promote_memory：写进调用方给的 scope，同 scope 照旧合并", () => {

  it("同 key 同文：在 A 再晋升一次合并进 A 的行（promoted、同 id）；晋升到 B 则 B 新增一行、A 不动", async () => {
    const { store, deps } = makeDeps({ withConflictStore: true });
    const durable = "User prefers concise, direct replies.";
    const e1 = await seedEvidence(store, "[用户] 回复短一点，直说。", "s1");
    const e2 = await seedEvidence(store, "[用户] 别绕弯子，简短回答。", "s2");
    const e3 = await seedEvidence(store, "[用户] 说重点就行。", "s3");

    const p1 = await promoteMemory(deps, { memoryId: e1.id, text: durable, category: "preferences", scope: A, canonicalKey: "user.reply.style" });
    expect(p1.disposition).toBe("promoted");
    expect(p1.id).toBe(deterministicId(A, normalizeCanonicalKey("user.reply.style")));

    const p2 = await promoteMemory(deps, { memoryId: e2.id, text: durable, category: "preferences", scope: A, canonicalKey: "user.reply.style" });
    expect(p2.disposition).toBe("promoted");
    expect(p2.id).toBe(p1.id);
    const aAfterMerge = snapshot(await store.getById(p1.id));
    expect(aAfterMerge!.metadata).toContain(e2.id);

    const p3 = await promoteMemory(deps, { memoryId: e3.id, text: durable, category: "preferences", scope: B, canonicalKey: "user.reply.style" });
    expect(p3.disposition).toBe("promoted");
    expect(p3.resolvedScope).toBe(B);
    expect(p3.id).toBe(deterministicId(B, normalizeCanonicalKey("user.reply.style")));
    expect(snapshot(await store.getById(p1.id))).toEqual(aAfterMerge);
    expect((await activeRowsWithKey(store, B, normalizeCanonicalKey("user.reply.style"))).length).toBe(1);
  }, 60_000);
});

describe("本 scope 的旧行落在扫描窗口外、窗口内只有别的 scope 的同 key 行（R1 Codex P1）：按 id 兜底也要过冲突判定", () => {
  /** 让 list() 看不见 A 的行：等价于 A 的行被 1000 条更新的行挤出扫描窗口，而 B 的同 key 行还在窗口内。 */
  function blindListToScope(store: MemoryStore, hidden: string): void {
    const original = store.list.bind(store);
    (store as any).list = async (...args: Parameters<MemoryStore["list"]>) =>
      (await original(...args)).filter((entry) => entry.scope !== hidden);
  }

  it("跨类别同 key：A 的 preferences 行在窗口外，向 A 写 entities 仍进冲突、A 不变", async () => {
    const { store, deps } = makeDeps({ withConflictStore: true });
    const a = await persistMemory(deps, {
      text: "User prefers VS Code with the vim extension", category: "preferences", scope: A, source: "manual", canonicalKey: "editor",
    });
    await persistMemory(deps, {
      text: "Default editor on the build box is Neovim", category: "entities", scope: B, source: "manual", canonicalKey: "editor",
    });
    const aBefore = snapshot(await store.getById(a.id));
    blindListToScope(store, A);

    const write = await persistMemory(deps, {
      text: "Primary editor installed on the work machine is Neovim 0.10", category: "entities", scope: A, source: "manual", canonicalKey: "editor",
    });
    expect(write.disposition).toBe("conflict");
    expect(write.conflictId).toBeDefined();
    expect(snapshot(await store.getById(a.id))).toEqual(aBefore);
    expect(await store.getById(a.id)).toMatchObject({ category: "preferences" });
  }, 60_000);

  it("晋升同 key、不同槽位的偏好：A 的行在窗口外仍进晋升冲突，不被替换", async () => {
    const { store, deps } = makeDeps({ withConflictStore: true });
    const p0 = await persistMemory(deps, {
      text: "User prefers concise, direct replies.", category: "preferences", scope: A, source: "manual", canonicalKey: "user.reply.style",
    });
    await persistMemory(deps, {
      text: "User prefers long, detailed replies.", category: "preferences", scope: B, source: "manual", canonicalKey: "user.reply.style",
    });
    const aBefore = snapshot(await store.getById(p0.id));
    blindListToScope(store, A);

    const evidence = await seedEvidence(store, "[用户] 回复可以展开讲，细一点。", "s-window");
    const promoted = await promoteMemory(deps, {
      memoryId: evidence.id, text: "User prefers long, detailed replies.", category: "preferences", scope: A, canonicalKey: "user.reply.style",
    });
    expect(promoted.disposition).toBe("conflict");
    expect(snapshot(await store.getById(p0.id))).toEqual(aBefore);
  }, 60_000);

  it("对照：窗口外的同 scope 同类别异文修订照旧原位替换（updated 语义不变）", async () => {
    const { store, deps } = makeDeps({ withConflictStore: true });
    const a = await persistMemory(deps, {
      text: "User works from the Guangzhou office", category: "profile", scope: A, source: "manual", canonicalKey: "office",
    });
    blindListToScope(store, A);
    const write = await persistMemory(deps, {
      text: "User works from the Singapore office", category: "profile", scope: A, source: "manual", canonicalKey: "office",
    });
    expect(write.id).toBe(a.id);
    expect(write.disposition).toBe("stored");
    expect((await store.getById(a.id))!.text).toBe("User works from the Singapore office");
  }, 60_000);
});

describe("pivot-apply：固定写 memory:pivot，别的 scope 的同 key 行不再被改写", () => {
  const REPORT_ID = "00b609834309b7b44d1e36fc7c93169e083abb66487073bfd64d8c5bafc337fa";
  const KEY = "pivot-preference-rule-learning-audit-workflow";

  function candidate(text: string, hashSeed: string): Record<string, unknown> {
    return {
      kind: "preference_rule",
      text,
      anchor: "你要记住了，以后都是，甩链接，学习，记录。",
      canonicalKey: KEY,
      evidence: ["你要记住了，以后都是，甩链接，学习，记录，如果借鉴了就要记到审计这里。"],
      proposedScope: PIVOT_SCOPE,
      proposedCategory: "preferences",
      tags: ["src:bb8af0b7", "date:2026-04-12"],
      sessionId: "bb8af0b7-cc58-4bb2-8e35-9744537e5854",
      reportId: REPORT_ID,
      candidateHash: hashSeed.repeat(64).slice(0, 64),
      batchId: "scope-test-batch",
      importance: 0.7,
    };
  }

  it("project 里已有同 key 偏好：pivot 写入在 memory:pivot 新增一行；之后同 key 异文在 memory:pivot 原位修订", async () => {
    const { store, deps } = makeDeps();
    const other = await persistMemory(deps, {
      text: "User wants every external link reviewed and summarized before reuse",
      category: "preferences", scope: A, source: "manual", canonicalKey: KEY,
    });
    expect(other.disposition).toBe("stored");
    const otherBefore = snapshot(await store.getById(other.id));

    const first = await persistPivotCandidate(deps, candidate(
      "用户确立了外部项目学习的标准化工作流：分析链接后必须记录到 learnings 并同步更新借鉴审计目录。", "a",
    ));
    expect(first.disposition).toBe("stored");
    expect(first.memoryId).toBe(deterministicId(PIVOT_SCOPE, KEY));
    expect(first.verified).toBe(true);
    expect(snapshot(await store.getById(other.id))).toEqual(otherBefore);

    const second = await persistPivotCandidate(deps, candidate(
      "用户确立了外部项目学习的标准化工作流：分析链接后记录到 learnings、更新借鉴审计目录，并在周报里汇总。", "b",
    ));
    expect(second.disposition).toBe("updated");
    expect(second.memoryId).toBe(first.memoryId);
    expect(snapshot(await store.getById(other.id))).toEqual(otherBefore);
    expect((await activeRowsWithKey(store, PIVOT_SCOPE, KEY)).length).toBe(1);
  }, 60_000);
});
