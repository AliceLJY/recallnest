/**
 * Security floors for dependencies that had Dependabot / `bun audit` advisories.
 *
 * Each entry is the first patched version of a package. The test fails when any copy of that
 * package resolved in bun.lock, package-lock.json or the installed node_modules is older — so
 * dropping an override or rolling a bump back turns it red instead of silently reopening the
 * advisory.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

interface Floor {
  name: string;
  min: string;
  advisory: string;
}

const FLOORS: Floor[] = [
  { name: "body-parser", min: "2.4.0", advisory: "GHSA-27r3-jxmh-p828" },
  { name: "qs", min: "6.16.1", advisory: "GHSA-6pq8-jhm2-2vcw" },
  { name: "@hono/node-server", min: "2.1.3", advisory: "GHSA-rmxm-3fg6-px4f" },
];

function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`unparseable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(v: string, min: string): boolean {
  const a = parseVersion(v);
  const b = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** Every version of `name` that bun.lock resolves (top-level and nested copies). */
function bunLockVersions(name: string): string[] {
  const text = readFileSync(join(REPO, "bun.lock"), "utf8");
  const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as { packages: Record<string, [string, ...unknown[]]> };
  const out: string[] = [];
  for (const entry of Object.values(lock.packages)) {
    const spec = entry[0];
    const at = spec.lastIndexOf("@");
    if (spec.slice(0, at) === name) out.push(spec.slice(at + 1));
  }
  return out;
}

/** Every version of `name` that package-lock.json resolves. */
function packageLockVersions(name: string): string[] {
  const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  const out: string[] = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if ((path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) && entry.version) out.push(entry.version);
  }
  return out;
}

describe("dependency security floors", () => {
  it("versionAtLeast compares numerically, not lexically", () => {
    expect(versionAtLeast("2.10.0", "2.4.0")).toBe(true);
    expect(versionAtLeast("2.3.9", "2.4.0")).toBe(false);
    expect(versionAtLeast("6.16.1", "6.16.1")).toBe(true);
    expect(versionAtLeast("6.16.0", "6.16.1")).toBe(false);
    expect(versionAtLeast("3.25.76", "4.6.6")).toBe(false);
  });

  for (const floor of FLOORS) {
    describe(`${floor.name} >= ${floor.min} (${floor.advisory})`, () => {
      it("bun.lock resolves no older copy", () => {
        const versions = bunLockVersions(floor.name);
        expect(versions.length).toBeGreaterThan(0);
        expect(versions.filter((v) => !versionAtLeast(v, floor.min))).toEqual([]);
      });

      it("package-lock.json resolves no older copy", () => {
        const versions = packageLockVersions(floor.name);
        expect(versions.length).toBeGreaterThan(0);
        expect(versions.filter((v) => !versionAtLeast(v, floor.min))).toEqual([]);
      });

      it("installed copy is not older", () => {
        const pkgJson = join(REPO, "node_modules", floor.name, "package.json");
        expect(existsSync(pkgJson)).toBe(true);
        const { version } = JSON.parse(readFileSync(pkgJson, "utf8")) as { version: string };
        expect(versionAtLeast(version, floor.min)).toBe(true);
      });
    });
  }
});
