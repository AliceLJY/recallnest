/**
 * Minis 入库后的存档：投递目录里入库过的 jsonl 挪进 data/minis-archive（Deja 从那里读原文），
 * 投递目录清空。承重的是三件事：
 * - 只挪台账里记着、且大小和 mtime 都没变的文件——没入库的挪走就再也不会入库了；
 * - 存档是逐字节一样的一份——原件随后会被删掉，存档就是唯一的原文；
 * - 同名不同内容时两版都留——同一场对话可能被 Minis 同名覆盖导出好几次；
 * - 一行可用对话都没有的留在原处报错——台账照样会把它记成已处理，悄悄收走就没人知道格式坏了。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCCTranscript } from "../ingest.js";
import { archiveIngestedMinisFiles, type IngestedCheck } from "../minis-archive.js";

let root: string;
let drop: string;
let archive: string;

/** 模拟台账：记下入库那一刻的大小和 mtime，之后文件一变就不再算已入库（与 tracker.isProcessed 同口径）。 */
function ledgerOf(...paths: string[]): IngestedCheck {
  const entries = new Map(paths.map((p) => {
    const s = statSync(p);
    return [p, { size: s.size, mtimeMs: s.mtimeMs }] as const;
  }));
  return (filePath, size, mtimeMs) => {
    const entry = entries.get(filePath);
    return entry !== undefined && entry.size === size && entry.mtimeMs === mtimeMs;
  };
}

