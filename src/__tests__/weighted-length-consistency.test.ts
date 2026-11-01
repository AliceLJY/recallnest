import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { admissionLength } from "../admission-control.js";
import { persistMemory } from "../capture-engine.js";
import { selectStableResults } from "../context-composer-stable-selection.js";
import { KGExtractor } from "../kg-extractor.js";
import { KGStore } from "../kg-store.js";
import type { LLMClient } from "../llm-client.js";
import type { RetrievalResult } from "../retriever.js";
import { MemoryStore } from "../store.js";
import { MIN_MEMORY_TEXT_UNITS, weightedTextLength } from "../text-length.js";
import { fakeEmbedder } from "./helpers/mcp-tool-harness.js";

/**
 * 「最短长度」口径一致（PR #51 Codex 冷读 P2-1）：写入准入放行的短中文事实，
 * 下游的稳定上下文、KG 抽取、pivot-apply schema 不能再按 UTF-16 把它挡掉。
 * pivot-apply 那条在 pivot-apply.test.ts（复用那边的 deps 替身）。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("weightedTextLength is the one shared measure", () => {
  it("admission-control re-exports the same function, not a copy", () => {
    expect(admissionLength).toBe(weightedTextLength);
    expect(MIN_MEMORY_TEXT_UNITS).toBe(10);
  });

  it("normalizes to NFC first: decomposed Hangul counts the same as composed", () => {
    const nfd = "한국어".normalize("NFD");
    expect(nfd.length).toBeGreaterThan(3); // 前提：NFD 确实拆开了
    expect(weightedTextLength(nfd)).toBe(6);
    expect(weightedTextLength("한국어")).toBe(6);
  });
});

function stableResult(text: string): RetrievalResult {
  return {
    entry: {
      id: `stable-${text}`,
      text,
      vector: [],
      category: "profile",
      scope: "memory:profile",
      importance: 0.9,
      timestamp: Date.now(),
    },
    score: 1,
    sources: {},
  } as RetrievalResult;
}

describe("stable context selection uses the shared measure", () => {
  it("short CJK facts that pass admission reach stable context", () => {
    for (const text of ["我是左撇子", "我对花生过敏"]) {
      const lines = selectStableResults("profile", [stableResult(text)], 3);
      expect(lines.length, text).toBe(1);
      expect(lines[0]).toContain(text);
    }
  });

  it("the floor is still there: three CJK characters (6 units) and seven ASCII characters are dropped", () => {
    expect(selectStableResults("profile", [stableResult("我左撇")], 3)).toEqual([]);
    expect(selectStableResults("profile", [stableResult("lefty x")], 3)).toEqual([]);
  });
});

/** 固定返回一条关系的假 LLM，记下被调了几次。 */
function oneTripleLlm(): { llm: LLMClient; calls: () => number } {
  let n = 0;
  const llm = {
    async chatJson() {
      n++;
      return { triples: [{ subject: "我", predicate: "allergic_to", object: "花生", confidence: 0.95 }] };
    },
  } as unknown as LLMClient;
  return { llm, calls: () => n };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("KG extraction uses the shared measure", () => {
  it("revising a fact to a short Chinese sentence does not empty its KG relations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-kg-short-cjk-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "db");
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    const kgStore = new KGStore({ dbPath });
    const { llm, calls } = oneTripleLlm();
    const kgExtractor = new KGExtractor({ llmClient: llm, kgStore });
    const deps = { store, embedder: fakeEmbedder, kgExtractor } as unknown as Parameters<typeof persistMemory>[0];
    const scope = "project:kg-short-cjk";

    const first = await persistMemory(deps, {
      text: "我从小就一直对花生过敏",
      category: "profile",
      scope,
      source: "manual",
      canonicalKey: "allergy:peanut",
    });
    await waitFor(async () => calls() === 1 && (await kgStore.countTriples(scope)) === 1);
    expect(calls()).toBe(1);
    expect(await kgStore.countTriples(scope)).toBe(1);

    const second = await persistMemory(deps, {
      text: "我对花生过敏",
      category: "profile",
      scope,
      source: "manual",
      canonicalKey: "allergy:peanut",
    });
    // 前提：走的是原位修订（会先 purge 旧关系），不是另起一行
    expect(second.disposition).toBe("updated");
    expect(second.id).toBe(first.id);

    await waitFor(async () => calls() === 2 && (await kgStore.countTriples(scope)) === 1);
    expect(calls()).toBe(2); // 第二次真的调了 LLM，没有被短文本门槛直接挡回
    expect(await kgStore.countTriples(scope)).toBe(1); // 旧关系清掉后重新抽回来，不是 1 → 0
  }, 30_000);
});
