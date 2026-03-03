#!/usr/bin/env bun
/**
 * local-memory MCP Server
 *
 * Exposes conversation memory search as MCP tools,
 * so any MCP-compatible AI client (Claude Code, etc.)
 * can search your indexed conversations.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { MemoryStore, validateStoragePath } from "./store.js";
import { createEmbedder, type EmbeddingConfig } from "./embedder.js";
import { createRetriever, type RetrievalConfig, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";

// ============================================================================
// Config (same as cli.ts)
// ============================================================================

interface LocalMemoryConfig {
  dbPath: string;
  embedding: {
    provider: string;
    apiKey: string;
    model: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
  };
  sources: Record<string, { path: string; glob: string; description: string }>;
  retrieval?: Partial<RetrievalConfig>;
}

function findConfigPath(): string {
  // 1. Environment variable
  if (process.env.LOCAL_MEMORY_CONFIG) {
    return resolve(process.env.LOCAL_MEMORY_CONFIG);
  }
  // 2. Next to this script
  const scriptDir = typeof import.meta.dir === "string"
    ? import.meta.dir
    : resolve(".");
  const localConfig = resolve(scriptDir, "../config.json");
  if (existsSync(localConfig)) return localConfig;
  // 3. ~/.config/local-memory/config.json
  const homeConfig = join(homedir(), ".config", "local-memory", "config.json");
  if (existsSync(homeConfig)) return homeConfig;

  throw new Error(
    "Config not found. Set LOCAL_MEMORY_CONFIG env var or place config.json next to the project."
  );
}

function loadConfig(): LocalMemoryConfig {
  const configPath = findConfigPath();
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as LocalMemoryConfig;
}

function resolveEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const envVal = process.env[name];
    if (!envVal) throw new Error(`Environment variable ${name} not set`);
    return envVal;
  });
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// ============================================================================
// Initialize components
// ============================================================================

function createComponents(config: LocalMemoryConfig) {
  const configDir = typeof import.meta.dir === "string"
    ? resolve(import.meta.dir, "..")
    : resolve(".");
  const dbPath = resolve(configDir, expandHome(config.dbPath));
  validateStoragePath(dbPath);

  const embeddingConfig: EmbeddingConfig = {
    provider: "openai-compatible",
    apiKey: resolveEnv(config.embedding.apiKey),
    model: config.embedding.model,
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
  };

  const embedder = createEmbedder(embeddingConfig);

  const store = new MemoryStore({
    dbPath,
    vectorDim: embedder.dimensions,
  });

  const retrieverConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...(config.retrieval || {}),
  };
  const retriever = createRetriever(store, embedder, retrieverConfig);

  return { store, embedder, retriever };
}

// ============================================================================
// MCP Server
// ============================================================================

// Load .env if present
const envPath = resolve(typeof import.meta.dir === "string" ? import.meta.dir : ".", "../.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const config = loadConfig();
const { store, retriever } = createComponents(config);

const server = new McpServer({
  name: "local-memory",
  version: "1.0.0",
});

// --- search_memory tool ---
server.tool(
  "search_memory",
  "Search indexed AI conversations (Claude Code, Codex, Gemini, etc.) using hybrid vector + keyword retrieval",
  {
    query: z.string().describe("Search query — natural language or keywords"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to return"),
    scope: z.string().optional().describe("Filter by source: cc, codex, gemini, memory"),
  },
  async ({ query, limit, scope }) => {
    const scopeFilter = scope ? [scope] : undefined;
    const results = await retriever.retrieve({ query, limit, scopeFilter });

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No results found." }] };
    }

    const formatted = results.map((r, i) => {
      let meta: any = {};
      try { meta = JSON.parse(r.entry.metadata || "{}"); } catch {}

      const score = (r.score * 100).toFixed(0);
      const date = new Date(r.entry.timestamp).toISOString().split("T")[0];
      const sourceLabel = meta.source || r.entry.scope || "?";
      const file = meta.file || "";

      const sources: string[] = [];
      if (r.sources.vector) sources.push("vector");
      if (r.sources.bm25) sources.push("bm25");
      if (r.sources.reranked) sources.push("reranked");

      return `${i + 1}. [${score}%] [${sourceLabel}] ${date}\n${r.entry.text}\n   file: ${file} | retrieval: ${sources.join("+")}`;
    });

    return {
      content: [{ type: "text" as const, text: formatted.join("\n\n---\n\n") }],
    };
  }
);

// --- memory_stats tool ---
server.tool(
  "memory_stats",
  "Show statistics of the indexed memory database",
  {},
  async () => {
    const stats = await store.stats();

    // Aggregate by source prefix
    const sourceCounts: Record<string, number> = {};
    for (const [scope, count] of Object.entries(stats.scopeCounts)) {
      const prefix = scope.split(":")[0];
      sourceCounts[prefix] = (sourceCounts[prefix] || 0) + count;
    }

    const lines = [
      `Total entries: ${stats.totalCount}`,
      "",
      "By source:",
      ...Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([src, count]) => `  ${src}: ${count}`),
    ];

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ============================================================================
// Start
// ============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
