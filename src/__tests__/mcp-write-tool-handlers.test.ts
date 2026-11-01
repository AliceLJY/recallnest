import { afterEach, describe, expect, it } from "bun:test";

import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import { buildSessionCheckpointResult } from "../session-engine.js";
import { createToolHarness, SAME_VECTOR, type ToolHarness } from "./helpers/mcp-tool-harness.js";

/**
 * 写工具 handler 冒烟测试（2026-10-17 体检第 9 条）。
 *
 * 以前 44 个工具里只有 6 个的 handler 在测试里被真正调用过，store_memory 等写工具只有源码 grep 守卫：
 * 从 store_memory 的 handler 里拿掉 triggerStore / embedQueryBatch，trigger 永远写不进侧表，
 * 全量测试照样全绿。这里经真实的 register*Tools 拿到 handler，在临时目录的真实 LanceDB 上调用，
 * 断言回执与表里的行对得上：回执说存了几条、挂了几条 trigger、判重 / 冲突 / 被拒了几条，
 * 表里（主表、trigger 侧表、conflict 存储）就得正好是那样。
 */

const ALL_TOOLS = [registerCoreTools, registerAdvancedTools, registerGovernanceTools];
const harnesses: ToolHarness[] = [];

function harness(): ToolHarness {
  const h = createToolHarness(ALL_TOOLS);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

async function onlyRow(h: ToolHarness, scope: string) {
  const rows = await h.store.list([scope], undefined, 200, 0, "exact");
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("store_memory handler", () => {
  const SCOPE = "project:tool-store-memory";

  it("stored with triggers: receipt id and trigger count equal the main-table row and its side-table rows", async () => {
    const h = harness();
    const text = await h.text("store_memory", {
      text: "RecallNest receipts now follow the write disposition",
      scope: SCOPE,
      triggers: ["回执怎么写的", "存没存成功怎么看"],
    });
    const lines = text.split("\n");

    const row = await onlyRow(h, SCOPE);
    expect(lines[0]).toBe(`Stored memory ${row.id.slice(0, 8)}`);
    expect(lines).toContain("Disposition: stored");
    // trigger 接线：handler 把 triggerStore 与 embedQueryBatch 交给写入端，侧表里真有这两行
    expect(lines).toContain("Triggers: 2");
    expect(await h.triggerStore.countForMemory(row.id)).toBe(2);
    expect(await h.triggerStore.stats([SCOPE])).toEqual({ rows: 2, memories: 1 });
  }, 30_000);

  it("rejected: receipt says Not stored, nothing lands in either table", async () => {
    const h = harness();
    const text = await h.text("store_memory", {
      text: "too short",
      scope: SCOPE,
      triggers: ["那个太短的东西是什么", "之前存过的短句"],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Not stored: rejected (text_too_short)");
    expect(lines).toContain("Disposition: rejected");
    expect(lines).toContain("Triggers: 0 of 2 written (nothing was stored)");
    expect(await h.rowCount(SCOPE)).toBe(0);
    expect(await h.triggerStore.stats([SCOPE])).toEqual({ rows: 0, memories: 0 });
  }, 30_000);

  it("deduped preference: receipt names the existing row, table keeps one row, no triggers attached", async () => {
    const h = harness();
    await h.text("store_memory", {
      text: "User prefers dark editor themes in every tool",
      category: "preferences",
      scope: SCOPE,
    });
    const first = await onlyRow(h, SCOPE);

    const text = await h.text("store_memory", {
      text: "User likes a dark theme for all editors",
      category: "preferences",
      scope: SCOPE,
      triggers: ["她编辑器用什么主题", "深色还是浅色"],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Not stored: duplicate of existing memory ${first.id}`);
    expect(lines).toContain("Disposition: deduped");
    expect(lines).toContain(`Triggers: 0 of 2 written (none attached to memory ${first.id.slice(0, 8)})`);
    expect(await h.rowCount(SCOPE)).toBe(1);
    expect(await h.triggerStore.countForMemory(first.id)).toBe(0);
  }, 30_000);

  it("canonical-key conflict: receipt says Not stored, row count unchanged, the conflict id is in the conflict store", async () => {
    const h = harness();
    await h.text("store_memory", {
      text: "User prefers dark editor themes in every tool",
      category: "preferences",
      scope: SCOPE,
      canonicalKey: "editor-theme",
    });
    const existing = await onlyRow(h, SCOPE);

    const text = await h.text("store_memory", {
      text: "User works mostly in a light terminal profile",
      category: "entities",
      scope: SCOPE,
      canonicalKey: "editor-theme",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Not stored: canonical key conflict with memory ${existing.id}`);
    expect(lines).toContain("Disposition: conflict");
    expect(await h.rowCount(SCOPE)).toBe(1);

    const conflicts = await h.conflictStore.listRecent({});
    expect(conflicts).toHaveLength(1);
    expect(lines).toContain(`Conflict: ${conflicts[0].conflictId.slice(0, 8)}`);
  }, 30_000);
});

describe("batch_store handler", () => {
  const SCOPE = "project:tool-batch-store";

  it("headline counts match the table: 1 new, 1 deduped, 1 rejected → exactly 1 row", async () => {
    const h = harness();
    const text = await h.text("batch_store", {
      scope: SCOPE,
      memories: [
        { text: "Batch entry about deploy pipeline caching rules" },
        { text: "short" },
        { text: "Batch entry about deploy pipeline caching rules" },
      ],
    });
    const lines = text.split("\n");
    const row = await onlyRow(h, SCOPE);

    expect(lines[0]).toBe(
      "Stored 1 of 3 memories (1 new, 0 updated, 0 promoted, 1 deduped, 0 conflict, 1 rejected)",
    );
    expect(lines).toContain("- #2 rejected (text_too_short)");
    expect(lines).toContain(`- #3 deduped: duplicate of existing memory ${row.id}`);

    // 回执说写了几条，表里就有几条
    const written = Number(/^Stored (\d+) of \d+ memories/.exec(lines[0])?.[1]);
    expect(written).toBe(await h.rowCount(SCOPE));
  }, 30_000);

  it("all rejected: headline says 0 written and the table stays empty", async () => {
    const h = harness();
    const text = await h.text("batch_store", {
      scope: SCOPE,
      memories: [{ text: "short" }, { text: "tiny" }],
    });
    expect(text.split("\n")[0]).toBe(
      "Stored 0 of 2 memories (0 new, 0 updated, 0 promoted, 0 deduped, 0 conflict, 2 rejected)",
    );
    expect(await h.rowCount(SCOPE)).toBe(0);
  }, 30_000);
});

describe("store_workflow_pattern handler", () => {
  const SCOPE = "project:tool-pattern";
  const PATTERN = {
    title: "Cross-window continuity handoff",
    trigger: "When opening a fresh terminal window for the same project",
    steps: ["Call resume_context before coding", "Save checkpoint_session before leaving the window"],
    scope: SCOPE,
  };

  it("first write is stored as one row; the identical second write is deduped onto that row", async () => {
    const h = harness();
    const first = (await h.text("store_workflow_pattern", PATTERN)).split("\n");
    const row = await onlyRow(h, SCOPE);
    expect(row.category).toBe("patterns");
    expect(first[0]).toBe(`Stored workflow pattern ${row.id.slice(0, 8)}`);
    expect(first).toContain("Disposition: stored");

    const second = (await h.text("store_workflow_pattern", PATTERN)).split("\n");
    expect(second).toContain("Disposition: deduped");
    expect(second[0]).toContain(row.id.slice(0, 8));
    expect(await h.rowCount(SCOPE)).toBe(1);
  }, 30_000);
});

describe("store_case handler", () => {
  const SCOPE = "project:tool-case";
  const CASE = {
    title: "Sparse startup context cleanup",
    problem: "resume_context returned noisy transcript fragments instead of a clean handoff",
    solutionSteps: ["Filter low-signal transcript fragments from stable recall"],
    scope: SCOPE,
  };

  it("first write is stored as one row; the identical second write is deduped onto that row", async () => {
    const h = harness();
    const first = (await h.text("store_case", CASE)).split("\n");
    const row = await onlyRow(h, SCOPE);
    expect(row.category).toBe("cases");
    expect(first[0]).toBe(`Stored case ${row.id.slice(0, 8)}`);
    expect(first).toContain("Disposition: stored");

    const second = (await h.text("store_case", CASE)).split("\n");
    expect(second).toContain("Disposition: deduped");
    expect(second[0]).toContain(row.id.slice(0, 8));
    expect(await h.rowCount(SCOPE)).toBe(1);
  }, 30_000);
});

describe("promote_memory handler", () => {
  const SCOPE = "project:tool-promote";

  async function seedEvidence(h: ToolHarness) {
    return h.store.store({
      text: "Session decided: release tokens live only in the secret manager, scripts fetch them by name",
      vector: SAME_VECTOR,
      category: "events",
      scope: "cc:tool-promote-session",
      importance: 0.6,
      metadata: "{}",
    });
  }

  it("promotes evidence into one durable row linked to the source; promoting again does not add a row", async () => {
    const h = harness();
    const evidence = await seedEvidence(h);

    const first = (await h.text("promote_memory", { memoryId: evidence.id, category: "patterns", scope: SCOPE })).split("\n");
    const row = await onlyRow(h, SCOPE);
    expect(first[0]).toBe(`Promoted memory ${row.id.slice(0, 8)}`);
    expect(first).toContain(`From: ${evidence.id.slice(0, 8)} (events)`);
    expect(first).toContain("Disposition: promoted");
    expect(row.category).toBe("patterns");
    expect(row.id).not.toBe(evidence.id);

    const second = (await h.text("promote_memory", { memoryId: evidence.id, category: "patterns", scope: SCOPE })).split("\n");
    expect(second[0]).toBe(`Promoted memory ${row.id.slice(0, 8)}`);
    expect(await h.rowCount(SCOPE)).toBe(1);
  }, 30_000);

  it("unknown source id surfaces as isError and writes nothing", async () => {
    const h = harness();
    const result = await h.call("promote_memory", { memoryId: "deadbeefdeadbeef", scope: SCOPE });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
    expect(await h.rowCount(SCOPE)).toBe(0);
  }, 30_000);
});

describe("set_reminder handler", () => {
  const SCOPE = "project:tool-reminder";

  it("receipt id is the stored row, and the row carries the trigger and action as a pending reminder", async () => {
    const h = harness();
    const lines = (await h.text("set_reminder", {
      trigger: "deploy friday",
      action: "check the freeze calendar",
      scope: SCOPE,
      expiresInDays: 3,
    })).split("\n");

    const row = await onlyRow(h, SCOPE);
    expect(lines[0]).toBe(`Reminder set: ${row.id.slice(0, 8)}`);
    expect(lines).toContain("Expires in: 3 days");
    const meta = JSON.parse(row.metadata ?? "{}") as {
      prospective?: { trigger?: string; action?: string; status?: string; expiresAt?: string };
    };
    expect(meta.prospective).toMatchObject({
      trigger: "deploy friday",
      action: "check the freeze calendar",
      status: "pending",
    });
    expect(typeof meta.prospective?.expiresAt).toBe("string");
  }, 30_000);
});

describe("latest_checkpoint handler (read-only)", () => {
  it("returns the saved checkpoint for its session and nothing for another session", async () => {
    const h = harness();
    const { record } = buildSessionCheckpointResult({
      sessionId: "tool-ckpt-a",
      summary: "Wiring handler smoke tests for write tools",
      decisions: [],
      openLoops: [],
      nextActions: ["run the full test suite"],
      entities: [],
      files: [],
    });
    await h.checkpointStore.save(record);

    const found = (await h.text("latest_checkpoint", { sessionId: "tool-ckpt-a" })).split("\n");
    expect(found[0]).toBe("Latest checkpoint");
    expect(found).toContain("Session: tool-ckpt-a");
    expect(found).toContain("Summary: Wiring handler smoke tests for write tools");
    expect(found).toContain("Next: run the full test suite");

    expect(await h.text("latest_checkpoint", { sessionId: "tool-ckpt-other" })).toBe("No checkpoint found.");
  }, 30_000);
});

describe("list_conflicts / audit_conflicts handlers (read-only)", () => {
  const SCOPE = "project:tool-conflicts";

  it("both report the one open conflict that store_memory created, and an empty store reports none", async () => {
    const h = harness();
    expect(await h.text("audit_conflicts", {})).toContain("Open conflicts : 0/0");

    await h.text("store_memory", {
      text: "User prefers dark editor themes in every tool",
      category: "preferences",
      scope: SCOPE,
      canonicalKey: "editor-theme",
    });
    await h.text("store_memory", {
      text: "User works mostly in a light terminal profile",
      category: "entities",
      scope: SCOPE,
      canonicalKey: "editor-theme",
    });
    const [conflict] = await h.conflictStore.listRecent({});
    const short = conflict.conflictId.slice(0, 8);

    const list = await h.text("list_conflicts", {});
    expect(list).toContain(short);
    expect(list).toContain("editor-theme");

    const single = await h.text("list_conflicts", { conflictId: conflict.conflictId });
    expect(single).not.toContain("Conflict not found");
    expect(single).toContain("editor-theme");
    expect(await h.text("list_conflicts", { conflictId: "nonexistent-conflict" })).toBe(
      "Conflict not found: nonexistent-conflict",
    );

    const audit = await h.text("audit_conflicts", {});
    expect(audit).toContain("Open conflicts : 1/1");
    expect(audit).toContain(short);
  }, 30_000);
});
