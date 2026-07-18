const coverCache = new Map<string, Promise<string | null>>();

export function loadCoverDataUrl(assetId: string): Promise<string | null> {
  const cached = coverCache.get(assetId);
  if (cached) return cached;
  const loading = window.app.knowledge.getAssetDataUrl(assetId).catch(() => null);
  coverCache.set(assetId, loading);
  return loading;
}

export function coverAssetIdFromMetadata(metadata: Record<string, unknown>): string | null {
  const cover = metadata["cover"];
  if (!cover || typeof cover !== "object") return null;
  const assetId = (cover as Record<string, unknown>)["assetId"];
  return typeof assetId === "string" && assetId.length > 0 ? assetId : null;
}
