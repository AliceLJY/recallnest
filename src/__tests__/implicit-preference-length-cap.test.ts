import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMPLICIT_PREFERENCE_MAX_TEXT_CHARS,
  persistMemory,
  shouldDeriveImplicitPreference,
} from "../capture-engine.js";
import { MemoryStore } from "../store.js";

/**
 * 隐式偏好双写（LME-1）的长度上限（2026-10-10）。
 * 起因：生产库里 13 条派生偏好行全是 446–1,653 字的长文，正文里碰巧有一句「我用 X 做了…」，
 * 整段被再存成一条 preferences，还继承了来源行的 pinned 与业务标签。
 * 交接：sync-bridge AI产出/2026-10-10-RecallNest隐式偏好副本/README.md。
 * 库是临时目录里的真实 LanceDB；嵌入是本地假向量，不调接口。
 */

const SCOPE = "memory:pivot";

// 触发这次排查的那句原话，放回一段与生产实例同量级的长文里。
const TRIGGER_SENTENCE = "下午我用 Muse 青丘成片同一张首帧做了九尾开扇对照";
const LONG_NARRATIVE = [
  "lemo-wake 评估结论：只用于已经设计好的平面图，写实画面不用。",
  "它把一张平面图在本地拆成图层，再用代码编排出约五秒首尾无缝的动效，不生图也不需要任何 key。",
  `${TRIGGER_SENTENCE}，结果是写实画面的光线和毛发一动就露出拆层的边，镜头感完全出不来。`,
  "同一天做的广州旅行箱海报是平面设计稿，拆层后开箱动效很自然，声音对上之后镜头有震颤感。",
  "所以判据是素材本身是不是平面设计：是就用它，写实镜头走生成式视频那条路。",
].join("");

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "rn-implicit-pref-"));
  tmpDirs.push(dir);
  const realStore = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
  // Count store calls that have started and not yet settled, so a test can wait
  // for the fire-and-forget dual-write to actually finish instead of guessing a delay.
  let inFlight = 0;
  const store = new Proxy(realStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          inFlight += 1;
          return (result as Promise<unknown>).finally(() => { inFlight -= 1; });
        }
        return result;
      };
    },
  });
  /** Resolves once no store call has been in flight across several consecutive macrotasks. */
  const settled = async () => {
    let quiet = 0;
    const deadline = Date.now() + 10_000;
    while (quiet < 5) {
      if (Date.now() > deadline) throw new Error("store never went idle");
      await new Promise((resolve) => setTimeout(resolve, 5));
      quiet = inFlight === 0 ? quiet + 1 : 0;
    }
  };
  const deps = {
    store,
    embedder: { embedPassage: async (text: string) => [1, (text.length % 7) + 1, 0.5] },
    noisePrototypeBank: null,
  };
  const rows = async () => {
    const listed = await realStore.list([SCOPE], undefined, 1000, 0, "exact");
    return listed.map((row) => ({
      id: row.id,
      category: row.category,
      text: row.text,
      importance: row.importance,
      tags: (JSON.parse(row.metadata || "{}").tags ?? []) as string[],
    }));
  };
  return { deps, rows, settled };
}

/** The dual-write is fire-and-forget; poll until `want` rows are there or time runs out. */
async function waitForRowCount(rows: () => Promise<unknown[]>, want: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = (await rows()).length;
  while (count < want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    count = (await rows()).length;
  }
  return count;
}

