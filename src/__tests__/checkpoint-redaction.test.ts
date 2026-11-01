import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionCheckpointResult } from "../session-engine.js";
import { SessionCheckpointRecordSchema } from "../session-schema.js";
import {
  CHECKPOINT_REDACTED_FIELD_CAPS,
  checkpointFileName,
  redactCheckpointRecord,
  SessionCheckpointStore,
} from "../session-store.js";

/**
 * The checkpoint JSON written to data/session-checkpoints/ goes through the same
 * `redactSecrets` as the memory-table mirror: what lands on disk only holds
 * `[REDACTED:<type>]` placeholders; the tests read the file back as raw text.
 */

const dirs: string[] = [];

function tempStore(): { dir: string; store: SessionCheckpointStore } {
  const dir = mkdtempSync(join(tmpdir(), "rn-checkpoint-redact-"));
  dirs.push(dir);
  return { dir, store: new SessionCheckpointStore(dir) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Assembled from fragments so no tracked file carries a credential-shaped literal.
const OPENAI_KEY = ["sk", "proj", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0"].join("-");
const GITHUB_TOKEN = ["gh", "p_", "R4nd0mT0k3nV4lu3F0rT3st1ngOnlyXyZ12"].join("");
const AWS_KEY = ["AK", "IA", "Q2W3E4R5T6Y7U8I9"].join("");
const PASSWORD_VALUE = ["hunter", "2-", "correct-horse"].join("");
const BEARER_VALUE = ["abcDEF", "123456", "ghiJKL789012"].join("");
const URI_PASSWORD = ["s3cr3t", "Pa55"].join("");

const RAW_SECRETS = [OPENAI_KEY, GITHUB_TOKEN, AWS_KEY, PASSWORD_VALUE, BEARER_VALUE, URI_PASSWORD];

const body = {
  sessionId: "s-redact",
  scope: "project:redact-test",
  summary: `Rotated the deploy key; the old one was ${OPENAI_KEY} and must not reappear.`,
  task: `Login with password=${PASSWORD_VALUE} failed on staging`,
  decisions: [`Keep ${GITHUB_TOKEN} out of the repo`],
  openLoops: [`Header still sends Bearer ${BEARER_VALUE}`],
  nextActions: [`Revoke ${AWS_KEY} in IAM`],
  entities: [`postgres://admin:${URI_PASSWORD}@db.internal`],
  files: [`config/${OPENAI_KEY}.env`],
  idempotencyKey: "checkpoint-redaction",
  updatedAt: "2026-11-01T08:00:00.000Z",
};

function onlyFile(dir: string): string {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]!), "utf-8");
}

function expectScrubbed(text: string): void {
  for (const secret of RAW_SECRETS) expect(text).not.toContain(secret);
  for (const type of ["api_key", "github_token", "aws_access_key", "password", "bearer_token", "uri_credentials"]) {
    expect(text).toContain(`[REDACTED:${type}]`);
  }
}

