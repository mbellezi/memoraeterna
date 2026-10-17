import {
  ExtractedEntityRelationSchema,
  ExtractedGraphEntitySchema,
  validationProblems,
  type KnowledgeGraphGenerationOutput
} from "@app/domain";

/**
 * Knowledge-graph salvage (F3 D35): an answer is judged item by item, so a relation that points to an
 * unknown entity key, or to its own subject, no longer costs the entities and relations around it.
 * Valid items are kept with no further call; the answer is asked again only when nothing valid is
 * left. The recording-era parse (`parseKnowledgeGraphOutput`) stays for pinned runs.
 */

/** A model answer with no valid item to keep, or a shape no item can be read from. */
export class StructuredItemsError extends Error {
  public readonly problems: readonly string[];

  public constructor(message: string, problems: readonly string[]) {
    super(message);
    this.name = "StructuredItemsError";
    this.problems = problems;
  }
}

/** Items dropped without a call, by the reason that dropped them. */
export type GraphSalvageReason =
  | "invalid_entity"
  | "duplicate_entity_key"
  | "invalid_relation"
  | "invalid_predicate"
  | "unknown_entity_key"
  | "self_relation"
  | "unknown_evidence_alias"
  | "over_limit";

export interface GraphSalvage {
  /** The valid items, evidence aliases resolved to chunk IDs. */
  output: KnowledgeGraphGenerationOutput;
  /** Items dropped with no call, by reason. */
  dropped: Partial<Record<GraphSalvageReason, number>>;
  /** Items kept after a deterministic normalization (a predicate to snake_case, an ignored canonical ID, a blank optional description). */
  normalized: number;
  /** `dropped` plus `normalized`: the number reported as `salvaged_items`. */
  salvagedItems: number;
  /** What was wrong, as short lines for a repair prompt (at most 8). */
  problems: string[];
  /**
   * True when nothing valid is left of an answer that had content, or when the answer had no entity
   * and relation lists at all: only then is the answer asked again.
   */
  nothingValid: boolean;
}

type JsonRecord = Record<string, unknown>;

const maxEntities = 100;
const maxRelations = 200;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A predicate as snake_case when that reading is unambiguous: separators (spaces, hyphens, dots,
 * slashes) and camelCase boundaries become underscores, the result is lower case. Anything with other
 * characters (digits, accents, punctuation) is ambiguous and is not guessed at.
 */
export function normalizePredicate(predicate: string): string | null {
  const snake = predicate
    .trim()
    .replace(/([a-z])([A-Z])/gu, "$1_$2")
    .replace(/[\s\-./]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_|_$/gu, "")
    .toLowerCase();
  return /^[a-z]+(?:_[a-z]+)*$/u.test(snake) && snake.length <= 120 ? snake : null;
}

/**
 * Resolves the evidence aliases of one item to chunk IDs. An alias that is not in the batch drops the
 * item: it cites evidence this batch does not have.
 */
function resolveEvidence(
  item: JsonRecord,
  aliases: ReadonlyMap<string, string>
): JsonRecord | "unknown_alias" {
  if (!Array.isArray(item.evidenceChunkIds)) return item;
  const resolved: unknown[] = [];
  for (const candidate of item.evidenceChunkIds) {
    if (typeof candidate !== "string") {
      resolved.push(candidate);
      continue;
    }
    const chunkId = aliases.get(candidate);
    if (!chunkId) return "unknown_alias";
    resolved.push(chunkId);
  }
  return { ...item, evidenceChunkIds: resolved };
}

/**
 * Salvages a parsed answer. `value` is the JSON the model returned and `aliases` maps the evidence
 * aliases of the batch to chunk IDs. Claims are ignored, as they are everywhere since F1a.
 */
