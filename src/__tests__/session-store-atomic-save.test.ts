import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { runToolSafely } from "../error-taxonomy.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { buildSessionCheckpointRecord } from "../session-engine.js";
import type { SessionCheckpointRecord } from "../session-schema.js";
import { checkpointFileName, SessionCheckpointStore } from "../session-store.js";

const SRC_DIR = join(import.meta.dir, "..");

/**
 * checkpoint 保存（2026-10-17）：原先先删同 checkpointId 的旧文件再直接写目标文件，写失败只打一行日志、照样返回成功，
 * 结果旧版没了、新版没写成、工具还报成功。现在先写临时文件再 rename，rename 成功之后才删旧版，任何失败都抛出。
 * 写失败一律用「目标路径上放一个目录」制造（EISDIR），root 下同样稳定，不靠 chmod。
 */

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = {
  sessionId: "s-atomic",
  scope: "project:recallnest",
  decisions: ["先写临时文件再 rename"],
  idempotencyKey: "atomic-save-key",
};

function version(summary: string, updatedAt: string): SessionCheckpointRecord {
  return buildSessionCheckpointRecord({ ...base, summary, updatedAt });
}

describe("SessionCheckpointStore.save", () => {
  it("throws when the new version cannot be written, and keeps the previous version readable", async () => {
    const dir = tempDir("rn-ckpt-atomic-");
    const store = new SessionCheckpointStore(dir);
    const v1 = version("第一版状态", "2026-10-17T10:00:00.000Z");
    await store.save(v1);
    const v2 = version("第二版状态", "2026-10-17T11:00:00.000Z");
    expect(v2.checkpointId).toBe(v1.checkpointId);
    mkdirSync(join(dir, checkpointFileName(v2)));

    await expect(store.save(v2)).rejects.toThrow(/Failed to save session checkpoint/);

    const latest = await store.getLatest({ sessionId: "s-atomic" });
    expect(latest?.summary).toBe("第一版状态");
    expect(readFileSync(join(dir, checkpointFileName(v1)), "utf-8")).toContain("第一版状态");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces the previous version only after the new one is in place", async () => {
    const dir = tempDir("rn-ckpt-atomic-");
    const store = new SessionCheckpointStore(dir);
    await store.save(version("第一版状态", "2026-10-17T10:00:00.000Z"));
    const v2 = version("第二版状态", "2026-10-17T11:00:00.000Z");
    await store.save(v2);

    expect(readdirSync(dir)).toEqual([checkpointFileName(v2)]);
    expect((await store.getLatest({ sessionId: "s-atomic" }))?.summary).toBe("第二版状态");
  });

  it("overwrites in place when the new version lands on the same file name", async () => {
    const dir = tempDir("rn-ckpt-atomic-");
    const store = new SessionCheckpointStore(dir);
    await store.save(version("第一版状态", "2026-10-17T10:00:00.000Z"));
    const v2 = version("同一时刻的新状态", "2026-10-17T10:00:00.000Z");
    await store.save(v2);

    expect(readdirSync(dir)).toEqual([checkpointFileName(v2)]);
    expect((await store.getLatest({ sessionId: "s-atomic" }))?.summary).toBe("同一时刻的新状态");
  });

  it("leaves the previous file intact when a write dies halfway through (same file name)", async () => {
    const dir = tempDir("rn-ckpt-atomic-");
    const store = new SessionCheckpointStore(dir);
    const v1 = version("第一版状态", "2026-10-17T10:00:00.000Z");
    await store.save(v1);
    const realWrite = fs.writeFileSync;
    // Simulates a disk filling up mid-write: half the bytes land, then ENOSPC.
    // The save lock's own file goes through untouched; every checkpoint-data write gets cut short.
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
      if (String(file).endsWith(".lock")) return realWrite(file, data, options);
      realWrite(file, data.slice(0, Math.floor(data.length / 2)));
      throw new Error("ENOSPC: no space left on device, write");
    }) as typeof fs.writeFileSync);
    try {
      await expect(store.save(version("同一时刻的新状态", "2026-10-17T10:00:00.000Z"))).rejects.toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }

    expect((await store.getLatest({ sessionId: "s-atomic" }))?.summary).toBe("第一版状态");
    expect(readdirSync(dir)).toEqual([checkpointFileName(v1)]);
  });

  it("throws when an older version cannot be removed, after the new version is already saved", async () => {
    const dir = tempDir("rn-ckpt-atomic-");
    const store = new SessionCheckpointStore(dir);
    const v1 = version("第一版状态", "2026-10-17T10:00:00.000Z");
    // A directory carrying the same checkpointId suffix: unlinkSync on it fails (EISDIR / EPERM), root included.
    mkdirSync(join(dir, checkpointFileName(v1)));
    const v2 = version("第二版状态", "2026-10-17T11:00:00.000Z");

    await expect(store.save(v2)).rejects.toThrow(/could not remove older versions/);

    expect((await store.getLatest({ sessionId: "s-atomic" }))?.summary).toBe("第二版状态");
  });

  it("does not list or sweep a leftover temp file", async () => {
    const dir = tempDir("rn-ckpt-atomic-");
    const store = new SessionCheckpointStore(dir);
    const v1 = version("第一版状态", "2026-10-17T10:00:00.000Z");
    const leftover = `.${checkpointFileName(v1)}.999-leftover.tmp`;
    writeFileSync(join(dir, leftover), "{\"half\":");
    await store.save(v1);

    expect(await store.listRecent({ sessionId: "s-atomic" })).toHaveLength(1);
    expect(readdirSync(dir)).toContain(leftover);
  });
});