describe("checkpoint JSON is redacted before it is written", () => {
  it("every free-text field on disk holds placeholders, not the secrets", async () => {
    const { dir, store } = tempStore();
    const { record } = buildSessionCheckpointResult(body);
    // Precondition: the build step itself does not redact, so the save has to.
    expect(JSON.stringify(record)).toContain(OPENAI_KEY);

    const stored = await store.save(record);

    const raw = onlyFile(dir);
    expectScrubbed(raw);
    const onDisk = JSON.parse(raw) as typeof stored;
    expect(onDisk.summary).toContain("[REDACTED:api_key]");
    expect(onDisk.task).toBe("Login with password=[REDACTED:password] failed on staging");
    expect(onDisk.decisions).toEqual(["Keep [REDACTED:github_token] out of the repo"]);
    expect(onDisk.openLoops).toEqual(["Header still sends [REDACTED:bearer_token]"]);
    expect(onDisk.nextActions).toEqual(["Revoke [REDACTED:aws_access_key] in IAM"]);
    expect(onDisk.entities).toEqual(["postgres://[REDACTED:uri_credentials]@db.internal"]);
    expect(onDisk.files).toEqual(["config/[REDACTED:api_key].env"]);
    // The returned record is the one on disk, so callers never hold the raw text.
    expect(stored).toEqual(onDisk);
  });

  it("identifier fields are untouched: same checkpointId, same file name, same scope", async () => {
    const { dir, store } = tempStore();
    const { record } = buildSessionCheckpointResult(body);
    const stored = await store.save(record);
    expect(stored.checkpointId).toBe(record.checkpointId);
    expect(stored.sessionId).toBe(record.sessionId);
    expect(stored.resolvedScope).toBe(record.resolvedScope);
    expect(stored.idempotencyKey).toBe(record.idempotencyKey);
    expect(stored.updatedAt).toBe(record.updatedAt);
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual([checkpointFileName(record)]);
  });

  it("latest_checkpoint reads back the redacted text", async () => {
    const { store } = tempStore();
    await store.save(buildSessionCheckpointResult(body).record);
    const latest = await store.getLatest({ sessionId: body.sessionId });
    expect(latest).not.toBeNull();
    expectScrubbed(JSON.stringify(latest));
  });

  it("a text without secrets is saved byte for byte as before", async () => {
    const { dir, store } = tempStore();
    const plain = {
      ...body,
      summary: "Split checkpoint errors into 400 / 500 / 503; task-assignment stays risk-gated.",
      task: "Checkpoint status codes",
      decisions: ["Use LockTimeoutError for 503"],
      openLoops: [],
      nextActions: ["Run bun test"],
      entities: ["RecallNest", "src.session-store.ts"],
      files: ["src/session-store.ts"],
    };
    const { record } = buildSessionCheckpointResult(plain);
    await store.save(record);
    expect(onlyFile(dir)).toBe(JSON.stringify(record, null, 2) + "\n");
  });

  it("a field near its cap still saves when a placeholder is longer than the secret", async () => {
    const { dir, store } = tempStore();
    // `pwd=12345678` (12 chars) becomes `pwd=[REDACTED:password]` (23 chars).
    const tail = ` pwd=${"12345678"}`;
    const summary = "x".repeat(CHECKPOINT_REDACTED_FIELD_CAPS.summary - tail.length) + tail;
    expect(summary.length).toBe(CHECKPOINT_REDACTED_FIELD_CAPS.summary);
    const { record } = buildSessionCheckpointResult({ ...body, summary });

    const stored = await store.save(record);

    expect(Array.from(stored.summary).length).toBeLessThanOrEqual(CHECKPOINT_REDACTED_FIELD_CAPS.summary);
    expect(onlyFile(dir)).not.toContain("12345678");
  });

  it("list items that redact to the same text are deduped like any other duplicate", async () => {
    const { dir, store } = tempStore();
    const other = ["sk", "proj", "Z9x8C7v6B5n4M3a2S1d0F9g8H7"].join("-");
    const { record } = buildSessionCheckpointResult({ ...body, decisions: [`use ${OPENAI_KEY}`, `use ${other}`] });
    expect(record.decisions).toHaveLength(2);
    // The pure step keeps both; the save's final parse folds them into one.
    expect(redactCheckpointRecord(record).decisions).toEqual(["use [REDACTED:api_key]", "use [REDACTED:api_key]"]);

    const stored = await store.save(record);

    expect(stored.decisions).toEqual(["use [REDACTED:api_key]"]);
    expect((JSON.parse(onlyFile(dir)) as typeof stored).decisions).toEqual(["use [REDACTED:api_key]"]);
  });

  it("the caps match SessionCheckpointRecordSchema field by field", () => {
    const { record } = buildSessionCheckpointResult(body);
    for (const [field, cap] of Object.entries(CHECKPOINT_REDACTED_FIELD_CAPS)) {
      const at = "y".repeat(cap);
      const over = "y".repeat(cap + 1);
      const isList = Array.isArray(record[field as keyof typeof record]);
      const make = (value: string) => ({ ...record, [field]: isList ? [value] : value });
      expect(SessionCheckpointRecordSchema.safeParse(make(at)).success).toBe(true);
      expect(SessionCheckpointRecordSchema.safeParse(make(over)).success).toBe(false);
    }
  });
});
