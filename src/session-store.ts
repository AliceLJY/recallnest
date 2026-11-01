import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";

import { metaDir } from "./compat.js";
import { withWriteLock } from "./distill-lock.js";
import { redactSecrets } from "./pii-detector.js";
import { logInfo } from "./stderr-log.js";
import type { SessionCheckpointRecord } from "./session-schema.js";
import { SessionCheckpointRecordSchema } from "./session-schema.js";
import { isFallbackSummary, normalizeCheckpointScope, type CheckpointQuality } from "./session-engine.js";


export function classifyCheckpointQuality(record: SessionCheckpointRecord): CheckpointQuality {
  const isFallback = isFallbackSummary(record.summary);
  const hasContent = record.decisions.length > 0 || record.openLoops.length > 0 || record.nextActions.length > 0;
  return isFallback && !hasContent ? "minimal" : "rich";
}

/** File name a checkpoint is saved under (updatedAt with ":" and "." made file-safe, then the id). */
export function checkpointFileName(record: Pick<SessionCheckpointRecord, "updatedAt" | "checkpointId">): string {
  return `${record.updatedAt.replace(/[:.]/g, "-")}-${record.checkpointId}.json`;
}

/**
 * Per-field length caps of SessionCheckpointRecordSchema for the free-text fields, in
 * the schema's own unit (UTF-16 code units, `String.length`). A placeholder can be
 * longer than the secret it replaces (`pwd=12345678` → `pwd=[REDACTED:password]`), so
 * a field pushed past its cap is shortened back to it instead of failing the save.
 * Pinned to the schema by a test.
 */
export const CHECKPOINT_REDACTED_FIELD_CAPS = {
  summary: 600,
  task: 240,
  decisions: 200,
  openLoops: 200,
  nextActions: 200,
  entities: 120,
  files: 220,
} as const;

type CheckpointRedactedField = keyof typeof CHECKPOINT_REDACTED_FIELD_CAPS;

const PLACEHOLDER = /\[REDACTED(?::[a-z_]+)?\]/g;
const TYPED_PLACEHOLDER = /\[REDACTED:[a-z_]+\]/g;
/** What sits right before a placeholder and means nothing without it: `key=`, `"key": "`, `scheme://`. */
const PLACEHOLDER_LEAD = /(?:["']?[A-Za-z][A-Za-z0-9_-]*["']?\s*[=:]\s*["']?|[a-z][a-z0-9+.-]*:\/\/)$/i;

/**
 * Names the generic rules would otherwise eat in a checkpoint: they are how the next
 * window finds its way back (a session id, a file named sk-…), not credentials.
 * Each is masked before redaction and put back after, so the rules never see it.
 * - `sessionId=<uuid>` / `session_id: <uuid>`: only `id`, and only a plain UUID value —
 *   `session_token=…` and any other value still go through sensitive_assignment.
 * - `sk-` followed by two or more short all-lowercase words (`sk-checkpoint-redaction-design`):
 *   a kebab-case name, while a real key's random tail mixes digits and case.
 */
