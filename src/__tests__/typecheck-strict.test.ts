/**
 * CLAUDE.md §1 says "TypeScript strict, no any". These tests make that a checked fact:
 *  1. a fixture proves MCP tool handlers get their argument types from the zod schema
 *     (they were implicit `any` while registerTool's types came from `Parameters<server.tool>`);
 *  2. the whole of `src/` (tests excluded, as in tsconfig.json) type-checks with zero errors.
 * CI also runs `bunx tsc --noEmit`; this keeps `bun test` red locally for the same regression.
 */
import { describe, expect, it } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function loadCompilerOptions(): ts.ParsedCommandLine {
  const configPath = join(REPO_ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.start === undefined) return `TS${d.code}: ${message}`;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    const rel = d.file.fileName.startsWith(REPO_ROOT) ? d.file.fileName.slice(REPO_ROOT.length + 1) : d.file.fileName;
    return `${rel}(${line + 1},${character + 1}): TS${d.code}: ${message}`;
  });
}

describe("TypeScript strict", () => {
  it("infers MCP tool handler arguments from the zod schema", () => {
    const parsed = loadCompilerOptions();
    const fixture = join(REPO_ROOT, "src/__tests__/fixtures/typecheck/register-tool-inference.ts");
    const program = ts.createProgram([fixture], parsed.options);
    const sourceFile = program.getSourceFile(fixture);
    expect(sourceFile).toBeDefined();
    // Only the fixture's own diagnostics: the files it imports are covered by the next test.
    const errors = formatDiagnostics([
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ]);
    expect(errors).toEqual([]);
  }, 60_000);

  it("src/ type-checks with zero errors under tsconfig.json", () => {
    const parsed = loadCompilerOptions();
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.strict).toBe(true);
    expect(parsed.fileNames.length).toBeGreaterThan(100);
    expect(parsed.fileNames.some((f) => f.includes("__tests__"))).toBe(false);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const errors = formatDiagnostics(ts.getPreEmitDiagnostics(program));
    expect(errors).toEqual([]);
  }, 120_000);
});
