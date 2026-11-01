/**
 * 钉住分数下限的实际语义：六个类别的下限来自 categoryMinScores（不设时用 DEFAULT_CATEGORY_MIN_SCORES），
 * 不受 hardMinScore 影响；hardMinScore 只管表外的类别（默认表下就是旧版类别）。
 *
 * 这是有意的行为，不是 bug：2026-08-22 shadow 实测否决了放宽准入（hard_min 只占丢弃的 13.5%，
 * applyLayerAdmission 占 79.4%）。谁以为 config.json.example 里的 hardMinScore 0.3 该对六类生效、
 * 顺手改了 minScoreFor，这里会红。改之前先读 CHANGELOG / eval 里那条否决记录。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Embedder } from "../embedder.js";
import { DURABLE_MEMORY_CATEGORIES, LEGACY_MEMORY_CATEGORIES } from "../memory-schema.js";
import { applyRetrievalProfile } from "../retrieval-profiles.js";
import {
  DEFAULT_CATEGORY_MIN_SCORES,
  DEFAULT_RETRIEVAL_CONFIG,
  MemoryRetriever,
  type RetrievalConfig,
} from "../retriever.js";
import type { MemoryStore } from "../store.js";

interface MinScoreProbe {
  minScoreFor(category: string, shortQuery?: boolean): number;
}

function floors(config: RetrievalConfig): MinScoreProbe {
  // minScoreFor 是 private：这里只读它的返回值，不起检索、不碰库。
  return new MemoryRetriever({} as MemoryStore, {} as Embedder, config) as unknown as MinScoreProbe;
}

/** 与 runtime-config.ts 同一合并方式：默认配置上整体展开 config.json 的 retrieval 段。 */
function exampleRetrievalConfig(): RetrievalConfig {
  const example = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "config.json.example"), "utf8")) as {
    retrieval?: Partial<RetrievalConfig>;
  };
  return { ...DEFAULT_RETRIEVAL_CONFIG, ...(example.retrieval ?? {}) };
}

describe("category floors come from categoryMinScores, not hardMinScore", () => {
  it("the default map covers exactly the six durable categories", () => {
    expect(Object.keys(DEFAULT_CATEGORY_MIN_SCORES).sort()).toEqual([...DURABLE_MEMORY_CATEGORIES].sort());
  });

  it("config.json.example: its hardMinScore (0.3) moves none of the six floors, only legacy categories", () => {
    const config = exampleRetrievalConfig();
    expect(config.hardMinScore).toBe(0.3);
    expect(config.categoryMinScores).toBeUndefined();
    const r = floors(config);
    for (const category of DURABLE_MEMORY_CATEGORIES) {
      expect(r.minScoreFor(category)).toBe(DEFAULT_CATEGORY_MIN_SCORES[category]!);
    }
    for (const category of LEGACY_MEMORY_CATEGORIES) {
      expect(r.minScoreFor(category)).toBe(0.3);
    }
  });

  it("any hardMinScore value leaves the six floors unchanged", () => {
    for (const hardMinScore of [0, 0.3, 0.99]) {
      const r = floors({ ...DEFAULT_RETRIEVAL_CONFIG, hardMinScore });
      for (const category of DURABLE_MEMORY_CATEGORIES) {
        expect(r.minScoreFor(category)).toBe(DEFAULT_CATEGORY_MIN_SCORES[category]!);
      }
      expect(r.minScoreFor("other")).toBe(hardMinScore);
    }
  });

  it("a configured categoryMinScores replaces the default map as a whole (no per-key merge)", () => {
    const r = floors({ ...DEFAULT_RETRIEVAL_CONFIG, hardMinScore: 0.3, categoryMinScores: { events: 0.5 } });
    expect(r.minScoreFor("events")).toBe(0.5);
    // 没列出的类别不回到默认表，落到 hardMinScore。
    expect(r.minScoreFor("patterns")).toBe(0.3);
    expect(r.minScoreFor("profile")).toBe(0.3);
  });

  it("named profiles override a configured categoryMinScores with their own complete map", () => {
    const base = { ...DEFAULT_RETRIEVAL_CONFIG, categoryMinScores: { events: 0.9 } };
    for (const name of ["writing", "debug", "fact-check"]) {
      const { config } = applyRetrievalProfile(base, name);
      expect(Object.keys(config.categoryMinScores ?? {}).sort()).toEqual([...DURABLE_MEMORY_CATEGORIES].sort());
      expect(config.categoryMinScores?.events).not.toBe(0.9);
    }
    expect(applyRetrievalProfile(base, "default").config.categoryMinScores).toEqual({ events: 0.9 });
  });
});
