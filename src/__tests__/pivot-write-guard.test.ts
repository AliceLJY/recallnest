import { afterEach, describe, expect, it } from "bun:test";

import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import { applyPivotWriteGuard, currentSessionId, isPivotScope } from "../pivot-write-guard.js";
import { createToolHarness, type ToolHarness } from "./helpers/mcp-tool-harness.js";

/**
 * memory:pivot 必带字段的服务端保证（2026-11-03 错误转脚本检查第 1 条）。
 * 坏样本取自真实会话：
 *  - session 08ef14a1（2026-09-04）preferences 写入，带 pinned 与 src:，**没有 canonicalKey**；
 *  - session 778f0856（2026-11-02）eval 写入，有 key 有 pinned，**没有 src: 标签**。
 */

const BAD_NO_KEY = {
  scope: "memory:pivot",
  tags: ["pinned", "src:08ef14a1", "2026-09-04", "验收标准", "绿勾不等于覆盖", "护栏", "reddit"],
  canonicalKey: undefined,
};
const BAD_NO_SRC = {
  scope: "memory:pivot",
  tags: ["eval", "pinned", "2026-11-03", "llm-wiki"],
  canonicalKey: "eval:mojeskoqq-llm-wiki",
};

describe("applyPivotWriteGuard（纯函数）", () => {
  it("真实坏样本 08ef14a1：缺 canonicalKey 拒写，报错带理由与锚点", () => {
    const r = applyPivotWriteGuard(BAD_NO_KEY, { env: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("canonicalKey");
    expect(r.error).toContain("2026-11-03");
    expect(r.error).toContain("08ef14a1");
  });

  it("真实坏样本 778f0856：缺 src: 用会话 id 前 8 位补上", () => {
    const r = applyPivotWriteGuard(BAD_NO_SRC, { env: { CLAUDE_CODE_SESSION_ID: "c9bd5950-c3b3-5686" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tags).toContain("src:c9bd5950");
    expect(r.notes.join("\n")).toContain("src:c9bd5950");
  });

  it("缺 pinned 自动补在最前", () => {
    const r = applyPivotWriteGuard({ scope: "memory:pivot", tags: ["src:abcdefgh"], canonicalKey: "k" }, { env: {} });
    expect(r.ok && r.tags[0]).toBe("pinned");
  });

  it("拿不到会话 id 时不编造 src:，回执给警告", () => {
    const r = applyPivotWriteGuard(BAD_NO_SRC, { env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tags.some((t) => t.startsWith("src:"))).toBe(false);
    expect(r.notes.join("\n")).toContain("缺 src:");
  });

  it("补完超过 8 个标签时保住 pinned 与 src:，并写明丢了哪些", () => {
    const tags = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const r = applyPivotWriteGuard({ scope: "memory:pivot", tags, canonicalKey: "k" }, { env: { CLAUDE_CODE_SESSION_ID: "12345678xx" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tags).toHaveLength(8);
    expect(r.tags).toContain("pinned");
    expect(r.tags).toContain("src:12345678");
    expect(r.notes.join("\n")).toContain("丢掉了");
  });

  it("非 pivot scope 原样放行；开关 off 时 pivot 也放行", () => {
    expect(applyPivotWriteGuard({ scope: "project:x", tags: [], canonicalKey: undefined }, { env: {} })).toEqual({ ok: true, tags: [], notes: [] });
    expect(applyPivotWriteGuard(BAD_NO_KEY, { env: { RECALLNEST_PIVOT_GUARD: "off" } }).ok).toBe(true);
  });

  it("scope 判定：memory:pivot 及其子 scope 算，memory 与 memory:pivotal 不算", () => {
    expect(isPivotScope("memory:pivot")).toBe(true);
    expect(isPivotScope("memory:pivot:sub")).toBe(true);
    expect(isPivotScope("memory")).toBe(false);
    expect(isPivotScope("memory:pivotal")).toBe(false);
  });

  it("trims pivot scopes before checking the guard", () => {
    for (const scope of [" memory:pivot ", "\tmemory:pivot:child\n"]) {
      expect(isPivotScope(scope)).toBe(true);
      expect(applyPivotWriteGuard({ scope, tags: [] }, { env: {} }).ok).toBe(false);
    }
    expect(isPivotScope(" memory:pivotal ")).toBe(false);
  });

  it("caps protected tags at pinned and the first src and reports every dropped src", () => {
    const sources = Array.from({ length: 8 }, (_, i) => `src:synthetic${i}`);
    const r = applyPivotWriteGuard({ scope: "memory:pivot", tags: sources, canonicalKey: "test:tag-cap" }, { env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tags).toHaveLength(8);
    expect(r.tags.slice(0, 2)).toEqual(["pinned", sources[0]]);
    expect(r.tags).not.toContain(sources[7]);
    expect(r.notes.join("\n")).toContain(`丢掉了：${sources[7]}`);
  });

  it("RECALLNEST_SESSION_ID 优先于 CLAUDE_CODE_SESSION_ID", () => {
    expect(currentSessionId({ RECALLNEST_SESSION_ID: "aaa", CLAUDE_CODE_SESSION_ID: "bbb" })).toBe("aaa");
    expect(currentSessionId({})).toBeUndefined();
  });
});

describe("经真实 handler", () => {
  const harnesses: ToolHarness[] = [];
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()!.cleanup();
  });
  function harness(): ToolHarness {
    const h = createToolHarness([registerCoreTools, registerAdvancedTools, registerGovernanceTools]);
    harnesses.push(h);
    return h;
  }

  it("store_memory：坏样本 08ef14a1 形状被拒，主表一行不多", async () => {
    const h = harness();
    const text = await h.text("store_memory", {
      text: "验收标准的第二种失效：判据正确不等于覆盖，一条正确触发的检查对没想到的失败模式什么都没说",
      category: "preferences",
      scope: "memory:pivot",
      tags: BAD_NO_KEY.tags,
    });
    expect(text).toContain("Not stored");
    expect(await h.store.list(["memory:pivot"], undefined, 50, 0, "exact")).toHaveLength(0);
  }, 30_000);

  it("store_memory：缺 pinned 的写入落库后带 pinned", async () => {
    const h = harness();
    const text = await h.text("store_memory", {
      text: "评估结论：这个外部帖子讲的是知识库组织方式，对现有栈没有新增可复用的做法",
      scope: "memory:pivot",
      tags: ["eval", "src:778f0856"],
      canonicalKey: "eval:guard-test",
    });
    expect(text).toContain("已自动补 pinned");
    const rows = await h.store.list(["memory:pivot"], undefined, 50, 0, "exact");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain("pinned");
  }, 30_000);

  it("store_memory: eight src tags still persist at most eight tags including pinned", async () => {
    const h = harness();
    const sources = Array.from({ length: 8 }, (_, i) => `src:synthetic${i}`);
    const receipt = await h.text("store_memory", {
      text: "Synthetic tag overflow record for a fictional project", scope: " memory:pivot ",
      canonicalKey: "test:tag-overflow", tags: sources,
    });
    expect(receipt).toContain("Disposition: stored");
    expect(receipt).toContain(`丢掉了：${sources[7]}`);
    const [row] = await h.store.list(["memory:pivot"], undefined, 10, 0, "exact");
    const metadata: { tags: string[] } = JSON.parse(row.metadata ?? "{}");
    expect(metadata.tags).toHaveLength(8);
    expect(metadata.tags).toContain("pinned");
    expect(metadata.tags).toContain(sources[0]);
    expect(metadata.tags).not.toContain(sources[7]);
  }, 30_000);

  for (const tool of ["store_memory", "batch_store"]) {
    it(`${tool}: padded pivot scopes cannot bypass rejection`, async () => {
      const h = harness();
      const text = "Synthetic padded scope guard regression record";
      const result = await h.call(tool, {
        scope: " \tmemory:pivot:child ",
        ...(tool === "store_memory" ? { text } : { memories: [{ text }] }),
      });
      expect(result.isError).toBe(true);
      expect(await h.rowCount("memory:pivot:child")).toBe(0);
    }, 30_000);
  }

  for (const disposition of ["deduped", "rejected", "conflict"] as const) {
    it(`store_memory: ${disposition} never claims pivot tags were added`, async () => {
      const h = harness();
      const scope = "memory:pivot";
      const text = "Synthetic guard receipt test record for a fictional project";
      if (disposition !== "rejected") {
        await h.text("store_memory", { text, scope, canonicalKey: "test:receipt", tags: ["src:fixture"] });
      }
      const result = await h.text("store_memory", {
        text: disposition === "rejected" ? "hi" : disposition === "conflict" ? "Synthetic conflicting category record for a fictional project" : text,
        category: disposition === "conflict" ? "entities" : "events",
        scope,
        canonicalKey: "test:receipt",
        tags: ["src:fixture"],
      });
      expect(result).toContain(`Disposition: ${disposition}`);
      expect(result).not.toContain("已自动补");
      expect(result).toContain("这次没写入，标签没有补上");
    }, 30_000);
  }

  it("batch_store：pivot scope 整批拒绝", async () => {
    const h = harness();
    const text = await h.text("batch_store", {
      scope: "memory:pivot",
      memories: [{ text: "一条想批量写进 pivot 的判断，没有 canonicalKey" }],
    });
    expect(text).toContain("Not stored");
    expect(await h.store.list(["memory:pivot"], undefined, 50, 0, "exact")).toHaveLength(0);
  }, 30_000);
});
