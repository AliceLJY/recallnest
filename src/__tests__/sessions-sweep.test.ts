import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionDoc } from "../session-events.js";
import { applyDecision, decide, DEFAULT_POLICY, discoverTranscripts, isTmpWorkdirTranscript, ledgerRelPath, SessionStateStore, sid8, stateKey, type TranscriptFile } from "../sessions-sweep.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-23T12:00:00.000Z");

function fakeDoc(opts: { users: number; endedAt: string; imported?: string; subagent?: boolean }): SessionDoc {
  const events = [] as SessionDoc["events"];
  for (let i = 0; i < opts.users; i++) events.push({ seq: i, ts: opts.endedAt, tsMs: Date.parse(opts.endedAt), kind: "user", text: `u${i}` });
  return { source: "cc", sessionId: "s1", filePath: "/x/s1.jsonl", events, startedAt: opts.endedAt, endedAt: opts.endedAt, lastUserAt: opts.endedAt, importedSource: opts.imported, isSubagent: opts.subagent, malformedLines: 0 };
}
const file = (mtimeAgoMin: number): TranscriptFile => ({ path: "/x/s1.jsonl", source: "cc", sessionId: "s1", mtimeMs: NOW - mtimeAgoMin * MIN, sizeBytes: 1 });
const store = new SessionStateStore(mkdtempSync(join(tmpdir(), "sweep-state-")));

