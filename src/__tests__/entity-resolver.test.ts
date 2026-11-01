import { describe, expect, it } from "bun:test";

import { EntityResolver, BUILTIN_ALIASES, defaultResolver, resolveQueryEntities } from "../entity-resolver.js";
import { expandQuery } from "../query-expander.js";

describe("EntityResolver", () => {
  it("resolves known aliases", () => {
    expect(defaultResolver.resolve("ts")).toBe("typescript");
    expect(defaultResolver.resolve("TS")).toBe("typescript");
    expect(defaultResolver.resolve("k8s")).toBe("kubernetes");
    expect(defaultResolver.resolve("pg")).toBe("postgresql");
  });

  it("returns term as-is for unknown aliases", () => {
    expect(defaultResolver.resolve("unknownThing")).toBe("unknownThing");
    expect(defaultResolver.resolve("")).toBe("");
  });

  it("supports user aliases that override builtins", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES, { "ts": "my-custom-ts" });
    expect(resolver.resolve("ts")).toBe("my-custom-ts");
  });

  it("resolveText replaces aliases in context", () => {
    const text = "I'm using TS with k8s and pg for the backend";
    const resolved = defaultResolver.resolveText(text);
    expect(resolved).toContain("typescript");
    expect(resolved).toContain("kubernetes");
    expect(resolved).toContain("postgresql");
  });

  it("resolveText handles longer aliases first", () => {
    const text = "Using docker-compose for local dev";
    const resolved = defaultResolver.resolveText(text);
    expect(resolved).toContain("docker compose");
  });

  it("hasAlias returns true for known aliases", () => {
    expect(defaultResolver.hasAlias("ts")).toBe(true);
    expect(defaultResolver.hasAlias("unknown")).toBe(false);
  });

  it("size returns the number of aliases", () => {
    expect(defaultResolver.size).toBeGreaterThan(40);
  });
});

describe("resolveQueryEntities", () => {
  it("normalizes entities in a search query", () => {
    const result = resolveQueryEntities("search for ts config in k8s");
    expect(result).toContain("typescript");
    expect(result).toContain("kubernetes");
  });

  it("passes through queries with no aliases", () => {
    const result = resolveQueryEntities("how to deploy a web app");
    expect(result).toBe("how to deploy a web app");
  });
});

// 体检 14 顺带的小问题：`\bts\b` 在点后面也算词边界，BM25 查询里的 `retriever.ts` 曾被改写成
// `retriever.typescript`，精确 token 丢了。带点的文件名里的扩展名不算独立词；独立的 `ts` 照旧改写。
describe("resolveText 不改写带点的文件名", () => {
  it("retriever.ts 原样保留，同一句里独立的 ts 照旧改成 typescript", () => {
    const out = resolveQueryEntities("how is length normalization computed in retriever.ts with ts");
    expect(out).toContain("retriever.ts");
    expect(out).not.toContain("retriever.typescript");
    expect(out).toMatch(/with typescript$/);
  });

  it("其他扩展名同理：app.js / setup.py / main.rs 不动", () => {
    expect(resolveQueryEntities("fix app.js and setup.py and main.rs")).toBe("fix app.js and setup.py and main.rs");
  });

  it("句末的点不算文件名：'I use ts.' 里的 ts 照旧改写", () => {
    expect(resolveQueryEntities("I use ts.")).toBe("I use typescript.");
  });

  it("自身带点的别名照旧生效（node.js → nodejs，next.js → nextjs）", () => {
    expect(resolveQueryEntities("node.js vs next.js")).toBe("nodejs vs nextjs");
  });

  it("expandQuery（BM25 查询的来源）里 retriever.ts 也保留", () => {
    expect(expandQuery("how is length normalization computed in retriever.ts")).toContain("retriever.ts");
  });
});
