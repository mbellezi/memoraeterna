import { compareContent } from "./content-order.js";
import { renderPrompt, joinPrompts } from "./prompt-runtime.js";
import {
  CanonicalMatchingSettingsSchema,
  identityGroupFor,
  maxIdentityGroupRows,
  parseSingleJsonObject,
  type CanonicalMatchingSettings,
  type IdentityGroupLimits
} from "@app/domain";
import { createCanonicalEmbedder } from "./canonical-embedding.js";
import { z } from "zod";
import type { AiOutputContract, KnowledgeGraphGenerationOutput } from "@app/domain";
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
const matchSchema = z.object({ matches: z.array(pairSchema).max(maxIdentityGroupRows) }).strict();
/** The contract of a confirmation answer (relation types and entity identities), for the structured-output catalog. */
export const relationMatchOutputSchema = matchSchema;
/** The contracts the confirmation calls state (F4 D23): the tuple keeps them prompt-level remotely. */
const entityIdentityContract: AiOutputContract = {
  name: "entity_identity",
  contract: relationMatchOutputSchema
};
const relationIdentityContract: AiOutputContract = {
  name: "relation_identity",
  contract: relationMatchOutputSchema
};
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
        outputContract: entityIdentity ? entityIdentityContract : relationIdentityContract,
        contentLanguage: "en",
        stage: input.stage,
        operation: entityIdentity ? "entity_identity_resolution" : "relation_type_resolution",
        workloadClass: "write-quality",
        priority: "P2",
        // An imported source's own graph unless the graph pass says otherwise (a catalog header, D14).
        budgetClass: input.context.budgetClass ?? "user"
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

/** What closed an identity group: its row cap, its character cap, or the end of the rows to decide. */
export type IdentityGroupBound = "rows" | "characters" | "end";

/** One identity call as it was formed (F4 D20): C1 reads the effective group sizes and the cap that bound. */
export interface IdentityGroupRecord {
  kind: "entity_identity" | "relation_type";
  rows: number;
  /** Characters of the call's prompt, before the runtime adds its preamble. */
  characters: number;
  maxRows: number;
  maxCharacters: number;
  bound: IdentityGroupBound;
}
export type IdentityGroupTracer = <T>(
  record: IdentityGroupRecord,
  run: () => Promise<T>
) => Promise<T>;

/** The cap one more row would break, or null when it joins the group. A first row always joins. */
export function identityGroupCloses(
  rows: readonly RelationMatchRow[],
  next: RelationMatchRow,
  limits: IdentityGroupLimits,
  entityIdentity: boolean
): Exclude<IdentityGroupBound, "end"> | null {
  if (rows.length === 0) return null;
  if (rows.length >= limits.maxRows) return "rows";
  return buildRelationMatchPrompt([...rows, next], entityIdentity).length > limits.maxCharacters
    ? "characters"
    : null;
}

/**
 * Asks about rows in calls that keep to `limits`, in order: split by serialized prompt size too, so
 * long definitions cannot create unbounded requests. The last call's bound is `bound`, what closed
 * the group the rows came from.
 */
export async function confirmRowsInGroups(
  input: Omit<Parameters<typeof confirmMatchGroup>[0], "group"> & {
    rows: readonly RelationMatchRow[];
    limits: IdentityGroupLimits;
    bound: IdentityGroupBound;
    traceGroup?: IdentityGroupTracer | undefined;
  }
): Promise<Map<string, ConfirmedMatch>> {
  const { rows, limits, bound: groupBound, traceGroup, ...confirmation } = input;
  const decisions = new Map<string, ConfirmedMatch>();
  const pending = [...rows];
  while (pending.length) {
    const group: RelationMatchRow[] = [];
    let bound: IdentityGroupBound = groupBound;
    while (pending.length) {
      const closes = identityGroupCloses(group, pending[0]!, limits, confirmation.entityIdentity);
      if (closes) {
        bound = closes;
        break;
      }
      group.push(pending.shift()!);
    }
    const record: IdentityGroupRecord = {
      kind: confirmation.entityIdentity ? "entity_identity" : "relation_type",
      rows: group.length,
      characters: buildRelationMatchPrompt(group, confirmation.entityIdentity).length,
      maxRows: limits.maxRows,
      maxCharacters: limits.maxCharacters,
      bound
    };
    const ask = () => confirmMatchGroup({ ...confirmation, group });
    const confirmed = traceGroup ? await traceGroup(record, ask) : await ask();
    for (const [key, decision] of confirmed) decisions.set(key, decision);
  }
  return decisions;
}

/**
 * The options both identity resolvers take for grouping (F4 D20). Unpinned, a source's rows are asked
 * in groups of `group` across its extraction batches (rows in batch order, then position); pinned
 * (`MEMORA_GOLDEN_PIN=extraction`), each batch is resolved alone in slices of 12, as recorded.
 */
