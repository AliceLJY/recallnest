import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  CHECKPOINT_MIRROR_SCOPE,
  backfillCheckpointMirror,
  buildCheckpointMirrorText,
  checkpointMirrorId,
  checkpointMirrorKey,
  mirrorCheckpoint,
  mirrorCheckpointWithDeadline,
  type CheckpointMirrorDeps,
} from "../checkpoint-mirror.js";
import { DEFAULT_DREAM_CONFIG, runDream } from "../dream-pipeline.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { resolveExcludedScopes } from "../memory-boundaries.js";
import { createRetriever } from "../retriever.js";
import type { SessionCheckpointRecord } from "../session-schema.js";
import { FALLBACK_SUMMARY } from "../session-engine.js";
import { SessionCheckpointStore } from "../session-store.js";
import { MemoryStore } from "../store.js";

/**
 * checkpoint 镜像（2026-10-07）：checkpoint 存完后按会话镜像一行进记忆库，让 search_memory 搜得到。
 * 方案与三方互审：sync-bridge AI产出/2026-10-07-RecallNest第一下命中率/plan-checkpoint镜像.md 与 mr-checkpoint镜像/。
 * 库一律是临时目录里的真实 LanceDB；嵌入是本地假向量，不调接口。
 */

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.RECALLNEST_CHECKPOINT_MIRROR;
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function record(overrides: Partial<SessionCheckpointRecord> = {}): SessionCheckpointRecord {
  return {
    checkpointId: "chk-1",
    sessionId: "session-a",
    resolvedScope: "session:session-a",
    task: "上线 checkpoint 镜像",
    summary: "方案写好，等互审",
    decisions: ["scope 用 checkpoint"],
    openLoops: ["排序试验结果"],
    nextActions: ["发 R1", "写测试"],
    entities: ["RecallNest", "Codex"],
    files: ["/tmp/should-not-appear.md"],
    updatedAt: "2026-10-06T17:30:00.000Z",
    ...overrides,
  };
}

interface Harness {
  store: MemoryStore;
  deps: CheckpointMirrorDeps;
  embedCalls: string[];
  offFile: string;
  rows: () => Promise<Array<{ id: string; text: string; timestamp: number; metadata: Record<string, unknown> }>>;
}

function harness(embedImpl?: (text: string) => Promise<number[]>): Harness {
  const dir = tempDir("rn-ckpt-mirror-");
  const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
  const embedCalls: string[] = [];
  const offFile = join(dir, "checkpoint-mirror.off");
  const embedPassage = async (text: string) => {
    embedCalls.push(text);
    return embedImpl ? embedImpl(text) : [1, (text.length % 7) + 1, 0.5];
  };
  return {
    store,
    embedCalls,
    offFile,
    deps: { store, embedder: { embedPassage }, offFile, lockDir: join(dir, "locks") },
    async rows() {
      const listed = await store.list([CHECKPOINT_MIRROR_SCOPE], undefined, 1000, 0, "exact");
      return listed.map((row) => ({ id: row.id, text: row.text, timestamp: row.timestamp, metadata: JSON.parse(row.metadata || "{}") }));
    },
  };
}

describe("entry text", () => {
  it("date (Beijing time) + task, summary, three lists, entities; no files, no labels", () => {
    expect(buildCheckpointMirrorText(record())).toBe([
      "2026-10-07 上线 checkpoint 镜像",
      "方案写好，等互审",
      "scope 用 checkpoint",
      "排序试验结果",
      "发 R1；写测试",
      "RecallNest、Codex",
    ].join("\n"));
  });

  it("empty parts drop out; no task leaves only the date", () => {
    const text = buildCheckpointMirrorText(record({ task: undefined, decisions: [], openLoops: [], entities: [] }));
    expect(text).toBe("2026-10-07\n方案写好，等互审\n发 R1；写测试");
    expect(text).not.toMatch(/summary|decisions|openLoops|nextActions|entities|checkpoint:/i);
  });
});

describe("key and id", () => {
  it("distinct sessions never share a key (case, punctuation, length past 120)", () => {
    const long = "x".repeat(130);
    const pairs: Array<[string, string]> = [["task_a", "task-a"], ["ABC", "abc"], [`${long}1`, `${long}2`]];
    for (const [a, b] of pairs) {
      expect(checkpointMirrorKey(a)).not.toBe(checkpointMirrorKey(b));
      expect(checkpointMirrorId(a)).not.toBe(checkpointMirrorId(b));
    }
    expect(checkpointMirrorKey("session-a")).toBe(checkpointMirrorKey("session-a"));
    expect(checkpointMirrorKey("session-a")).toMatch(/^checkpoint-[0-9a-f]{32}$/);
  });
});

