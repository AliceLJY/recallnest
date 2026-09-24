# Architecture

> 架构总览：RecallNest 的分层设计，从接入层到存储层。

边界说明：

- structured capture 写 durable memory
- checkpoint store 写 session state
- raw ingest 写 evidence

See [memory-boundary-contract.md](./memory-boundary-contract.md).

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Client Layer                           │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ Claude   │ Gemini   │ Codex    │ Custom   │ curl / any      │
│ Code     │ CLI      │          │ Agents   │ HTTP client     │
└────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬────────────┘
     │          │          │          │          │
     └──── MCP (stdio) ───┘          └── HTTP ──┘
                │                        │
                ▼                        ▼
┌─────────────────────────────────────────────────────────────┐
│                     Integration Layer                        │
├────────────────────────┬────────────────────────────────────┤
│    MCP Server          │       HTTP API Server               │
│    (mcp-server.ts)     │       (api-server.ts)               │
│                        │       port 4318                     │
│  Tools:                │                                     │
│  - search_memory       │  Endpoints:                         │
│  - memory_stats        │  - POST /v1/recall                  │
│  - brief_memory        │  - POST /v1/store                   │
│  - distill_memory      │  - POST /v1/search                  │
│  - pin_memory          │  - GET  /v1/stats                   │
│  - explain_memory      │  - GET  /v1/health                  │
│  - export_memory       │  - POST /v1/consolidate             │
│                        │  - GET  /v1/gaps                    │
└────────────┬───────────┴──────────────┬─────────────────────┘
             │                          │
             ▼                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      Core Engine                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Retriever   │  │  Classifier  │  │  Query Expander    │  │
│  │ (default:    │  │ (6 categories│  │  (synonym +        │  │
│  │  vector-only;│  │  auto-assign)│  │   semantic expand) │  │
│  │  optional    │  │              │  │                    │  │
│  │  hybrid:     │  │              │  │                    │  │
│  │  weighted    │  │              │  │                    │  │
│  │  vector+BM25)│  │              │  │                    │  │
│  └──────┬───────┘  └──────────────┘  └────────────────────┘  │
│         │                                                    │
│  ┌──────┴───────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Decay       │  │  Access      │  │  Noise Filter      │  │
│  │  Engine      │  │  Tracker     │  │  (relevance        │  │
│  │  (Weibull)   │  │  (use it or  │  │   threshold)       │  │
│  │              │  │   lose it)   │  │                    │  │
│  └──────────────┘  └──────────────┘  └────────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐                          │
│  │ Consolidator │  │ Gap Detector │   ← Self-Evolution       │
│  │ (merge/dedup)│  │ (find blind  │                          │
│  │              │  │  spots)      │                          │
│  └──────────────┘  └──────────────┘                          │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Storage Layer                            │
├─────────────────────────┬───────────────────────────────────┤
│  LanceDB               │  Jina Embeddings                   │
│  (vector + columnar)    │  (v5, 1024-dim)                    │
│                         │                                    │
│  Tables:                │  Task-aware:                       │
│  - memories (main)      │  - retrieval.query (for searches)  │
│  - access_log           │  - retrieval.passage (for docs)    │
│  - search_log           │                                    │
└─────────────────────────┴───────────────────────────────────┘
```

## Data Flow

### Ingestion Pipeline

```
Source Files                    Processing                  Storage
─────────────                  ──────────                  ───────

CC transcripts ─┐
                │   ┌──────────────────┐   ┌───────────┐
Codex sessions ─┼──►│  Chunker         │──►│ Embedder  │──► LanceDB
                │   │  (split by turn, │   │ (Jina v5) │
Gemini chats ───┤   │   noise filter)  │   └───────────┘
                │   └──────────────────┘
Memory .md ─────┘         │
                          ▼
                   ┌──────────────┐
                   │ Classifier   │
                   │ (6 categories│
                   │  + tier)     │
                   └──────────────┘
