import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";

import { resolveSearchReinforcement } from "../api-server.js";
import { createRetriever } from "../retriever.js";
import { buildRetrievalContext } from "../scope-policy.js";

/**
 * /v1/search `reinforce: false` — a read-only probe must return the same ranking as a normal search
 * and must not trigger any of the three reinforcement writes in the retriever.
 */

const SCOPE = "test:probe";

// Scores carry a recency term, so two searches a few milliseconds apart differ around the tenth decimal.
// Freeze the clock: "same ranking and scores" is then an exact comparison, not a matter of timing.
const FROZEN_NOW = new Date("2026-11-25T04:00:00.000Z");
beforeAll(() => { setSystemTime(FROZEN_NOW); });
afterAll(() => { setSystemTime(); });

function harness() {
  const now = Date.now();
  const candidates = [
    { entry: { id: "probe-a", text: "decision: do not install the desktop client", vector: [1, 0, 0], category: "events", scope: SCOPE, importance: 0.8, timestamp: now, metadata: "{}" }, score: 0.86 },
    { entry: { id: "probe-b", text: "an unrelated note about the same client", vector: [0.9, 0.1, 0], category: "events", scope: SCOPE, importance: 0.6, timestamp: now, metadata: "{}" }, score: 0.71 },
  ];
  const writes = { frequency: 0, evolution: 0, access: 0 };
  const store = {
    hasFtsSupport: false,
    async vectorSearch(_v: number[], limit: number, minScore: number, scopeFilter?: string[]) {
      return candidates
        .filter((c) => c.score >= minScore)
        .filter((c) => !scopeFilter || scopeFilter.includes(c.entry.scope))
        .slice(0, limit);
    },
    async patchMetadataBatch() {
      writes.evolution += 1;
    },
  };
  const embedder = {
    async embedQuery() { return [1, 0, 0]; },
    async embedPassage() { return [1, 0, 0]; },
  };
  const retriever = createRetriever(store as any, embedder as any, {
    mode: "vector",
    rerank: "none",
    candidatePoolSize: 5,
    minScore: 0.3,
    hardMinScore: 0.38,
    filterNoise: false,
    enableRIF: false,
    sourceDiversity: 0,
    multiHop: false,
  });
  retriever.setAccessTracker({
    computeEffectiveHalfLife(base: number) { return base; },
    recordAccess() { writes.access += 1; },
  } as any);
  retriever.setFrequencyTracker({
    recordHits() { writes.frequency += 1; },
    getBoostMultiplier() { return 1; },
  } as any);
  return { retriever, writes };
}

async function search(body: Record<string, unknown>) {
  const h = harness();
  const results = await h.retriever.retrieve(buildRetrievalContext({
    query: String(body.query),
    limit: 3,
    scope: SCOPE,
    ...resolveSearchReinforcement(body),
  }, { operation: "test:api-search-reinforce" }));
  await new Promise((r) => setTimeout(r, 0));      // the evolution write is queued as a microtask
  return { ids: results.map((r) => r.entry.id), scores: results.map((r) => r.score), writes: h.writes };
}

describe("/v1/search reinforce flag", () => {
  it("maps only an explicit false to the non-reinforcing context", () => {
    expect(resolveSearchReinforcement({})).toEqual({});
    expect(resolveSearchReinforcement({ reinforce: true })).toEqual({});
    expect(resolveSearchReinforcement({ reinforce: "false" })).toEqual({});
    expect(resolveSearchReinforcement({ reinforce: 0 })).toEqual({});
    expect(resolveSearchReinforcement({ reinforce: false })).toEqual({ source: "auto-recall", trivialQueryGate: false });
  });

  it("a default search still records all three reinforcement writes", async () => {
    const r = await search({ query: "what did we decide about the desktop client" });
    expect(r.ids).toEqual(["probe-a", "probe-b"]);
    expect(r.writes).toEqual({ frequency: 1, evolution: 1, access: 1 });
  });

  it("reinforce:false returns the same ranking and scores and writes nothing", async () => {
    const normal = await search({ query: "what did we decide about the desktop client" });
    await Bun.sleep(25);      // real time passes between the two calls; the frozen clock must make that irrelevant
    const probe = await search({ query: "what did we decide about the desktop client", reinforce: false });
    expect(probe.ids).toEqual(normal.ids);
    expect(probe.scores).toEqual(normal.scores);
    expect(probe.writes).toEqual({ frequency: 0, evolution: 0, access: 0 });
  });

  it("reinforce:false keeps the trivial-query gate off, so a short probe is not swallowed", async () => {
    const probe = await search({ query: "ok", reinforce: false });
    expect(probe.ids.length).toBeGreaterThan(0);
  });
});