describe("mirrorCheckpoint", () => {
  it("stores one row with the trial's data model", async () => {
    const h = harness();
    const result = await mirrorCheckpoint(h.deps, record());
    expect(result.status).toBe("stored");
    const rows = await h.rows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toBe(checkpointMirrorId("session-a"));
    expect(row.timestamp).toBe(Date.parse("2026-10-06T17:30:00.000Z"));
    expect(row.metadata.boundary).toMatchObject({ layer: "session", authority: "session-checkpoint", conflictPolicy: "latest-wins" });
    expect(row.metadata).toMatchObject({
      source: "checkpoint", sessionId: "session-a", checkpointId: "chk-1", tier: "peripheral",
      resolvedScope: "session:session-a", checkpointMirror: true, canonicalKey: checkpointMirrorKey("session-a"),
      file: "session-checkpoints/2026-10-06T17-30-00-000Z-chk-1.json",
    });
    const full = await h.store.getById(row.id);
    expect(full?.category).toBe("events");
    expect(full?.importance).toBe(0.5);
  });

  it("a newer checkpoint of the same session replaces the row in place — no history rows", async () => {
    const h = harness();
    await mirrorCheckpoint(h.deps, record());
    const second = record({ checkpointId: "chk-2", summary: "互审完成，开始实现", updatedAt: "2026-10-06T19:00:00.000Z" });
    expect((await mirrorCheckpoint(h.deps, second)).status).toBe("replaced");
    const rows = await h.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("互审完成，开始实现");
    expect(rows[0].metadata.checkpointId).toBe("chk-2");
    expect(rows[0].timestamp).toBe(Date.parse("2026-10-06T19:00:00.000Z"));
  });

  it("an older checkpoint never overwrites a newer one, even after a same-text refresh (t1=A, t3=A, then t2=B)", async () => {
    const h = harness();
    const a1 = record({ checkpointId: "a1", updatedAt: "2026-10-06T10:00:00.000Z" });
    const a3 = record({ checkpointId: "a3", updatedAt: "2026-10-06T12:00:00.000Z" });
    const b2 = record({ checkpointId: "b2", summary: "旧状态 B", updatedAt: "2026-10-06T11:00:00.000Z" });
    expect((await mirrorCheckpoint(h.deps, a1)).status).toBe("stored");
    const embedsBefore = h.embedCalls.length;
    expect((await mirrorCheckpoint(h.deps, a3)).status).toBe("refreshed");
    expect(h.embedCalls.length).toBe(embedsBefore); // same text → vector reused
    expect((await mirrorCheckpoint(h.deps, b2)).status).toBe("skipped-stale");
    const [row] = await h.rows();
    expect(row.metadata.checkpointId).toBe("a3");
    expect(row.text).not.toContain("旧状态 B");
    expect(row.timestamp).toBe(Date.parse("2026-10-06T12:00:00.000Z"));
  });

  it("the same version again is unchanged and embeds nothing", async () => {
    const h = harness();
    await mirrorCheckpoint(h.deps, record());
    const embeds = h.embedCalls.length;
    expect((await mirrorCheckpoint(h.deps, record())).status).toBe("unchanged");
    expect(h.embedCalls.length).toBe(embeds);
  });

  it("minimal checkpoints are not mirrored", async () => {
    const h = harness();
    const minimal = record({ summary: FALLBACK_SUMMARY, decisions: [], openLoops: [], nextActions: [] });
    expect((await mirrorCheckpoint(h.deps, minimal)).status).toBe("skipped-minimal");
    expect(await h.rows()).toHaveLength(0);
  });

  it("an embedding failure comes back as status failed and never throws", async () => {
    const h = harness(async () => { throw new Error("embedding endpoint down"); });
    const result = await mirrorCheckpoint(h.deps, record());
    expect(result).toEqual({ status: "failed", error: "embedding endpoint down" });
    expect(await h.rows()).toHaveLength(0);
  });

  it("credential-shaped text is redacted before it reaches the embedder or the table", async () => {
    const h = harness();
    const secret = "q".repeat(12);
    const url = `https://demo:${secret}@example.invalid/hook`;
    await mirrorCheckpoint(h.deps, record({ summary: `调了 ${url} 之后通了` }));
    expect(h.embedCalls.join("\n")).not.toContain(secret);
    const [row] = await h.rows();
    expect(row.text).not.toContain(secret);
  });

  it("an older request whose embedding finishes last does not overwrite the newer row", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(async (text) => {
      if (text.includes("慢的旧版")) await gate;
      return [1, 2, 3];
    });
    const older = mirrorCheckpoint(h.deps, record({ checkpointId: "old", summary: "慢的旧版", updatedAt: "2026-10-06T10:00:00.000Z" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await mirrorCheckpoint(h.deps, record({ checkpointId: "new", summary: "新版", updatedAt: "2026-10-06T11:00:00.000Z" }))).status).toBe("stored");
    release();
    expect((await older).status).toBe("skipped-stale");
    const [row] = await h.rows();
    expect(row.metadata.checkpointId).toBe("new");
  });
});

