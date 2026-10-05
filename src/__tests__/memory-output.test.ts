import { describe, expect, it } from "bun:test";

import {
  formatBriefResults,
  formatCollapsedResults,
  formatExplainResults,
  formatFullResults,
  formatFullTextResults,
  formatLegacyTableResults,
  formatSearchResults,
} from "../memory-output.js";
import { estimateTokens } from "../context-collapse-renderer.js";
import type { RetrievalResult } from "../retriever.js";

function buildResult(id: string, metadata: Record<string, unknown>): RetrievalResult {
  return {
    entry: {
      id,
      text: "User prefers concise, direct replies.",
      vector: [],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: JSON.stringify(metadata),
    },
    score: 0.91,
    sources: {
      vector: { score: 0.9, rank: 1 },
      bm25: { score: 0.8, rank: 2 },
      fused: { score: 0.91 },
    },
  };
}

describe("memory output", () => {
  it("renders a whole-day age next to every date so nobody has to subtract", () => {
    const result = buildResult("abcd1234-0000-0000-0000-000000000009", { source: "agent" });
    const legacy = formatLegacyTableResults([result], { query: "concise", profile: "default" } as any);
    expect(legacy).toContain("Date       Age   Retrieval Path");
    expect(legacy).toMatch(/2026-03-16 \d+d\s+vector/);
    const search = formatFullTextResults([result], { query: "concise", profile: "default" } as any);
    expect(search).toMatch(/2026-03-16 \(\d+d\)/);
    const explain = formatExplainResults([result], { query: "concise", profile: "default" } as any);
    expect(explain).toMatch(/2026-03-16 \(\d+d\)/);
  });

  it("includes provenance in search results", () => {
    const provenanceResults = [
      buildResult("abcd1234-0000-0000-0000-000000000001", {
        source: "agent",
        canonicalKey: "user-reply-style",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        promotedFrom: {
          memoryId: "feedface-0000-0000-0000-000000000001",
          scope: "cc:session1",
          category: "events",
          boundary: {
            layer: "evidence",
            authority: "transcript-ingest",
            conflictPolicy: "append-only",
            originalCategory: "preferences",
          },
        },
        provenanceHistory: [
          {
            memoryId: "feedface-0000-0000-0000-000000000001",
            scope: "cc:session1",
            category: "events",
            source: "cc",
          },
          {
            memoryId: "deadbeef-0000-0000-0000-000000000002",
            scope: "cc:session2",
            category: "events",
            source: "cc",
            observedAt: "2026-03-17T04:30:00.000Z",
            boundary: {
              layer: "evidence",
              authority: "transcript-ingest",
              conflictPolicy: "append-only",
              originalCategory: "preferences",
            },
          },
        ],
        provenanceHistoryCount: 2,
        preferenceSlot: {
          type: "brand-item",
          brand: "麦当劳",
          item: "麦辣鸡翅",
        },
      }),
    ];
    const context = { query: "reply style", profile: "default" as const };
    const legacy = formatLegacyTableResults(provenanceResults, context);
    const fullText = formatFullTextResults(provenanceResults, context);

    expect(legacy).toContain("prov : durable/structured-memory");
    // 新默认把 provenance 并进条目那一行，内容一样不少
    expect(fullText).toMatch(/^\[1\] abcd1234 · .* · durable\/structured-memory \| key:user-reply-style/m);
    for (const output of [legacy, fullText]) {
      expect(output).toContain("key:user-reply-style");
      expect(output).toContain("promoted:feedface<-evidence/transcript-ingest");
      expect(output).toContain("history:2");
      expect(output).toContain("observed:deadbeef@2026-03-17");
      expect(output).toContain("slot:brand-item:麦当劳:麦辣鸡翅");
    }
  });

  it("includes provenance in explain results", () => {
    const output = formatExplainResults([
      buildResult("abcd1234-0000-0000-0000-000000000001", {
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
          downgradedFrom: "preferences",
        },
      }),
    ], {
      query: "reply style",
      profile: "writing",
    });

    expect(output).toContain("prov    : evidence/transcript-ingest");
    expect(output).toContain("downgraded:preferences");
  });

  it("renders reply-style slots in provenance summaries", () => {
    const output = formatSearchResults([
      buildResult("abcd1234-0000-0000-0000-000000000002", {
        source: "agent",
        canonicalKey: "preferences:reply-style:concise:direct",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        preferenceSlot: {
          type: "reply-style",
          traits: ["concise", "direct"],
        },
      }),
    ], {
      query: "reply style",
      profile: "default",
    });

    expect(output).toContain("slot:reply-style:concise:direct");
  });

  it("renders tool-choice slots in provenance summaries", () => {
    const output = formatSearchResults([
      buildResult("abcd1234-0000-0000-0000-000000000003", {
        source: "agent",
        canonicalKey: "preferences:tool-choice:bun:over:node",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        preferenceSlot: {
          type: "tool-choice",
          preferredTool: "bun",
          avoidedTool: "node",
        },
      }),
    ], {
      query: "tool choice",
      profile: "default",
    });

    expect(output).toContain("slot:tool-choice:bun:over:node");
  });

  it("does not render slot provenance for plain preferences canonical keys", () => {
    const output = formatSearchResults([
      buildResult("abcd1234-0000-0000-0000-000000000004", {
        source: "agent",
        canonicalKey: "preferences:这段文案简洁直接-先别改",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
      buildResult("abcd1234-0000-0000-0000-000000000005", {
        source: "agent",
        canonicalKey: "preferences:文档里写了-uses-bun-over-node-的迁移说明",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
    ], {
      query: "preferences",
      profile: "default",
    });

    expect(output).toContain("key:preferences:这段文案简洁直接-先别改");
    expect(output).toContain("key:preferences:文档里写了-uses-bun-over-node-的迁移说明");
    expect(output).not.toContain("slot:reply-style:");
    expect(output).not.toContain("slot:tool-choice:");
  });

  it("does not render slot provenance in explain output for plain preferences canonical keys", () => {
    const output = formatExplainResults([
      buildResult("abcd1234-0000-0000-0000-000000000006", {
        source: "agent",
        canonicalKey: "preferences:这段文案简洁直接-先别改",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
    ], {
      query: "draft note",
      profile: "default",
    });

    expect(output).toContain("key:preferences:这段文案简洁直接-先别改");
    expect(output).not.toContain("slot:reply-style:");
    expect(output).not.toContain("slot:tool-choice:");
  });
});

// session 级图片标记（2026-08-27）：ingest 不把图编进库，只记「这个 session 里
// 用户贴过几张图」。检索侧必须把它显式说出来——不说，读到这条记忆的人不会知道
// 附近还有图没看，写入侧就白做了。
describe("memory output — session 级图片标记", () => {
  it("有 sessionImages 时多给一行 imgs，带张数和回查坐标", () => {
    const output = formatSearchResults(
      [
        buildResult("abcd1234-0000-0000-0000-00000000000a", {
          source: "cc",
          sessionId: "05a9a168-9ee9-489e-9a9a-7f691a272ef1",
          sessionImages: 7,
        }),
      ],
      { query: "报错", profile: "default" } as any,
    );

    expect(output).toContain("imgs :");
    expect(output).toContain("7 user-pasted");
    expect(output).toContain("sess=05a9a168");
    // 措辞要说清这是 session 级、未必属于本条，否则读的人会当成「这条有图」
    expect(output).toContain("in this session");
  });

  // AI 产图单独成一类：它答的是「我当时生成的图 / 页面当时什么样」，
  // 跟「我发过的那张截图」不是一个问题。实测它比用户贴图多三倍多，
  // 只标用户贴图会让一半以上的带图 session 完全没有标记。
  it("只有 AI 产图时也出 imgs 行，并与用户贴图分开报", () => {
    const output = formatSearchResults(
      [
        buildResult("abcd1234-0000-0000-0000-00000000000c", {
          source: "codex",
          sessionId: "019f710a-84a6-7a73-a283-a198cf9a6208",
          sessionToolImages: 23,
        }),
      ],
      { query: "截图", profile: "default" } as any,
    );

    expect(output).toContain("imgs :");
    expect(output).toContain("23 agent-made");
    expect(output).not.toContain("user-pasted");
  });

  // 反向断言：无图记忆不该多出这一行，否则就是给所有记忆添噪音
  it("没有任何图片标记的记忆不输出 imgs 行", () => {
    const output = formatSearchResults(
      [buildResult("abcd1234-0000-0000-0000-00000000000b", { source: "agent" })],
      { query: "concise", profile: "default" } as any,
    );

    expect(output).not.toContain("imgs :");
  });
});

// 2026-09-11：pivot 池 1,516 条批量提炼行的转述句没逐条核对过，抽 20 条有 8 条与自存原文有实质出入。
// 读取时把行上已有的原文 anchor 亮出来，表头说明以原文为准。
describe("memory output — 批量提炼行附原文", () => {
  const ANCHOR = "说很多次了，只要我说我们记忆项目，就是只这个master仓库。";
  const ctx = { query: "记忆项目", profile: "default" as const };

  function buildDistilled(id: string, extra: Record<string, unknown> = {}): RetrievalResult {
    return buildResult(id, {
      source: "session_distill",
      tags: ["src:a9d91600", "date:2026-03-13", "pivot-apply", "batch:pref-r1-p3", "pinned"],
      anchor: ANCHOR,
      ...extra,
    });
  }

  it("normal 档：批量行多一行 orig，带原会话日期和原文，表头说明以原文为准", () => {
    const distilled = [buildDistilled("abcd1234-0000-0000-0000-0000000000d1")];
    // 新默认与退回开关下的旧表格都要带
    for (const output of [formatFullTextResults(distilled, ctx), formatLegacyTableResults(distilled, ctx)]) {
      expect(output).toContain(`orig : (2026-03-13 session) ${ANCHOR}`);
      expect(output).toContain("Note    :");
      expect(output).toContain("trust orig");
    }
  });

  // 反向断言：当场记录的行也存 anchor，但语义不同——不该冒出 orig 行，更不该出表头说明
  it("非批量行即使带 anchor 也不出 orig 行和表头说明", () => {
    const output = formatSearchResults(
      [
        buildResult("abcd1234-0000-0000-0000-0000000000d2", {
          source: "manual",
          tags: ["pinned", "2026-08-01"],
          anchor: "某句检索锚点",
        }),
      ],
      ctx,
    );

    expect(output).not.toContain("orig :");
    expect(output).not.toContain("Note    :");
  });

  it("批量行与当场记录混排时，只有批量行带 orig，且不串到下一条", () => {
    const mixed = [
      buildDistilled("abcd1234-0000-0000-0000-0000000000d3"),
      buildResult("abcd1234-0000-0000-0000-0000000000d4", { source: "manual", tags: ["pinned"], anchor: "锚点" }),
    ];
    const cases: Array<[string, string]> = [
      [formatLegacyTableResults(mixed, ctx), "2  abcd1234"],
      [formatFullTextResults(mixed, ctx), "[2] abcd1234"],
    ];
    for (const [output, secondRowPrefix] of cases) {
      const lines = output.split("\n");
      const origIdx = lines.findIndex((line) => line.startsWith("   orig : "));
      const secondRowIdx = lines.findIndex((line) => line.startsWith(secondRowPrefix));

      expect(output.match(/^ {3}orig : /gm)?.length).toBe(1);
      expect(origIdx).toBeGreaterThan(-1);
      expect(secondRowIdx).toBeGreaterThan(-1);
      expect(origIdx).toBeLessThan(secondRowIdx);
    }
  });

  it("full 档同样附原文", () => {
    const output = formatFullResults([buildDistilled("abcd1234-0000-0000-0000-0000000000d5")], ctx);

    expect(output).toContain(`orig : (2026-03-13 session) ${ANCHOR}`);
    expect(output).toContain("Note    :");
  });

  it("brief 档只标不附原文，保持简短", () => {
    const output = formatBriefResults(
      [
        buildDistilled("abcd1234-0000-0000-0000-0000000000d6"),
        buildResult("abcd1234-0000-0000-0000-0000000000d7", { source: "manual" }),
      ],
      { query: "记忆项目" },
    );
    const markedRows = output.split("\n").filter((line) => line.startsWith("#") && line.includes("[distilled"));

    expect(markedRows.length).toBe(1);
    expect(markedRows[0]).toContain("[distilled, 2026-03-13 session]");
    expect(output).not.toContain(ANCHOR);
    expect(output).toContain("detail_level=normal");
  });

  it("adaptive 档附原文，并把原文算进 token 预算", () => {
    const single = formatCollapsedResults([buildDistilled("abcd1234-0000-0000-0000-0000000000d8")], ctx);
    expect(single).toContain(`orig: (2026-03-13 session) ${ANCHOR}`);
    expect(single).toContain("Note    :");

    // 塞满预算：每条显示出来的批量行都必须带着原文，不能为了挤进预算把原文丢掉
    const longText = "很长的提炼句".repeat(200);
    const many = Array.from({ length: 200 }, (_, i) =>
      buildDistilled(`abcd1234-0000-0000-0000-${String(i).padStart(12, "0")}`),
    ).map((result) => ({ ...result, score: 0.5, entry: { ...result.entry, text: longText } }));
    const output = formatCollapsedResults(many, ctx);
    const shown = Number(/Shown\s+: (\d+) of 200/.exec(output)?.[1]);

    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);
    expect(output.match(/^orig: /gm)?.length).toBe(shown);

    // 真正核预算：显示出来的正文 + 原文加起来不许超 8000。只数条数挡不住「原文没算进预算」——
    // 那种写法照样每条都带原文，只是总量悄悄超标。
    const lines = output.split("\n");
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/^\[(FULL|SNIP)\] /.test(lines[i] ?? "")) continue;
      used += estimateTokens(lines[i + 1] ?? "");
      const next = lines[i + 2] ?? "";
      if (next.startsWith("orig: ")) used += estimateTokens(next);
    }
    expect(used).toBeLessThanOrEqual(8000);
  });

  it("批量行缺原文时照样标出来，不崩", () => {
    const output = formatSearchResults(
      [buildResult("abcd1234-0000-0000-0000-0000000000d9", { source: "session_distill", tags: ["pivot-apply"] })],
      ctx,
    );

    expect(output).toContain("orig : (source text missing)");
  });

  it("原文过长时截断并留省略号", () => {
    const output = formatSearchResults(
      [buildDistilled("abcd1234-0000-0000-0000-0000000000da", { anchor: "原".repeat(500) })],
      ctx,
    );
    const origLine = output.split("\n").find((line) => line.startsWith("   orig : ")) ?? "";

    expect(origLine.endsWith("...")).toBe(true);
    expect(origLine.length).toBeLessThan(220);
  });
});

// 2026-10-05：默认第一屏从「表格 + 每条 120 字」改成按名次给全文。
// 依据是同一批 48 条真实查询的盲判：只看这一屏就够的，120 字是 1 条、全文是 18 条。
describe("memory output — 默认第一屏给全文", () => {
  const ctx = { query: "结论", profile: "default" as const };
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  function withText(id: string, text: string, score = 0.5, metadata: Record<string, unknown> = { source: "manual" }): RetrievalResult {
    const base = buildResult(id, metadata);
    return { ...base, score, entry: { ...base.entry, text } };
  }
  const idOf = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
  /** 取出第 n 条命中那一块（从它的条目行到下一条之前）。 */
  function blockOf(output: string, n: number): string {
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`[${n}] `));
    if (start < 0) return "";
    const next = lines.findIndex((line, i) => i > start && /^\[\d+\] /.test(line));
    return lines.slice(start, next < 0 ? undefined : next).join("\n");
  }

  it("正文整条给出、换行保留，旧表格在同一条上只露出一小段", () => {
    const tail = "否决的理由写在最后：当时试过两次都没成。";
    const text = `结论：默认走 A。\n契机：她说「那就按你说的改」。\n${"推理过程很长。".repeat(60)}\n${tail}`;
    const result = [withText(idOf(1), text)];
    const output = formatFullTextResults(result, ctx);

    expect(output).toContain(text);
    expect(output.split("\n")).toContain("Text    : 1 in full");
    expect(output).not.toContain("File / Snippet");
    expect(output).not.toContain("truncated");
    // 反向校准：这条断言在旧表格上必须不成立，否则上面那句「整条给出」什么都没证明
    expect(formatLegacyTableResults(result, ctx)).not.toContain(tail);
  });

  it("只看名次不看分数：分数很低的命中也给全文", () => {
    const text = `开头一句。${"中段细节。".repeat(80)}低分条目的结尾也要看得到。`;
    const result = [withText(idOf(2), text, 0.3)];

    expect(formatFullTextResults(result, ctx)).toContain(text);
    // 反向校准：adaptive 按分数给，同一条只拿到片段
    expect(formatCollapsedResults(result, ctx)).not.toContain("低分条目的结尾也要看得到。");
  });

  it("单条超过封顶只给开头 2400 字，并写明共多少、给了多少、用哪个编号展开", () => {
    const text = "甲".repeat(2400) + "乙".repeat(600);
    const output = formatFullTextResults([withText(idOf(3), text)], ctx);

    expect(output).toContain("甲".repeat(2400));
    expect(output).not.toContain("乙");
    // 展开提示给完整编号，不给 8 位前缀：前缀在库里有撞的，撞了取不回来
    expect(output).toContain(`… [truncated: showing 2400 of 3000 chars · memory_drill_down ${idOf(3)} for the full text]`);
    expect(output.split("\n")).toContain("Text    : 0 in full, 1 capped (2400-char cap) — shortened entries say how much is shown");
  });

  it("恰好 2400 字不截、不出说明行", () => {
    const output = formatFullTextResults([withText(idOf(4), "丙".repeat(2400))], ctx);

    expect(output).toContain("丙".repeat(2400));
    expect(output).not.toContain("truncated");
    expect(output.split("\n")).toContain("Text    : 1 in full");
  });

  it("封顶处不把四字节字符切成两半", () => {
    // 第 2400 个码点是表情：按 UTF-16 下标截会留下半个代理对
    const text = "丁".repeat(2399) + "😀" + "戊".repeat(500);
    const output = formatFullTextResults([withText(idOf(5), text)], ctx);

    expect(LONE_SURROGATE.test(output)).toBe(false);
    expect(output).toContain("丁".repeat(2399) + "😀");
    expect(output).toContain("showing 2400 of 2900 chars");
  });

  it("总量超预算：前面的给全文，放不下的降成片段并标明，每条命中都还在", () => {
    // 每条 2400 个汉字 ≈ 3600 token，预算 8000 只放得下两条
    const many = Array.from({ length: 20 }, (_, i) => withText(idOf(100 + i), `第${i}条结论。` + "长".repeat(2390)));
    const output = formatFullTextResults(many, ctx);
    const headers = output.split("\n").filter((line) => /^\[\d+\] /.test(line));

    expect(headers.length).toBe(20);
    expect(output.split("\n")).toContain("Text    : 2 in full, 18 snippet (8000-token budget) — shortened entries say how much is shown");
    expect(blockOf(output, 1)).toContain("长".repeat(2390));
    expect(blockOf(output, 2)).toContain("长".repeat(2390));
    expect(blockOf(output, 3)).not.toContain("长".repeat(400));
    expect(blockOf(output, 3)).toContain(
      `[snippet: token budget reached · showing 183 of 2396 chars · memory_drill_down ${idOf(102)} for the full text]`,
    );
    expect(blockOf(output, 20)).toContain(`memory_drill_down ${idOf(119)}`);

    // 真正核预算，全文和片段都数：8000 是给全文的额度，全文加起来不许超；
    // 片段不受它拦，但每个片段不许比片段窗口长，所以整屏的上界是 8000 + 片段条数 × 一个窗口。
    const bodyOf = (n: number) => blockOf(output, n).split("\n")[1] ?? "";
    let fullTokens = 0;
    let snippetTokens = 0;
    let snippets = 0;
    for (let n = 1; n <= 20; n++) {
      if (blockOf(output, n).includes("[snippet:")) {
        snippets++;
        snippetTokens += estimateTokens(bodyOf(n));
        expect(Array.from(bodyOf(n)).length).toBeLessThanOrEqual(242);
      } else {
        fullTokens += estimateTokens(bodyOf(n));
      }
    }
    expect(snippets).toBe(18);
    expect(fullTokens).toBeLessThanOrEqual(8000);
    expect(fullTokens + snippetTokens).toBeLessThanOrEqual(8000 + snippets * estimateTokens("长".repeat(242)));
    // 这条用例同时记下「整屏会超过 8000」这件事本身：它是有意的，不是漏算
    expect(fullTokens + snippetTokens).toBeGreaterThan(8000);
  });

  it("片段说明里的字数是真的", () => {
    const many = Array.from({ length: 4 }, (_, i) => withText(idOf(200 + i), `第${i}条结论。` + "长".repeat(2390)));
    const block = blockOf(formatFullTextResults(many, ctx), 3);
    const match = /showing (\d+) of (\d+) chars/.exec(block);
    const shownText = block.split("\n")[1] ?? "";
    // 片段函数在截断的那一头补一个省略号，它不是原文，不该数进「给了多少」
    const fromSource = shownText.replace(/^…/, "").replace(/…$/, "");

    expect(match).not.toBeNull();
    expect(shownText.endsWith("…")).toBe(true);
    expect(many[2].entry.text.startsWith(fromSource)).toBe(true);
    expect(Number(match?.[2])).toBe(Array.from(many[2].entry.text).length);
    expect(Number(match?.[1])).toBe(Array.from(fromSource).length);
  });

  it("降成片段时窗口切在四字节字符中间，不留半个代理对", () => {
    const long = (n: number) => withText(idOf(n), "长".repeat(2400));
    // 两条长的加 500 个汉字用掉 7950；第四条是英文，匹配词在第 100 位，窗口右边界正好落在表情的两半之间
    const fourth = "x".repeat(100) + "KEY" + "x".repeat(176) + "😀" + "x".repeat(100);
    const output = formatFullTextResults(
      [long(601), long(602), withText(idOf(603), "短".repeat(500)), withText(idOf(604), fourth)],
      { query: "KEY", profile: "default" as const },
    );

    expect(blockOf(output, 4)).toContain("[snippet: token budget reached");
    expect(blockOf(output, 4)).toContain("KEY");
    expect(LONE_SURROGATE.test(output)).toBe(false);
  });

  it("orig 行在 160 字处截到四字节字符中间，也不留半个代理对", () => {
    const output = formatFullTextResults(
      [
        withText(idOf(605), "提炼句", 0.5, {
          source: "session_distill",
          tags: ["pivot-apply", "date:2026-03-13"],
          anchor: "原".repeat(156) + "😀" + "原".repeat(50),
        }),
      ],
      ctx,
    );

    expect(output).toContain("   orig : (2026-03-13 session) " + "原".repeat(156));
    expect(LONE_SURROGATE.test(output)).toBe(false);
  });

  it("最后一条正文自己的结尾空白不被吃掉", () => {
    const output = formatFullTextResults([withText(idOf(606), "第一条"), withText(idOf(607), "正文结尾有空格和换行  \n")], ctx);

    expect(output.endsWith("正文结尾有空格和换行  \n")).toBe(true);
  });

  it("长的放不下时，后面放得下的短条目仍给全文", () => {
    const long = (n: number) => withText(idOf(n), "长".repeat(2400));
    // 300 字：比片段窗口（240 字）长，所以它拿到全文靠的是「放得下」，不是短条目豁免
    const shortText = "排在后面、放得下的条目，整条都该看得到。" + "尾".repeat(280);
    const output = formatFullTextResults([long(301), long(302), long(303), withText(idOf(304), shortText)], ctx);

    expect(blockOf(output, 3)).toContain("[snippet: token budget reached");
    expect(blockOf(output, 4)).toContain(shortText);
    expect(blockOf(output, 4)).not.toContain("[snippet:");
    expect(output).toContain("Text    : 3 in full, 1 snippet (8000-token budget)");
  });

  it("预算用完之后，片段也占预算；整条不比片段长的短条目照给全文、不标片段", () => {
    const long = (n: number) => withText(idOf(n), "长".repeat(2400));
    // 两条长的 7200；第三条降成片段（没有匹配词时是开头 180 字，约 270）；第四条 400 字 = 600。
    // 片段不占预算的话，第四条是 7200 + 600 放得下；占了就是 7200 + 270 + 600 > 8000，放不下。
    const fourth = "第四条。" + "中".repeat(396);
    const output = formatFullTextResults([long(501), long(502), long(503), withText(idOf(504), fourth)], ctx);

    expect(blockOf(output, 3)).toContain("[snippet: token budget reached");
    expect(blockOf(output, 4)).toContain("[snippet: token budget reached");

    // 预算已经被三条片段顶破（7200 + 270 × 3 > 8000）之后来一条十个字的：
    // 它比片段还短，降了也省不下字，照给全文、不挂「给了片段」的说明
    const tiny = "只有一句话的短条目。";
    const exhausted = formatFullTextResults(
      [long(511), long(512), long(513), long(514), long(515), withText(idOf(516), tiny)],
      ctx,
    );

    expect(blockOf(exhausted, 5)).toContain("[snippet: token budget reached");
    expect(blockOf(exhausted, 6)).toContain(tiny);
    expect(blockOf(exhausted, 6)).not.toContain("[snippet:");
    expect(exhausted).toContain("Text    : 3 in full, 3 snippet (8000-token budget)");
  });

  it("orig 行算进预算：正文刚好放得下、加上原文放不下时降成片段", () => {
    const long = (n: number) => withText(idOf(n), "长".repeat(2400));
    // 两条长的用掉 7200；第三条正文 500 个汉字 = 750，不带原文时合计 7950 放得下
    const third = "短".repeat(500);
    const plain = formatFullTextResults([long(401), long(402), withText(idOf(403), third)], ctx);
    const distilled = formatFullTextResults(
      [
        long(401),
        long(402),
        withText(idOf(403), third, 0.5, {
          source: "session_distill",
          tags: ["pivot-apply", "date:2026-03-13"],
          anchor: "原".repeat(60),
        }),
      ],
      ctx,
    );

    expect(blockOf(plain, 3)).toContain(third);
    expect(blockOf(distilled, 3)).toContain("[snippet: token budget reached");
    // 降成片段也不能把原文行丢掉
    expect(blockOf(distilled, 3)).toContain("   orig : (2026-03-13 session) " + "原".repeat(60));
  });

  it("没有 provenance 也没有文件名的条目，条目行里不留空占位", () => {
    const base = buildResult(idOf(5), { source: "manual" });
    const output = formatFullTextResults([{ ...base, entry: { ...base.entry, scope: "project:x" } }], ctx);
    const header = output.split("\n").find((line) => line.startsWith("[1] ")) ?? "";

    expect(header).toMatch(/^\[1\] 00000005 · 91\.0% · 2026-03-16 \(\d+d\) · preferences · manual$/);
  });

  it("有文件名的条目把文件名放在条目行末尾", () => {
    const output = formatFullTextResults(
      [withText(idOf(6), "切片正文", 0.5, { source: "memory", file: "feedback_x.md" })],
      ctx,
    );

    expect(output.split("\n").find((line) => line.startsWith("[1] "))).toMatch(/ · feedback_x\.md$/);
  });

  it("会话切片给 sess=前 8 位；文件名只是会话编号的重复时不再写一遍", () => {
    const headerOf = (metadata: Record<string, unknown>) =>
      formatFullTextResults([withText(idOf(8), "切片正文", 0.5, metadata)], ctx)
        .split("\n")
        .find((line) => line.startsWith("[1] ")) ?? "";
    const sid = "05a9a168-9ee9-489e-9a9a-7f691a272ef1";

    // Claude Code：文件名就是会话编号
    const cc = headerOf({ source: "cc", sessionId: sid, file: `${sid}.jsonl` });
    expect(cc).toMatch(/ · sess=05a9a168$/);
    expect(cc).not.toContain(".jsonl");
    // Codex：文件名是时间戳加会话编号
    const codex = headerOf({ source: "codex", sessionId: sid, file: `rollout-2026-08-11T12-41-09-${sid}.jsonl` });
    expect(codex).toMatch(/ · sess=05a9a168$/);
    expect(codex).not.toContain("rollout-");
    // 文件名另带信息（Minis 的对话标题）时两样都给
    expect(headerOf({ source: "minis", sessionId: sid, file: "conversation-20260828-滚动录屏.jsonl" })).toMatch(
      / · sess=05a9a168 · conversation-20260828-滚动录屏\.jsonl$/,
    );
    // 只是碰巧含有会话编号前 8 位的文件名不算重复，照给
    expect(headerOf({ source: "memory", sessionId: sid, file: "report-05a9a168-investigation.md" })).toMatch(
      / · sess=05a9a168 · report-05a9a168-investigation\.md$/,
    );
  });

  it("声明了依赖的记忆：fresh 行排在正文之前", () => {
    const output = formatFullTextResults(
      [
        withText(idOf(7), "这条依赖一个已经不在的文件。", 0.5, {
          source: "manual",
          dependsOn: [{ kind: "file", ref: "/nonexistent/recallnest-first-screen-test.txt" }],
        }),
      ],
      ctx,
    );
    const lines = output.split("\n");
    const freshIdx = lines.findIndex((line) => line.startsWith("   fresh: "));
    const textIdx = lines.findIndex((line) => line === "这条依赖一个已经不在的文件。");

    expect(freshIdx).toBeGreaterThan(-1);
    expect(lines[freshIdx]).toBe("   fresh: invalid");
    expect(freshIdx).toBeLessThan(textIdx);
  });

  it("没有命中时与旧样式同一句话", () => {
    expect(formatFullTextResults([], ctx)).toBe("No results found.");
    expect(formatLegacyTableResults([], ctx)).toBe("No results found.");
  });
});

