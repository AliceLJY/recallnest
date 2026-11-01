/**
 * 调用方给的 id 在库里找不到 → 归为调用方的输入错误，不是 RecallNest 内部故障。
 *
 * 以前 forget_memory / promote_memory 的「Memory <id> not found」与 resolve_conflict 的
 * 「Conflict <id> not found」都落到兜底的 internal_error / app，调用方会把一个输错的 id
 * 当成服务端故障去上报。这里经真实的 register*Tools 拿到 handler，在临时目录的真实 LanceDB
 * 上调用，断言回执里的分类字段；回执里的原始报错文字不变。
 */
import { afterEach, describe, expect, it } from "bun:test";

import { classifyError } from "../error-taxonomy.js";
import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import { createToolHarness, type ToolHarness } from "./helpers/mcp-tool-harness.js";

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

const MISSING_ID = "abcd1234abcd1234";

describe("not-found ids are classified as caller-side errors", () => {
  it("forget_memory on a missing id: invalid_memory_ref / peer, detail unchanged", async () => {
    const h = harness();
    const result = await h.call("forget_memory", { memoryId: MISSING_ID, confirm: true });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("reason_code: invalid_memory_ref");
    expect(text).toContain("responsibility: peer");
    expect(text).toContain("retryable: false");
    expect(text).toContain(`detail: Memory ${MISSING_ID} not found`);
  }, 30_000);

  it("promote_memory on a missing source id: invalid_memory_ref / peer", async () => {
    const h = harness();
    const result = await h.call("promote_memory", { memoryId: MISSING_ID, scope: "project:not-found" });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("reason_code: invalid_memory_ref");
    expect(text).toContain("responsibility: peer");
    expect(text).toContain(`detail: Memory ${MISSING_ID} not found`);
  }, 30_000);

  it("resolve_conflict on a missing conflict id: invalid_input / peer", async () => {
    const h = harness();
    const result = await h.call("resolve_conflict", { conflictId: "conflict-missing", resolution: "keep_existing" });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("reason_code: invalid_input");
    expect(text).toContain("responsibility: peer");
    expect(text).toContain("detail: Conflict conflict-missing not found");
  }, 30_000);

  it("only the whole caller-id sentence counts: store / data-inconsistency not-founds keep their class", () => {
    // 库内不一致（冲突记录指向的旧记忆没了）不是调用方输错，仍按兜底归 app。
    expect(classifyError(new Error("Existing memory abcd1234 not found")).reasonCode).toBe("internal_error");
    expect(classifyError(new Error("LanceDB table not found")).reasonCode).toBe("store_error");
    // id 里恰好带别的规则的关键词，也按 not-found 判。
    expect(classifyError(new Error("Memory timeout-index not found")).reasonCode).toBe("invalid_memory_ref");
  });
});