describe("kill switch", () => {
  it("RECALLNEST_CHECKPOINT_MIRROR=off disables it; other values do not", async () => {
    const h = harness();
    process.env.RECALLNEST_CHECKPOINT_MIRROR = "off";
    expect((await mirrorCheckpoint(h.deps, record())).status).toBe("disabled");
    process.env.RECALLNEST_CHECKPOINT_MIRROR = "OFF";
    expect((await mirrorCheckpoint(h.deps, record())).status).toBe("stored");
  });

  it("the off file disables it without a restart", async () => {
    const h = harness();
    writeFileSync(h.offFile, "");
    expect((await mirrorCheckpoint(h.deps, record())).status).toBe("disabled");
    expect(h.embedCalls).toHaveLength(0);
    expect(await h.rows()).toHaveLength(0);
  });

  it("switching off while an embedding is in flight keeps that write out (rollback after scope delete)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(async () => { await gate; return [1, 2, 3]; });
    const inflight = mirrorCheckpoint(h.deps, record());
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(h.offFile, "");
    release();
    expect((await inflight).status).toBe("disabled");
    expect(await h.rows()).toHaveLength(0);
  });
});

describe("mirrorCheckpointWithDeadline", () => {
  it("stops waiting at the deadline while the write finishes in the background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(async () => { await gate; return [1, 2, 3]; });
    const started = Date.now();
    const outcome = await mirrorCheckpointWithDeadline(() => h.deps, record(), 50);
    expect(outcome.status).toBe("pending");
    expect(Date.now() - started).toBeLessThan(2_000);
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await h.rows()).toHaveLength(1);
  });

  it("a failing component factory is caught", async () => {
    const outcome = await mirrorCheckpointWithDeadline(() => { throw new Error("no embedder configured"); }, record(), 50);
    expect(outcome).toEqual({ status: "failed", error: "no embedder configured" });
  });
});

describe("checkpoint_session tool", () => {
  function toolHarness(getComponents: () => unknown) {
    const tools = new Map<string, { schema: z.ZodRawShape; handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }>();
    const dir = tempDir("rn-ckpt-tool-");
    const checkpointStore = new SessionCheckpointStore(join(dir, "session-checkpoints"));
    registerCoreTools({
      registerTool(name: string, _description: string, schema: z.ZodRawShape, handler: never) {
        tools.set(name, { schema, handler });
      },
      getComponents,
      config: {},
      checkpointStore,
      workflowObservationStore: { async save() {} },
      toolDescriptions: new Map(),
      toolTiers: {},
      getKGExtractor: () => null,
      getKGStore: () => null,
    } as never);
    const tool = tools.get("checkpoint_session")!;
    return {
      checkpointStore,
      call: (input: Record<string, unknown>) => tool.handler(z.object(tool.schema).parse(input)),
    };
  }

  it("saves and answers exactly as before when the mirror cannot even get its components", async () => {
    const t = toolHarness(() => { throw new Error("components unavailable"); });
    const out = await t.call({ sessionId: "s-tool", summary: "工具层测试", nextActions: ["继续"] });
    expect(out.content[0].text).toContain("s-tool");
    const saved = await t.checkpointStore.listRecent({ sessionId: "s-tool" });
    expect(saved).toHaveLength(1);
  });

  it("saves and answers when the embedder throws, and mirrors when it works", async () => {
    const broken = harness(async () => { throw new Error("embedding endpoint down"); });
    const t1 = toolHarness(() => ({ store: broken.store, embedder: broken.deps.embedder }));
    const out = await t1.call({ sessionId: "s-broken", summary: "嵌入挂了也要存", nextActions: ["继续"] });
    expect(out.content[0].text).toContain("s-broken");
    expect(await t1.checkpointStore.listRecent({ sessionId: "s-broken" })).toHaveLength(1);
    expect(await broken.rows()).toHaveLength(0);

    const ok = harness();
    const t2 = toolHarness(() => ({ store: ok.store, embedder: ok.deps.embedder }));
    await t2.call({ sessionId: "s-ok", summary: "正常镜像", nextActions: ["继续"] });
    const rows = await ok.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.sessionId).toBe("s-ok");
  });
});