export function salvageKnowledgeGraph(
  value: unknown,
  aliases: ReadonlyMap<string, string>
): GraphSalvage {
  const dropped: Partial<Record<GraphSalvageReason, number>> = {};
  const problems: string[] = [];
  let normalized = 0;
  const drop = (reason: GraphSalvageReason, detail: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
    if (problems.length < 8) problems.push(detail);
  };
  const empty = (): GraphSalvage => ({
    output: { entities: [], relations: [] },
    dropped,
    normalized,
    salvagedItems: 0,
    problems,
    nothingValid: true
  });
  if (!isRecord(value)) {
    problems.push("root: the answer must be one JSON object with entities and relations");
    return empty();
  }
  if (!Array.isArray(value.entities) && !Array.isArray(value.relations)) {
    problems.push("root: entities and relations must be lists");
    return empty();
  }
  // A list the model left out holds nothing; the other one is judged on its own.
  const rawEntities: unknown[] = Array.isArray(value.entities) ? value.entities : [];
  const rawRelations: unknown[] = Array.isArray(value.relations) ? value.relations : [];
  if (!Array.isArray(value.entities)) problems.push("entities: must be a list");
  if (!Array.isArray(value.relations)) problems.push("relations: must be a list");

  const entities: KnowledgeGraphGenerationOutput["entities"] = [];
  const keys = new Set<string>();
  rawEntities.forEach((raw, index) => {
    if (entities.length >= maxEntities) return drop("over_limit", `entities.${index}: too many`);
    if (!isRecord(raw)) return drop("invalid_entity", `entities.${index}: must be an object`);
    const resolved = resolveEvidence(raw, aliases);
    if (resolved === "unknown_alias")
      return drop("unknown_evidence_alias", `entities.${index}: unknown evidence alias`);
    // A model never supplies a canonical identity; the field is ignored, not trusted.
    const { canonicalEntityId, ...withDescription } = resolved;
    if (canonicalEntityId !== undefined) normalized += 1;
    // An optional description the model left empty is no description (it is the commonest
    // recorded defect of strong remote writers).
    const { description, ...withoutDescription } = withDescription;
    const blankDescription = typeof description === "string" && description.trim() === "";
    if (blankDescription) normalized += 1;
    const rest = blankDescription ? withoutDescription : withDescription;
    const checked = ExtractedGraphEntitySchema.safeParse(rest);
    if (!checked.success)
      return drop(
        "invalid_entity",
        `entities.${index}: ${validationProblems(checked.error, 1)[0] ?? "invalid"}`
      );
    const entity = checked.data;
    if (keys.has(entity.key))
      return drop("duplicate_entity_key", `entities.${index}: key ${entity.key} is not unique`);
    keys.add(entity.key);
    entities.push(entity);
  });

  const relations: KnowledgeGraphGenerationOutput["relations"] = [];
  rawRelations.forEach((raw, index) => {
    if (relations.length >= maxRelations) return drop("over_limit", `relations.${index}: too many`);
    if (!isRecord(raw)) return drop("invalid_relation", `relations.${index}: must be an object`);
    const resolved = resolveEvidence(raw, aliases);
    if (resolved === "unknown_alias")
      return drop("unknown_evidence_alias", `relations.${index}: unknown evidence alias`);
    const { relationTypeId, originalPredicate, ...rest } = resolved;
    if (relationTypeId !== undefined || originalPredicate !== undefined) normalized += 1;
    let candidate: JsonRecord = rest;
    if (typeof rest.predicate === "string") {
      const predicate = normalizePredicate(rest.predicate);
      if (predicate === null)
        return drop("invalid_predicate", `relations.${index}.predicate: not snake_case`);
      if (predicate !== rest.predicate) {
        normalized += 1;
        candidate = { ...rest, predicate };
      }
    }
    const checked = ExtractedEntityRelationSchema.safeParse(candidate);
    if (!checked.success)
      return drop(
        "invalid_relation",
        `relations.${index}: ${validationProblems(checked.error, 1)[0] ?? "invalid"}`
      );
    const relation = checked.data;
    if (!keys.has(relation.subjectEntityKey) || !keys.has(relation.objectEntityKey))
      return drop("unknown_entity_key", `relations.${index}: references an unknown entity key`);
    if (relation.subjectEntityKey === relation.objectEntityKey)
      return drop("self_relation", `relations.${index}: connects an entity to itself`);
    relations.push(relation);
  });

  const droppedItems = Object.values(dropped).reduce((sum, count) => sum + (count ?? 0), 0);
  const hadContent = rawEntities.length > 0 || rawRelations.length > 0;
  return {
    output: { entities, relations },
    dropped,
    normalized,
    salvagedItems: droppedItems + normalized,
    problems,
    nothingValid: entities.length === 0 && hadContent
  };
}
