import { createHash } from "node:crypto";
import type { KnowledgeGraphGenerationOutput } from "@app/domain";
import { createEntityIdentityRepository, normalizeIdentityName, type EntityIdentityDecision, type PgPool, type RelationTypeVector } from "@app/db";
import type { AiService, AiTaskLogContext } from "./ai-service.js";
import { createCanonicalEmbedder } from "./canonical-embedding.js";
import { buildRelationMatchPrompt, parseRelationMatches, relationTypeCosine, type RelationMatchRow } from "./relation-type-resolution.js";

export const entityIdentityResolutionVersion = "entity-identity-resolution-v1";
const identityText = (input: { type: string; canonicalName: string; identityDescription: string }) => `${input.type}: ${input.canonicalName}\n${input.identityDescription}`;
type Entity = KnowledgeGraphGenerationOutput["entities"][number];
type Candidate = { sourceItemIds?: string[]; key: string; predicate: string; definition: string; score: number; target: NonNullable<EntityIdentityDecision["target"]> };

export function createEntityIdentityResolver(options: {
  pool: PgPool; ai: Pick<AiService, "runDefaultTask">; threshold: number; language: string; context: AiTaskLogContext; signal?: AbortSignal;
}) {
  const repository = createEntityIdentityRepository(options.pool);
  const fingerprint = (entity: Entity) => createHash("sha256").update(JSON.stringify({ sourceItemId: options.context.sourceItemId, key: entity.key, type: entity.type, name: entity.canonicalName, identityDescription: entity.identityDescription, evidence: [...entity.evidenceChunkIds].sort(), version: entityIdentityResolutionVersion })).digest("hex");
  const embed = createCanonicalEmbedder({ ...options, strategy: entityIdentityResolutionVersion });
  async function confirm(rows: RelationMatchRow[]) {
    const result = new Map<string, { candidate: string | null; aiTaskRunId: string }>();
    const pending = [...rows];
    while (pending.length) {
      const group: RelationMatchRow[] = [];
      while (pending.length && group.length < 12) {
        if (group.length && buildRelationMatchPrompt([...group, pending[0]!], true).length > 12_000) break;
        group.push(pending.shift()!);
      }
      let valid = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        options.signal?.throwIfAborted();
        const execution = await options.ai.runDefaultTask("knowledge-graph-generation", buildRelationMatchPrompt(group, true)
          + (attempt ? "\nRepair: include every supplied input key exactly once, selecting only its candidates or null." : ""),
        { ...options.context, sourceItemIds: [...new Set([...(options.context.sourceItemIds ?? []), ...(options.context.sourceItemId ? [options.context.sourceItemId] : []), ...group.flatMap((row) => row.candidates.flatMap((candidate) => candidate.sourceItemIds ?? []))])], contentLanguage: "en", stage: "entity_identity_resolution" }, options.signal);
        if (!execution) throw new Error("errors.ai.noCompatibleModel");
        try {
          for (const [key, candidate] of parseRelationMatches(execution.output, group)) result.set(key, { candidate, aiTaskRunId: execution.aiTaskRunId });
          valid = true; break;
        } catch { /* Reject invalid aliases and repair once. */ }
      }
      if (!valid) throw new Error("errors.relationTypes.invalidOutput");
    }
    return result;
  }
  return async (batch: KnowledgeGraphGenerationOutput): Promise<KnowledgeGraphGenerationOutput> => {
    const resolved = new Map<string, string>();
    for (let offset = 0; offset < batch.entities.length; offset += 12) {
      const group = batch.entities.slice(offset, offset + 12);
      let committed: Map<string, string> | null = null;
      for (let attempt = 0; attempt < 3 && !committed; attempt++) {
        const revision = await repository.revision();
        const cached = await repository.findResolved(group.map(fingerprint));
        for (const entity of group) { const id = cached.get(fingerprint(entity)); if (id) resolved.set(entity.key, id); }
        const unknown = group.filter((entity) => !cached.has(fingerprint(entity)));
        if (!unknown.length) { committed = new Map(group.map((entity) => [entity.key, resolved.get(entity.key)!])); break; }
        const embedded: Array<{ entity: Entity; vector: RelationTypeVector }> = [];
        const candidatesByRow = new Map<string, Candidate[]>();
        const candidateKeys = new Map<string, string>();
        for (const [index, entity] of unknown.entries()) {
          const vector = await embed(identityText(entity));
          for (;;) {
            options.signal?.throwIfAborted();
            const missing = await repository.missingVectors(vector, [entity.type]);
            if (!missing.length) break;
            for (const item of missing) await repository.saveVector(item.id, await embed(identityText(item), item.sourceItemIds));
          }
          const candidates: Candidate[] = (await repository.candidates({ type: entity.type, names: [entity.canonicalName, ...entity.aliases], vector, threshold: options.threshold })).map((candidate) => ({
            key: `id:${candidate.id}`, predicate: `${candidate.type}: ${candidate.canonicalName}`, definition: candidate.identityDescription,
            sourceItemIds: candidate.sourceItemIds ?? [], score: candidate.score, target: { id: candidate.id }
          }));
          for (const previous of embedded) {
            if (previous.entity.type !== entity.type) continue;
            const score = relationTypeCosine(vector.embedding, previous.vector.embedding);
            const names = new Set([entity.canonicalName, ...entity.aliases].map(normalizeIdentityName));
            const sameName = [previous.entity.canonicalName, ...previous.entity.aliases].some((name) => names.has(normalizeIdentityName(name)));
            if (sameName || score >= options.threshold) candidates.push({ key: `new:${previous.entity.key}`, predicate: `${previous.entity.type}: ${previous.entity.canonicalName}`,
              definition: previous.entity.identityDescription, score, target: { key: previous.entity.key } });
          }
          const selected = candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, 3).map((candidate) => {
            if (!candidateKeys.has(candidate.key)) candidateKeys.set(candidate.key, `c${candidateKeys.size + 1}`);
            return { ...candidate, key: candidateKeys.get(candidate.key)! };
          });
          candidatesByRow.set(`r${index + 1}`, selected);
          embedded.push({ entity, vector });
        }
        const rows = unknown.map((entity, index) => ({ key: `r${index + 1}`, predicate: `${entity.type}: ${entity.canonicalName}`, definition: entity.identityDescription, candidates: candidatesByRow.get(`r${index + 1}`)! })).filter((row) => row.candidates.length);
        const matches = await confirm(rows);
        const decisions = unknown.map((entity, index): EntityIdentityDecision => {
          const match = matches.get(`r${index + 1}`);
          const candidate = candidatesByRow.get(`r${index + 1}`)!.find((item) => item.key === match?.candidate);
          return { ...entity, fingerprint: fingerprint(entity), sourceItemId: options.context.sourceItemId ?? null, language: options.language, target: candidate?.target ?? null, vector: embedded[index]!.vector,
            metadata: { promptVersion: entityIdentityResolutionVersion, threshold: options.threshold,
              method: candidate ? "llm_same_identity" : "new_identity", ...(match ? { aiTaskRunId: match.aiTaskRunId } : {}),
              ...(candidate ? { score: candidate.score } : {}), embeddingSpaceKey: embedded[index]!.vector.spaceKey } };
        });
        options.signal?.throwIfAborted();
        committed = await repository.commit(decisions, revision);
      }
      if (!committed) throw new Error("errors.relationTypes.catalogChanged");
      for (const [key, id] of committed) resolved.set(key, id);
    }
    return { ...batch, entities: batch.entities.map((entity) => ({ ...entity, canonicalEntityId: resolved.get(entity.key)! })),
      relations: batch.relations.filter((relation) => resolved.get(relation.subjectEntityKey) !== resolved.get(relation.objectEntityKey)) };
  };
}
