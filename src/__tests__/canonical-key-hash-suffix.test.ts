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

/** 生产用的哈希段：sha256 前 16 位 hex。 */
function h16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function h8(algorithm: "sha1" | "sha256", text: string): string {
  return createHash(algorithm).update(text).digest("hex").slice(0, 8);
}

/**
 * 生产用的哈希输入：与 normalizeCanonicalKey 同一套折叠（小写、去直引号、标点空白折成 -），
 * 但保留任何文字系统的字母数字（\p{L}\p{N}），西里尔 / 假名 / 谚文不被剥掉。
 */
function hashInput(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** normalizeCanonicalKey 截断前的结果（只留 a-z0-9 与汉字），用来证明两段正文归一化后相同。 */
function fullBaseOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
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
    expect(key("entities", ivan)).toBe(`entities:memory:h${h16(hashInput(ivan))}`);
    expect(key("entities", petr)).toBe(`entities:memory:h${h16(hashInput(petr))}`);
    expect(key("entities", ivan)).not.toBe(key("entities", petr));
  });

  it("韩文", () => {
    const text = "서울에 살고 있습니다";
    expect(key("profile", text)).toBe(`profile:memory:h${h16(hashInput(text))}`);
  });

  it("纯假名", () => {
    const text = "ひらがなだけのメモ";
    expect(key("profile", text)).toBe(`profile:memory:h${h16(hashInput(text))}`);
  });

  it("只有标点也算为空；标点与空白不进哈希，所以纯标点文本互相同 key（改前它们本来就同为 `<类别>:memory`）", () => {
    expect(key("entities", "!!! ???")).toBe(`entities:memory:h${h16("")}`);
    expect(key("entities", "  !!!   ???  ")).toBe(key("entities", "!!! ???"));
    expect(key("entities", "...")).toBe(key("entities", "!!! ???"));
  });

  it("有 title 时按 title 算（与改前取 base 的规则一致）", () => {
    expect(key("entities", "body", "Иван")).toBe(`entities:memory:h${h16("иван")}`);
  });
});

describe("归一化后超过 120 字：截断并附全文短哈希", () => {
  const a = `${LONG_PREFIX} — and also owns the nightly dream consolidation job`;
  const b = `${LONG_PREFIX} — and is on vacation for all of November`;

  it("前 120 字相同的一对得到两个不同的 key", () => {
    expect(key("entities", a)).not.toBe(key("entities", b));
    expect(key("entities", a).endsWith(`:h${h16(hashInput(a))}`)).toBe(true);
    expect(key("entities", b).endsWith(`:h${h16(hashInput(b))}`)).toBe(true);
  });

  it("整条 key 不超过 120 字（冲突记录的 canonicalKey 上限），开头仍是正文的前缀", () => {
    for (const category of ["profile", "preferences", "entities", "events", "cases", "patterns"] as const) {
      const k = key(category, a);
      expect(k.length).toBeLessThanOrEqual(120);
      const body = k.slice(`${category}:`.length, -":h0000000000000000".length);
      expect(body.length).toBeGreaterThan(80);
      expect(k.length).toBe(120);
      expect("alice-is-the-maintainer-of-the-recallnest-memory-service-and-she-reviews-every-pull-request-touching-the-core-write-path".startsWith(body)).toBe(true);
    }
  });

  it("121 字触发、120 字不触发", () => {
    expect(key("entities", "a".repeat(120))).toBe(`entities:${"a".repeat(120)}`);
    expect(key("entities", "a".repeat(121)).endsWith(`:h${h16("a".repeat(121))}`)).toBe(true);
  });

  it("截断处不留半个代理对", () => {
    const astral = "𠀀".repeat(130); // 扩展 B 汉字，每个 2 个 UTF-16 单元
    const k = key("entities", astral);
    expect(k.endsWith(`:h${h16(astral)}`)).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(k)).toBe(false);
    expect(k.length).toBeLessThanOrEqual(120);
  });
});

describe("哈希段 16 位 hex（sha256 前 64 bit）：8 位下撞车的对不再撞", () => {
  it("评审构造的西里尔一对：旧方案（sha1 原文前 8 位）同为 3a66b8c3，现在 key 不同", () => {
    const x = "Иван бдщф";
    const y = "Иван гтзз";
    expect(h8("sha1", x)).toBe("3a66b8c3");
    expect(h8("sha1", y)).toBe("3a66b8c3");
    expect(key("entities", x)).not.toBe(key("entities", y));
  });

  it("在现行哈希输入上 sha256 前 8 位相撞的西里尔一对，16 位下 key 不同", () => {
    const x = "иван бйце";
    const y = "иван фцищ";
    expect(h8("sha256", hashInput(x))).toBe(h8("sha256", hashInput(y)));
    expect(key("entities", x)).toBe(`entities:memory:h${h16(hashInput(x))}`);
    expect(key("entities", x)).not.toBe(key("entities", y));
  });

  it("前缀相同、尾号不同的长英文：旧方案 sha1 前 8 位相撞的一对，现在 key 不同", () => {
    const x = `${LONG_PREFIX} 00079847`;
    const y = `${LONG_PREFIX} 00096619`;
    expect(h8("sha1", x)).toBe(h8("sha1", y));
    expect(key("entities", x)).not.toBe(key("entities", y));
  });

  it("前缀相同、尾号不同的长英文：在现行哈希输入上 sha256 前 8 位相撞的一对，16 位下 key 不同", () => {
    const x = `${LONG_PREFIX} 00032053`;
    const y = `${LONG_PREFIX} 00048400`;
    expect(h8("sha256", hashInput(x))).toBe(h8("sha256", hashInput(y)));
    expect(key("entities", x)).not.toBe(key("entities", y));
  });
});