const CHECKPOINT_PROTECTED_NAMES: readonly CheckpointProtectedName[] = [
  { pattern: /\bsession[_-]?id["']?\s*[=:]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  {
    pattern: /(?<![A-Za-z0-9])sk(?:-[a-z]{2,20}){2,}(?![A-Za-z0-9_-])/g,
    // A kebab-case `sk-…` sitting right after `key=`, `key: "`, `Bearer ` or a URI's
    // `user:` is a value, not a name (`password=sk-correct-horse-battery`): leave it to
    // the generic rules. Second-round audit #1 (2026-11-01).
    unlessLedBy: /(?:[=:]\s*["'`]?|\bbearer\s+)$/i,
  },
];
interface CheckpointProtectedName {
  pattern: RegExp;
  /** When the text just before the match ends like this, the match is not protected. */
  unlessLedBy?: RegExp;
}
const MASK_OPEN = "";
const MASK_CLOSE = "";

/**
 * The same `redactSecrets` the mirror uses, narrowed for checkpoint text: ordinary dotted
 * names (`checkpoint.sessionstore.integration`) are kept via `keepIdentifiers`, and the
 * names in CHECKPOINT_PROTECTED_NAMES are masked first. pii-detector itself is unchanged,
 * so the mirror and every other caller redact exactly as before.
 */
function redactCheckpointText(value: string): string {
  if (value.includes(MASK_OPEN) || value.includes(MASK_CLOSE)) {
    // Text already carrying the mask characters: skip the protection rather than risk a mix-up.
    return redactSecrets(value, { keepIdentifiers: true }).text;
  }
  const kept: string[] = [];
  let masked = value;
  for (const { pattern, unlessLedBy } of CHECKPOINT_PROTECTED_NAMES) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, (match: string, ...rest: unknown[]) => {
      const offset = rest.find((arg): arg is number => typeof arg === "number") ?? 0;
      if (unlessLedBy && unlessLedBy.test(masked.slice(Math.max(0, offset - 32), offset))) {
        return match;
      }
      kept.push(match);
      return `${MASK_OPEN}${kept.length - 1}${MASK_CLOSE}`;
    });
  }
  const redacted = redactSecrets(masked, { keepIdentifiers: true }).text;
  return redacted.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"),
    (_match, index: string) => kept[Number(index)] ?? "",
  );
}

/** Largest cut ≤ `at` that does not split a surrogate pair. */
function safeCut(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return Math.max(0, Math.min(at, text.length));
  const before = text.charCodeAt(at - 1);
  return before >= 0xd800 && before <= 0xdbff ? at - 1 : at;
}

/**
 * Bring a redacted field back under its cap, losing as little as possible:
 * 1. collapse typed placeholders to the short `[REDACTED]`, done locally and only on
 *    overflow (pii-detector has no short-placeholder option and is not changed for this);
 * 2. if still too long, cut at the cap without splitting a surrogate pair; a cut that would
 *    land inside a placeholder drops that placeholder whole, with its `key=` lead.
 * A real cut is logged with the field name and how many characters were dropped.
 */
function fitToCap(text: string, cap: number, field: CheckpointRedactedField): string {
  if (text.length <= cap) return text;
  const short = text.replace(TYPED_PLACEHOLDER, "[REDACTED]");
  if (short.length <= cap) return short;

  let cut = safeCut(short, cap);
  PLACEHOLDER.lastIndex = 0;
  for (let m = PLACEHOLDER.exec(short); m; m = PLACEHOLDER.exec(short)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start >= cut) break;
    if (end > cut) {
      const lead = PLACEHOLDER_LEAD.exec(short.slice(0, start));
      cut = start - (lead ? lead[0].length : 0);
      break;
    }
  }
  const out = short.slice(0, cut).trimEnd();
  logInfo(
    `[checkpoint-redact] ${field}: redaction pushed it past ${cap} chars; dropped ${short.length - out.length} trailing chars`,
  );
  return out;
}

function redactField(value: string, field: CheckpointRedactedField): string {
  const redacted = redactCheckpointText(value);
  if (redacted === value) return value;
  return fitToCap(redacted, CHECKPOINT_REDACTED_FIELD_CAPS[field], field);
}

function redactList(items: string[], field: CheckpointRedactedField): string[] {
  return items.map((item) => redactField(item, field));
}

/**
 * Scrub secrets from every free-text field of a checkpoint so the JSON file on disk only
 * ever holds placeholders (see redactCheckpointText for what is deliberately kept).
 * Identifier fields (sessionId, scope, idempotencyKey, checkpointId, resolvedScope,
 * updatedAt) are left alone: they name the file and the record, and rewriting them
 * would change which checkpoint a save replaces.
 */
