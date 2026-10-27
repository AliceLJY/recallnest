#!/usr/bin/env node
/**
 * RecallNest CLI launcher.
 *
 * RecallNest runs on Bun only: its cross-process lock calls flock(2) through bun:ffi
 * (src/flock.ts), which Node cannot load. This launcher is plain JavaScript so that `npx` /
 * a global npm install can start it under any runtime; it only ever hands off to Bun, and
 * without Bun it exits with instructions instead of trying another runtime.
 */
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "src", "cli.ts");
const args = process.argv.slice(2);

function hasBun() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasBun()) {
  console.error(`
  RecallNest requires Bun (https://bun.sh) — it does not run on Node.js.

  Install Bun:
    curl -fsSL https://bun.sh/install | bash      # macOS / Linux
    brew install oven-sh/bun/bun                  # or with Homebrew

  Then open a new shell (so \`bun\` is on PATH) and retry your command.
`);
  process.exit(1);
}

const child = spawn("bun", ["run", cli, ...args], { stdio: "inherit" });
child.on("close", (code) => process.exit(code || 0));
child.on("error", (err) => {
  console.error(`Failed to start bun: ${err.message}`);
  process.exit(1);
});
