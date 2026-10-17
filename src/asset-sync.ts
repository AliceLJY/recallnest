import type { Embedder } from "./embedder.js";
import type { MemoryEntry, MemoryStore } from "./store.js";
import { buildPinAsset, savePinAsset, type BriefAsset, type MemoryAsset, type PinAsset } from "./memory-assets.js";
import type { RetrievalProfileName } from "./retrieval-profiles.js";

function buildPinnedAssetText(asset: PinAsset): string {
  const tags = asset.tags.join(", ");
  return [
    `[Pinned Asset] ${asset.title}`,
    `Summary: ${asset.summary}`,
    `Snippet: ${asset.snippet}`,
    `Original Scope: ${asset.source.scope}`,
    tags ? `Tags: ${tags}` : "",
  ].filter(Boolean).join("\n");
}

function buildBriefAssetText(asset: BriefAsset): string {
  const tags = asset.tags.join(", ");
  return [
    `[Memory Brief] ${asset.title}`,
    `Query: ${asset.query}`,
    `Profile: ${asset.profile}`,
    `Summary: ${asset.summary}`,
    asset.takeaways.length > 0 ? `Takeaways: ${asset.takeaways.join(" | ")}` : "",
    asset.reusableCandidates.length > 0 ? `Reusable: ${asset.reusableCandidates.join(" | ")}` : "",
    asset.sources.length > 0 ? `Sources: ${asset.sources.map((item) => `${item.source}(${item.hits})`).join(", ")}` : "",
    tags ? `Tags: ${tags}` : "",
  ].filter(Boolean).join("\n");
}

function buildAssetText(asset: MemoryAsset): string {
  return asset.type === "memory-brief"
    ? buildBriefAssetText(asset)
    : buildPinnedAssetText(asset);
}

function assetImportance(asset: MemoryAsset): number {
  return asset.type === "memory-brief" ? 0.72 : 0.96;
}

export async function indexAsset(
  store: MemoryStore,
  embedder: Embedder,
  asset: MemoryAsset,
): Promise<void> {
  const text = buildAssetText(asset);
  const vector = await embedder.embedPassage(text);
  const metadata = asset.type === "memory-brief"
    ? {
        source: "asset",
        assetId: asset.id,
        assetType: asset.type,
        title: asset.title,
        query: asset.query,
        profile: asset.profile,
        tags: asset.tags,
        sources: asset.sources.map((item) => item.source),
      }
    : {
        source: "asset",
        assetId: asset.id,
        assetType: asset.type,
        title: asset.title,
        originalMemoryId: asset.source.memoryId,
        originalScope: asset.source.scope,
        tags: asset.tags,
      };
  await store.store({
    text,
    vector,
    category: "decision",
    scope: asset.type === "memory-brief"
      ? `asset:brief:${asset.id.slice(0, 8)}`
      : `asset:${asset.id.slice(0, 8)}`,
    importance: assetImportance(asset),
    metadata: JSON.stringify(metadata),
  });
}

export const indexPinnedAsset = indexAsset;

/**
 * pin_memory（MCP 工具、CLI `pin`、本地 UI `/api/pin` 共用）：先把这条记忆的 importance 提到至少 0.95，
 * update() 返回 null（行在查到之后被删掉了）就返回 null——不写 pin 文件、不建索引副本，由调用方报 not found；
 * 写成功才用 update() 返回的那一行生成 pin。2026-10-17 起 update() 不再把被删的行插回来，
 * 原先这里不看返回值，会给一条已经不存在的记忆留下 pin 文件和索引副本。
 */
export async function pinMemory(
  store: MemoryStore,
  embedder: Embedder,
  entry: MemoryEntry,
  scopeFilter: string[] | undefined,
  options: { title?: string; summary?: string; query?: string; profile?: RetrievalProfileName },
  save: (asset: PinAsset) => string = savePinAsset,
): Promise<{ asset: PinAsset; path: string; entry: MemoryEntry } | null> {
  const updated = await store.update(entry.id, { importance: Math.max(entry.importance || 0.7, 0.95) }, scopeFilter);
  if (!updated) return null;
  const score = updated.importance || 0.7;
  const asset = buildPinAsset({ entry: updated, score, sources: { fused: { score } } }, options);
  const path = save(asset);
  await indexAsset(store, embedder, asset);
  return { asset, path, entry: updated };
}
