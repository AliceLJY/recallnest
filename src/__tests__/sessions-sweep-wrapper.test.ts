import { describe, expect, it } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * launchd 包装 scripts/sessions-sweep.sh 的失败计数（P1 互审 R1 Codex #7）：沙箱里桩掉 bun 与 TG，
 * 按退出码序列跑脚本副本，看 TG 发了几条。bash 3.2（/bin/bash）、精简 PATH，同 launchd。
 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "rn-sweep-wrapper-"));
  mkdirSync(join(root, "repo", "scripts"), { recursive: true });
  cpSync(join(import.meta.dir, "..", "..", "scripts", "sessions-sweep.sh"), join(root, "repo", "scripts", "sessions-sweep.sh"));
  mkdirSync(join(root, "bin"));
  // 桩 bun：退出码取 $root/next-code 的内容
  writeFileSync(join(root, "bin", "bun"), `#!/bin/bash\nexit "$(cat ${root}/next-code)"\n`);
  writeFileSync(join(root, "notify"), `#!/bin/bash\nprintf '%s\\n<<<END>>>\\n' "$1" >> ${root}/tg.log\n`);
  chmodSync(join(root, "bin", "bun"), 0o755);
  chmodSync(join(root, "notify"), 0o755);
  return root;
}

function runSeq(root: string, codes: number[]): number[] {
  const rcs: number[] = [];
  for (const c of codes) {
    writeFileSync(join(root, "next-code"), String(c));
    const r = spawnSync("/bin/bash", [join(root, "repo", "scripts", "sessions-sweep.sh")], {
      env: { HOME: join(root, "home"), PATH: `${join(root, "bin")}:/usr/bin:/bin`, SESSIONS_SWEEP_NOTIFY: join(root, "notify"), SESSIONS_SWEEP_TIMEOUT: "30" },
      encoding: "utf-8",
    });
    rcs.push(r.status ?? -1);
  }
  return rcs;
}
const tgCount = (root: string) => (existsSync(join(root, "tg.log")) ? readFileSync(join(root, "tg.log"), "utf-8").split("<<<END>>>").length - 1 : 0);

describe("sessions-sweep.sh 失败计数", () => {
  it("连续 3 次真失败才报一条；成功清零", () => {
    const root = sandbox();
    expect(runSeq(root, [4, 4])).toEqual([4, 4]);
    expect(tgCount(root)).toBe(0);
    runSeq(root, [4]);
    expect(tgCount(root)).toBe(1);
    expect(readFileSync(join(root, "tg.log"), "utf-8")).toContain("连续 3 轮失败");
    runSeq(root, [0, 4, 4]);
    expect(tgCount(root)).toBe(1);
  });
  it("锁忙（5）与空轮未恢复（6）不清零也不计数，以 0 退出", () => {
    const root = sandbox();
    expect(runSeq(root, [4, 6, 5, 4, 6])).toEqual([4, 0, 0, 4, 0]);
    expect(tgCount(root)).toBe(0);
    runSeq(root, [4]);
    expect(tgCount(root)).toBe(1);
  });
});
