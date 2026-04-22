import { describe, expect, it } from "bun:test";

import { buildManagedResumeObservation } from "../workflow-observation-managed.js";

describe("workflow-observation-managed", () => {
  it("prefers the resolved response scope over the session fallback", () => {
    const observation = buildManagedResumeObservation({
      task: "Continue document-test checkpoint investigation",
      sessionId: "codex-2026-04-22-repo-tree-archive-setup",
    }, {
      resolvedScope: "project:document-test",
      stableContext: ["Checkpoint summary: Continue RecallNest checkpoint debugging."],
      relevantPatterns: [],
      recentCases: [],
      latestCheckpoint: {
        sessionId: "codex-2026-04-22-repo-tree-archive-setup",
        resolvedScope: "project:document-test",
        summary: "Checkpoint summary",
        updatedAt: "2026-04-22T09:00:00.000Z",
      },
      responseMode: "default",
    });

    expect(observation.scope).toBe("project:document-test");
  });
});
