import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildStructuredMetadata,
  persistCaseMemory,
  persistMemory,
  persistWorkflowPattern,
  promoteMemory,
  type PersistMemoryDeps,
} from "../capture-engine.js";
import { buildDefaultCanonicalKey } from "../memory-boundaries.js";
import { loadLanceDB, MemoryStore } from "../store.js";
import { redactSecrets } from "../pii-detector.js";
import { extractTriggerCandidates, normalizeTriggerTexts, TRIGGER_TABLE_NAME, TriggerStore } from "../trigger-store.js";

/**
 * 脱敏覆盖 metadata 与 trigger（2026-10-17）。
 * 起因：只有拼好的正文过 redactSecrets；case / pattern 的结构化 metadata、tags、显式 canonicalKey、
 * trigger 原文都按入参原样进库，trigger 还原样发给外部嵌入接口。
 * 库是临时目录里的真实 LanceDB（主表与 trigger 侧表）；嵌入是本地假向量，记下每一段发出去的文字。
 */

// 运行时拼出来，免得源文件里出现一段完整的 token 形态
const SECRET = "ghp_" + "A1b2C3d4".repeat(3);
const SECRET_BODY = SECRET.slice(4);
const OTHER_SECRET = "ghp_" + "Z9y8X7w6".repeat(3);

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

interface StoredRowSnapshot {
  id: string;
  scope: string;
  text: string;
  metadata: string;
}