describe("sweep decide()", () => {
  it("does not touch files whose mtime is younger than idleMinutes, and does not parse them", () => {
    let parsed = false;
    const d = decide(file(10), store.fresh(file(10)), NOW, DEFAULT_POLICY, () => { parsed = true; return fakeDoc({ users: 5, endedAt: "2026-10-23T11:50:00.000Z" }); });
    expect(d.action).toBe("not-idle");
    expect(parsed).toBe(false);
  });
  it("uses message time, not mtime, as the silence clock", () => {
    const d = decide(file(45), store.fresh(file(45)), NOW, DEFAULT_POLICY, () => fakeDoc({ users: 5, endedAt: new Date(NOW - 5 * MIN).toISOString() }));
    expect(d.action).toBe("not-idle");
  });
  it("CC 在 /tmp、/private/tmp 下跑的会话不写账本、不解析；别的目录与别的端不受影响（10-31：规则实验回放混进账本）", () => {
    const at = (path: string, source: TranscriptFile["source"] = "cc"): TranscriptFile => ({ path, source, sessionId: "s1", mtimeMs: NOW - 60 * MIN, sizeBytes: 1 });
    const tmp = at("/Users/user/.claude/projects/-private-tmp-rule-exp2-work/s1.jsonl");
    let parsed = false;
    const d = decide(tmp, store.fresh(tmp), NOW, DEFAULT_POLICY, () => { parsed = true; return fakeDoc({ users: 9, endedAt: new Date(NOW - 60 * MIN).toISOString() }); });
    expect(d.action).toBe("skip-tmp");
    expect(parsed).toBe(false);
    expect(applyDecision(store.fresh(tmp), tmp, d, NOW, DEFAULT_POLICY).skipReason).toBe("skip-tmp");
    expect(isTmpWorkdirTranscript(at("/Users/user/.claude/projects/-tmp-x/s1.jsonl"))).toBe(true);
    expect(isTmpWorkdirTranscript(at("/Users/user/.claude/projects/-private-tmp/s1.jsonl"))).toBe(true);
    expect(isTmpWorkdirTranscript(at("/Users/user/.claude/projects/-Users-user/s1.jsonl"))).toBe(false);
    expect(isTmpWorkdirTranscript(at("/Users/user/.claude/projects/-Users-user-tmpl/s1.jsonl"))).toBe(false);
    expect(isTmpWorkdirTranscript(at("/Users/user/.claude/projects/-private-tmpfoo/s1.jsonl"))).toBe(false);
    expect(isTmpWorkdirTranscript(at("/Users/user/.codex/sessions/-private-tmp-x/s1.jsonl", "codex"))).toBe(false);
  });
  it("skips short / imported / subagent sessions and remembers why", () => {
    const f = file(60);
    expect(decide(f, store.fresh(f), NOW, DEFAULT_POLICY, () => fakeDoc({ users: 2, endedAt: new Date(NOW - 60 * MIN).toISOString() })).action).toBe("skip-short");
    expect(decide(f, store.fresh(f), NOW, DEFAULT_POLICY, () => fakeDoc({ users: 9, endedAt: new Date(NOW - 60 * MIN).toISOString(), imported: "doubao" })).action).toBe("skip-imported");
    expect(decide(f, store.fresh(f), NOW, DEFAULT_POLICY, () => fakeDoc({ users: 9, endedAt: new Date(NOW - 60 * MIN).toISOString(), subagent: true })).action).toBe("skip-subagent");
    const skipped = applyDecision(store.fresh(f), f, { action: "skip-short", reason: "x" }, NOW, DEFAULT_POLICY);
    expect(skipped.skipReason).toBe("skip-short");
    // 同一 mtime 再来一轮：不解析
    let parsed = false;
    expect(decide(f, skipped, NOW + MIN, DEFAULT_POLICY, () => { parsed = true; return fakeDoc({ users: 2, endedAt: "2026-10-23T11:00:00.000Z" }); }).action).toBe("unchanged");
    expect(parsed).toBe(false);
  });
  it("first pass writes a ledger and schedules the candidate stage 6h after the last message", () => {
    const f = file(60);
    const endedAt = new Date(NOW - 60 * MIN).toISOString();
    const d = decide(f, store.fresh(f), NOW, DEFAULT_POLICY, () => fakeDoc({ users: 4, endedAt }));
    expect(d.action).toBe("ledger");
    const s1 = applyDecision(store.fresh(f), f, d, NOW, DEFAULT_POLICY, "/out/2026-10/s1.md");
    expect(s1.pass).toBe(1);
    expect(s1.processedUpto).toBe(endedAt);
    expect(s1.candidateDueAt).toBe(new Date(Date.parse(endedAt) + 360 * MIN).toISOString());
    expect(s1.candidateDone).toBe(false);
    // 内容没变、阶段没到 → up-to-date，且不解析
    let parsed = false;
    expect(decide(f, s1, NOW + 60 * MIN, DEFAULT_POLICY, () => { parsed = true; return fakeDoc({ users: 4, endedAt }); }).action).toBe("up-to-date");
    expect(parsed).toBe(false);
    // 内容没变、6 小时到了 → candidates（这是 Codex R3 指出的那条「没有它六小时候选阶段永远进不来」的入口）
    const d2 = decide(f, s1, Date.parse(endedAt) + 361 * MIN, DEFAULT_POLICY, () => fakeDoc({ users: 4, endedAt }));
    expect(d2.action).toBe("candidates");
    const s2 = applyDecision(s1, f, d2, Date.parse(endedAt) + 361 * MIN, DEFAULT_POLICY);
    expect(s2.candidateDone).toBe(true);
    expect(s2.pass).toBe(1);
    // 用户又续写了 → 新一轮 ledger，pass+1，候选重排
    const later = new Date(Date.parse(endedAt) + 500 * MIN).toISOString();
    const f2 = { ...f, mtimeMs: Date.parse(later) };
    const d3 = decide(f2, s2, Date.parse(later) + 40 * MIN, DEFAULT_POLICY, () => fakeDoc({ users: 6, endedAt: later }));
    expect(d3.action).toBe("ledger");
    const s3 = applyDecision(s2, f2, d3, Date.parse(later) + 40 * MIN, DEFAULT_POLICY);
    expect(s3.pass).toBe(2);
    expect(s3.candidateDone).toBe(false);
  });
  it("does not let a not-idle sweep cache the mtime (resumed content must still get a ledger later)", () => {
    // 互审 R1 Codex #1 的合成复现：处理过一次 → 用户续写 → 5 分钟时 not-idle → 40 分钟时必须 ledger，而不是 up-to-date
    const f = file(60 * 24);
    const endedAt = new Date(NOW - 24 * 60 * MIN).toISOString();
    const s1 = applyDecision(store.fresh(f), f, decide(f, store.fresh(f), NOW, DEFAULT_POLICY, () => fakeDoc({ users: 4, endedAt })), NOW, DEFAULT_POLICY);
    const resumedAt = new Date(NOW + 10 * MIN).toISOString();
    const f2 = { ...f, mtimeMs: Date.parse(resumedAt) };
    const d5 = decide(f2, s1, Date.parse(resumedAt) + 5 * MIN, DEFAULT_POLICY, () => fakeDoc({ users: 6, endedAt: resumedAt }));
    expect(d5.action).toBe("not-idle");
    const s2 = applyDecision(s1, f2, d5, Date.parse(resumedAt) + 5 * MIN, DEFAULT_POLICY);
    expect(s2.lastMtimeMs).toBe(s1.lastMtimeMs);
    const d40 = decide(f2, s2, Date.parse(resumedAt) + 40 * MIN, DEFAULT_POLICY, () => fakeDoc({ users: 6, endedAt: resumedAt }));
    expect(d40.action).toBe("ledger");
  });
  it("enters the candidate stage when candidateDueAt has passed even if the mtime is fresh (Grok R3 residual)", () => {
    const f = file(60);
    const endedAt = new Date(NOW - 60 * MIN).toISOString();
    const s1 = applyDecision(store.fresh(f), f, decide(f, store.fresh(f), NOW, DEFAULT_POLICY, () => fakeDoc({ users: 4, endedAt })), NOW, DEFAULT_POLICY);
    const due = Date.parse(s1.candidateDueAt!) + MIN;
    const fresh = { ...f, mtimeMs: due - 2 * MIN }; // 同步工具刚刷过 mtime
    const d = decide(fresh, s1, due, DEFAULT_POLICY, () => fakeDoc({ users: 4, endedAt }));
    expect(d.action).toBe("candidates");
  });
  it("keeps skipReason across repeated unchanged rounds (apply + decide again)", () => {
    const f = file(60);
    let st = applyDecision(store.fresh(f), f, { action: "skip-short", reason: "x" }, NOW, DEFAULT_POLICY);
    for (let k = 1; k <= 3; k++) {
      const d = decide(f, st, NOW + k * MIN, DEFAULT_POLICY, () => { throw new Error("must not parse"); });
      expect(d.action).toBe("unchanged");
      st = applyDecision(st, f, d, NOW + k * MIN, DEFAULT_POLICY);
      expect(st.skipReason).toBe("skip-short");
    }
  });
  it("forces a parse after being not-idle for candidateAfterMinutes even if mtime keeps refreshing", () => {
    // R3 Codex 对 G#1 的补刀：从未处理的会话、外部每隔几分钟刷一次 mtime → 不能永远 not-idle
    const endedAt = new Date(NOW - 24 * 60 * MIN).toISOString();
    let st = store.fresh(file(5));
    let parsed = 0;
    for (let k = 0; k < 40; k++) {
      const now = NOW + k * 10 * MIN;
      const f = { ...file(0), mtimeMs: now - 5 * MIN }; // 每轮 mtime 都「刚刷新过」
      const d = decide(f, st, now, DEFAULT_POLICY, () => { parsed++; return fakeDoc({ users: 5, endedAt }); });
      st = applyDecision(st, f, d, now, DEFAULT_POLICY);
      if (d.action === "ledger+candidates") break;
    }
    expect(parsed).toBe(1);
    expect(st.lastAction).toBe("ledger+candidates");
    expect(st.notIdleSince).toBeNull();
  });
  it("dry-run never creates the state directory", () => {
    const dir = join(tmpdir(), `sweep-nomkdir-${process.pid}-${Date.now()}`);
    const st = new SessionStateStore(dir);
    expect(st.load("x")).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });
  it("in replay (now far after the session) does ledger+candidates in one pass", () => {
    const f = file(60 * 24);
    const endedAt = new Date(NOW - 24 * 60 * MIN).toISOString();
    const d = decide(f, store.fresh(f), NOW, DEFAULT_POLICY, () => fakeDoc({ users: 4, endedAt }));
    expect(d.action).toBe("ledger+candidates");
    expect(applyDecision(store.fresh(f), f, d, NOW, DEFAULT_POLICY).candidateDone).toBe(true);
  });
});

