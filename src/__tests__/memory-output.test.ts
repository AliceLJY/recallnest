import { describe, expect, it } from "bun:test";

import {
  formatBriefResults,
  formatCollapsedResults,
  formatExplainResults,
  formatFullResults,
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
    const search = formatSearchResults([result], { query: "concise", profile: "default" } as any);
    expect(search).toContain("Date       Age   Retrieval Path");
    expect(search).toMatch(/2026-03-16 \d+d\s+vector/);
    const explain = formatExplainResults([result], { query: "concise", profile: "default" } as any);
    expect(explain).toMatch(/2026-03-16 \(\d+d\)/);
  });

  it("includes provenance in search results", () => {
    const output = formatSearchResults([
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
    ], {
      query: "reply style",
      profile: "default",
    });

    expect(output).toContain("prov : durable/structured-memory");
    expect(output).toContain("key:user-reply-style");
    expect(output).toContain("promoted:feedface<-evidence/transcript-ingest");
    expect(output).toContain("history:2");
    expect(output).toContain("observed:deadbeef@2026-03-17");
    expect(output).toContain("slot:brand-item:麦当劳:麦辣鸡翅");
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
    const output = formatSearchResults([buildDistilled("abcd1234-0000-0000-0000-0000000000d1")], ctx);

    expect(output).toContain(`orig : (2026-03-13 session) ${ANCHOR}`);
    expect(output).toContain("Note    :");
    expect(output).toContain("trust orig");
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
    const output = formatSearchResults(
      [
        buildDistilled("abcd1234-0000-0000-0000-0000000000d3"),
        buildResult("abcd1234-0000-0000-0000-0000000000d4", { source: "manual", tags: ["pinned"], anchor: "锚点" }),
      ],
      ctx,
    );
    const lines = output.split("\n");
    const origIdx = lines.findIndex((line) => line.startsWith("   orig : "));
    const secondRowIdx = lines.findIndex((line) => line.startsWith("2  abcd1234"));

    expect(output.match(/^ {3}orig : /gm)?.length).toBe(1);
    expect(origIdx).toBeGreaterThan(-1);
    expect(origIdx).toBeLessThan(secondRowIdx);
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
