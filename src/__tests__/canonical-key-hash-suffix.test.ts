import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistMemory } from "../capture-engine.js";
import { buildDefaultCanonicalKey, type DurableMemoryCategory } from "../memory-boundaries.js";
import { MemoryStore } from "../store.js";

/**
 * 默认 canonical key 塌缩（体检第 12 条，2026-10-17）。
 *
 * normalizeCanonicalKey 只留 [a-z0-9] 与汉字、截到 120 字。改前：
 * - 西里尔 / 韩文 / 纯假名正文归一化后为空，一律退回 `<类别>:memory`，同 scope 后写的把先写的标成 superseded；
 * - 归一化后超过 120 字的两段正文只要前 120 字相同就共用一个 key。
 * 改后只在这两种情形附全文短哈希；其余情形与改前逐字相同（现有生产行的 key 不能变）。
 */

function sha8(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function key(category: DurableMemoryCategory, text: string, title?: string): string {
  return buildDefaultCanonicalKey({ category, text, title });
}

const LONG_PREFIX =
  "Alice is the maintainer of the RecallNest memory service and she reviews every pull request touching the core write path and retrieval ranking";

describe("没有空、没有截断时：与改前逐字相同（改前代码实跑录下的值）", () => {
  // 每一行的期望值都是在改动之前的 memory-boundaries.ts 上实跑 buildDefaultCanonicalKey 得到的
  const golden: Array<{ category: DurableMemoryCategory; text: string; title?: string; expected: string }> = [
    { category: "profile", text: "我住在上海浦东", expected: "profile:我住在上海浦东" },
    { category: "entities", text: "Alice works at Acme Corp on the search team", expected: "entities:alice-works-at-acme-corp-on-the-search-team" },
    { category: "entities", text: "RecallNest 用 LanceDB 做向量存储", expected: "entities:recallnest-用-lancedb-做向量存储" },
    { category: "patterns", text: "Always run `bun test` before committing", expected: "patterns:always-run-bun-test-before-committing" },
    { category: "events", text: "2026-10-06 删除了对话原文切片", expected: "events:2026-10-06-删除了对话原文切片" },
    { category: "cases", text: "修复 \"forget\" 级联：trigger 行与 pin 一起清", expected: "cases:修复-forget-级联-trigger-行与-pin-一起清" },
    { category: "profile", text: "  User's name is   Alice  ", expected: "profile:users-name-is-alice" },
    { category: "preferences", text: "我喜欢吃麦当劳的麦旋风、板烧鸡腿堡和麦辣鸡翅", expected: "preferences:我喜欢吃麦当劳的麦旋风-板烧鸡腿堡和麦辣鸡翅" },
    { category: "preferences", text: "Uses Bun over Node.", expected: "preferences:tool-choice:bun:over:node" },
    // 混排时假名被剥掉但汉字留下：不为空、不截断，按规则不加哈希
    { category: "entities", text: "東京の近くに住んでいる", expected: "entities:東京-近-住" },
    { category: "entities", text: "Café déjà vu — naïve résumé", expected: "entities:caf-d-j-vu-na-ve-r-sum" },
    { category: "profile", text: "x", title: "Project Title: Memory v3", expected: "profile:project-title-memory-v3" },
    // 归一化后恰好 120 字：没有截断，不加哈希
    { category: "entities", text: "a".repeat(120), expected: `entities:${"a".repeat(120)}` },
    // 没有任何正文：没有可区分的东西，照旧 `<类别>:memory`
    { category: "entities", text: "", expected: "entities:memory" },
  ];

  for (const row of golden) {
    it(`${row.category} ← ${JSON.stringify(row.title ?? row.text).slice(0, 40)}`, () => {
      expect(key(row.category, row.text, row.title)).toBe(row.expected);
    });
  }
});

describe("归一化后为空：附全文短哈希", () => {
  it("西里尔一对得到两个不同的 key，各带自己全文的哈希", () => {
    const ivan = "Иван — мой коллега по работе";
    const petr = "Пётр — мой брат";
    expect(key("entities", ivan)).toBe(`entities:memory-h${sha8(ivan)}`);
    expect(key("entities", petr)).toBe(`entities:memory-h${sha8(petr)}`);
    expect(key("entities", ivan)).not.toBe(key("entities", petr));
  });

  it("韩文", () => {
    const text = "서울에 살고 있습니다";
    expect(key("profile", text)).toBe(`profile:memory-h${sha8(text)}`);
  });

  it("纯假名", () => {
    const text = "ひらがなだけのメモ";
    expect(key("profile", text)).toBe(`profile:memory-h${sha8(text)}`);
  });

  it("只有标点也算为空；哈希按折叠空白后的原文算，首尾与连续空白不影响", () => {
    expect(key("entities", "!!! ???")).toBe(`entities:memory-h${sha8("!!! ???")}`);
    expect(key("entities", "  !!!   ???  ")).toBe(key("entities", "!!! ???"));
  });

  it("有 title 时按 title 算（与改前取 base 的规则一致）", () => {
    expect(key("entities", "body", "Иван")).toBe(`entities:memory-h${sha8("Иван")}`);
  });
});

describe("归一化后超过 120 字：截断并附全文短哈希", () => {
  const a = `${LONG_PREFIX} — and also owns the nightly dream consolidation job`;
  const b = `${LONG_PREFIX} — and is on vacation for all of November`;

  it("前 120 字相同的一对得到两个不同的 key", () => {
    expect(key("entities", a)).not.toBe(key("entities", b));
    expect(key("entities", a).endsWith(`-h${sha8(a)}`)).toBe(true);
    expect(key("entities", b).endsWith(`-h${sha8(b)}`)).toBe(true);
  });

  it("整条 key 不超过 120 字（冲突记录的 canonicalKey 上限），开头仍是正文的前缀", () => {
    for (const category of ["profile", "preferences", "entities", "events", "cases", "patterns"] as const) {
      const k = key(category, a);
      expect(k.length).toBeLessThanOrEqual(120);
      const body = k.slice(`${category}:`.length, -"-h00000000".length);
      expect(body.length).toBeGreaterThan(80);
      expect("alice-is-the-maintainer-of-the-recallnest-memory-service-and-she-reviews-every-pull-request-touching-the-core-write-path".startsWith(body)).toBe(true);
    }
  });

  it("121 字触发、120 字不触发", () => {
    expect(key("entities", "a".repeat(120))).toBe(`entities:${"a".repeat(120)}`);
    expect(key("entities", "a".repeat(121)).endsWith(`-h${sha8("a".repeat(121))}`)).toBe(true);
  });

  it("截断处不留半个代理对", () => {
    const astral = "𠀀".repeat(130); // 扩展 B 汉字，每个 2 个 UTF-16 单元
    const k = key("entities", astral);
    expect(k.endsWith(`-h${sha8(astral)}`)).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(k)).toBe(false);
    expect(k.length).toBeLessThanOrEqual(120);
  });
});

