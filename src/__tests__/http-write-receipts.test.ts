import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  persistCaseMemory,
  persistMemoryBatch,
  persistWorkflowPattern,
  type PersistMemoryDeps,
} from "../capture-engine.js";
import type {
  StoredPromotedMemoryRecord,
  StoredWorkflowPatternRecord,
  WriteDisposition,
} from "../memory-schema.js";
import { MemoryStore } from "../store.js";
import {
  buildCaptureHttpResponse,
  buildPromoteHttpResponse,
  buildStructuredWriteHttpResponse,
} from "../store-receipts.js";

/**
 * HTTP /v1/capture、/v1/pattern、/v1/case、/v1/promote 的回执与 /v1/store 同一条规则：
 * 只有 disposition 是 stored / updated / promoted 才回 201 与 `stored: true`；
 * capture 的 `stored` 是真写进主表的条数。
 *
 * 真实临时 LanceDB + 本地假向量：回执说写了几行，拿表里实际的行数核对。
 * 另有四个 handler 的源码守卫，确认它们用的就是这里测的函数。
 */

const SCOPE = "project:http-receipt-test";
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SAME_VECTOR = [1, 0, 0];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "rn-http-receipts-"));
  tmpDirs.push(dir);
  const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
  const deps: PersistMemoryDeps = {
    store,
    embedder: { embedPassage: async () => SAME_VECTOR },
    noisePrototypeBank: null,
  };
  const rowCount = async (): Promise<number> =>
    (await store.list([SCOPE], undefined, 100, 0, "exact")).length;
  return { deps, rowCount };
}

const PATTERN = {
  title: "Cross-window continuity handoff",
  trigger: "When opening a fresh terminal window for the same project",
  steps: ["Call resume_context before coding", "Save checkpoint_session before leaving the window"],
  scope: SCOPE,
};

const CASE = {
  title: "Sparse startup context cleanup",
  problem: "resume_context returned noisy transcript fragments instead of a clean handoff",
  solutionSteps: ["Filter low-signal transcript fragments from stable recall"],
  scope: SCOPE,
};

describe("/v1/pattern and /v1/case report what actually landed", () => {
  it("pattern: first write is 201 stored:true, the identical second write is deduped → 200 stored:false", async () => {
    const h = harness();
    const first = await persistWorkflowPattern(h.deps, PATTERN);
    const second = await persistWorkflowPattern(h.deps, PATTERN);
    expect(first.disposition).toBe("stored");
    expect(second.disposition).toBe("deduped");
    expect(await h.rowCount()).toBe(1);

    const a = buildStructuredWriteHttpResponse(first);
    expect(a.status).toBe(201);
    expect(a.body.stored).toBe(true);

    const b = buildStructuredWriteHttpResponse(second);
    expect(b.status).toBe(200);
    expect(b.body.stored).toBe(false);
    expect(b.body.disposition).toBe("deduped");
    expect(b.body.id).toBe(first.id);
  }, 30_000);

  it("case: the identical second write is deduped → 200 stored:false", async () => {
    const h = harness();
    const first = await persistCaseMemory(h.deps, CASE);
    const second = await persistCaseMemory(h.deps, CASE);
    expect(second.disposition).toBe("deduped");
    expect(await h.rowCount()).toBe(1);

    expect(buildStructuredWriteHttpResponse(first)).toMatchObject({ status: 201, body: { stored: true } });
    expect(buildStructuredWriteHttpResponse(second)).toMatchObject({
      status: 200,
      body: { stored: false, disposition: "deduped", id: first.id },
    });
  }, 30_000);

  it("conflict is 200 stored:false; updated is 201 stored:true", () => {
    const base: StoredWorkflowPatternRecord = {
      ...PATTERN,
      tools: [],
      importance: 0.82,
      source: "agent",
      tags: ["workflow", "pattern"],
      canonicalKey: "patterns:cross-window",
      category: "patterns",
      text: "Workflow pattern: Cross-window continuity handoff",
      resolvedScope: SCOPE,
      id: "a1b2c3d4-0000-0000-0000-000000000000",
      storedAt: "2026-10-17T00:00:00.000Z",
      disposition: "stored",
    };
    const conflict = buildStructuredWriteHttpResponse({ ...base, disposition: "conflict", conflictId: "c-1" });
    expect(conflict).toMatchObject({ status: 200, body: { stored: false, conflictId: "c-1" } });
    expect(buildStructuredWriteHttpResponse({ ...base, disposition: "updated" })).toMatchObject({
      status: 201,
      body: { stored: true },
    });
  });
});

