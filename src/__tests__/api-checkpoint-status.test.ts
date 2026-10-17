import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCheckpoint } from "../api-server.js";
import { LockTimeoutError, withWriteLock } from "../distill-lock.js";
import { buildSessionCheckpointResult } from "../session-engine.js";
import { CHECKPOINT_SAVE_LOCK_KEY, checkpointFileName, SessionCheckpointStore } from "../session-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rn-api-checkpoint-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function post(body: unknown): Request {
  return new Request("http://127.0.0.1/v1/checkpoint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = {
  sessionId: "s-status",
  summary: "Split checkpoint errors into 400 / 500 / 503.",
  updatedAt: "2026-10-17T08:00:00.000Z",
  // Fixes checkpointId (otherwise random), so the test can predict the target file name.
  idempotencyKey: "api-checkpoint-status",
};

describe("POST /v1/checkpoint status codes", () => {
  it("answers 500 when the save fails on disk (target path is a directory → EISDIR)", async () => {
    const dir = tempDir();
    const store = new SessionCheckpointStore(dir);
    const { record } = buildSessionCheckpointResult(validBody);
    const target = join(dir, checkpointFileName(record));
    mkdirSync(target);

    const response = await handleCheckpoint(post(validBody), store);

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain(`Failed to save session checkpoint ${record.checkpointId}`);
    expect(payload.error).toContain("EISDIR");
    // The directory in the way is untouched and no stray temp file is left behind.
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("answers 503 when the save lock is held by another process past the wait", async () => {
    const busy = {
      save: async (): Promise<never> => {
        throw new LockTimeoutError("lock 'checkpoint-save' timed out after 10000ms (held by another process)");
      },
    };

    const response = await handleCheckpoint(post(validBody), busy);

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("lock 'checkpoint-save' timed out");
  });

  it("a real wait on the checkpoint save lock times out with LockTimeoutError, message unchanged", async () => {
    const dir = tempDir();
    const opts = { lockDir: dir, expireMs: 60_000 };
    const inner = withWriteLock(CHECKPOINT_SAVE_LOCK_KEY, async () => {
      await withWriteLock(CHECKPOINT_SAVE_LOCK_KEY, async () => undefined, { ...opts, waitTimeoutMs: 150, pollMs: 25 });
    }, opts);
    const err = await inner.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as Error).message).toBe(`lock '${CHECKPOINT_SAVE_LOCK_KEY}' timed out after 150ms (held by another process)`);
  });

  it("still answers 400 for a body that fails validation, without touching the store", async () => {
    let saves = 0;
    const counting = {
      save: async (): Promise<never> => {
        saves += 1;
        throw new Error("save must not be reached");
      },
    };

    const missingSummary = await handleCheckpoint(post({ sessionId: "s-status" }), counting);
    expect(missingSummary.status).toBe(400);
    expect(((await missingSummary.json()) as { error: string }).error).toContain("summary");

    // Unparseable JSON is read as {} and rejected the same way.
    const notJson = await handleCheckpoint(post("{not json"), counting);
    expect(notJson.status).toBe(400);

    expect(saves).toBe(0);
  });
});
