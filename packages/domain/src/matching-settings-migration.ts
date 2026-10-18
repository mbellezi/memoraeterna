/**
 * Matching settings v2 (F3 T53b): the one-time migration of a stored settings document.
 *
 * Relations v2 decides a note pair with a calibrated probability, retrieves its candidates from
 * typed configuration (`relations-config.ts`) and promotes source relations from note relations
 * (F3 D17, D27, D46). The settings that shaped the old blended score and the old shortlists no
 * longer decide anything, so they leave the stored document and every saved preset. Nothing else
 * changes: the live values, the preset names and the active preset stay as they are.
 *
 * The function is pure and idempotent. It returns the very same object when there is nothing to
 * drop, so a caller can tell a document that needs rewriting from one that does not.
 */

/** Top-level fields of a settings document or of a preset's settings. */
export const retiredMatchingSettingKeys = ["atomicNoteRelationThreshold"] as const;

/** Fields of `atomicNoteMatchingSettings`; only `maxRerankOutputTokens` still applies. */
export const retiredNoteMatchingSettingKeys = [
  "textCandidateLimit",
  "vectorCandidateLimit",
  "graphCandidateLimit",
  "fusedCandidateLimit",
  "minimumGraphOnlyCandidates",
  "reciprocalRankConstant",
  "withEmbeddingAndGraph",
  "withEmbedding",
  "withGraph",
  "textAndMetadata",
  "rerankerWeight",
  "minRerankScore",
  "requireReranking",
  "includeWeakTypes",
  "maxRelationsPerNote"
] as const;

/** Fields of `sourceRelationSettings`: the shortlist design E deleted (F3 D27). */
export const retiredSourceRelationSettingKeys = [
  "reciprocalRankConstant",
  "noteRelationsPerPair",
  "maxCandidates",
  "maxPairs",
  "maxRelations"
] as const;

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` without `keys`, or `value` itself when it holds none of them. */
function without(value: PlainObject, keys: readonly string[]): PlainObject {
  if (!keys.some((key) => key in value)) return value;
  const kept = { ...value };
  for (const key of keys) delete kept[key];
  return kept;
}

/** Applies `change` to `value[key]` when it is an object; keeps `value` when nothing changed. */
function withChild(
  value: PlainObject,
  key: string,
  change: (child: PlainObject) => PlainObject
): PlainObject {
  const child = value[key];
  if (!isPlainObject(child)) return value;
  const changed = change(child);
  return changed === child ? value : { ...value, [key]: changed };
}

/** A settings document, or the settings of one preset. */
function migrateConfiguration(configuration: PlainObject): PlainObject {
  let next = without(configuration, retiredMatchingSettingKeys);
  next = withChild(next, "atomicNoteMatchingSettings", (notes) =>
    without(notes, retiredNoteMatchingSettingKeys)
  );
  return withChild(next, "sourceRelationSettings", (sources) =>
    without(sources, retiredSourceRelationSettingKeys)
  );
}

export function migrateMatchingSettingsV2(document: unknown): unknown {
  if (!isPlainObject(document)) return document;
  let next = migrateConfiguration(document);
  const presets = next.matchingPresets;
  if (Array.isArray(presets)) {
    let changed = false;
    const migrated = presets.map((preset: unknown) => {
      if (!isPlainObject(preset)) return preset;
      const result = withChild(preset, "settings", migrateConfiguration);
      changed ||= result !== preset;
      return result;
    });
    if (changed) next = { ...next, matchingPresets: migrated };
  }
  return next;
}
