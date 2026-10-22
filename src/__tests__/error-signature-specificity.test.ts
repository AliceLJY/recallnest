import { describe, expect, it } from "bun:test";
import { classifySignatureSpecificity, specificSignatures } from "../error-signature-specificity.js";

describe("signature specificity", () => {
  it("calls bare exit codes, bare not-found and short/boilerplate fragments generic", () => {
    for (const g of ["exit code 1", "Exit code: 127", "No such file or directory", "command not found", "zsh: command not found", "404 Not Found", "error:", "失败", "Error: failed", "exit status 2 while running"]) {
      expect([g, classifySignatureSpecificity(g)]).toEqual([g, "generic"]);
    }
  });
  it("keeps fragments that carry a locatable token", () => {
    for (const s of [
      "zsh: command not found: xmlsec1",
      "ENOENT: no such file or directory, open '/Users/x/recallnest/config.json'",
      "TypeError: Cannot read properties of undefined (reading 'scope')",
      "error: Environment variable QWEN_API_KEY not set",
      "mcp__recallnest__store_memory failed to parse canonicalKey",
      "429 Too Many Requests: QUOTA_EXHAUSTED for generate_image",
      "makoto: row content.unsourced_webfetch (WebFetch 未经 search_memory)",
      "launchctl: Could not find service com.recallnest.api in domain",
    ]) {
      expect([s, classifySignatureSpecificity(s)]).toEqual([s, "specific"]);
    }
  });
  it("filters a mixed list", () => {
    expect(specificSignatures(["exit code 1", "ENOENT: open '/tmp/x'"])).toEqual(["ENOENT: open '/tmp/x'"]);
  });
});
