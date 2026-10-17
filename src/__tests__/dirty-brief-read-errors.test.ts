import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  archiveDirtyBriefAsset,
  formatDirtyBriefEmptyMessage,
  formatDirtyBriefReadErrors,
  scanDirtyBriefAssets,
  type BriefAsset,
} from "../memory-assets.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function brief(id: string, dirty: boolean): BriefAsset {
  return {
    id,
    type: "memory-brief",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    title: `brief ${id}`,
    summary: "a summary",
    tags: [],
    query: "q",
    profile: "default",
    hits: 1,
    sources: [],
    takeaways: dirty ? ["asset: stale takeaway"] : ["clean takeaway"],
    evidence: [],
    reusableCandidates: [],
  };
}

function writeBrief(dir: string, asset: BriefAsset): string {
  const path = join(dir, `${asset.id}.json`);
  writeFileSync(path, JSON.stringify(asset, null, 2) + "\n");
  return path;
}

function writeCorrupt(dir: string, name = "broken.json"): string {
  const path = join(dir, name);
  writeFileSync(path, "{ this is not json");
  return path;
}

/** 照入口的做法跑一遍清理：归档能读的脏 brief，返回报给用户的文字。 */
function runClean(assetsDir: string, archiveDir: string): { output: string; archived: string[] } {
  const scan = scanDirtyBriefAssets(200, assetsDir);
  if (scan.items.length === 0) return { output: formatDirtyBriefEmptyMessage(scan), archived: [] };
  const archived = scan.items.map((row) => archiveDirtyBriefAsset(row, archiveDir));
  const readErrors = formatDirtyBriefReadErrors(scan.readErrors);
  return {
    output: `Dirty briefs: ${scan.items.length}\nArchived: ${archived.length}` + (readErrors ? `\n\n${readErrors}` : ""),
    archived,
  };
}

describe("dirty brief scan reports unreadable files", () => {
  it("archives the valid dirty brief, leaves the corrupt file in place, and names it", () => {
    const assetsDir = tempDir("rn-briefs-");
    const archiveDir = tempDir("rn-briefs-archive-");
    const dirtyPath = writeBrief(assetsDir, brief("aaaaaaaa-dirty", true));
    const corruptPath = writeCorrupt(assetsDir);
    const corruptBytes = readFileSync(corruptPath);

    const scan = scanDirtyBriefAssets(200, assetsDir);
    expect(scan.items.map((row) => row.path)).toEqual([dirtyPath]);
    expect(scan.readErrors).toHaveLength(1);
    expect(scan.readErrors[0]?.path).toBe(corruptPath);
    expect(scan.readErrors[0]?.reason.length).toBeGreaterThan(0);

    const { output, archived } = runClean(assetsDir, archiveDir);
    expect(archived).toEqual([join(archiveDir, "aaaaaaaa-dirty.json")]);
    expect(existsSync(dirtyPath)).toBe(false);
    expect(existsSync(corruptPath)).toBe(true);
    expect(readFileSync(corruptPath).equals(corruptBytes)).toBe(true);
    expect(readdirSync(archiveDir)).toEqual(["aaaaaaaa-dirty.json"]);
    expect(output).toContain("Archived: 1");
    expect(output).toContain("1 brief file could not be read");
    expect(output).toContain(corruptPath);
  });

  it("only a corrupt file: does not say 'No dirty briefs found', reports the read failure", () => {
    const assetsDir = tempDir("rn-briefs-");
    const archiveDir = tempDir("rn-briefs-archive-");
    const corruptPath = writeCorrupt(assetsDir);

    const scan = scanDirtyBriefAssets(200, assetsDir);
    expect(scan.items).toEqual([]);
    expect(scan.readErrors.map((item) => item.path)).toEqual([corruptPath]);

    const { output, archived } = runClean(assetsDir, archiveDir);
    expect(archived).toEqual([]);
    expect(output).not.toContain("No dirty briefs found.");
    expect(output).toContain("scan is incomplete");
    expect(output).toContain("1 brief file could not be read");
    expect(output).toContain(corruptPath);
    expect(existsSync(corruptPath)).toBe(true);
    expect(readdirSync(archiveDir)).toEqual([]);
  });

  it("only clean valid briefs: still 'No dirty briefs found', no read failures", () => {
    const assetsDir = tempDir("rn-briefs-");
    const archiveDir = tempDir("rn-briefs-archive-");
    const cleanPath = writeBrief(assetsDir, brief("bbbbbbbb-clean", false));

    const scan = scanDirtyBriefAssets(200, assetsDir);
    expect(scan).toEqual({ items: [], readErrors: [] });

    const { output } = runClean(assetsDir, archiveDir);
    expect(output).toBe("No dirty briefs found.");
    expect(existsSync(cleanPath)).toBe(true);
  });

  it("lists several unreadable files with a plural count", () => {
    const text = formatDirtyBriefReadErrors([
      { path: "/x/a.json", reason: "bad" },
      { path: "/x/b.json", reason: "worse" },
    ]);
    expect(text.split("\n")).toEqual([
      "2 brief files could not be read (left in place, not archived):",
      "  /x/a.json — bad",
      "  /x/b.json — worse",
    ]);
    expect(formatDirtyBriefReadErrors([])).toBe("");
  });
});

describe("dirty brief entry points use the scan with read errors", () => {
  const root = resolve(import.meta.dir, "../..");
  const files = ["src/mcp-tools-governance.ts", "src/cli.ts", "src/ui-server.ts"];

  for (const file of files) {
    it(`${file} reports read errors instead of a bare 'No dirty briefs found.'`, () => {
      const source = readFileSync(join(root, file), "utf-8");
      expect(source).toContain("scanDirtyBriefAssets(");
      expect(source).toContain("formatDirtyBriefEmptyMessage(scan)");
      expect(source).toContain("formatDirtyBriefReadErrors(scan.readErrors)");
      expect(source).not.toContain("listDirtyBriefAssets(");
      expect(source).not.toContain('"No dirty briefs found."');
    });
  }

  it("UI cleanup status mentions unreadable files", () => {
    const source = readFileSync(join(root, "assets/ui/app.js"), "utf-8");
    expect(source).toContain("data.readErrors");
    expect(source).toContain("could not be read");
  });
});
