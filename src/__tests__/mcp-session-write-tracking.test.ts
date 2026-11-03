import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import { forgetMemory } from "../forget-engine.js";
import { resetSessionWrites, sessionWrittenIds } from "../revision-guard.js";
import { MIN_PROMOTABLE_CONTRACT_VERSION } from "../memory-promotion.js";
import { captureTools, fakeEmbedder, createToolHarness, type ToolHarness } from "./helpers/mcp-tool-harness.js";

const registrations = [registerCoreTools, registerAdvancedTools, registerGovernanceTools];
const harnesses: ToolHarness[] = [];
const scope = "project:synthetic-write-tracking";
function harness() {
  const h = createToolHarness(registrations);
  harnesses.push(h);
  return h;
}
beforeEach(resetSessionWrites);
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
  resetSessionWrites();
});

async function seed(h: ToolHarness, text: string, metadata = "{}", rowScope = scope) {
  return h.store.store({ text, scope: rowScope, vector: [1, 0, 0], importance: 0.8, category: "events", metadata });
}

const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: "store_memory", args: { text: "Synthetic ordinary memory write" } },
  { tool: "batch_store", args: { memories: [{ text: "Synthetic batch memory write" }] } },
  { tool: "store_case", args: { title: "Synthetic case", problem: "Fixture request fails validation", solutionSteps: ["Correct the fixture argument"] } },
  { tool: "store_workflow_pattern", args: { title: "Synthetic workflow", trigger: "Fixture setup", steps: ["Create synthetic input", "Check synthetic output"] } },
  { tool: "auto_capture", args: { text: "Remember that the fictional project uses synthetic blue widgets for its test fixtures." } },
  { tool: "set_reminder", args: { trigger: "synthetic fixture", action: "Check the fictional widget" } },
  { tool: "store_skill", args: { name: "synthetic-fixture", description: "Validate synthetic fixtures", triggerPattern: "A fixture needs validation", implementationType: "instruction_sequence", implementation: "Read the fixture and check its expected output." } },
  { tool: "import_conversations", args: { content: "user: The fictional project uses synthetic blue widgets for testing.", format: "plaintext" } },
];

// 2026-11-03 owner 裁决：只登记「新写出一条内容」的工具（经 persistMemory 的 onMemoryWritten 与 set_reminder），
// dream / consolidate / pin / brief / checkpoint 镜像 / skill 结果 / 冲突裁决这些派生写入或元数据补丁不算「本会话刚写的」，
// 否则一次 dream 之后同 scope 的 forget 几乎都会被拒。
describe("MCP session write tracking", () => {
  for (const { tool, args } of cases) {
    it(`${tool}: successful writes are protected from a later forget`, async () => {
      const h = harness();
      const result = await h.call(tool, { scope, ...args });
      expect(result.isError).not.toBe(true);
      const rows = await h.store.list([scope], undefined, 100, 0, "exact");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(sessionWrittenIds().has(row.id)).toBe(true);
      const old = await seed(h, "Synthetic older unrelated-key row to forget");
      const forgotten = await forgetMemory({ store: h.store }, { memoryId: old.id, confirm: true });
      expect(forgotten.success).toBe(false);
      expect(forgotten.error).toContain("本会话刚写的");
    }, 30_000);
  }

  it("promote_memory: records the durable output, not the evidence id", async () => {
    const h = harness();
    const evidence = await seed(h, "Synthetic imported evidence for a fictional project", "{}", "test:evidence");
    const result = await h.call("promote_memory", { memoryId: evidence.id, scope, category: "entities" });
    expect(result.isError).not.toBe(true);
    const rows = await h.store.list([scope], undefined, 100, 0, "exact");
    expect(rows).toHaveLength(1);
    expect(sessionWrittenIds()).toEqual(new Set([rows[0].id]));
  }, 30_000);

  it("promote_scan: dry run does not register; applied promotion does", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await seed(h, `Synthetic profile evidence number ${i}`, JSON.stringify({
      boundary: { layer: "evidence", authority: "transcript-ingest", conflictPolicy: "append-only", originalCategory: "profile", downgradedFrom: "profile" },
    }));
    expect((await h.call("promote_scan", { scope })).isError).not.toBe(true);
    expect(sessionWrittenIds().size).toBe(0);
    expect((await h.call("promote_scan", { scope, dryRun: false })).isError).not.toBe(true);
    const rows = await h.store.list([scope], "profile", 100, 0, "exact");
    expect(rows).toHaveLength(1);
    expect(sessionWrittenIds()).toEqual(new Set([rows[0].id]));
  }, 30_000);

  it("promote_synthesis: registers only the promoted conclusion", async () => {
    const h = harness();
    const a = await seed(h, "Synthetic evidence alpha");
    const b = await seed(h, "Synthetic evidence beta");
    const synthesis = await seed(h, "Synthetic supported conclusion about fictional fixtures", JSON.stringify({
      boundary: { layer: "evidence", authority: "distillation", conflictPolicy: "append-only", originalCategory: "patterns" },
      synthesis_contract: MIN_PROMOTABLE_CONTRACT_VERSION, evidenceMemories: [a.id, b.id],
    }));
    expect((await h.call("promote_synthesis", { scope, dryRun: false })).isError).not.toBe(true);
    const rows = await h.store.list([scope], "patterns", 100, 0, "exact");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(synthesis.id);
    expect(sessionWrittenIds()).toEqual(new Set([rows[0].id]));
  }, 30_000);

  it("failed writes and rejected batch items never enter the session registry", async () => {
    const h = harness();
    const write = spyOn(h.store, "store").mockRejectedValue(new Error("synthetic write failure"));
    try {
      expect((await h.call("set_reminder", { scope, trigger: "synthetic", action: "Synthetic action" })).isError).toBe(true);
      expect(sessionWrittenIds().size).toBe(0);
    } finally {
      write.mockRestore();
    }
    await h.call("batch_store", { scope, memories: [{ text: "hi" }, { text: "Synthetic accepted batch record" }] });
    const rows = await h.store.list([scope], undefined, 10, 0, "exact");
    expect(rows).toHaveLength(1);
    expect(sessionWrittenIds()).toEqual(new Set([rows[0].id]));
  }, 30_000);

});