describe("sweep state store and paths", () => {
  it("round-trips state atomically", () => {
    const f = file(60);
    const s = store.fresh(f);
    store.save(s);
    expect(store.load(s.key)).toEqual(s);
    expect(stateKey("cc", "a/b c")).toBe("cc__a_b_c");
    expect(sid8("01a15411-54df-7b23")).toBe("01a15411");
    expect(ledgerRelPath("01a15411-54df", "2026-10-19T23:59:00.000Z")).toBe(join("2026-10", "01a15411.md"));
  });
});

describe("discoverTranscripts", () => {
  it("finds the four layouts, skips CC subagents, prefers transcript_full", () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-disc-"));
    const mk = (p: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), "{}\n"); };
    mk(".claude/projects/-U/aaaaaaaa-1111-4222-8333-444444444444.jsonl");
    mk(".claude/projects/-U/subagents/sub.jsonl");
    mk(".codex/sessions/2026/10/20/rollout-2026-10-20T15-11-18-01a15411-54df-7b23-93ef-1272cbe09290.jsonl");
    mk(".kimi-code/sessions/wd/session_k1/agents/main/wire.jsonl");
    mk(".kimi-code/sessions/wd/session_k1/agents/sub1/wire.jsonl");
    mk(".gemini/antigravity-cli/brain/b1/.system_generated/logs/transcript.jsonl");
    mk(".gemini/antigravity-cli/brain/b1/.system_generated/logs/transcript_full.jsonl");
    mk(".gemini/antigravity-cli/brain/b2/.system_generated/logs/transcript.jsonl");
    const old = join(root, ".claude/projects/-U/old-1111-4222-8333-444444444444.jsonl");
    writeFileSync(old, "{}\n");
    utimesSync(old, new Date(2025, 0, 1), new Date(2025, 0, 1));
    const r = discoverTranscripts([
      { source: "cc", dir: join(root, ".claude/projects") },
      { source: "codex", dir: join(root, ".codex/sessions") },
      { source: "kimi", dir: join(root, ".kimi-code/sessions") },
      { source: "antigravity", dir: join(root, ".gemini/antigravity-cli/brain"), machine: "mini" },
      { source: "antigravity", dir: join(root, "nope") },
    ], { sinceMs: Date.parse("2026-01-01T00:00:00Z") });
    const bySource = Object.fromEntries(["cc", "codex", "kimi", "antigravity"].map((s) => [s, r.files.filter((f) => f.source === s).map((f) => f.path.slice(root.length))]));
    expect(bySource.cc).toEqual(["/.claude/projects/-U/aaaaaaaa-1111-4222-8333-444444444444.jsonl"]);
    expect(bySource.codex).toHaveLength(1);
    expect(bySource.kimi).toEqual(["/.kimi-code/sessions/wd/session_k1/agents/main/wire.jsonl"]);
    expect(bySource.antigravity.sort()).toEqual(["/.gemini/antigravity-cli/brain/b1/.system_generated/logs/transcript_full.jsonl", "/.gemini/antigravity-cli/brain/b2/.system_generated/logs/transcript.jsonl"]);
    expect(r.files.find((f) => f.source === "antigravity")?.machine).toBe("mini");
    expect(r.files.find((f) => f.source === "kimi")?.sessionId).toBe("k1");
    expect(r.missingRoots).toEqual([join(root, "nope")]);
    expect(r.statCalls).toBeGreaterThan(0);
  });
});