export interface IdentityGroupingOptions {
  /** The group of the writer's locality (`identityGroupFor`); absent, the stored values capped at the local group. */
  group?: IdentityGroupLimits;
  /** Wraps each identity call with the group it was formed from. */
  traceGroup?: IdentityGroupTracer;
  /** Items decided so far (stored, reused or committed) of the items to decide. */
  onProgress?: (completed: number, total: number) => void | Promise<void>;
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

type Predicate = { predicate: string; definition: string };

/**
 * Each batch's predicates still to resolve, once each in the order they first appear, with the batch's
 * last definition of each (the per-batch reading the recordings were made with).
 */
function predicatesByBatch(batches: readonly KnowledgeGraphGenerationOutput[]): Predicate[][] {
  return batches.map((batch) =>
    [
      ...new Map(
        batch.relations
          .filter((relation) => relation.relationTypeId === undefined)
          .map((relation) => [relation.predicate, relation])
      ).values()
    ].map(({ predicate, definition }) => ({ predicate, definition }))
  );
}

/**
 * Resolves a source's relation types against the catalog (F4 D20). Unpinned, the source's new
 * predicates, in batch order, are asked in groups across its batches; pinned, batch by batch in slices
 * of 12 with the stored splits, as recorded. Relations a stored checkpoint already resolved are kept.
 */
export function createRelationTypeResolver(
  options: {
    settings?: CanonicalMatchingSettings;
    pool: PgPool;
    ai: Pick<AiService, "runDefaultTask">;
    threshold: number;
    context: AiTaskLogContext;
    signal?: AbortSignal;
    /** The recording-era path (F3 D5): strict reading of the answer, whole-group repair, per batch. */
    pinned?: boolean;
  } & IdentityGroupingOptions
) {
  const settings = CanonicalMatchingSettingsSchema.parse(options.settings ?? {});
  const repository = createRelationTypeRepository(options.pool);
  const pinned = options.pinned === true;
  const group = options.group ?? identityGroupFor(null, settings);
  // A pinned run asks in the stored settings' splits, as it was recorded.
  const confirmLimits: IdentityGroupLimits = pinned
    ? {
        maxRows: settings.confirmationBatchSize,
        maxCharacters: settings.confirmationMaxCharacters
      }
    : group;
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
  async function resolveScope(
    relations: readonly Predicate[],
    resolved: Map<string, CanonicalRelationType>,
    progress: () => Promise<void>
  ) {
    if (!relations.length) return;
    for (const [key, value] of await repository.findExact(relations.map((r) => r.predicate)))
      resolved.set(key, value);
    let pending = relations.filter((relation) => !resolved.has(relation.predicate));
    await progress();
    while (pending.length) {
      let outcome: { size: number; committed: Map<string, CanonicalRelationType> } | null = null;
      for (let attempt = 0; attempt < 3 && !outcome; attempt++) {
        // Pinned: slices of 12, as recorded. Unpinned: the group closes at the first cap it meets.
        const window = pinned ? pending.slice(0, 12) : pending;
        const revision = await repository.revision();
        const exact = await repository.findExact(window.map((relation) => relation.predicate));
        for (const [key, value] of exact) resolved.set(key, value);
        let size = 0;
        let bound: IdentityGroupBound = "end";
        const unknown: Predicate[] = [];
        const embedded: Array<Predicate & { vector: RelationTypeVector }> = [];
        const candidatesByRow = new Map<string, Candidate[]>();
        let candidateKeys = new Map<string, string>();
        const rows: RelationMatchRow[] = [];
        for (const relation of window) {
          if (!exact.has(relation.predicate)) {
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
            const keys = new Map(candidateKeys);
            const selected = candidates
              .sort(compareConfirmationCandidates)
              .slice(0, settings.relationTypeCandidateLimit)
              .map((candidate) => {
                if (!keys.has(candidate.key)) keys.set(candidate.key, `c${keys.size + 1}`);
                return { ...candidate, key: keys.get(candidate.key)! };
              });
            const row: RelationMatchRow = {
              key: `r${unknown.length + 1}`,
              predicate: relation.predicate,
              definition: relation.definition,
              candidates: selected
            };
            const closes =
              !pinned && selected.length ? identityGroupCloses(rows, row, group, false) : null;
            if (closes) {
              bound = closes;
              break;
            }
            candidateKeys = keys;
            candidatesByRow.set(row.key, selected);
            unknown.push(relation);
            embedded.push({ ...relation, vector });
            if (selected.length) rows.push(row);
          }
          size += 1;
        }
        if (!unknown.length) {
          outcome = { size, committed: exact };
          break;
        }
        const matches = await confirmRowsInGroups({
          ai: options.ai,
          rows,
          limits: confirmLimits,
          bound,
          traceGroup: options.traceGroup,
          entityIdentity: false,
          context: options.context,
          promptVersion: relationTypeResolutionVersion,
          stage: "relation_type_resolution",
          pinned,
          invalidOutputError: "errors.relationTypes.invalidOutput",
          signal: options.signal
        });
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
        const committed = await repository.commit(decisions, revision);
        if (committed) outcome = { size, committed };
      }
      if (!outcome) throw new Error("errors.relationTypes.catalogChanged");
      for (const [key, value] of outcome.committed) resolved.set(key, value);
      pending = pending.slice(outcome.size);
      await progress();
    }
  }
  return async (
    batches: readonly KnowledgeGraphGenerationOutput[]
  ): Promise<KnowledgeGraphGenerationOutput[]> => {
    const byBatch = predicatesByBatch(batches);
    const all = [...new Set(byBatch.flat().map((relation) => relation.predicate))];
    const resolved = new Map<string, CanonicalRelationType>();
    const progress = async () =>
      options.onProgress?.(all.filter((predicate) => resolved.has(predicate)).length, all.length);
    if (pinned) for (const relations of byBatch) await resolveScope(relations, resolved, progress);
    else {
      // The source's new predicates once each, in batch order: the first batch's reading of each.
      const seen = new Set<string>();
      const source: Predicate[] = [];
      for (const relation of byBatch.flat())
        if (!seen.has(relation.predicate)) {
          seen.add(relation.predicate);
          source.push(relation);
        }
      await resolveScope(source, resolved, progress);
    }
    return batches.map((batch) => ({
      ...batch,
      relations: batch.relations.map((relation) => {
        if (relation.relationTypeId !== undefined) return relation;
        const type = resolved.get(relation.predicate)!;
        return {
          ...relation,
          originalPredicate: relation.predicate,
          predicate: type.predicate,
          definition: type.definition,
          relationTypeId: type.id
        };
      })
    }));
  };
}