function harness(vectorFor: (text: string) => number[] = (text) => [1, (text.length % 7) + 1, 0.5]) {
  const dir = mkdtempSync(join(tmpdir(), "rn-redact-meta-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "db");
  const store = new MemoryStore({ dbPath, vectorDim: 3 });
  const triggerStore = new TriggerStore({ dbPath, vectorDim: 3 });
  const embedded: string[] = [];
  const deps: PersistMemoryDeps = {
    store,
    embedder: {
      embedPassage: async (text: string) => {
        embedded.push(text);
        return vectorFor(text);
      },
    },
    triggerStore,
    embedQueryBatch: async (texts: string[]) => {
      embedded.push(...texts);
      return texts.map(vectorFor);
    },
    noisePrototypeBank: null,
  };
  const rows = async (scope: string): Promise<StoredRowSnapshot[]> => {
    const listed = await store.list([scope], undefined, 100, 0, "exact");
    return listed.map((row) => ({ id: row.id, scope: row.scope, text: row.text, metadata: row.metadata ?? "" }));
  };
  const triggerRows = async (): Promise<string[]> => {
    const lancedb = await loadLanceDB();
    const db = await lancedb.connect(dbPath);
    const names = await db.tableNames();
    if (!names.includes(TRIGGER_TABLE_NAME)) return [];
    const table = await db.openTable(TRIGGER_TABLE_NAME);
    const all = await table.query().toArray();
    return all.map((row) => String((row as { text: unknown }).text));
  };
  return { deps, store, triggerStore, embedded, rows, triggerRows };
}

function expectNoSecret(label: string, value: string): void {
  if (value.includes(SECRET_BODY)) throw new Error(`${label} still holds the secret: ${value.slice(0, 300)}`);
}

describe("normalizeTriggerTexts redacts", () => {
  it("replaces a token inside a trigger with the redaction placeholder", () => {
    const out = normalizeTriggerTexts([`我那个 ${SECRET} 是哪个仓库的`, "普通的问法不变"]);
    expect(out).toEqual(["我那个 [REDACTED:github_token] 是哪个仓库的", "普通的问法不变"]);
  });

  it("TriggerStore.upsertForMemory neither embeds nor stores the raw token", async () => {
    const h = harness();
    const sent: string[] = [];
    const n = await h.triggerStore.upsertForMemory("m-1", "project:redact", [`token ${SECRET} 是做什么的`], async (texts) => {
      sent.push(...texts);
      return texts.map(() => [1, 1, 1]);
    });
    expect(n).toBe(1);
    expect(sent.length).toBe(1);
    for (const s of sent) expectNoSecret("embed input", s);
    const stored = await h.triggerRows();
    expect(stored).toEqual(["token [REDACTED:github_token] 是做什么的"]);
    // 本文件第一条开 LanceDB 的用例，冷启动（加载原生模块）一次实测 5.3 秒，撞过默认的 5 秒
  }, 30_000);
});

describe("persistMemory redacts metadata fields and triggers", () => {
  it("tags, topicTag and triggers reach metadata, side table and embedder scrubbed", async () => {
    const h = harness();
    const scope = "project:redact";
    const result = await persistMemory(h.deps, {
      text: "部署脚本换了新的发布凭证，旧的那个已经吊销，流程写进运维手册里",
      category: "events",
      importance: 0.8,
      scope,
      source: "manual",
      tags: ["deploy", `cred-${SECRET}`],
      topicTag: `ops ${SECRET}`,
      triggers: [`之前那个 ${SECRET} 还能用吗`, "发布凭证换过没有"],
    });

    expect(result.disposition).toBe("stored");
    const [row] = await h.rows(scope);
    expect(row).toBeDefined();
    expectNoSecret("row text", row.text);
    expectNoSecret("row metadata", row.metadata);
    const meta = JSON.parse(row.metadata) as { triggers?: string[]; tags?: string[] };
    expect(meta.triggers).toEqual(["之前那个 [REDACTED:github_token] 还能用吗", "发布凭证换过没有"]);
    expect(meta.tags?.[0]).toBe("deploy");
    expect(meta.tags?.[1]).toContain("[REDACTED:github_token]");

    for (const t of await h.triggerRows()) expectNoSecret("trigger side table", t);
    expect((await h.triggerRows()).length).toBe(2);
    expect(h.embedded.length).toBeGreaterThan(0);
    for (const s of h.embedded) expectNoSecret("embed input", s);
    expectNoSecret("returned record", JSON.stringify(result));
  });

  it("drops an explicit canonicalKey that holds a secret and falls back to the default key", async () => {
    const h = harness();
    const scope = "project:redact";
    const text = "发布用的 token 存在 1Password 的运维保险库，不进仓库也不进环境文件";
    const result = await persistMemory(h.deps, {
      text,
      category: "events",
      importance: 0.8,
      scope,
      source: "manual",
      canonicalKey: `release-${SECRET}`,
    });

    const expected = buildDefaultCanonicalKey({ category: "events", text });
    expect(result.canonicalKey).toBe(expected);
    const [row] = await h.rows(scope);
    expect(JSON.parse(row.metadata).canonicalKey).toBe(expected);
    // 规整后的形态（ghp- 小写）也不能留下
    expect(row.metadata.toLowerCase()).not.toContain(SECRET_BODY.toLowerCase());
  });

  it("two preferences whose keys differ only by secret do not collapse into one revision chain", async () => {
    // 正交向量：不让 Tier 3.6 的语义判重先把第二条吞掉，只看 key 撞不撞
    const h = harness((text) => (text.includes("SSH") ? [1, 0, 0] : text.includes("机器人") ? [0, 1, 0] : [0, 0, 1]));
    const scope = "project:redact";
    const first = await persistMemory(h.deps, {
      text: "偏好：内部仓库的推送一律走 SSH，不用 HTTPS 加个人令牌",
      category: "preferences",
      importance: 0.8,
      scope,
      source: "manual",
      canonicalKey: `push-${SECRET}`,
    });
    const second = await persistMemory(h.deps, {
      text: "偏好：发布机器人只用细粒度令牌，过期时间不超过三十天",
      category: "preferences",
      importance: 0.8,
      scope,
      source: "manual",
      canonicalKey: `push-${OTHER_SECRET}`,
    });

    expect(first.disposition).toBe("stored");
    expect(second.disposition).toBe("stored");
    expect(second.id).not.toBe(first.id);
    const stored = await h.rows(scope);
    expect(stored.map((r) => r.text).sort()).toEqual([first.text, second.text].sort());
  });

  it("keeps a clean explicit canonicalKey and adds no keys to the returned record", async () => {
    const h = harness();
    const result = await persistMemory(h.deps, {
      text: "推送前先跑 bun test，全绿才推，红了先查红了多久",
      category: "events",
      importance: 0.8,
      scope: "project:redact",
      source: "manual",
      canonicalKey: "push-checklist",
    });
    expect(result.canonicalKey).toBe("push-checklist");
    expect(Object.keys(result)).not.toContain("topicTag");
    expect(Object.keys(result)).not.toContain("triggers");
  });
});

describe("persistCaseMemory redacts structured metadata", () => {
  it("no field of caseMemory, tags or debugFraming keeps the raw token", async () => {
    const h = harness();
    const scope = "project:redact";
    const result = await persistCaseMemory(h.deps, {
      title: `推送失败 ${SECRET}`,
      problem: `git push 用 ${SECRET} 报 403，令牌权限不够`,
      context: `CI 环境变量 GH_TOKEN=${SECRET}`,
      solutionSteps: [`吊销 ${SECRET}`, "换细粒度令牌并只给 contents:write"],
      outcome: `新令牌替换 ${SECRET} 后推送成功`,
      tools: ["git", SECRET],
      tags: ["ci", SECRET],
      importance: 0.85,
      scope,
      source: "agent",
      debugFraming: {
        rootCause: "implicit_assumption",
        whyPriorFixFailed: `以为 ${SECRET} 有写权限`,
        defense: `CI 里检查 ${SECRET} 的权限范围`,
        systematicExtension: `别的工作流也用了 ${SECRET}`,
        knowledgeFix: `运维手册写明 ${SECRET} 已作废`,
      },
    });

    const [row] = await h.rows(scope);
    expectNoSecret("row text", row.text);
    expectNoSecret("row metadata", row.metadata);
    const meta = JSON.parse(row.metadata) as {
      caseMemory: { title: string; tools: string[] };
      debugFraming: { rootCause: string; defense: string };
    };
    expect(meta.caseMemory.title).toBe("推送失败 [REDACTED:github_token]");
    expect(meta.caseMemory.tools).toEqual(["git", "[REDACTED:github_token]"]);
    expect(meta.debugFraming.rootCause).toBe("implicit_assumption");
    expect(meta.debugFraming.defense).toBe("CI 里检查 [REDACTED:github_token] 的权限范围");
    for (const s of h.embedded) expectNoSecret("embed input", s);
    expectNoSecret("returned record", JSON.stringify(result));
  });

  it("adds no optional keys when the caller left them out", async () => {
    const h = harness();
    const result = await persistCaseMemory(h.deps, {
      title: "本地测试缺配置",
      problem: "新 worktree 里 ingest-scope-prefix 整文件不跑",
      solutionSteps: ["cp config.json.example config.json"],
      scope: "project:redact",
    });
    const keys = Object.keys(result);
    for (const k of ["context", "outcome", "debugFraming"]) expect(keys).not.toContain(k);
  });
});

describe("persistWorkflowPattern redacts structured metadata", () => {
  it("no field of workflowPattern or tags keeps the raw token", async () => {
    const h = harness();
    const scope = "project:redact";
    const result = await persistWorkflowPattern(h.deps, {
      title: `轮换 ${SECRET}`,
      trigger: `看到 ${SECRET} 出现在日志里`,
      steps: [`吊销 ${SECRET}`, "签发新令牌", "更新 CI 密钥"],
      outcome: `${SECRET} 作废`,
      tools: ["gh", SECRET],
      tags: ["security", SECRET],
      canonicalKey: `rotate-${SECRET}`,
      scope,
    });

    const [row] = await h.rows(scope);
    expectNoSecret("row text", row.text);
    expectNoSecret("row metadata", row.metadata);
    expect(row.metadata.toLowerCase()).not.toContain(SECRET_BODY.toLowerCase());
    const meta = JSON.parse(row.metadata) as { workflowPattern: { trigger: string; steps: string[] } };
    expect(meta.workflowPattern.trigger).toBe("看到 [REDACTED:github_token] 出现在日志里");
    expect(meta.workflowPattern.steps[0]).toBe("吊销 [REDACTED:github_token]");
    for (const s of h.embedded) expectNoSecret("embed input", s);
    expectNoSecret("returned record", JSON.stringify(result));
  });
});

describe("promoteMemory redacts tags and explicit canonicalKey", () => {
  it("the promoted row's metadata keeps neither", async () => {
    const h = harness();
    const evidenceScope = "cc:redact-session";
    const evidence = await h.store.store({
      text: "会话里定下来：发布令牌只放在密钥管理里，脚本按名字取",
      vector: [1, 2, 0.5],
      category: "events",
      scope: evidenceScope,
      importance: 0.6,
      metadata: "{}",
    });
    const scope = "project:redact";
    const result = await promoteMemory(h.deps, {
      memoryId: evidence.id,
      scope,
      tags: ["release", SECRET],
      canonicalKey: `release-${SECRET}`,
    });

    const [row] = await h.rows(scope);
    expectNoSecret("row metadata", row.metadata);
    expect(row.metadata.toLowerCase()).not.toContain(SECRET_BODY.toLowerCase());
    expect(JSON.parse(row.metadata).tags).toEqual(["release", "[REDACTED:github_token]"]);
    expectNoSecret("returned record", JSON.stringify(result));
  });
});

// ============================================================================
// Fixes after review（2026-10-17，owner 请的独立 reviewer）
// ============================================================================

/** 主表里已有的一行，形状照改动前的 persistMemory 写出来的样子（id 不是确定性 id）。 */
async function seedLegacyRow(
  store: MemoryStore,
  params: { id: string; scope: string; text: string; category: "events" | "patterns"; canonicalKey: string },
): Promise<void> {
  await store.store({
    id: params.id,
    text: params.text,
    vector: [1, 2, 0.5],
    category: params.category,
    scope: params.scope,
    importance: 0.8,
    metadata: buildStructuredMetadata({
      source: "manual",
      tags: [],
      capture: "store_memory_schema_v1",
      category: params.category,
      canonicalKey: params.canonicalKey,
    }),
  });
}

describe("review 1: ordinary dotted canonical keys are kept", () => {
  it("field mode keeps a dotted identifier; prose mode and real tokens are unchanged", () => {
    expect(redactSecrets("workflow.database.recovery", { keepIdentifiers: true })).toEqual({
      text: "workflow.database.recovery",
      redacted: 0,
    });
    // 正文仍按原规则逐字节不变
    expect(redactSecrets("workflow.database.recovery").text).toBe("[REDACTED:segmented_token]");
    // 真的分段 token（大小写混着数字）照样脱敏
    const opaque = "aB3dE9fG" + ".Hj2kL5mN" + ".pQ7rS1tU";
    expect(redactSecrets(`key ${opaque}`, { keepIdentifiers: true }).text).toBe("key [REDACTED:segmented_token]");
    // 豁免只管 segmented_token：长得像点分标识符的密码值仍被密码规则抓住
    const pw = redactSecrets("password=workflow.database.recovery", { keepIdentifiers: true });
    expect(pw.text).toBe("password=[REDACTED:password]");
  });

  it("persistMemory resubmitting identical content with workflow.database.recovery dedupes onto the existing row", async () => {
    const h = harness();
    const scope = "project:redact";
    const text = "数据库恢复流程：先停写、再从最近一次快照回放日志，最后核对行数";
    const seedId = "11111111-2222-4333-8444-555555555555";
    await seedLegacyRow(h.store, { id: seedId, scope, text, category: "events", canonicalKey: "workflow-database-recovery" });

    const result = await persistMemory(h.deps, {
      text,
      category: "events",
      importance: 0.8,
      scope,
      source: "manual",
      canonicalKey: "workflow.database.recovery",
    });

    expect(result.disposition).toBe("deduped");
    expect(result.id).toBe(seedId);
    expect(result.canonicalKey).toBe("workflow-database-recovery");
    expect((await h.rows(scope)).map((r) => r.id)).toEqual([seedId]);
  });

  it("persistWorkflowPattern resubmitting identical content with workflow.database.recovery dedupes onto the existing row", async () => {
    const input = {
      title: "数据库恢复",
      trigger: "主库写入失败且副本落后",
      steps: ["停写", "从快照回放日志", "核对行数"],
      scope: "project:redact",
      canonicalKey: "workflow.database.recovery",
    };
    // 先在另一个库里取到这组字段拼出的正文，再在被测库里照旧形状种一行
    const probe = harness();
    const builtText = (await persistWorkflowPattern(probe.deps, input)).text;

    const h = harness();
    const seedId = "66666666-7777-4888-9999-000000000000";
    await seedLegacyRow(h.store, { id: seedId, scope: input.scope, text: builtText, category: "patterns", canonicalKey: "workflow-database-recovery" });
    const result = await persistWorkflowPattern(h.deps, input);

    expect(result.disposition).toBe("deduped");
    expect(result.id).toBe(seedId);
    expect((await h.rows(input.scope)).map((r) => r.id)).toEqual([seedId]);
  });

  it("a dotted identifier inside a trigger stays as written", () => {
    expect(normalizeTriggerTexts(["workflow.database.recovery 那套流程怎么走"])).toEqual([
      "workflow.database.recovery 那套流程怎么走",
    ]);
  });

  it("a dotted identifier tag stays as written", async () => {
    const h = harness();
    const scope = "project:redact";
    await persistMemory(h.deps, {
      text: "恢复演练每季度一次，演练记录放到运维仓库的 drills 目录",
      category: "events",
      importance: 0.8,
      scope,
      source: "manual",
      tags: ["workflow.database.recovery"],
    });
    const [row] = await h.rows(scope);
    expect(JSON.parse(row.metadata).tags).toEqual(["workflow.database.recovery"]);
  });
});

describe("review 2: trigger backfill redacts the whole source before splitting", () => {
  const PASSWORD = "Hunter2" + "Secret99";
  const LEGACY_TEXT = `连内部库的办法记在这里，账号是运维组的共享账号。\n\n检索锚点：怎么连 https://alice:${PASSWORD}@db.internal`;

  it("extractTriggerCandidates never yields the scheme-less user:password@host fragment", () => {
    const candidates = extractTriggerCandidates(LEGACY_TEXT);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c).not.toContain(PASSWORD);
    expect(candidates.some((c) => c.includes("[REDACTED:uri_credentials]"))).toBe(true);
  });

  it("the backfill path (extract → upsertForMemory) embeds and stores no credential", async () => {
    const h = harness();
    const payload: string[] = [];
    // 与 cli.ts triggers-backfill 同一条路：抠候选 → upsertForMemory（嵌入 + 侧表）
    const texts = extractTriggerCandidates(LEGACY_TEXT);
    await h.triggerStore.upsertForMemory("legacy-1", "memory:pivot", texts, async (batch) => {
      payload.push(...batch);
      return batch.map(() => [1, 1, 1]);
    });
    expect(payload.length).toBeGreaterThan(0);
    for (const s of payload) expect(s).not.toContain(PASSWORD);
    for (const t of await h.triggerRows()) expect(t).not.toContain(PASSWORD);
  });
});