describe("HTTP /v1/checkpoint", () => {
  it("handleCheckpoint mirrors after the save and before the 201, through the never-throwing wrapper", () => {
    const src = readFileSync(join(import.meta.dir, "..", "api-server.ts"), "utf-8");
    const body = src.slice(src.indexOf("async function handleCheckpoint"), src.indexOf("async function handleWorkflowObserve"));
    const save = body.indexOf("checkpointStore.save(");
    const mirror = body.indexOf("mirrorCheckpointWithDeadline(");
    const respond = body.indexOf("jsonResponse(stored, 201)");
    expect(save).toBeGreaterThan(0);
    expect(mirror).toBeGreaterThan(save);
    expect(respond).toBeGreaterThan(mirror);
    expect(body).not.toContain("mirrorCheckpoint(");
  });
});

describe("retrieval", () => {
  const embedQuery = async (text: string) => (text.includes("做到哪") ? [1, 0, 0] : [0, 1, 0]);
  const embedder = { embedQuery, embedPassage: embedQuery } as never;
  const retrieverOf = (store: MemoryStore) => createRetriever(store, embedder, {
    mode: "vector", rerank: "none", filterNoise: false, sourceDiversity: 0, hotnessWeight: 0, utilityWeight: 0,
  });

  it("mirror rows come back from an unscoped search (session layer passes layer admission)", async () => {
    const h = harness(async () => [1, 0.01, 0]);
    await mirrorCheckpoint(h.deps, record());
    const results = await retrieverOf(h.store).retrieve({ query: "做到哪了", limit: 5, source: "auto-recall" });
    expect(results.map((r) => r.entry.id)).toContain(checkpointMirrorId("session-a"));
  });

  it("mirror rows do not take candidate slots from a non-events category search", async () => {
    const h = harness(async () => [1, 0.001, 0]);
    for (let i = 0; i < 25; i++) {
      await mirrorCheckpoint(h.deps, record({ sessionId: `crowd-${i}`, checkpointId: `c-${i}`, summary: `会话 ${i} 做到第 ${i} 步` }));
    }
    await h.store.upsert({
      id: "00000000-0000-0000-0000-0000000000f1", text: "复用流程：先方案后互审再实现", vector: [0.8, 0.6, 0], category: "patterns",
      scope: "memory:pivot", importance: 0.7, timestamp: Date.now(), metadata: "{}",
    });
    const retriever = retrieverOf(h.store);
    const patterns = await retriever.retrieve({ query: "做到哪了", limit: 3, category: "patterns", source: "auto-recall" });
    expect(patterns.map((r) => r.entry.id)).toContain("00000000-0000-0000-0000-0000000000f1");
    // Calibration: without the exclusion the 25 closer mirror rows fill the 20-slot pool and the pattern is lost.
    const raw = await h.store.vectorSearch([1, 0, 0], 20, 0.1);
    expect(raw.every((r) => r.entry.scope === CHECKPOINT_MIRROR_SCOPE)).toBe(true);
  });

  it("the exclusion is pushed into the vector query, so even a pool flooded past the 10x over-fetch keeps the other rows", async () => {
    const dir = tempDir("rn-ckpt-flood-");
    const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
    await store.storeBatch(Array.from({ length: 210 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, text: `镜像 ${i}`, vector: [1, 0.0001 * i, 0], category: "events" as const,
      scope: CHECKPOINT_MIRROR_SCOPE, importance: 0.5, metadata: "{}",
    })));
    await store.upsert({
      id: "00000000-0000-0000-0000-0000000000f2", text: "复用流程", vector: [0.8, 0.6, 0], category: "patterns",
      scope: "memory:pivot", importance: 0.7, timestamp: Date.now(), metadata: "{}",
    });
    // Calibration: 210 closer rows exceed the 200-row over-fetch, so without exclusion the pattern is not even fetched.
    expect((await store.vectorSearch([1, 0, 0], 20, 0.1)).some((r) => r.entry.scope === "memory:pivot")).toBe(false);
    const excluded = await store.vectorSearch([1, 0, 0], 20, 0.1, undefined, undefined, [CHECKPOINT_MIRROR_SCOPE]);
    expect(excluded.map((r) => r.entry.id)).toEqual(["00000000-0000-0000-0000-0000000000f2"]);
  });

  it("resolveExcludedScopes adds the mirror scope only for non-events category filters", () => {
    expect(resolveExcludedScopes({})).toEqual([]);
    expect(resolveExcludedScopes({ category: "events" })).toEqual([]);
    expect(resolveExcludedScopes({ category: "patterns" })).toEqual([CHECKPOINT_MIRROR_SCOPE]);
    expect(resolveExcludedScopes({ excludeScopes: ["x"], category: "cases" }).sort()).toEqual([CHECKPOINT_MIRROR_SCOPE, "x"].sort());
  });

  it("resume_context keeps every retrieval free of mirror rows", () => {
    const src = readFileSync(join(import.meta.dir, "..", "context-composer.ts"), "utf-8");
    const fn = src.slice(src.indexOf("async function retrieveCandidates"), src.indexOf("function mergeRetrievalResults"));
    const calls = fn.split("retriever.retrieve({").slice(1);
    expect(calls.length).toBe(3);
    for (const call of calls) {
      const end = call.indexOf("})", call.indexOf("source:"));
      expect(call.slice(0, end)).toContain("excludeScopes");
    }
    expect(src.split("retriever.retrieve(").length - 1).toBe(3);
  });
});

