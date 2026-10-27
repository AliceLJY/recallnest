import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendRecallLog, buildRecallLogEntry, recallLogFileName } from "../recall-log.js";

describe("recall-log", () => {
  it("builds a compact, redacted entry and appends one line per call to the session file", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "recall-log-"));
    // 假 key 在运行时拼出来，不写成能被扫描器认成真凭证的字面量（shared-behaviors §8.1）
    const fakeKey = ["sk", "-", "a".repeat(20), "0".repeat(20)].join("");
    const entry = buildRecallLogEntry({
      sessionId: "cfe4de46-aaaa-4bbb-8ccc-ddddeeeeffff",
      operation: "api:/v1/auto-recall",
      query: `  给这个网页录个屏   token=${fakeKey}  `.repeat(3),
      scope: "memory:pivot",
      mode: "resume+search",
      results: [
        { entry: { id: "12345678-1111-4222-8333-444444444444", scope: "memory:pivot", category: "preferences", metadata: JSON.stringify({ canonicalKey: "pref-x" }) }, score: 0.91234 },
        { id: "abcdefab-1111-4222-8333-444444444444", score: 0.5, scope: "memory" },
      ],
      now: Date.parse("2026-10-23T00:00:00Z"),
    });
    expect(entry.query.length).toBeLessThanOrEqual(200);
    expect(entry.query).not.toContain(fakeKey);
    expect(entry.results[0]).toEqual({ id8: "12345678", score: 0.912, scope: "memory:pivot", canonicalKey: "pref-x", category: "preferences" });
    expect(entry.results[1].id8).toBe("abcdefab");
    expect(entry.outcome).toBeNull();
    const file = appendRecallLog(dataDir, entry);
    appendRecallLog(dataDir, entry);
    expect(file).toBe(join(dataDir, "recall-log", recallLogFileName(entry.sessionId)));
    const lines = readFileSync(file!, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).sessionId).toBe(entry.sessionId);
  });
  it("never throws on an unwritable data dir", () => {
    const entry = buildRecallLogEntry({ sessionId: "x", operation: "t", query: "q", results: [] });
    expect(appendRecallLog("/dev/null/not-a-dir", entry)).toBeNull();
  });
});
