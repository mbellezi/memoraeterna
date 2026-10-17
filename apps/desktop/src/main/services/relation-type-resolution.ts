import { compareContent } from "./content-order.js";
import { renderPrompt, joinPrompts } from "./prompt-runtime.js";
import {
  CanonicalMatchingSettingsSchema,
  parseSingleJsonObject,
  type CanonicalMatchingSettings
} from "@app/domain";
import { createCanonicalEmbedder } from "./canonical-embedding.js";
import { z } from "zod";
import type { KnowledgeGraphGenerationOutput } from "@app/domain";
import {
  createRelationTypeRepository,
  type CanonicalRelationType,
  type PgPool,
  type RelationTypeDecision,
  type RelationTypeVector
} from "@app/db";
import type { AiService, AiTaskLogContext } from "./ai-service.js";

export const relationTypeResolutionVersion = "relation-type-resolution-v1";
export const defaultRelationTypeSimilarityThreshold = 0.92;
const pairSchema = z.tuple([z.string(), z.string().nullable()]);
const matchSchema = z.object({ matches: z.array(pairSchema).max(12) }).strict();
/** The contract of a confirmation answer (relation types and entity identities), for the structured-output catalog. */
export const relationMatchOutputSchema = matchSchema;
type Candidate = {
  sourceItemIds?: string[];
  key: string;
  predicate: string;
  definition: string;
  score: number;
  target: NonNullable<RelationTypeDecision["target"]>;
};
export interface RelationMatchRow {
  key: string;
  predicate: string;
  definition: string;
  candidates: Array<Pick<Candidate, "key" | "predicate" | "definition" | "sourceItemIds">>;
}

/**
 * Orders confirmation candidates by score, then by what a reader sees. The candidate key embeds a
 * database ID for stored candidates, which differs on every import and so can never break a tie.
 */
export function compareConfirmationCandidates(
  left: Pick<Candidate, "score" | "predicate" | "definition" | "key">,
  right: Pick<Candidate, "score" | "predicate" | "definition" | "key">
): number {
  return (
    right.score - left.score ||
    compareContent(left.predicate, right.predicate) ||
    compareContent(left.definition, right.definition) ||
    compareContent(left.key, right.key)
  );
}

export function buildRelationMatchPrompt(rows: RelationMatchRow[], entityIdentity = false): string {
  const candidates = new Map(
    rows.flatMap((row) => row.candidates.map((candidate) => [candidate.key, candidate] as const))
  );
  return renderPrompt(entityIdentity ? "graph.entity_identity" : "graph.relation_identity", {
    candidates: {
      relations: rows.map((row) => [
        row.key,
        row.predicate,
        row.definition,
        row.candidates.map((candidate) => candidate.key)
      ]),
      candidates: [...candidates.values()].map((candidate) => [
        candidate.key,
        candidate.predicate,
        candidate.definition
      ])
    }
  });
}

export function parseRelationMatches(
  output: unknown,
  rows: RelationMatchRow[]
): Map<string, string | null> {
  const parsed = matchSchema.parse(typeof output === "string" ? JSON.parse(output) : output);
  const allowed = new Map(
    rows.map((row) => [row.key, new Set(row.candidates.map((candidate) => candidate.key))])
  );
  const result = new Map(parsed.matches);
  if (
    parsed.matches.length !== rows.length ||
    result.size !== rows.length ||
    parsed.matches.some(
      ([key, candidate]) =>
        !allowed.has(key) || (candidate !== null && !allowed.get(key)!.has(candidate))
    )
  )
    throw new Error("errors.relationTypes.invalidOutput");
  return result;
}

export interface TolerantRelationMatches {
  /** The rows the answer decided validly: a known row and one of its candidates, or null. */
  decided: Map<string, string | null>;
  /** The rows still to decide: not in the answer, or in it with an unknown key or candidate. */
  missing: RelationMatchRow[];
}

/**
 * Reads a confirmation answer row by row (F3 D35). The answer may carry a stray character or repeat
 * its object (`parseSingleJsonObject`); a pair that names an unknown row or a candidate the row does
 * not have, or a row answered twice differently, leaves that row missing and the rest decided. An
 * answer with no `matches` list decides nothing. The strict reader above stays for pinned runs.
 */
export function parseRelationMatchesTolerant(
  output: unknown,
  rows: RelationMatchRow[]
): TolerantRelationMatches {
  const allowed = new Map(
    rows.map((row) => [row.key, new Set(row.candidates.map((candidate) => candidate.key))])
  );
  let pairs: unknown[] = [];
  try {
    const value = parseSingleJsonObject(output);
    const list =
      typeof value === "object" && value !== null
        ? (value as { matches?: unknown }).matches
        : undefined;
    if (Array.isArray(list)) pairs = list;
  } catch {
    pairs = [];
  }
  const answered = new Map<string, string | null>();
  const conflicting = new Set<string>();
  for (const pair of pairs) {
    const parsed = pairSchema.safeParse(pair);
    if (!parsed.success) continue;
    const [key, candidate] = parsed.data;
    const candidates = allowed.get(key);
    if (!candidates || (candidate !== null && !candidates.has(candidate))) continue;
    if (answered.has(key) && answered.get(key) !== candidate) conflicting.add(key);
    else answered.set(key, candidate);
  }
  for (const key of conflicting) answered.delete(key);
  return {
    decided: answered,
    missing: rows.filter((row) => !answered.has(row.key))
  };
}