describe("implicit preference dual-write: length cap", () => {
  it("does not copy a long narrative that merely contains a 我用 X clause", async () => {
    const { deps, rows, settled } = harness();
    expect(LONG_NARRATIVE.length).toBeGreaterThan(IMPLICIT_PREFERENCE_MAX_TEXT_CHARS);
    // The sentence does match the usage pattern on its own — the cap is what stops the copy.
    expect(shouldDeriveImplicitPreference("events", `${TRIGGER_SENTENCE}。`)).toBe(true);

    const stored = await persistMemory(deps as never, {
      text: LONG_NARRATIVE,
      category: "events",
      scope: SCOPE,
      source: "manual",
      importance: 0.8,
      canonicalKey: "eval:lemomo-ai/lemo-wake",
      tags: ["pinned", "eval-slot", "src:5eb4604e"],
    });
    expect(stored.disposition).toBe("stored");

    // Wait until every store call the write set off has finished, then look.
    await settled();
    const all = await rows();
    expect(all.length).toBe(1);
    expect(all.map((row) => row.category)).toEqual(["events"]);
    expect(all.some((row) => row.tags.includes("derived-preference"))).toBe(false);
  });

  it("still derives a preference from a short usage statement, without the source row's tags", async () => {
    const { deps, rows } = harness();

    const stored = await persistMemory(deps as never, {
      text: "我在用Figma做设计。",
      category: "events",
      scope: SCOPE,
      source: "manual",
      importance: 0.8,
      tags: ["pinned", "eval-slot", "src:5eb4604e"],
    });

    expect(await waitForRowCount(rows, 2, 3000)).toBe(2);
    const all = await rows();
    const derived = all.find((row) => row.category === "preferences");
    const source = all.find((row) => row.category === "events");
    expect(source?.tags).toEqual(expect.arrayContaining(["pinned", "eval-slot", "src:5eb4604e"]));
    expect(derived?.text).toBe("我在用Figma做设计。");
    expect(derived?.tags).toEqual(["derived-preference", `derived-from:${stored.id}`]);
    expect(derived?.importance).toBeLessThanOrEqual(0.5);
  });

  it("does not derive anything when the primary write ended in a conflict", async () => {
    const { deps, rows, settled } = harness();
    const conflicts: Array<Record<string, unknown>> = [];
    const conflictStore = {
      async save(record: Record<string, unknown>) { conflicts.push(record); return record; },
      async replace(record: Record<string, unknown>) { conflicts.push(record); return record; },
      async getOpenByFingerprint() { return null; },
      async getLatestByFingerprint() { return null; },
    };
    const withConflicts = { ...deps, conflictStore };

    const baseline = await persistMemory(withConflicts as never, {
      text: "User prefers concise technical replies.",
      category: "preferences",
      scope: SCOPE,
      source: "manual",
      canonicalKey: "user.reply.style.cross-category",
    });
    const collided = await persistMemory(withConflicts as never, {
      text: "我在用Figma做设计。",
      category: "events",
      scope: SCOPE,
      source: "manual",
      canonicalKey: "user.reply.style.cross-category",
    });
    expect(collided.disposition).toBe("conflict");
    expect(collided.id).toBe(baseline.id);

    // The incoming text was parked, not stored: no copy of it may appear, least of
    // all one that names the row it collided with as its source.
    await settled();
    expect((await rows()).length).toBe(1);
    expect((await rows()).some((row) => row.tags.includes("derived-preference"))).toBe(false);
  });

  it("draws the line at the cap itself", () => {
    // The number is part of the contract: built from literals so that moving the
    // constant fails here instead of moving the samples with it.
    expect(IMPLICIT_PREFERENCE_MAX_TEXT_CHARS).toBe(120);
    const atCap = "我在用Figma做设计。".padEnd(120, "嗯");
    const overCap = "我在用Figma做设计。".padEnd(121, "嗯");
    expect(atCap.length).toBe(120);
    expect(overCap.length).toBe(121);
    expect(shouldDeriveImplicitPreference("events", atCap)).toBe(true);
    expect(shouldDeriveImplicitPreference("events", overCap)).toBe(false);
    expect(shouldDeriveImplicitPreference("preferences", "我在用Figma做设计。")).toBe(false);
    expect(shouldDeriveImplicitPreference("events", "今天把发版流程走了一遍。")).toBe(false);
  });
});