describe("/v1/promote", () => {
  it("stored is true and status 201 only for stored / updated / promoted", () => {
    const base: StoredPromotedMemoryRecord = {
      text: "User prefers concise, direct replies.",
      category: "preferences",
      importance: 0.78,
      scope: SCOPE,
      source: "agent",
      tags: [],
      privacyTier: "durable",
      canonicalKey: "user-reply-style",
      resolvedScope: SCOPE,
      id: "c0ffee00-0000-0000-0000-000000000000",
      storedAt: "2026-10-17T00:00:00.000Z",
      disposition: "promoted",
      sourceMemoryId: "12345678-1234-1234-1234-123456789abc",
      sourceCategory: "events",
    };
    const wrote: WriteDisposition[] = ["stored", "updated", "promoted"];
    const notWrote: WriteDisposition[] = ["deduped", "conflict", "rejected"];
    for (const disposition of wrote) {
      expect(buildPromoteHttpResponse({ ...base, disposition })).toMatchObject({ status: 201, body: { stored: true } });
    }
    for (const disposition of notWrote) {
      expect(buildPromoteHttpResponse({ ...base, disposition })).toMatchObject({
        status: 200,
        body: { stored: false, disposition, sourceMemoryId: base.sourceMemoryId },
      });
    }
  });
});

describe("/v1/capture", () => {
  it("stored counts only the items written to the table; rejected items carry rejectionReason", async () => {
    const h = harness();
    const records = await persistMemoryBatch(h.deps, {
      scope: SCOPE,
      source: "agent",
      defaultImportance: 0.7,
      memories: [
        { text: "First capture memory long enough to be admitted", category: "events" },
        { text: "short", category: "events" },
        { text: "First capture memory long enough to be admitted", category: "events" },
        { text: "Second capture memory long enough to be admitted", category: "entities" },
      ],
    });
    expect(records.map((r) => r.disposition)).toEqual(["stored", "rejected", "deduped", "stored"]);
    expect(await h.rowCount()).toBe(2);

    const res = buildCaptureHttpResponse(records);
    expect(res.status).toBe(201);
    expect(res.body.stored).toBe(2);
    const items = res.body.memories as Array<Record<string, unknown>>;
    expect(items.map((i) => i.disposition)).toEqual(["stored", "rejected", "deduped", "stored"]);
    expect(items[1].rejectionReason).toBe("text_too_short");
    expect(items.filter((i) => "rejectionReason" in i)).toHaveLength(1);
  }, 30_000);

  it("nothing written: status 200 and stored 0", async () => {
    const h = harness();
    const records = await persistMemoryBatch(h.deps, {
      scope: SCOPE,
      memories: [{ text: "short", category: "events" }, { text: "tiny", category: "events" }],
    });
    expect(await h.rowCount()).toBe(0);
    const res = buildCaptureHttpResponse(records);
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(0);
  }, 30_000);
});

describe("handlers use the receipt functions", () => {
  const api = readFileSync(join(import.meta.dir, "..", "api-server.ts"), "utf8");

  function handlerBody(name: string): string {
    const from = api.indexOf(`async function ${name}(`);
    expect(from).toBeGreaterThanOrEqual(0);
    const to = api.indexOf("\n}\n", from);
    expect(to).toBeGreaterThan(from);
    return api.slice(from, to);
  }

  it.each([
    ["handleCapture", "buildCaptureHttpResponse(stored)"],
    ["handlePattern", "buildStructuredWriteHttpResponse(stored)"],
    ["handleCase", "buildStructuredWriteHttpResponse(stored)"],
    ["handlePromote", "buildPromoteHttpResponse(stored)"],
  ])("%s answers with %s", (name, call) => {
    const body = handlerBody(name);
    expect(body).toContain(call);
    expect(body).toContain("jsonResponse(response.body, response.status)");
    expect(body).not.toContain("201");
    expect(body).not.toContain('disposition !== "conflict"');
  });
});