export interface ConfirmedMatch {
  candidate: string | null;
  aiTaskRunId: string;
}

/**
 * Asks the model which candidate of each row is the same thing, for one group of rows (relation types
 * and entity identities share it). Unpinned, a first answer that decides only some rows keeps them and
 * the one repair asks about the others only; the group fails when a row is still undecided after it,
 * with the error code the caller names. Pinned, the recording-era path runs: strict reading, and the
 * whole group asked again, so each recorded repair replays.
 */
export async function confirmMatchGroup(input: {
  ai: Pick<AiService, "runDefaultTask">;
  group: RelationMatchRow[];
  entityIdentity: boolean;
  context: AiTaskLogContext;
  promptVersion: string;
  stage: string;
  pinned: boolean;
  invalidOutputError: string;
  signal?: AbortSignal | undefined;
}): Promise<Map<string, ConfirmedMatch>> {
  const { group, entityIdentity } = input;
  const repairPrompt = () =>
    renderPrompt(
      entityIdentity ? "graph.entity_identity.repair" : "graph.relation_identity.repair"
    );
  const sourceItemIds = [
    ...new Set([
      ...(input.context.sourceItemIds ?? []),
      ...(input.context.sourceItemId ? [input.context.sourceItemId] : []),
      ...group.flatMap((row) =>
        row.candidates.flatMap((candidate) => candidate.sourceItemIds ?? [])
      )
    ])
  ];
  const decisions = new Map<string, ConfirmedMatch>();
  let pending = group;
  for (let attempt = 0; attempt < 2; attempt++) {
    input.signal?.throwIfAborted();
    // The first attempt asks the whole group; an unpinned repair asks about the rows still missing.
    const asked = input.pinned || attempt === 0 ? group : pending;
    const execution = await input.ai.runDefaultTask(
      "knowledge-graph-generation",
      joinPrompts(buildRelationMatchPrompt(asked, entityIdentity), attempt ? repairPrompt() : ""),
      {
        ...input.context,
        sourceItemIds,
        attempt,
        isRepair: attempt > 0,
        promptVersion: input.promptVersion,
        contentLanguage: "en",
        stage: input.stage
      },
      input.signal
    );
    if (!execution) throw new Error("errors.ai.noCompatibleModel");
    if (input.pinned) {
      try {
        for (const [key, candidate] of parseRelationMatches(execution.output, group))
          decisions.set(key, { candidate, aiTaskRunId: execution.aiTaskRunId });
        return decisions;
      } catch {
        // Invalid aliases are rejected and the group is repaired once.
        continue;
      }
    }
    const answer = parseRelationMatchesTolerant(execution.output, asked);
    for (const [key, candidate] of answer.decided)
      decisions.set(key, { candidate, aiTaskRunId: execution.aiTaskRunId });
    pending = pending.filter((row) => !decisions.has(row.key));
    if (pending.length === 0) return decisions;
  }
  throw new Error(input.invalidOutputError);
}

export function relationTypeCosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return -1;
  const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const norms = Math.hypot(...left) * Math.hypot(...right);
  return norms > 0 ? Math.max(-1, Math.min(1, dot / norms)) : -1;
}

export function embeddingText(input: { predicate: string; definition: string }): string {
  return renderPrompt("embedding.content.relation", {
    predicate: input.predicate.replaceAll("_", " "),
    definition: input.definition
  });
}