export function redactCheckpointRecord(record: SessionCheckpointRecord): SessionCheckpointRecord {
  return {
    ...record,
    summary: redactField(record.summary, "summary"),
    ...(record.task !== undefined ? { task: redactField(record.task, "task") } : {}),
    decisions: redactList(record.decisions, "decisions"),
    openLoops: redactList(record.openLoops, "openLoops"),
    nextActions: redactList(record.nextActions, "nextActions"),
    entities: redactList(record.entities, "entities"),
    files: redactList(record.files, "files"),
  };
}

/** Named write lock held while a checkpoint file is published and older same-id files are removed. */
export const CHECKPOINT_SAVE_LOCK_KEY = "checkpoint-save";

export interface SessionCheckpointQuery {
  sessionId?: string;
  scope?: string;
  limit?: number;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sortNewestFirst(records: SessionCheckpointRecord[]): SessionCheckpointRecord[] {
  return [...records].sort((a, b) => {
    const timeDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (timeDiff !== 0) return timeDiff;
    return b.checkpointId.localeCompare(a.checkpointId);
  });
}

export interface CheckpointGcOptions {
  dryRun?: boolean;
  now?: Date;
  /** Keep N newest rich checkpoints per resolvedScope (default: 5) */
  keepPerScope?: number;
  /** Keep 1 checkpoint per sessionId if younger than this many hours (default: 48) */
  sessionTtlHours?: number;
  /** Delete minimal checkpoints older than this many days (default: 7) */
  minimalTtlDays?: number;
  /** Archive rich checkpoints older than this many days (default: 30) */
  archiveAfterDays?: number;
  /** Hard-delete archived files older than this many days (default: 90) */
  archiveTtlDays?: number;
}

export interface CheckpointGcFileAction {
  file: string;
  checkpointId: string;
  resolvedScope: string;
  quality: CheckpointQuality;
  updatedAt: string;
  action: "keep" | "archive" | "delete";
  reason: string;
}

export interface CheckpointGcResult {
  kept: number;
  archived: number;
  deleted: number;
  errors: string[];
  actions: CheckpointGcFileAction[];
}

export class SessionCheckpointStore {
  constructor(private readonly dir = resolve(metaDir(import.meta), "../data/session-checkpoints")) {}

  get dataDir(): string {
    return ensureDir(this.dir);
  }

  /**
   * Secrets in the free-text fields are replaced with `[REDACTED:<type>]` first (see
   * redactCheckpointRecord). Then write the new version to a temp file, rename it into
   * place, and only then remove older files with the same checkpointId. Any failure throws, so a failed save never
   * deletes the previous version and is never reported as a success.
   */
  async save(record: SessionCheckpointRecord): Promise<SessionCheckpointRecord> {
    // Redact before the final parse: the parse re-collapses whitespace and re-dedupes
    // list items that redaction made identical. The returned record is the redacted one,
    // so callers (managed observation, mirror, HTTP response) never see the raw text.
    const parsed = SessionCheckpointRecordSchema.parse(
      redactCheckpointRecord(SessionCheckpointRecordSchema.parse(record)),
    );
    const dir = this.dataDir;
    // Publication and the same-id sweep run under one cross-process lock: without it two
    // processes saving the same id could each rename their file in, then each delete the
    // other's, leaving nothing. The lock lives in the checkpoint directory itself so every
    // process writing that directory shares it, whatever its data dir; it ends in ".lock",
    // so listRecent / gc never read it.
    // lock-wait: no store-write inside — publish() only renames and sweeps checkpoint files.
    return withWriteLock(CHECKPOINT_SAVE_LOCK_KEY, async () => this.publish(dir, parsed), {
      lockDir: dir,
      expireMs: 60_000,
    });
  }

