/**
 * Shared dependency contract for MCP tool registration modules.
 *
 * P3-B split: the 43 `registerTool(...)` calls that used to live inline in
 * mcp-server.ts now live in tier modules (mcp-tools-core / -advanced /
 * -governance). mcp-server.ts owns the heavy module-level state (config,
 * component resolver, stores, lazy KG handles, the tier-aware registerTool
 * wrapper) and hands it to each tier module through this contract.
 *
 * Mutable module-level handles (kgExtractor / kgStoreInstance) are exposed as
 * getters so tier handlers read the live value after ensureComponents() runs,
 * not the null they would capture at registration time.
 */
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { createComponentResolver, loadConfig } from "./runtime-config.js";
import type { SessionCheckpointStore } from "./session-store.js";
import type { ConflictCandidateStore } from "./conflict-store.js";
import type { WorkflowObservationStore } from "./workflow-observation-store.js";
import type { KGExtractor } from "./kg-extractor.js";
import type { KGStore } from "./kg-store.js";
import type { AuditLogger } from "./audit-log.js";
import type { ForgetPinArchive } from "./forget-engine.js";

export type ToolTier = "core" | "advanced" | "governance";
/**
 * Input schema of one tool: a zod raw shape (`{ query: z.string(), ... }`).
 *
 * These used to be `Parameters<McpServer["tool"]>[2]` / `[3]`. `server.tool` is overloaded and
 * `Parameters<>` resolves against the LAST overload, whose third parameter is the annotations
 * object and whose fourth is an untyped callback — so every handler's destructured arguments were
 * implicit `any` and a schema/handler mismatch never failed to compile. The handler type is now
 * derived from the schema itself, so `registerTool(name, desc, { q: z.string() }, async ({ q }) => …)`
 * infers `q: string`.
 */
export type ToolSchema = ZodRawShape;
/** Handler whose first argument is the parsed output of schema `S` (same shape the SDK passes). */
export type ToolHandler<S extends ToolSchema> = ToolCallback<S>;
/** Tier-aware registration wrapper signature; generic so each call site infers its own args. */
export type RegisterToolFn = <S extends ToolSchema>(name: string, description: string, schema: S, handler: ToolHandler<S>) => void;
export type ComponentResolver = ReturnType<typeof createComponentResolver>;

export interface ToolRegistryDeps {
  /** Tier-aware registration wrapper from mcp-server.ts (shouldRegisterTool gate + lazy component init). */
  registerTool: RegisterToolFn;
  /** Memoized component resolver: getComponents(profileName?) => { store, embedder, retriever, llm, profile }. */
  getComponents: ComponentResolver;
  /** Loaded runtime config (used by resume_context for recall-mode resolution). */
  config: ReturnType<typeof loadConfig>;
  checkpointStore: SessionCheckpointStore;
  conflictStore: ConflictCandidateStore;
  workflowObservationStore: WorkflowObservationStore;
  /** F-1/F-3b: persistent audit trail — must be injected at the runtime entry or store/reject audit entries never land on disk (codex review 2026-07-10). */
  auditLogger: AuditLogger;
  /** Live map of registered tool name -> description, populated by the registerTool wrapper (read by list_tools). */
  toolDescriptions: Map<string, string>;
  /** Static tool-name -> tier map (read by list_tools to group/filter tools). */
  toolTiers: Record<string, ToolTier>;
  /** Live getter for the lazily-initialized KG extractor (null unless RECALLNEST_KG_MODE=true). */
  getKGExtractor: () => KGExtractor | null;
  /** Live getter for the lazily-initialized KG store (null unless RECALLNEST_KG_MODE=true). */
  getKGStore: () => KGStore | null;
  /**
   * Pin files that forget_memory archives. Left unset at the runtime entry, which gives the
   * data/pins directory; tests set it so that no case reads or moves a real pin.
   */
  forgetPins?: ForgetPinArchive;
}
