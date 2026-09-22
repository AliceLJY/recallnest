/**
 * Trigger Store — 写入时预演触发器（借自腾讯 T-Mem，EMNLP 2026，arXiv 2606.15405）。
 *
 * 一条记忆存进来的时候，顺手存几句「她以后会怎么问起这件事」（trigger）。
 * 这些句子单独嵌入、单独建表、只参与召回、永远不进证据：检索时用 query 向量
 * 对 trigger 表做向量搜索，命中的 trigger 把它的宿主记忆拉进候选池，宿主按
 * 「所有 trigger 里最高的那条」计分（T-Mem 的 nanmax 归属），再走既有打分链。
 *
 * 为什么另开一张表而不是塞进正文：正文向量是几百字的均值，尾巴上的一句问法
 * 会被稀释（2026-09-22 实测：64df5691 写了「她以后可能会这样问起…」，换套口语
 * 照样 top-10 不出现）。为什么不在主表加列：主表 12.8 万行，加列要迁移；侧表
 * 可由主表 metadata.triggers 整表重建（`triggers-backfill --rebuild`），删掉即回退。
 *
 * trigger 文本用 embedQuery 嵌入：它本身就是「未来的问法」，与查询同侧任务
 * （jina-v5 的 retrieval.query），query↔query 的余弦比 query↔passage 稳定。
 */

import type * as LanceDB from "@lancedb/lancedb";
import { loadLanceDB, escapeSqlLiteral, scopeWhereClause } from "./store.js";
import { matchesScopeFilter, type ScopeMatchMode } from "./scope-policy.js";
import { readConsistencyInterval as envReadConsistencyInterval } from "./env-config.js";
import { logWarn } from "./stderr-log.js";
import { textOverlapScore, tokenize } from "./multi-vector.js";

export const TRIGGER_TABLE_NAME = "memory_triggers";

/** 每条记忆最多存几条 trigger（T-Mem 每条 item 2–6 个，这里取上限 6）。 */
export const MAX_TRIGGERS_PER_MEMORY = 6;
export const MIN_TRIGGER_LENGTH = 2;
export const MAX_TRIGGER_LENGTH = 200;

export interface TriggerRow {
  id: string;
  memory_id: string;
  scope: string;
  text: string;
  vector: number[];
  created_at: number;
}

export interface TriggerHit {
  memoryId: string;
  /** 命中的那条 trigger 原文（只用于 explain，不进证据） */
  text: string;
  /** 余弦相似度（1 - cosine distance） */
  cosine: number;
  /** 与主表 vectorSearch 同一映射：1 / (1 + distance)，可直接与向量分比较 */
  score: number;
  scope: string;
  /** query 与 trigger 文本的词面重合（textOverlapScore），只在传了 queryText 时有 */
  overlap?: number;
  /** 靠哪道闸放行：hard = 余弦过硬闸；soft = 余弦过软闸 + 词面重合过线 */
  admittedBy: "hard" | "soft";
}

export interface TriggerSearchOptions {
  /** 余弦硬闸（≥ 即放行） */
  minCosine?: number;
  /** 余弦软闸：≥ softCosine 且 overlap ≥ minOverlap 也放行；需同时给 queryText */
  softCosine?: number;
  minOverlap?: number;
  /** 软闸只对去停用词后 ≥ 这么多 token 的 query 开（关键词短 query 不走软闸） */
  minQueryTokens?: number;
  queryText?: string;
  scopeMatch?: ScopeMatchMode;
}

export interface TriggerStoreConfig {
  dbPath: string;
  vectorDim: number;
  readConsistencyInterval?: number;
}

export interface TriggerStoreStats {
  rows: number;
  memories: number;
}

/** 规整 trigger 文本：去空白、去重（不分大小写）、丢太短太长的、封顶 6 条。 */
export function normalizeTriggerTexts(texts: readonly string[] | undefined | null): string[] {
  if (!texts || texts.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    if (typeof raw !== "string") continue;
    const text = raw.replace(/\s+/g, " ").trim().replace(/[。．.！!？?；;，,、]+$/u, "").trim();
    if (text.length < MIN_TRIGGER_LENGTH || text.length > MAX_TRIGGER_LENGTH) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_TRIGGERS_PER_MEMORY) break;
  }
  return out;
}

/**
 * 从既有正文里把「她以后会怎么问」那段抠出来拆成 trigger 候选（回填用，零 LLM）。
 *
 * 认的是 §5.3 那条纪律的各种手写变体：「她以后会这么问起：「A」「B」」「她以后可能会这样问起：A、B、C」
 * 「检索锚点：…」「她会说…」。段落里有引号就取引号内的，没有就按 、；/ 或 拆。
 * 只认正文里已经写下的话，不生成、不改写——生成是另一条线（qwen-turbo，按 T-Mem 三条禁令），
 * 且要等批量提炼那批的忠实度有结论再做。
 */