  private publish(dir: string, parsed: SessionCheckpointRecord): SessionCheckpointRecord {
    const fileName = checkpointFileName(parsed);
    const path = join(dir, fileName);
    // Not ending in ".json", so listRecent / gc / the same-id sweep below never see it.
    const tmpPath = join(dir, `.${fileName}.${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(tmpPath, JSON.stringify(parsed, null, 2) + "\n");
      renameSync(tmpPath, path);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // The temp file may never have been created.
      }
      throw new Error(`Failed to save session checkpoint ${parsed.checkpointId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const suffix = `-${parsed.checkpointId}.json`;
    const stale = readdirSync(dir).filter((name) => name.endsWith(suffix) && name !== fileName);
    const cleanupErrors: string[] = [];
    for (const name of stale) {
      try {
        unlinkSync(join(dir, name));
      } catch (err) {
        cleanupErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Saved session checkpoint ${parsed.checkpointId} to ${fileName}, but could not remove older versions (retrying the save is safe): ${cleanupErrors.join("; ")}`,
      );
    }
    return parsed;
  }

  async listRecent(query: SessionCheckpointQuery = {}): Promise<SessionCheckpointRecord[]> {
    const { sessionId, scope, limit = 20 } = query;
    const files = readdirSync(this.dataDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(this.dataDir, name));

    const normalizedQueryScope = scope ? normalizeCheckpointScope(scope) : undefined;
    const items: SessionCheckpointRecord[] = [];
    for (const path of files) {
      try {
        const parsed = SessionCheckpointRecordSchema.parse(
          JSON.parse(readFileSync(path, "utf-8")),
        );
        if (sessionId && parsed.sessionId !== sessionId) continue;
        if (normalizedQueryScope) {
          const normalizedRecordScope = normalizeCheckpointScope(parsed.resolvedScope ?? parsed.scope ?? "");
          if (normalizedRecordScope !== normalizedQueryScope) continue;
        }
        items.push(parsed);
      } catch {
        // Skip corrupt checkpoint files.
      }
    }

    return sortNewestFirst(items).slice(0, limit);
  }

  async getLatest(query: SessionCheckpointQuery = {}): Promise<SessionCheckpointRecord | null> {
    // Look at recent checkpoints and prefer rich ones over minimal/fallback ones
    const recent = await this.listRecent({ ...query, limit: 5 });
    if (recent.length === 0) return null;
    const rich = recent.find((r) => classifyCheckpointQuality(r) === "rich");
    return rich || recent[0];
  }

  private get archiveDir(): string {
    return ensureDir(resolve(this.dir, "../archive/session-checkpoints"));
  }

  gc(options: CheckpointGcOptions = {}): CheckpointGcResult {
    const {
      dryRun = false,
      now = new Date(),
      keepPerScope = 5,
      sessionTtlHours = 48,
      minimalTtlDays = 7,
      archiveAfterDays = 30,
      archiveTtlDays = 90,
    } = options;

    const nowMs = now.getTime();
    const DAY_MS = 86_400_000;
    const HOUR_MS = 3_600_000;

    const errors: string[] = [];
    const actions: CheckpointGcFileAction[] = [];

    // --- Phase 1: Load and classify all checkpoint files ---
    const dir = this.dataDir;
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

    interface ParsedEntry {
      path: string;
      record: SessionCheckpointRecord;
      quality: CheckpointQuality;
      ageMs: number;
      scope: string;
    }

    const entries: ParsedEntry[] = [];
    for (const name of files) {
      const path = join(dir, name);
      try {
        const record = SessionCheckpointRecordSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
        const quality = classifyCheckpointQuality(record);
        const scope = normalizeCheckpointScope(record.resolvedScope ?? record.scope ?? `session:${record.sessionId}`);
        const ageMs = nowMs - Date.parse(record.updatedAt);
        entries.push({ path, record, quality, ageMs, scope });
      } catch (err) {
        errors.push(`parse error: ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Phase 2: Build protected set ---
    const protectedPaths = new Set<string>();
    const protectedReasons = new Map<string, string>();

    // Rule 1: Latest N rich per scope
    const byScope = new Map<string, ParsedEntry[]>();
    for (const entry of entries) {
      const list = byScope.get(entry.scope) ?? [];
      list.push(entry);
      byScope.set(entry.scope, list);
    }
    for (const [scope, list] of byScope) {
      const richSorted = list
        .filter((e) => e.quality === "rich")
        .sort((a, b) => a.ageMs - b.ageMs); // newest first (smallest age)
      for (const entry of richSorted.slice(0, keepPerScope)) {
        protectedPaths.add(entry.path);
        protectedReasons.set(entry.path, `latest ${keepPerScope} rich for scope ${scope}`);
      }
    }

    // Rule 2: Latest 1 per session within sessionTtlHours
    const bySession = new Map<string, ParsedEntry[]>();
    for (const entry of entries) {
      const list = bySession.get(entry.record.sessionId) ?? [];
      list.push(entry);
      bySession.set(entry.record.sessionId, list);
    }
    for (const [, list] of bySession) {
      const newest = list.sort((a, b) => a.ageMs - b.ageMs)[0];
      if (newest && newest.ageMs < sessionTtlHours * HOUR_MS) {
        if (!protectedPaths.has(newest.path)) {
          protectedPaths.add(newest.path);
          protectedReasons.set(newest.path, `latest checkpoint for session within ${sessionTtlHours}h`);
        }
      }
    }

    // --- Phase 3: Decide action for each entry ---
    for (const entry of entries) {
      const ageDays = entry.ageMs / DAY_MS;
      let action: "keep" | "archive" | "delete";
      let reason: string;

      if (protectedPaths.has(entry.path)) {
        action = "keep";
        reason = protectedReasons.get(entry.path) ?? "protected";
      } else if (entry.quality === "minimal" && ageDays > minimalTtlDays) {
        action = "delete";
        reason = `minimal checkpoint older than ${minimalTtlDays} days (${Math.floor(ageDays)}d)`;
      } else if (entry.quality === "rich" && ageDays > archiveAfterDays) {
        action = "archive";
        reason = `rich checkpoint older than ${archiveAfterDays} days (${Math.floor(ageDays)}d), not in latest ${keepPerScope} per scope`;
      } else {
        action = "keep";
        reason = `${entry.quality} checkpoint within retention window (${Math.floor(ageDays)}d)`;
      }

      actions.push({
        file: basename(entry.path),
        checkpointId: entry.record.checkpointId,
        resolvedScope: entry.scope,
        quality: entry.quality,
        updatedAt: entry.record.updatedAt,
        action,
        reason,
      });
    }

    // --- Phase 4: Execute actions (unless dry-run) ---
    let kept = 0;
    let archived = 0;
    let deleted = 0;

    for (const item of actions) {
      if (item.action === "keep") {
        kept++;
        continue;
      }
      if (dryRun) {
        if (item.action === "archive") archived++;
        else deleted++;
        continue;
      }
      const srcPath = join(dir, item.file);
      try {
        if (item.action === "archive") {
          renameSync(srcPath, join(this.archiveDir, item.file));
          archived++;
        } else {
          unlinkSync(srcPath);
          deleted++;
        }
      } catch (err) {
        errors.push(`${item.action} failed: ${item.file}: ${err instanceof Error ? err.message : String(err)}`);
        kept++; // count as kept since we couldn't move/delete it
      }
    }

    // --- Phase 5: Sweep archived directory for expired files ---
    const archDir = this.archiveDir;
    const archivedFiles = readdirSync(archDir).filter((name) => name.endsWith(".json"));
    for (const name of archivedFiles) {
      const path = join(archDir, name);
      try {
        const mtime = statSync(path).mtimeMs;
        const ageDays = (nowMs - mtime) / DAY_MS;
        if (ageDays > archiveTtlDays) {
          if (!dryRun) unlinkSync(path);
          deleted++;
          actions.push({
            file: `archive/${name}`,
            checkpointId: name.replace(/.*-([0-9a-f-]{36})\.json$/, "$1"),
            resolvedScope: "archived",
            quality: "rich",
            updatedAt: new Date(mtime).toISOString(),
            action: "delete",
            reason: `archived file older than ${archiveTtlDays} days (${Math.floor(ageDays)}d)`,
          });
        }
      } catch (err) {
        errors.push(`archive sweep: ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { kept, archived, deleted, errors, actions };
  }
}