describe("dream", () => {
  it("never consolidates the mirror scope", async () => {
    expect(DEFAULT_DREAM_CONFIG.neverDreamScopes).toContain(CHECKPOINT_MIRROR_SCOPE);
    const h = harness();
    const result = await runDream({
      store: h.store as never,
      llm: {} as never,
      embedder: { embedPassage: async () => [1, 2, 3] } as never,
      scope: CHECKPOINT_MIRROR_SCOPE,
      force: true,
      scopeMatch: "exact",
      activityStatsPath: join(tempDir("rn-ckpt-dream-"), "activity-stats.json"),
    });
    expect(result.ran).toBe(false);
    expect(result.output.reason).toBe("policy_excluded");
  });
});

describe("backfill", () => {
  let dir: string;
  let checkpointStore: SessionCheckpointStore;
  beforeEach(() => {
    dir = tempDir("rn-ckpt-backfill-");
    checkpointStore = new SessionCheckpointStore(join(dir, "session-checkpoints"));
  });

  async function seed(): Promise<void> {
    // 30 sessions (more than listRecent's default page of 20), two rich versions each,
    // plus a newest minimal one for session 0 that must not win.
    for (let i = 0; i < 30; i++) {
      await checkpointStore.save(record({ sessionId: `s-${i}`, checkpointId: `s${i}-v1`, summary: `v1 of ${i}`, updatedAt: `2026-10-0${1 + (i % 5)}T01:00:00.000Z` }));
      await checkpointStore.save(record({ sessionId: `s-${i}`, checkpointId: `s${i}-v2`, summary: `v2 of ${i}`, updatedAt: `2026-10-0${1 + (i % 5)}T02:00:00.000Z` }));
    }
    await checkpointStore.save(record({ sessionId: "s-0", checkpointId: "s0-min", summary: FALLBACK_SUMMARY, decisions: [], openLoops: [], nextActions: [], updatedAt: "2026-10-06T00:00:00.000Z" }));
  }

  it("mirrors each session's newest rich checkpoint once; a re-run changes nothing; timestamps are updatedAt", async () => {
    await seed();
    const h = harness();
    const records = await checkpointStore.listRecent({ limit: Number.MAX_SAFE_INTEGER });
    expect(records).toHaveLength(61);
    const first = await backfillCheckpointMirror(h.deps, records);
    expect(first).toMatchObject({ checkpoints: 61, sessions: 30, sessionsWithoutRich: 0, statuses: { stored: 30 } });
    const rows = await h.rows();
    expect(rows).toHaveLength(30);
    const s0 = rows.find((row) => row.metadata.sessionId === "s-0")!;
    expect(s0.metadata.checkpointId).toBe("s0-v2");
    expect(s0.timestamp).toBe(Date.parse("2026-10-01T02:00:00.000Z"));
    const embeds = h.embedCalls.length;
    const second = await backfillCheckpointMirror(h.deps, records);
    expect(second.statuses).toEqual({ unchanged: 30 });
    expect(h.embedCalls.length).toBe(embeds);
  });

  it("a dry run counts what would happen and writes nothing", async () => {
    await seed();
    const h = harness();
    const records = await checkpointStore.listRecent({ limit: Number.MAX_SAFE_INTEGER });
    const result = await backfillCheckpointMirror(h.deps, records, { dryRun: true });
    expect(result.statuses).toEqual({ "would-embed": 30 });
    expect(h.embedCalls).toHaveLength(0);
    expect(await h.rows()).toHaveLength(0);
  });
});

