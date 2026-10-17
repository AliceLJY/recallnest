import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cascadeForget } from "../cascade-forget.js";
import { MemoryStore, type MemoryEntry, type MemorySearchResult } from "../store.js";
import type { ScopeMatchMode } from "../scope-policy.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function createStore(): MemoryStore {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-cascade-scope-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({ dbPath, vectorDim: 3 });
}

const FORGOTTEN_VECTOR = [1, 0, 0];
// cosine ≈ 0.95 with FORGOTTEN_VECTOR — well above the 0.70 default threshold
const RELATED_VECTOR = [0.95, 0.31, 0];

async function storeRelated(store: MemoryStore, scope: string): Promise<MemoryEntry> {
  return store.store({
    text: `Related note in ${scope}`,
    vector: RELATED_VECTOR,
    category: "events",
    scope,
    importance: 0.9,
    metadata: JSON.stringify({ tier: "core" }),
  });
}

describe("cascadeForget scope boundary (real LanceDB)", () => {
  it("forgetting a row in `memory` demotes only `memory`, not `memory:pivot` or `memory-foo`", async () => {
    const store = createStore();

    const forgotten = await store.store({
      text: "The thing the user asked to forget",
      vector: FORGOTTEN_VECTOR,
      category: "events",
      scope: "memory",
      importance: 0.8,
      metadata: "{}",
    });
    const sameScope = await storeRelated(store, "memory");
    const pivot = await storeRelated(store, "memory:pivot");
    const dashSibling = await storeRelated(store, "memory-foo");

    expect(await store.delete(forgotten.id)).toBe(true);
    const result = await cascadeForget(store, {
      id: forgotten.id,
      vector: forgotten.vector,
      scope: forgotten.scope,
    });

    expect(result.demotedIds).toEqual([sameScope.id]);

    const sameAfter = await store.getById(sameScope.id);
    expect(sameAfter?.importance).toBeLessThan(0.9);
    expect(JSON.parse(sameAfter?.metadata ?? "{}").cascade_forget).toHaveLength(1);

    for (const sibling of [pivot, dashSibling]) {
      const after = await store.getById(sibling.id);
      expect(after?.importance).toBe(0.9);
      expect(after?.metadata).toBe(sibling.metadata);
    }
  });

  it("forgetting a row in `memory:pivot` leaves `memory` alone", async () => {
    const store = createStore();

    const forgotten = await store.store({
      text: "Pivot row the user asked to forget",
      vector: FORGOTTEN_VECTOR,
      category: "events",
      scope: "memory:pivot",
      importance: 0.8,
      metadata: "{}",
    });
    const pivotSibling = await storeRelated(store, "memory:pivot");
    const parent = await storeRelated(store, "memory");

    expect(await store.delete(forgotten.id)).toBe(true);
    const result = await cascadeForget(store, {
      id: forgotten.id,
      vector: forgotten.vector,
      scope: forgotten.scope,
    });

    expect(result.demotedIds).toEqual([pivotSibling.id]);
    expect((await store.getById(parent.id))?.importance).toBe(0.9);
  });
});

describe("cascadeForget scope match mode", () => {
  it("asks vectorSearch for an exact scope match", async () => {
    const calls: Array<{ scopeFilter?: string[]; scopeMatch?: ScopeMatchMode }> = [];
    const store = {
      async vectorSearch(
        _vector: number[],
        _limit?: number,
        _minScore?: number,
        scopeFilter?: string[],
        scopeMatch?: ScopeMatchMode,
      ): Promise<MemorySearchResult[]> {
        calls.push({ scopeFilter, scopeMatch });
        return [];
      },
      async update(): Promise<MemoryEntry | null> {
        return null;
      },
    } as unknown as MemoryStore;

    await cascadeForget(store, { id: "f-1", vector: [1, 0, 0], scope: "memory" });

    expect(calls).toEqual([{ scopeFilter: ["memory"], scopeMatch: "exact" }]);
  });
});