```

> 入库流程：多源文件 → 分块 → 过滤噪音 → 分类 → 嵌入向量 → 存入 LanceDB

### Search Pipeline

```
Query                                               Results
─────                                               ───────

"Docker debugging"
    │
    ▼
┌──────────────┐    ┌──────────────┐    ┌───────────────┐
│ Query        │───►│ Retrieval    │───►│ Post-process  │──► Top-K
│ Expander     │    │ default:     │    │               │   Results
│ (synonyms)   │    │  vector-only │    │ - Decay       │
└──────────────┘    │ hybrid mode: │    │ - Access boost│
                    │  Vector: 0.7 │    │ - Score floor │
                    │  BM25:   0.3 │    │ - Dedup       │
                    │  weighted    │    └───────────────┘
                    │  fusion      │
                    └──────────────┘
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **LanceDB** (not SQLite/Postgres) | Native vector search, columnar storage, zero-config, single-file DB |
| **Jina v5** (not OpenAI embeddings) | Task-aware embeddings (query vs passage), better multilingual, 1024-dim sweet spot |
| **Hybrid retrieval** (vector + BM25, optional) | Vector alone misses keyword matches; BM25 alone misses semantic similarity. Default `retrieval.mode` is `"vector"` (vector-only search; `DEFAULT_RETRIEVAL_CONFIG` in `src/retriever.ts`, `config.json.example`). Set `retrieval.mode` to `"hybrid"` in `config.json` to add BM25 full-text search; if the store has no full-text index, retrieval stays vector-only |
| **Weighted score fusion** (hybrid mode only) | Applies only when `retrieval.mode` is `"hybrid"` (default is `"vector"`). Hybrid mode combines vector and BM25 scores as a weighted average (defaults `vectorWeight: 0.7`, `bm25Weight: 0.3`), with a 5% bonus when both legs return the same memory; a memory found by only one leg is scored by that leg alone (BM25-only hits get ×1.15 on short queries). For short queries (≤ 4 tokens) the vector weight is multiplied by 0.7 and the BM25 weight by 1.5, capped at 0.6 (`fuseResults()` in `src/retriever.ts`) |
| **Weibull decay** (not exponential) | Better models human forgetting: slow start, accelerating fade |
| **6 categories** (not free-form tags) | Structured enough for filtering and lifecycle rules, simple enough to auto-classify |
| **HTTP API + MCP** (not just MCP) | MCP is great for CLI tools, but HTTP API works with any language/framework |
| **Bun runtime** | Fast startup, native TypeScript, good for CLI tools and local servers |

## File Map

```
src/
├── api-server.ts          # HTTP API server (port 4318)
├── mcp-server.ts          # MCP server (stdio transport)
├── cli.ts                 # CLI entry point (lm command)
├── store.ts               # LanceDB storage layer
├── retriever.ts           # Hybrid retrieval (vector + BM25, weighted score fusion)
├── embedder.ts            # Jina embedding client
├── ingest.ts              # Multi-source ingestion pipeline
├── chunker.ts             # Text chunking with noise filtering
├── decay-engine.ts        # Weibull time decay
├── access-tracker.ts      # "Use it or lose it" tracking
├── noise-filter.ts        # Low-quality content filter
├── query-expander.ts      # Query expansion (synonyms)
├── retrieval-profiles.ts  # 4 search profiles (precision/balanced/exploratory/recent)
├── memory-output.ts       # Output formatting
├── memory-assets.ts       # Brief/pin/export asset management
├── asset-sync.ts          # Asset indexing
├── runtime-config.ts      # Config loading
├── llm-client.ts          # LLM client for smart extraction
├── doctor.ts              # Health check diagnostics
├── adaptive-retrieval.ts  # Adaptive retrieval strategies
├── stderr-log.ts          # Logging
├── tracker.ts             # Ingestion tracker (incremental)
└── __tests__/             # Test suite
```