describe("after the third review round (R3)", () => {
  it("upsertUnlessNewer never moves a row back in time (the merge's own condition)", async () => {
    const dir = tempDir("rn-ckpt-unless-");
    const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
    const row = (timestamp: number, text: string) => ({
      id: "00000000-0000-0000-0000-0000000000a1", text, vector: [1, 0, 0], category: "events" as const,
      scope: CHECKPOINT_MIRROR_SCOPE, importance: 0.5, timestamp, metadata: "{}",
    });
    expect(await store.upsertUnlessNewer(row(200, "v200"))).toBe(true);
    expect(await store.upsertUnlessNewer(row(100, "v100"))).toBe(false);
    expect((await store.getById("00000000-0000-0000-0000-0000000000a1"))?.text).toBe("v200");
    expect(await store.upsertUnlessNewer(row(200, "v200b"))).toBe(true);
    expect(await store.upsertUnlessNewer(row(300, "v300"))).toBe(true);
    expect((await store.getById("00000000-0000-0000-0000-0000000000a1"))?.text).toBe("v300");
  });

  it("a writer whose view went stale (e.g. its lock expired) still cannot overwrite a newer row", async () => {
    const h = harness();
    await mirrorCheckpoint(h.deps, record({ checkpointId: "new", summary: "新版", updatedAt: "2026-10-06T11:00:00.000Z" }));
    // Simulate a writer that read the row before the newer one landed: its reads see nothing.
    const staleView: CheckpointMirrorDeps = { ...h.deps, store: { getById: async () => null, upsertUnlessNewer: (e) => h.store.upsertUnlessNewer(e) } };
    const result = await mirrorCheckpoint(staleView, record({ checkpointId: "old", summary: "旧版", updatedAt: "2026-10-06T10:00:00.000Z" }));
    expect(result.status).toBe("skipped-stale");
    const [row] = await h.rows();
    expect(row.metadata.checkpointId).toBe("new");
  });

  it("mirror rows stay out of the canonical-match scan window, so a cross-category write still conflicts", async () => {
    const dir = tempDir("rn-ckpt-window-");
    const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
    const now = Date.now();
    const KEY = "entities-window-edge-target";
    await store.upsert({
      id: "00000000-0000-0000-0000-0000000000b1", text: "窗口边缘的 durable 行", vector: [0, 1, 0], category: "entities",
      scope: "memory:pivot", importance: 0.7, timestamp: now - 10_000,
      metadata: JSON.stringify({ canonicalKey: KEY, boundary: { layer: "durable", authority: "structured-memory", conflictPolicy: "latest-wins", originalCategory: "entities" } }),
    });
    await store.storeBatch(Array.from({ length: 999 }, (_, i) => ({
      id: `00000000-0000-0000-0000-1${String(i).padStart(11, "0")}`, text: `填充 ${i}`, vector: [0, 0, 1], category: "events" as const,
      scope: "memory:filler", importance: 0.5, metadata: "{}",
    })));
    await store.upsert({
      id: checkpointMirrorId("window-session"), text: "镜像行", vector: [1, 0, 0], category: "events", scope: CHECKPOINT_MIRROR_SCOPE,
      importance: 0.5, timestamp: now + 60_000, metadata: JSON.stringify({ checkpointMirror: true, boundary: { layer: "session", authority: "session-checkpoint", conflictPolicy: "latest-wins" } }),
    });
    // Calibration: without the exclusion the target is pushed out of the newest-1000 window.
    expect((await store.list(undefined, undefined, 1000, 0)).some((e) => e.id === "00000000-0000-0000-0000-0000000000b1")).toBe(false);
    expect((await store.list(undefined, undefined, 1000, 0, undefined, [CHECKPOINT_MIRROR_SCOPE])).some((e) => e.id === "00000000-0000-0000-0000-0000000000b1")).toBe(true);
    const conflicts: unknown[] = [];
    const { writeDurableEntry } = await import("../capture-engine.js");
    const out = await writeDurableEntry({
      store,
      embedder: { embedPassage: async () => [0, 1, 0] },
      conflictStore: {
        async save(r: unknown) { conflicts.push(r); return r as never; },
        async replace(r: unknown) { return r as never; },
        async getOpenByFingerprint() { return null; },
        async getLatestByFingerprint() { return null; },
      } as never,
    }, {
      text: "同 key 另一类别", vector: [0, 1, 0], category: "events", scope: "memory:pivot", importance: 0.7,
      metadata: "{}", canonicalKey: KEY, source: "agent",
    });
    expect(out.disposition).toBe("conflict");
    expect(conflicts).toHaveLength(1);
  });

  it("purge turns the mirror off and deletes exactly scope `checkpoint`, waiting for an in-flight locked write", async () => {
    const dir = tempDir("rn-ckpt-purge-");
    const dbPath = join(dir, "db");
    const lockDir = join(dir, "locks");
    const offFile = join(dir, "checkpoint-mirror.off");
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    const deps: CheckpointMirrorDeps = { store, embedder: { embedPassage: async () => [1, 2, 3] }, offFile, lockDir };
    await mirrorCheckpoint(deps, record({ sessionId: "p1" }));
    await mirrorCheckpoint(deps, record({ sessionId: "p2" }));
    for (const scope of ["checkpoint-other", "checkpoint:family"]) {
      await store.upsert({ id: checkpointMirrorId(scope), text: scope, vector: [1, 1, 1], category: "events", scope, importance: 0.5, timestamp: Date.now(), metadata: "{}" });
    }
    const { withWriteLock } = await import("../distill-lock.js");
    let releasedAt = 0;
    const holder = withWriteLock("checkpoint-mirror-write", async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      releasedAt = Date.now();
    }, { lockDir });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { purgeCheckpointMirror } = await import("../checkpoint-mirror.js");
    const result = await purgeCheckpointMirror(dbPath, { offFile, lockDir });
    const purgedAt = Date.now();
    await holder;
    expect(releasedAt).toBeGreaterThan(0);
    expect(purgedAt).toBeGreaterThanOrEqual(releasedAt); // it waited for the in-flight locked write
    expect(result).toEqual({ rowsBefore: 2, rowsAfter: 0 });
    const left = (await store.list(undefined, undefined, 100, 0)).map((e) => e.scope).sort();
    expect(left).toEqual(["checkpoint-other", "checkpoint:family"]);
    expect((await mirrorCheckpoint(deps, record({ sessionId: "p3" }))).status).toBe("disabled");
  });

  it("a dry run against an existing store leaves every table version as it was", async () => {
    const h = harness();
    await mirrorCheckpoint(h.deps, record({ sessionId: "dry-1" }));
    const dbPath = (h.store as unknown as { dbPath: string }).dbPath;
    const { loadLanceDB } = await import("../store.js");
    const versions = async () => {
      const db = await (await loadLanceDB()).connect(dbPath);
      return Promise.all((await db.tableNames()).map(async (n) => `${n}:${await (await db.openTable(n)).version()}`));
    };
    const before = await versions();
    const { openReadOnlyMirrorReader } = await import("../checkpoint-mirror.js");
    const reader = await openReadOnlyMirrorReader(dbPath);
    const result = await backfillCheckpointMirror(
      { ...h.deps, store: { getById: (id) => reader.getById(id), upsertUnlessNewer: async () => { throw new Error("dry run does not write"); } } },
      [record({ sessionId: "dry-1" }), record({ sessionId: "dry-2" })],
      { dryRun: true },
    );
    expect(result.statuses).toEqual({ unchanged: 1, "would-embed": 1 });
    expect(await versions()).toEqual(before);
  });
});