export function createRelationTypeResolver(options: {
  settings?: CanonicalMatchingSettings;
  pool: PgPool;
  ai: Pick<AiService, "runDefaultTask">;
  threshold: number;
  context: AiTaskLogContext;
  signal?: AbortSignal;
  /** The recording-era path (F3 D5): strict reading of the answer, whole-group repair. */
  pinned?: boolean;
}) {
  const settings = CanonicalMatchingSettingsSchema.parse(options.settings ?? {});
  const repository = createRelationTypeRepository(options.pool);
  const embedText = createCanonicalEmbedder({
    ...options,
    strategy: relationTypeResolutionVersion
  });
  const embed = (input: { predicate: string; definition: string; sourceItemIds?: string[] }) =>
    embedText(embeddingText(input), input.sourceItemIds);
  async function indexMissing(vector: RelationTypeVector) {
    for (;;) {
      options.signal?.throwIfAborted();
      const missing = await repository.missingVectors(vector);
      if (!missing.length) return;
      for (const type of missing) await repository.saveVector(type.id, await embed(type));
    }
  }
  async function confirm(rows: RelationMatchRow[]) {
    const decisions = new Map<string, ConfirmedMatch>();
    // Split by serialized prompt size too, so long definitions cannot create unbounded requests.
    let pending = [...rows];
    while (pending.length) {
      const group: RelationMatchRow[] = [];
      while (pending.length && group.length < settings.confirmationBatchSize) {
        const next = pending[0]!;
        if (
          group.length &&
          buildRelationMatchPrompt([...group, next]).length > settings.confirmationMaxCharacters
        )
          break;
        group.push(pending.shift()!);
      }
      const confirmed = await confirmMatchGroup({
        ai: options.ai,
        group,
        entityIdentity: false,
        context: options.context,
        promptVersion: relationTypeResolutionVersion,
        stage: "relation_type_resolution",
        pinned: options.pinned === true,
        invalidOutputError: "errors.relationTypes.invalidOutput",
        signal: options.signal
      });
      for (const [key, decision] of confirmed) decisions.set(key, decision);
    }
    return decisions;
  }
  return async (batch: KnowledgeGraphGenerationOutput): Promise<KnowledgeGraphGenerationOutput> => {
    const unique = [
      ...new Map(batch.relations.map((relation) => [relation.predicate, relation])).values()
    ];
    const resolved = await repository.findExact(unique.map((relation) => relation.predicate));
    let pending = unique.filter((relation) => !resolved.has(relation.predicate));
    while (pending.length) {
      const group = pending.splice(0, 12);
      let committed: Map<string, CanonicalRelationType> | null = null;
      for (let attempt = 0; attempt < 3 && !committed; attempt++) {
        const revision = await repository.revision();
        const exact = await repository.findExact(group.map((relation) => relation.predicate));
        for (const [key, value] of exact) resolved.set(key, value);
        const unknown = group.filter((relation) => !exact.has(relation.predicate));
        if (!unknown.length) {
          committed = exact;
          break;
        }
        const embedded: Array<{
          predicate: string;
          definition: string;
          vector: RelationTypeVector;
        }> = [];
        const candidatesByRow = new Map<string, Candidate[]>();
        const candidateKeys = new Map<string, string>();
        for (const [index, relation] of unknown.entries()) {
          const vector = await embed(relation);
          await indexMissing(vector);
          const candidates: Candidate[] = (
            await repository.candidates(
              vector,
              options.threshold,
              settings.relationTypeCandidateLimit
            )
          ).map((candidate) => ({
            ...candidate,
            key: `id:${candidate.id}`,
            target: { id: candidate.id }
          }));
          for (const previous of embedded) {
            const score = relationTypeCosine(vector.embedding, previous.vector.embedding);
            if (score >= options.threshold)
              candidates.push({
                ...previous,
                key: `new:${previous.predicate}`,
                score,
                target: { predicate: previous.predicate }
              });
          }
          const selected = candidates
            .sort(compareConfirmationCandidates)
            .slice(0, settings.relationTypeCandidateLimit)
            .map((candidate) => {
              if (!candidateKeys.has(candidate.key))
                candidateKeys.set(candidate.key, `c${candidateKeys.size + 1}`);
              return { ...candidate, key: candidateKeys.get(candidate.key)! };
            });
          candidatesByRow.set(`r${index + 1}`, selected);
          embedded.push({ predicate: relation.predicate, definition: relation.definition, vector });
        }
        const rows = unknown
          .map((relation, index) => ({
            key: `r${index + 1}`,
            predicate: relation.predicate,
            definition: relation.definition,
            candidates: candidatesByRow.get(`r${index + 1}`)!
          }))
          .filter((row) => row.candidates.length > 0);
        const matches = await confirm(rows);
        const decisions: RelationTypeDecision[] = unknown.map((relation, index) => {
          const key = `r${index + 1}`,
            match = matches.get(key);
          const candidate = candidatesByRow.get(key)!.find((item) => item.key === match?.candidate);
          return {
            predicate: relation.predicate,
            definition: relation.definition,
            target: candidate?.target ?? null,
            vector: embedded[index]!.vector,
            metadata: {
              sourceItemIds: [
                ...(options.context.sourceItemIds ?? []),
                ...(options.context.sourceItemId ? [options.context.sourceItemId] : [])
              ],
              settings,
              promptVersion: relationTypeResolutionVersion,
              threshold: options.threshold,
              method: candidate ? "llm_equivalent" : "new_type",
              ...(match ? { aiTaskRunId: match.aiTaskRunId } : {}),
              ...(candidate ? { score: candidate.score } : {}),
              embeddingSpaceKey: embedded[index]!.vector.spaceKey
            }
          };
        });
        options.signal?.throwIfAborted();
        committed = await repository.commit(decisions, revision);
      }
      if (!committed) throw new Error("errors.relationTypes.catalogChanged");
      for (const [key, value] of committed) resolved.set(key, value);
    }
    return {
      ...batch,
      relations: batch.relations.map((relation) => {
        const type = resolved.get(relation.predicate)!;
        return {
          ...relation,
          originalPredicate: relation.predicate,
          predicate: type.predicate,
          definition: type.definition,
          relationTypeId: type.id
        };
      })
    };
  };
}
