import { renderPrompt, changedPromptIdentity } from "./prompt-runtime.js";
import {
  CanonicalMatchingSettingsSchema,
  identityGroupFor,
  type CanonicalMatchingSettings,
  type IdentityGroupLimits
} from "@app/domain";
import { createHash } from "node:crypto";
import type { KnowledgeGraphGenerationOutput } from "@app/domain";
import {
  createEntityIdentityRepository,
  normalizeIdentityName,
  type EntityIdentityDecision,
  type PgPool,
  type RelationTypeVector
} from "@app/db";
import type { AiService, AiTaskLogContext } from "./ai-service.js";
import { publishObjectsChanged } from "./object-events.js";
import { createCanonicalEmbedder } from "./canonical-embedding.js";
import {
  aliasCandidates,
  compareConfirmationCandidates,
  confirmRowsInGroups,
  identityGroupCloses,
  relationTypeCosine,
  type IdentityGroupBound,
  type IdentityGroupingOptions,
  type RelationMatchRow
} from "./relation-type-resolution.js";

export const entityIdentityResolutionVersion = "entity-identity-resolution-v1";
export const identityText = (input: {
  type: string;
  canonicalName: string;
  identityDescription: string;
}) =>
  renderPrompt("embedding.content.entity", {
    entity_type: input.type,
    entity_name: input.canonicalName,
    entity_description: input.identityDescription
  });
type Entity = KnowledgeGraphGenerationOutput["entities"][number];
type Candidate = {
  sourceItemIds?: string[];
  key: string;
  predicate: string;
  definition: string;
  score: number;
  target: NonNullable<EntityIdentityDecision["target"]>;
};
/**
 * An extracted entity to resolve. An entity key is unique only within its batch, so a source-wide group
 * names it `b<batch>:<key>`; the fingerprint keeps hashing the model's own key, so the stored
 * `entity_identity_keys` stay valid.
 */
interface Member {
  ref: string;
  entity: Entity;
  fingerprint: string;
}

/**
 * Resolves a source's extracted entities to canonical ones (F4 D20). Unpinned, the source's rows (an
 * entity with a candidate), in batch order then entity position, are asked in groups across its
 * batches; each group commits before the next is formed, so a retried stage resumes from
 * `entity_identity_keys`. Pinned, each batch is resolved alone in slices of 12, as recorded. Entities
 * a stored checkpoint already resolved are kept.
 */