describe("哈希后缀与普通正文隔离：哈希段用 `:h` 接，正文归一化后产不出冒号", () => {
  it("普通正文「memory-h<16 hex>」一字不变，且与西里尔文本的哈希 key 不同（R3 Codex / Kimi：既有行不能被新哈希 key 命中）", () => {
    const cyrillic = "Иван — мой коллега по работе";
    const hashKey = key("entities", cyrillic);
    expect(hashKey).toMatch(/^entities:memory:h[0-9a-f]{16}$/);
    const lookalike = `memory-h${hashKey.slice(-16)}`;
    expect(key("entities", lookalike)).toBe(`entities:${lookalike}`);
    expect(key("entities", lookalike)).not.toBe(hashKey);
    // 体检举的既有行形状：改前改后都原样
    expect(key("entities", "memory-h70e45d413597cb48")).toBe("entities:memory-h70e45d413597cb48");
  });

  it("正文恰好以 -h<16 hex> 结尾的普通 key 不再被反过来加哈希（R3 Codex / Kimi P1、Grok P2）", () => {
    expect(key("entities", "note-h0123456789abcdef")).toBe("entities:note-h0123456789abcdef");
    expect(key("entities", `${"a".repeat(102)}-h0123456789abcdef`)).toBe(`entities:${"a".repeat(102)}-h0123456789abcdef`);
    expect(key("preferences", "I use foo-h0123456789abcdef")).toBe("preferences:implicit-usage:foo-h0123456789abcdef");
  });

  it("任何归一化后非空、不超长的正文都产不出 `:h` 尾巴", () => {
    for (const text of ["x:h0123456789abcdef", "memory:h0123456789abcdef", "note :h0123456789abcdef"]) {
      expect(key("entities", text)).toBe(`entities:${text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
      expect(key("entities", text)).not.toMatch(/:h[0-9a-f]{16}$/);
    }
  });
});

describe("哈希输入与全文判等同一口径（先小写）", () => {
  it("「A」×121 与「a」×121 同 key", () => {
    expect(key("entities", "A".repeat(121))).toBe(key("entities", "a".repeat(121)));
  });

  it("前面多一个直引号的 121 个 a 与 121 个 a 同 key", () => {
    expect(key("entities", `"${"a".repeat(121)}`)).toBe(key("entities", "a".repeat(121)));
  });

  it("为空分支：大小写不同的同一段西里尔同 key，两段不同的西里尔仍不同", () => {
    expect(key("entities", "ИВАН")).toBe(key("entities", "иван"));
    expect(key("entities", "Иван")).not.toBe(key("entities", "Пётр"));
  });

  it("截断分支：长公共前缀后只差西里尔名字的两段不同 key（R3 Codex N2：哈希输入不能用剥掉非拉丁字符的归一化结果）", () => {
    const ivan = `${LONG_PREFIX}. Contact: Иван`;
    const petr = `${LONG_PREFIX}. Contact: Пётр`;
    expect(fullBaseOf(ivan)).toBe(fullBaseOf(petr)); // 归一化后两段一样，靠哈希输入区分
    expect(key("entities", ivan)).not.toBe(key("entities", petr));
    expect(key("entities", ivan)).toBe(key("entities", `${LONG_PREFIX}. Contact: ИВАН`));
  });

  it("截断分支：标点与空白的差异不进哈希（与归一化口径一致）", () => {
    expect(key("entities", `${LONG_PREFIX}, and more.`)).toBe(key("entities", `${LONG_PREFIX}  and more`));
  });
});

describe("偏好槽位 key 超长时同样附哈希", () => {
  const brand = "品".repeat(24);
  const item = "鸡".repeat(72);
  const jia = `我喜欢吃${brand}的${item}甲甲甲甲甲甲甲甲`;
  const yi = `我喜欢吃${brand}的${item}乙乙乙乙乙乙乙乙`;

  it("brand 24 字 + item 80 字、只差末 8 字的两条偏好得到不同 key，且不超过 120 字", () => {
    const a = key("preferences", jia);
    const b = key("preferences", yi);
    expect(a.startsWith(`preferences:brand-item:${brand}:鸡`)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(120);
    expect(b.length).toBeLessThanOrEqual(120);
    expect(a).toMatch(/:h[0-9a-f]{16}$/);
  });

  it("未超长的槽位 key 一字不变", () => {
    expect(key("preferences", "我喜欢吃麦当劳的麦辣鸡翅")).toBe("preferences:brand-item:麦当劳:麦辣鸡翅");
    expect(key("preferences", "User prefers concise, direct replies.")).toBe("preferences:reply-style:concise:direct");
    expect(key("preferences", "Uses Bun over Node.")).toBe("preferences:tool-choice:bun:over:node");
    expect(key("preferences", "I use Figma for design")).toBe("preferences:implicit-usage:figma");
  });
});

describe("真实临时 LanceDB：同 scope 先后写，前一条不再被原位改写成后一条", () => {
  // 文件里第一次开 LanceDB 要加载原生模块，冷启动时偶尔超过默认的 5 秒
  const LANCEDB_TIMEOUT_MS = 20_000;
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
  }, LANCEDB_TIMEOUT_MS);

  it("长公共前缀英文一对：两条都是 stored，第一条原文还在原 id 上", async () => {
    const one = `${LONG_PREFIX} — and also owns the nightly dream consolidation job`;
    const two = `${LONG_PREFIX} — and is on vacation for all of November`;
    const { store, a, b } = await writeBoth("entities", one, two);
    expect(a.disposition).toBe("stored");
    expect(b.disposition).toBe("stored");
    const first = await store.getById(a.id);
    expect(first!.text).toBe(one);
  }, LANCEDB_TIMEOUT_MS);
});