describe("真实临时 LanceDB：同 scope 先后写，前一条不再被原位改写成后一条", () => {
  const tmpDirs: string[] = [];
  let originalDataDir: string | undefined;

  beforeAll(() => {
    originalDataDir = process.env.RECALLNEST_DATA_DIR;
    process.env.RECALLNEST_DATA_DIR = mkdtempSync(join(tmpdir(), "rn-key-hash-datadir-"));
    tmpDirs.push(process.env.RECALLNEST_DATA_DIR);
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
    else process.env.RECALLNEST_DATA_DIR = originalDataDir;
    while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  afterEach(() => {
    while (tmpDirs.length > 1) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function makeDeps() {
    const dir = mkdtempSync(join(tmpdir(), "rn-key-hash-db-"));
    tmpDirs.push(dir);
    const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 4 });
    // 两段正文给互相正交的向量：语义判重（Tier 3.6）不会把它们当同一条，测的只是 key
    const vectors = new Map<string, number[]>();
    const deps = {
      store,
      embedder: {
        async embedPassage(text: string) {
          let v = vectors.get(text);
          if (!v) {
            v = [0, 0, 0, 0];
            v[vectors.size % 4] = 1;
            vectors.set(text, v);
          }
          return v;
        },
      },
      noisePrototypeBank: null,
    };
    return { store, deps };
  }

  async function writeBoth(category: DurableMemoryCategory, first: string, second: string) {
    const { store, deps } = makeDeps();
    const scope = "project:key-hash";
    // persistMemory 的 deps 类型要求完整的检索 / LLM 依赖，这里只给写路径用得到的三样
    const run = (text: string) =>
      persistMemory(deps as unknown as Parameters<typeof persistMemory>[0], { text, category, scope, source: "manual" });
    const a = await run(first);
    const b = await run(second);
    return { store, a, b };
  }

  it("西里尔一对：两条都是 stored，第一条原文还在原 id 上", async () => {
    const { store, a, b } = await writeBoth("entities", "Иван — мой коллега по работе", "Пётр — мой брат");
    expect(a.disposition).toBe("stored");
    expect(b.disposition).toBe("stored");
    expect(b.id).not.toBe(a.id);
    const first = await store.getById(a.id);
    expect(first).not.toBeNull();
    expect(first!.text).toBe("Иван — мой коллега по работе");
  });

  it("长公共前缀英文一对：两条都是 stored，第一条原文还在原 id 上", async () => {
    const one = `${LONG_PREFIX} — and also owns the nightly dream consolidation job`;
    const two = `${LONG_PREFIX} — and is on vacation for all of November`;
    const { store, a, b } = await writeBoth("entities", one, two);
    expect(a.disposition).toBe("stored");
    expect(b.disposition).toBe("stored");
    const first = await store.getById(a.id);
    expect(first!.text).toBe(one);
  });
});