export function extractTriggerCandidates(text: string): string[] {
  if (!text) return [];
  const lead = /(她以后[^。\n]{0,6}问[起法]?|她(?:大概|可能|应该|以后)?会(?:这么|这样|怎么|这样子)?(?:问|说|提)(?:起)?|检索锚点|以后[^。\n]{0,8}问起|下次[^。\n]{0,6}(?:会|再)[^。\n]{0,4}(?:问|提))/gu;
  // 取**最后一次**出现：这句纪律写在正文末尾（09-22 实测 98% 在最后 30%），
  // 正文中段提到「她以后会怎么问」多半是在讨论这条纪律本身（如本项目自己的记忆），不是问法。
  let m: RegExpExecArray | null = null;
  for (const hit of text.matchAll(lead)) m = hit;
  if (!m || m.index === undefined) return [];
  // 长正文里这句若离末尾太远（后面还拖着六成正文），那是在讨论纪律本身，不是问法
  if (text.length > 200 && (text.length - m.index) / text.length > 0.6) return [];
  // 从触发词起到段落结束（下一个空行）为止
  let segment = text.slice(m.index);
  const paraEnd = segment.search(/\n\s*\n/);
  if (paraEnd > 0) segment = segment.slice(0, paraEnd);
  // 去掉引导语本身（到第一个冒号为止）
  const colon = segment.search(/[:：]/);
  const body = colon >= 0 && colon < 40 ? segment.slice(colon + 1) : segment.slice(m[0].length);

  const quoted = [...body.matchAll(/[「“"『]([^」”"』]{2,200})[」”"』]/gu)].map((q) => q[1]);
  let parts: string[];
  if (quoted.length > 0) {
    parts = quoted;
  } else {
    parts = body
      .split(/[、；;／/\n]|，或者|或者|、或|或是/u)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  const leadOnly = new RegExp(lead.source, "u");
  const cleaned = parts
    .map((p) => p.replace(/^(?:比如|例如|像|如)[:：]?\s*/u, "").replace(/^[「“"『]|[」”"』]$/gu, "").trim())
    // 拆出来的最后一段常常拖着后文（「……这类问题。」），剪掉句号后的尾巴
    .map((p) => p.split(/[。！？!?]/u)[0].trim())
    .filter((p) => p.length >= 4 && p.length <= MAX_TRIGGER_LENGTH)
    // 引导语自己、日期开头的引用、纯路径 —— 都不是问法
    .filter((p) => !leadOnly.test(p))
    .filter((p) => !/^\d{4}-\d{2}(-\d{2})?/.test(p))
    .filter((p) => !(/[\/\\]/.test(p) && !/\s/.test(p)));
  return normalizeTriggerTexts(cleaned);
}

export class TriggerStore {
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: TriggerStoreConfig) {}

  get dbPath(): string {
    return this.config.dbPath;
  }

  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => {});
    return run;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    const db = await lancedb.connect(this.config.dbPath, {
      readConsistencyInterval:
        this.config.readConsistencyInterval ?? envReadConsistencyInterval(),
    });

    let table: LanceDB.Table;
    try {
      table = await db.openTable(TRIGGER_TABLE_NAME);
    } catch {
      const schemaRow: TriggerRow = {
        id: "__schema__",
        memory_id: "__schema__",
        scope: "__schema__",
        text: "",
        vector: new Array(this.config.vectorDim).fill(0),
        created_at: 0,
      };
      try {
        table = await db.createTable(TRIGGER_TABLE_NAME, [schemaRow]);
        await table.delete(`id = '__schema__'`);
      } catch (createErr) {
        if (String(createErr).includes("already exists")) {
          table = await db.openTable(TRIGGER_TABLE_NAME);
        } else {
          throw createErr;
        }
      }
    }
    this.table = table;
  }

  async ready(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * 覆盖式写入一条记忆的全部 trigger：先删旧行再加新行，同一 memory_id 永远只有一组。
   * `embed` 由调用方传入（应为 embedQuery 批量版），这里不持有 embedder。
   * 返回实际写入的条数；texts 规整后为空则只删不加、返回 0。
   */
  async upsertForMemory(
    memoryId: string,
    scope: string,
    texts: readonly string[],
    embed: (texts: string[]) => Promise<number[][]>,
  ): Promise<number> {
    const cleaned = normalizeTriggerTexts(texts);
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      await this.table!.delete(`memory_id = '${escapeSqlLiteral(memoryId)}'`);
      if (cleaned.length === 0) return 0;
      const vectors = await embed(cleaned);
      if (vectors.length !== cleaned.length) {
        throw new Error(`TriggerStore: embed returned ${vectors.length} vectors for ${cleaned.length} texts`);
      }
      const now = Date.now();
      const rows: TriggerRow[] = cleaned.map((text, i) => ({
        id: `${memoryId}#${i}`,
        memory_id: memoryId,
        scope,
        text,
        vector: vectors[i],
        created_at: now,
      }));
      await this.table!.add(rows);
      return rows.length;
    });
  }

  async deleteForMemory(memoryId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      await this.table!.delete(`memory_id = '${escapeSqlLiteral(memoryId)}'`);
    });
  }

  /**
   * 用 query 向量搜 trigger，按宿主聚合取最高分（nanmax 归属），再过闸。
   * 两道闸（2026-09-22 校准，见 env-config triggerGate / triggerSoftGate）：
   *   hard：cosine ≥ minCosine；
   *   soft：query 去停用词 ≥ minQueryTokens 个 token，且 cosine ≥ softCosine，且 textOverlapScore(queryText, trigger) ≥ minOverlap。
   * 为什么要软闸：jina-v5-small 上「腾讯那篇论文的榜我们要不要也去排个名」对
   * 「别的记忆系统的榜我们要不要也去排个名」余弦只有 0.44，与无关噪声（最高 0.53）分不开，
   * 但两句共用「榜 / 要不要 / 排个名」——词面是第二根轴，T-Mem 每层也是词法 + 稠密一起用。
   * scope 过滤下推到 SQL（与主表 vectorSearch 同款，2026-08-16 互审 C1 的教训）。
   */
  async search(
    queryVector: number[],
    topK: number,
    scopeFilter?: string[],
    options: TriggerSearchOptions = {},
  ): Promise<TriggerHit[]> {
    await this.ensureInitialized();
    const minCosine = options.minCosine ?? 0;
    const minOverlap = options.minOverlap ?? 1;
    const minQueryTokens = options.minQueryTokens ?? 0;
    // 软闸的前提：query 像一句话（不是两个关键词）——否则一个共用词就能把词面重合撑高
    const softEligible = options.softCosine !== undefined
      && !!options.queryText
      && tokenize(options.queryText).length >= minQueryTokens;
    const softCosine = softEligible ? options.softCosine : undefined;
    const scopeMatch = options.scopeMatch ?? "family";
    const safeTopK = Math.max(1, Math.min(50, Math.floor(topK)));
    // 一个宿主可能有多条 trigger 都命中，多取一些再聚合
    const fetchLimit = Math.min(safeTopK * MAX_TRIGGERS_PER_MEMORY, 200);

    let query = this.table!.vectorSearch(queryVector).distanceType("cosine").limit(fetchLimit);
    if (scopeFilter && scopeFilter.length > 0) {
      query = query.where(`(${scopeWhereClause(scopeFilter, scopeMatch)})`);
    }

    let rows: Array<Record<string, unknown>>;
    try {
      rows = await query.toArray();
    } catch (err) {
      logWarn("TriggerStore.search failed, continuing without trigger recall:", err);
      return [];
    }

    const best = new Map<string, TriggerHit>();
    for (const row of rows) {
      const memoryId = String(row.memory_id ?? "");
      if (!memoryId || memoryId === "__schema__") continue;
      const rowScope = String(row.scope ?? "");
      if (!matchesScopeFilter(rowScope, scopeFilter, scopeMatch)) continue;
      const distance = Number(row._distance ?? 1);
      const cosine = 1 - distance;
      const text = String(row.text ?? "");
      let admittedBy: "hard" | "soft" | null = null;
      let overlap: number | undefined;
      if (cosine >= minCosine) {
        admittedBy = "hard";
      } else if (softCosine !== undefined && options.queryText && cosine >= softCosine) {
        overlap = textOverlapScore(options.queryText, text);
        if (overlap >= minOverlap) admittedBy = "soft";
      }
      if (!admittedBy) continue;
      const hit: TriggerHit = {
        memoryId,
        text,
        cosine,
        score: 1 / (1 + distance),
        scope: rowScope,
        overlap,
        admittedBy,
      };
      const prev = best.get(memoryId);
      if (!prev || hit.cosine > prev.cosine) best.set(memoryId, hit);
    }
    return [...best.values()]
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, safeTopK);
  }

  /** 列出某 scope 下已有 trigger 的宿主 id（回填时跳过已做的）。 */
  async listMemoryIds(scopeFilter?: string[]): Promise<Set<string>> {
    await this.ensureInitialized();
    let query = this.table!.query().select(["memory_id", "scope"]);
    if (scopeFilter && scopeFilter.length > 0) {
      query = query.where(`(${scopeWhereClause(scopeFilter)})`);
    }
    const rows = await query.toArray();
    const ids = new Set<string>();
    for (const row of rows) {
      const id = String((row as Record<string, unknown>).memory_id ?? "");
      if (id && id !== "__schema__") ids.add(id);
    }
    return ids;
  }

  async stats(scopeFilter?: string[]): Promise<TriggerStoreStats> {
    await this.ensureInitialized();
    let query = this.table!.query().select(["memory_id", "scope"]);
    if (scopeFilter && scopeFilter.length > 0) {
      query = query.where(`(${scopeWhereClause(scopeFilter)})`);
    }
    const rows = await query.toArray();
    const memories = new Set<string>();
    let count = 0;
    for (const row of rows) {
      const id = String((row as Record<string, unknown>).memory_id ?? "");
      if (!id || id === "__schema__") continue;
      count += 1;
      memories.add(id);
    }
    return { rows: count, memories: memories.size };
  }
}