describe("memory output — 退回旧第一屏的开关", () => {
  const KEY = "RECALLNEST_SEARCH_FIRST_SCREEN";
  const ctx = { query: "concise", profile: "default" as const };
  const results = [
    buildResult("abcd1234-0000-0000-0000-0000000000e1", { source: "agent", canonicalKey: "user-reply-style" }),
    buildResult("abcd1234-0000-0000-0000-0000000000e2", {
      source: "session_distill",
      tags: ["pivot-apply", "date:2026-03-13"],
      anchor: "原话",
      sessionId: "05a9a168-9ee9-489e-9a9a-7f691a272ef1",
      sessionImages: 2,
    }),
  ];

  function withEnv(value: string | undefined, run: () => void): void {
    const saved = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  }

  it("不设时 formatSearchResults 出全文那一版", () => {
    withEnv(undefined, () => {
      expect(formatSearchResults(results, ctx)).toBe(formatFullTextResults(results, ctx));
      expect(formatSearchResults(results, ctx)).toContain("Text    : 2 in full");
    });
  });

  it("设成 legacy 时出旧表格，与旧函数逐字相同", () => {
    withEnv("legacy", () => {
      const output = formatSearchResults(results, ctx);
      expect(output).toBe(formatLegacyTableResults(results, ctx));
      expect(output).toContain("#  ID       Score Category     Tier       Source  Date       Age   Retrieval Path       File / Snippet");
      expect(output).not.toContain("Text    :");
    });
  });

  it("只认 legacy 这一个写法，别的值都按默认走", () => {
    for (const value of ["Legacy", "LEGACY", " legacy ", "1", "true", "table", ""]) {
      withEnv(value, () => {
        expect(formatSearchResults(results, ctx)).toBe(formatFullTextResults(results, ctx));
      });
    }
  });

  // 旧表格的样子钉死在这里：退回开关的承诺是「和改动之前一样」，不是「差不多」。
  it("旧表格的逐行样子没变", () => {
    const base = buildResult("abcd1234-0000-0000-0000-0000000000e3", {
      source: "cc",
      file: "session.jsonl",
      boundary: { layer: "evidence", authority: "transcript-ingest", conflictPolicy: "append-only", originalCategory: "preferences" },
    });
    const longText = "第一句讲结论。" + "后面的细节很多很多。".repeat(30);
    const output = formatLegacyTableResults([{ ...base, entry: { ...base.entry, text: longText } }], ctx);
    const lines = output.split("\n");
    const age = /2026-03-16 (\d+d)/.exec(lines[6] ?? "")?.[1] ?? "";

    expect(lines.slice(0, 6)).toEqual([
      "Query   : concise",
      "Profile : default",
      "Hits    : 1",
      "",
      "#  ID       Score Category     Tier       Source  Date       Age   Retrieval Path       File / Snippet",
      "-- -------- ----- ------------ ---------- ------- ---------- ----- -------------------- --------------",
    ]);
    expect(lines[6]).toBe(
      `1  abcd1234 91.0%  preferences  peripheral cc      2026-03-16 ${age.padEnd(5)} vector+bm25          session.jsonl | ${longText.slice(0, 117)}...`,
    );
    // 片段就是 120 字：117 个字加三个点
    expect((lines[6] ?? "").split(" | ")[1]?.length).toBe(120);
    expect(lines[7]).toBe("   prov : evidence/transcript-ingest");
    expect(lines.length).toBe(8);
  });

  // 独立基线：下面这 14 行是拿改动之前的提交（079da6e）里的 formatSearchResults 对同一组输入实际渲染出来的，
  // 不是照着现在的函数抄的。orig / imgs / fresh 三种附加行的顺序和缩进都在里面。
  it("旧表格带 orig / imgs / fresh 的混排与改动之前的实际输出逐行相同", () => {
    const mk = (id: string, text: string, score: number, scope: string, category: string, metadata: Record<string, unknown>): RetrievalResult => ({
      entry: {
        id,
        text,
        vector: [],
        category,
        scope,
        importance: 0.8,
        timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
        metadata: JSON.stringify(metadata),
      },
      score,
      sources: { vector: { score: 0.9, rank: 1 }, bm25: { score: 0.8, rank: 2 }, fused: { score } },
    } as RetrievalResult);
    const mixed = [
      mk("abcd1234-0000-0000-0000-0000000000f1", "提炼句：记忆项目指 master 仓库。", 0.91, "memory:pivot", "preferences", {
        source: "session_distill",
        tags: ["src:a9d91600", "date:2026-03-13", "pivot-apply"],
        anchor: "说很多次了，我们记忆项目就是这个仓库。",
        sessionId: "05a9a168-9ee9-489e-9a9a-7f691a272ef1",
        sessionImages: 2,
        sessionToolImages: 3,
        dependsOn: [{ kind: "file", ref: "/nonexistent/recallnest-legacy-golden.txt" }],
      }),
      mk("abcd1234-0000-0000-0000-0000000000f2", "第二条是当场记录。\n第二行。", 0.5, "cc:session1", "events", {
        source: "cc",
        file: "05a9a168-9ee9-489e-9a9a-7f691a272ef1.jsonl",
        tier: "working",
        boundary: { layer: "evidence", authority: "transcript-ingest", conflictPolicy: "append-only", originalCategory: "events" },
      }),
    ];
    const realNow = Date.now;
    Date.now = () => Date.parse("2026-10-05T00:00:00.000Z");
    let output: string;
    try {
      output = formatLegacyTableResults(mixed, { query: "记忆项目", profile: "default" as const });
    } finally {
      Date.now = realNow;
    }

    expect(output.split("\n")).toEqual([
      "Query   : 记忆项目",
      "Profile : default",
      "Hits    : 2",
      "Note    : rows with an orig line were batch-distilled from old sessions: the snippet is a paraphrase, orig is the source text (it may be the assistant's words, not the user's) — trust orig",
      "",
      "#  ID       Score Category     Tier       Source  Date       Age   Retrieval Path       File / Snippet",
      "-- -------- ----- ------------ ---------- ------- ---------- ----- -------------------- --------------",
      "1  abcd1234 91.0%  preferences  peripheral session_distill 2026-03-16 203d  vector+bm25          - | 提炼句：记忆项目指 master 仓库。",
      "   prov : durable/?",
      "   imgs : 2 user-pasted, 3 agent-made in this session · read sess=05a9a168",
      "   orig : (2026-03-13 session) 说很多次了，我们记忆项目就是这个仓库。",
      "   fresh: invalid",
      "2  abcd1234 50.0%  events       working    cc      2026-03-16 203d  vector+bm25          05a9a168-9ee9-489e-9a9a-7f691a272ef1.jsonl | 第二条是当场记录。",
      "   prov : evidence/transcript-ingest",
    ]);
  });
});