describe("checkpoint_session tool when the save fails", () => {
  it("reports isError and skips the observation and the mirror", async () => {
    const tools = new Map<string, { schema: z.ZodRawShape; handler: (input: unknown) => Promise<unknown> }>();
    const dir = tempDir("rn-ckpt-tool-fail-");
    const checkpointStore = new SessionCheckpointStore(dir);
    let observationSaves = 0;
    let componentCalls = 0;
    registerCoreTools({
      registerTool(name: string, _description: string, schema: z.ZodRawShape, handler: never) {
        tools.set(name, { schema, handler });
      },
      getComponents: () => {
        componentCalls++;
        throw new Error("mirror should not run");
      },
      config: {},
      checkpointStore,
      workflowObservationStore: { async save() { observationSaves++; } },
      toolDescriptions: new Map(),
      toolTiers: {},
      getKGExtractor: () => null,
      getKGStore: () => null,
    } as never);
    const tool = tools.get("checkpoint_session")!;
    const call = (input: Record<string, unknown>) =>
      runToolSafely("checkpoint_session", () => tool.handler(z.object(tool.schema).parse(input)));

    const input = {
      sessionId: "s-tool-fail",
      summary: "第一版状态",
      nextActions: ["继续"],
      idempotencyKey: "tool-fail-key",
      updatedAt: "2026-10-17T10:00:00.000Z",
    };
    const first = await call(input) as { isError?: boolean };
    expect(first.isError).toBeUndefined();
    const observationsAfterFirst = observationSaves;
    const componentsAfterFirst = componentCalls;

    const second = { ...input, summary: "第二版状态", updatedAt: "2026-10-17T11:00:00.000Z" };
    const v2 = buildSessionCheckpointRecord(second);
    mkdirSync(join(dir, checkpointFileName(v2)));
    const out = await call(second) as { isError?: boolean; content: Array<{ text: string }> };

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("Failed to save session checkpoint");
    expect(observationSaves).toBe(observationsAfterFirst);
    expect(componentCalls).toBe(componentsAfterFirst);
    expect((await checkpointStore.getLatest({ sessionId: "s-tool-fail" }))?.summary).toBe("第一版状态");
  });
});

describe("concurrent saves of the same checkpoint from two processes", () => {
  /**
   * Each child is a separate bun process running the real save(). A spy on readdirSync (the same-id sweep is
   * the only readdirSync inside save) parks the child at its sweep until the other child has also reached its
   * sweep, or BARRIER_MS has passed. Without a lock around publication + sweep both children rename their file
   * in, then each deletes the other's: nothing is left. With the lock the second child cannot publish until the
   * first has finished, so its barrier times out and exactly one version survives.
   */
  const BARRIER_MS = 3000;
  const childScript = (barrierDir: string) => `
import * as fs from "node:fs";
import { join } from "node:path";
import { spyOn } from "bun:test";
const [storeDir, name, other, updatedAt, summary] = process.argv.slice(2);
const realReaddir = fs.readdirSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let parked = false;
spyOn(fs, "readdirSync").mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
  if (!parked && String(dir) === storeDir) {
    parked = true;
    fs.writeFileSync(join(${JSON.stringify(barrierDir)}, name), "");
    const deadline = Date.now() + ${BARRIER_MS};
    while (!fs.existsSync(join(${JSON.stringify(barrierDir)}, other)) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 20);
  }
  return (realReaddir as (...args: unknown[]) => unknown)(dir, ...rest);
}) as typeof fs.readdirSync);
const { SessionCheckpointStore } = await import(${JSON.stringify(join(SRC_DIR, "session-store.ts"))});
const { buildSessionCheckpointRecord } = await import(${JSON.stringify(join(SRC_DIR, "session-engine.ts"))});
try {
  await new SessionCheckpointStore(storeDir).save(buildSessionCheckpointRecord({
    sessionId: "s-race", summary, decisions: ["并发保存"], idempotencyKey: "race-key", updatedAt,
  }));
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
}
`;

  it("never leaves the checkpoint with no version on disk", async () => {
    const root = tempDir("rn-ckpt-race-");
    const storeDir = join(root, "session-checkpoints");
    const barrierDir = join(root, "barrier");
    mkdirSync(storeDir);
    mkdirSync(barrierDir);
    const scriptPath = join(root, "child.ts");
    writeFileSync(scriptPath, childScript(barrierDir));

    const spawnChild = (name: string, other: string, updatedAt: string, summary: string) => Bun.spawn(
      [process.execPath, "run", scriptPath, storeDir, name, other, updatedAt, summary],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, RECALLNEST_DATA_DIR: join(root, "data") } },
    );
    const children = [
      spawnChild("a", "b", "2026-10-17T10:00:00.000Z", "进程 A 的状态"),
      spawnChild("b", "a", "2026-10-17T11:00:00.000Z", "进程 B 的状态"),
    ];
    const outputs = await Promise.all(children.map(async (child) => {
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await child.exited;
      return { stdout: stdout.trim(), stderr };
    }));

    for (const out of outputs) expect(JSON.parse(out.stdout || "{}")).toEqual({ ok: true });
    const remaining = readdirSync(storeDir).filter((name) => name.endsWith(".json"));
    expect(remaining).toHaveLength(1);
    const latest = await new SessionCheckpointStore(storeDir).getLatest({ sessionId: "s-race" });
    expect(["进程 A 的状态", "进程 B 的状态"]).toContain(latest?.summary ?? "");
    expect(readdirSync(storeDir).filter((name) => !name.endsWith(".json"))).toEqual([]);
  }, 30_000);
});