function conversation(lines: number, tag = "a"): string {
  return Array.from({ length: lines }, (_, i) => JSON.stringify({ type: "user", sessionId: tag, message: { content: `${tag}-${i}` } })).join("\n") + "\n";
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "minis-archive-"));
  drop = join(root, "minis-outbox", "ingest");
  archive = join(root, "data", "minis-archive");
  mkdirSync(drop, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("archiveIngestedMinisFiles", () => {
  it("入库过的文件：存档里有逐字节一样的一份、沿用原件 mtime 和权限，原件从投递目录消失", () => {
    const src = join(drop, "conversation-20260903-悬案局第四案.jsonl");
    const body = conversation(5);
    writeFileSync(src, body);
    chmodSync(src, 0o600);
    const past = new Date("2026-09-03T00:45:02+08:00");
    utimesSync(src, past, past);

    const result = archiveIngestedMinisFiles(drop, archive, ledgerOf(src));

    const target = join(archive, "conversation-20260903-悬案局第四案.jsonl");
    expect(result.archived).toEqual([target]);
    expect(result.errors).toEqual([]);
    expect(readFileSync(target, "utf-8")).toBe(body);
    expect(statSync(target).mtimeMs).toBe(past.getTime());
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(existsSync(src)).toBe(false);
  });

  it("还没入库的留在原处，存档目录不建", () => {
    const src = join(drop, "conversation-20260911-新对话.jsonl");
    writeFileSync(src, conversation(3));

    const result = archiveIngestedMinisFiles(drop, archive, ledgerOf());

    expect(result.pending).toEqual(["conversation-20260911-新对话.jsonl"]);
    expect(result.archived).toEqual([]);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(archive)).toBe(false);
  });

  it("入库后又被同名覆盖（大小变了）的留在原处，等下一轮先把新版入库", () => {
    const src = join(drop, "conversation-20260828-滚动录屏流水线.jsonl");
    writeFileSync(src, conversation(3));
    const ledger = ledgerOf(src);
    writeFileSync(src, conversation(6));

    const result = archiveIngestedMinisFiles(drop, archive, ledger);

    expect(result.pending).toEqual(["conversation-20260828-滚动录屏流水线.jsonl"]);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(archive)).toBe(false);
  });

  it("存档里已有同名同内容：不另存副本，原件照删", () => {
    const name = "conversation-20260903-悬案局第四案.jsonl";
    const body = conversation(4);
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, name), body);
    const src = join(drop, name);
    writeFileSync(src, body);

    const result = archiveIngestedMinisFiles(drop, archive, ledgerOf(src));

    expect(result.archived).toEqual([join(archive, name)]);
    expect(readdirSync(archive)).toEqual([name]);
    expect(existsSync(src)).toBe(false);
  });

  it("存档里已有同名不同内容：新版另存 -2，旧版原样保留", () => {
    const name = "conversation-20260820-记忆网关v2与收工自动化.jsonl";
    const older = conversation(2, "old");
    const newer = conversation(5, "new");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, name), older);
    const src = join(drop, name);
    writeFileSync(src, newer);

    const result = archiveIngestedMinisFiles(drop, archive, ledgerOf(src));

    const second = join(archive, "conversation-20260820-记忆网关v2与收工自动化-2.jsonl");
    expect(result.archived).toEqual([second]);
    expect(readFileSync(join(archive, name), "utf-8")).toBe(older);
    expect(readFileSync(second, "utf-8")).toBe(newer);
    expect(existsSync(src)).toBe(false);
  });

  it("读不出来的原件（如 iCloud 占位文件）报错并留在原处，不留半截存档", () => {
    const src = join(drop, "conversation-20260911-读不出来.jsonl");
    writeFileSync(src, conversation(3));
    const ledger = ledgerOf(src);
    chmodSync(src, 0o000);
    try {
      const result = archiveIngestedMinisFiles(drop, archive, ledger);
      expect(result.archived).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("conversation-20260911-读不出来.jsonl");
      expect(existsSync(src)).toBe(true);
      expect(existsSync(archive) ? readdirSync(archive) : []).toEqual([]);
    } finally {
      chmodSync(src, 0o644);
    }
  });

  it("一行可用对话都没有的文件（台账照样记成已处理）留在原处并报错，不悄悄收走", () => {
    const src = join(drop, "conversation-20260911-格式不对.jsonl");
    writeFileSync(src, JSON.stringify({ note: "no type, no message" }) + "\n");

    const result = archiveIngestedMinisFiles(drop, archive, ledgerOf(src), () => false);

    expect(result.archived).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("没有可用的对话行");
    expect(existsSync(src)).toBe(true);
    expect(existsSync(archive)).toBe(false);
  });

  it("cli 传进来的判据就是 parseCCTranscript：Minis 导出格式认得出，缺 type/message 的认不出", () => {
    const good = join(drop, "good.jsonl");
    writeFileSync(good, [
      { type: "user", sessionId: "bb9128c3-5b7b-4366-b8ae-f4bb9ab52703", uuid: "u1", parentUuid: null, timestamp: "2026-09-03T00:10:00+08:00", source: "minis", message: { role: "user", content: "帮我把悬案局第四案整理成一个时间线，按出场顺序排" } },
      { type: "assistant", sessionId: "bb9128c3-5b7b-4366-b8ae-f4bb9ab52703", uuid: "u2", parentUuid: "u1", timestamp: "2026-09-03T00:11:00+08:00", source: "minis", message: { role: "assistant", content: "好的，按出场顺序整理如下：第一幕是报案，第二幕是现场勘查，第三幕是嫌疑人对质。" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const bad = join(drop, "bad.jsonl");
    writeFileSync(bad, JSON.stringify({ sessionId: "x", text: "没有 type 和 message 字段" }) + "\n");

    expect(parseCCTranscript(good).length).toBeGreaterThan(0);
    expect(parseCCTranscript(bad).length).toBe(0);
  });

  it("只管投递目录顶层的 .jsonl：子目录和别的文件不碰", () => {
    const nested = join(drop, "sub", "x.jsonl");
    mkdirSync(join(drop, "sub"));
    writeFileSync(nested, conversation(2));
    const note = join(drop, "readme.md");
    writeFileSync(note, "not a conversation");

    const result = archiveIngestedMinisFiles(drop, archive, () => true);

    expect(result.archived).toEqual([]);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(note)).toBe(true);
  });

  it("投递目录不存在时什么都不做", () => {
    const result = archiveIngestedMinisFiles(join(root, "missing"), archive, () => true);
    expect(result).toEqual({ archived: [], pending: [], errors: [] });
    expect(existsSync(archive)).toBe(false);
  });
});