export function createEntityIdentityResolver(
  options: {
    settings?: CanonicalMatchingSettings;
    pool: PgPool;
    ai: Pick<AiService, "runDefaultTask">;
    threshold: number;
    language: string;
    context: AiTaskLogContext;
    signal?: AbortSignal;
    /** The recording-era path (F3 D5): strict reading, whole-group repair, the shared error code. */
    pinned?: boolean;
  } & IdentityGroupingOptions
) {
  const settings = CanonicalMatchingSettingsSchema.parse(options.settings ?? {});
  const repository = createEntityIdentityRepository(options.pool);
  const pinned = options.pinned === true;
  const group = options.group ?? identityGroupFor(null, settings);
  // A pinned run asks in the stored settings' splits, as it was recorded.
  const confirmLimits: IdentityGroupLimits = pinned
    ? {
        maxRows: settings.confirmationBatchSize,
        maxCharacters: settings.confirmationMaxCharacters
      }
    : group;
  const fingerprint = (entity: Entity) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          sourceItemId: options.context.sourceItemId,
          key: entity.key,
          type: entity.type,
          name: entity.canonicalName,
          identityDescription: entity.identityDescription,
          evidence: [...entity.evidenceChunkIds].sort(),
          version: entityIdentityResolutionVersion,
          ...(changedPromptIdentity(["graph.entity_identity", "graph.entity_identity.repair"])
            ? {
                promptIdentity: changedPromptIdentity([
                  "graph.entity_identity",
                  "graph.entity_identity.repair"
                ])
              }
            : {})
        })
      )
      .digest("hex");
  const embed = createCanonicalEmbedder({ ...options, strategy: entityIdentityResolutionVersion });
  async function resolveScope(
    members: readonly Member[],
    resolved: Map<string, string>,
    progress: () => Promise<void>
  ) {
    let start = 0;
    while (start < members.length) {
      let outcome: { size: number; ids: Map<string, string> } | null = null;
      for (let attempt = 0; attempt < 3 && !outcome; attempt++) {
        // Pinned: slices of 12, as recorded. Unpinned: the group closes at the first cap it meets.
        const window = pinned ? members.slice(start, start + 12) : members.slice(start);
        const revision = await repository.revision();
        const cached = await repository.findResolved([
          ...new Set(window.map((member) => member.fingerprint))
        ]);
        let size = 0;
        let bound: IdentityGroupBound = "end";
        const unknown: Member[] = [];
        // A fingerprint repeated in one group is decided once (the key table holds it once).
        const firstByFingerprint = new Map<string, Member>();
        const embedded: Array<{ member: Member; vector: RelationTypeVector }> = [];
        const candidatesByRow = new Map<string, Candidate[]>();
        let candidateKeys = new Map<string, string>();
        // Unpinned, an earlier row's provisional identity is named by its row key (`aliasCandidates`).
        const rowKeys = new Map<string, string>();
        const rows: RelationMatchRow[] = [];
        for (const member of window) {
          if (!cached.has(member.fingerprint) && !firstByFingerprint.has(member.fingerprint)) {
            const { entity } = member;
            const vector = await embed(identityText(entity));
            for (;;) {
              options.signal?.throwIfAborted();
              const missing = await repository.missingVectors(vector, [entity.type]);
              if (!missing.length) break;
              for (const item of missing)
                await repository.saveVector(
                  item.id,
                  await embed(identityText(item), item.sourceItemIds)
                );
            }
            const candidates: Candidate[] = (
              await repository.candidates({
                type: entity.type,
                names: [entity.canonicalName, ...entity.aliases],
                vector,
                threshold: options.threshold,
                limit: settings.entityCandidateLimit
              })
            ).map((candidate) => ({
              key: `id:${candidate.id}`,
              predicate: `${candidate.type}: ${candidate.canonicalName}`,
              definition: candidate.identityDescription,
              sourceItemIds: candidate.sourceItemIds ?? [],
              score: candidate.score,
              target: { id: candidate.id }
            }));
            for (const previous of embedded) {
              if (previous.member.entity.type !== entity.type) continue;
              const score = relationTypeCosine(vector.embedding, previous.vector.embedding);
              const names = new Set(
                [entity.canonicalName, ...entity.aliases].map(normalizeIdentityName)
              );
              const sameName = [
                previous.member.entity.canonicalName,
                ...previous.member.entity.aliases
              ].some((name) => names.has(normalizeIdentityName(name)));
              if (sameName || score >= options.threshold)
                candidates.push({
                  key: `new:${previous.member.ref}`,
                  predicate: `${previous.member.entity.type}: ${previous.member.entity.canonicalName}`,
                  definition: previous.member.entity.identityDescription,
                  score,
                  target: { key: previous.member.ref }
                });
            }
            const keys = new Map(candidateKeys);
            const selected = aliasCandidates(
              candidates
                .sort(compareConfirmationCandidates)
                .slice(0, settings.entityCandidateLimit),
              keys,
              rowKeys
            );
            const row: RelationMatchRow = {
              key: `r${unknown.length + 1}`,
              predicate: `${entity.type}: ${entity.canonicalName}`,
              definition: entity.identityDescription,
              candidates: selected
            };
            const closes =
              !pinned && selected.length ? identityGroupCloses(rows, row, group, true) : null;
            if (closes) {
              bound = closes;
              break;
            }
            candidateKeys = keys;
            candidatesByRow.set(row.key, selected);
            unknown.push(member);
            firstByFingerprint.set(member.fingerprint, member);
            embedded.push({ member, vector });
            if (selected.length) {
              rows.push(row);
              if (!pinned) rowKeys.set(`new:${member.ref}`, row.key);
            }
          }
          size += 1;
        }
        const idsOf = (committed: ReadonlyMap<string, string>) =>
          new Map(
            window
              .slice(0, size)
              .map((member) => [
                member.ref,
                cached.get(member.fingerprint) ??
                  committed.get(firstByFingerprint.get(member.fingerprint)!.ref)!
              ])
          );
        if (!unknown.length) {
          outcome = { size, ids: idsOf(new Map()) };
          break;
        }
        const matches = await confirmRowsInGroups({
          ai: options.ai,
          rows,
          limits: confirmLimits,
          bound,
          traceGroup: options.traceGroup,
          entityIdentity: true,
          context: options.context,
          promptVersion: entityIdentityResolutionVersion,
          stage: "entity_identity_resolution",
          pinned,
          // An entity decision has its own code now; a pinned run keeps the one it was recorded with.
          invalidOutputError: pinned
            ? "errors.relationTypes.invalidOutput"
            : "errors.entityIdentity.invalidOutput",
          signal: options.signal
        });
        const decisions = unknown.map((member, index): EntityIdentityDecision => {
          const match = matches.get(`r${index + 1}`);
          const candidate = candidatesByRow
            .get(`r${index + 1}`)!
            .find((item) => item.key === match?.candidate);
          return {
            ...member.entity,
            key: member.ref,
            fingerprint: member.fingerprint,
            sourceItemId: options.context.sourceItemId ?? null,
            language: options.language,
            target: candidate?.target ?? null,
            vector: embedded[index]!.vector,
            metadata: {
              settings,
              promptVersion: entityIdentityResolutionVersion,
              threshold: options.threshold,
              method: candidate ? "llm_same_identity" : "new_identity",
              ...(match ? { aiTaskRunId: match.aiTaskRunId } : {}),
              ...(candidate ? { score: candidate.score } : {}),
              embeddingSpaceKey: embedded[index]!.vector.spaceKey
            }
          };
        });
        options.signal?.throwIfAborted();
        const committed = await repository.commit(decisions, revision);
        if (committed) {
          // The group is stored: a new canonical entity was created, an existing one gained aliases.
          // A member that is an alias of another member of the group adds nothing of its own: that
          // member's decision already said whether its entity was created or existed.
          publishObjectsChanged(
            decisions.flatMap((decision) => {
              const id = committed.get(decision.key);
              if (!id || (decision.target && !("id" in decision.target))) return [];
              return [
                { kind: "entity" as const, id, change: decision.target ? "updated" : "created" }
              ];
            })
          );
          outcome = { size, ids: idsOf(committed) };
        }
      }
      if (!outcome)
        throw new Error(
          pinned ? "errors.relationTypes.catalogChanged" : "errors.entityIdentity.catalogChanged"
        );
      for (const [ref, id] of outcome.ids) resolved.set(ref, id);
      start += outcome.size;
      await progress();
    }
  }
  return async (
    batches: readonly KnowledgeGraphGenerationOutput[]
  ): Promise<KnowledgeGraphGenerationOutput[]> => {
    const byBatch = batches.map((batch, index) =>
      batch.entities
        .filter((entity) => entity.canonicalEntityId === undefined)
        .map((entity) => ({
          ref: `b${index}:${entity.key}`,
          entity,
          fingerprint: fingerprint(entity)
        }))
    );
    const total = byBatch.reduce((sum, members) => sum + members.length, 0);
    const resolved = new Map<string, string>();
    const progress = async () => options.onProgress?.(resolved.size, total);
    await progress();
    if (pinned) for (const members of byBatch) await resolveScope(members, resolved, progress);
    else await resolveScope(byBatch.flat(), resolved, progress);
    return batches.map((batch, index) => {
      const ids = new Map(
        batch.entities.map((entity) => [
          entity.key,
          entity.canonicalEntityId ?? resolved.get(`b${index}:${entity.key}`)!
        ])
      );
      return {
        ...batch,
        entities: batch.entities.map((entity) => ({
          ...entity,
          canonicalEntityId: ids.get(entity.key)!
        })),
        relations: batch.relations.filter(
          (relation) => ids.get(relation.subjectEntityKey) !== ids.get(relation.objectEntityKey)
        )
      };
    });
  };
}
