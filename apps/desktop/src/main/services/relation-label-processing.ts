import { renderPrompt, joinPrompts } from "./prompt-runtime.js";
import { z } from "zod";
import { createJobRepository, createKnowledgeGraphRepository, type JobRecord, type PgPool } from "@app/db";
import { relationLabelJobPayloadSchema } from "../../shared/ipc";
import type { AiService } from "./ai-service.js";

export const relationLabelPromptVersion = "relation-label-v1";
const outputSchema = z.object({
  labels: z.array(z.object({
    key: z.string().regex(/^r\d+$/),
    displayLabel: z.string().trim().min(1).max(300)
  }).strict()).max(20)
}).strict();

export function parseRelationLabels(output: unknown, ids: string[]) {
  const parsed = outputSchema.parse(typeof output === "string" ? JSON.parse(output) : output);
  const expected = new Set(ids.map((_, index) => `r${index + 1}`));
  if (parsed.labels.length !== ids.length || new Set(parsed.labels.map((label) => label.key)).size !== ids.length
      || parsed.labels.some((label) => !expected.has(label.key))) throw new Error("errors.relationLabels.invalidOutput");
  return parsed.labels.map((label) => ({ id: ids[Number(label.key.slice(1)) - 1]!, displayLabel: label.displayLabel }));
}

export function buildRelationLabelPrompt(relations: ReadonlyArray<{ subject: string; predicate: string; object: string }>, contentLanguage: string): string {
  return renderPrompt("graph.relation_labels", { content_language: contentLanguage, relations: relations.map((relation, index) => ({ key: `r${index + 1}`, subject: relation.subject, predicate: relation.predicate, object: relation.object })), });
}

export async function processRelationLabels(pool: PgPool, ai: Pick<AiService, "runDefaultTask">, job: JobRecord, signal: AbortSignal) {
  const input = relationLabelJobPayloadSchema.parse(job.payload);
  const graph = createKnowledgeGraphRepository(pool);
  const jobs = createJobRepository(pool);
  const selection = { jobId: job.id, mode: input.mode, before: input.before };
  const total = await graph.countRelationLabels(selection) + await graph.relationLabelProgress(job.id);
  for (;;) {
    signal.throwIfAborted();
    const relations = await graph.listRelationLabels({ jobId: job.id, mode: input.mode, before: input.before });
    if (relations.length === 0) break;
    const prompt = buildRelationLabelPrompt(relations, input.contentLanguage);
    const context = {
      jobId: job.id, stage: "relation_labels", contentLanguage: input.contentLanguage, promptVersion: relationLabelPromptVersion, attempt: 0,
      sourceItemIds: [...new Set(relations.flatMap((relation) => relation.sourceItemId ? [relation.sourceItemId] : []))]
    };
    let execution = await ai.runDefaultTask("knowledge-graph-generation", prompt, context, signal);
    if (!execution) throw new Error("errors.ai.noCompatibleModel");
    let labels;
    try { labels = parseRelationLabels(execution.output, relations.map((relation) => relation.id)); }
    catch {
      execution = await ai.runDefaultTask("knowledge-graph-generation", joinPrompts(prompt,renderPrompt("graph.relation_labels.repair")), { ...context, attempt: 1 }, signal);
      if (!execution) throw new Error("errors.ai.noCompatibleModel");
      try { labels = parseRelationLabels(execution.output, relations.map((relation) => relation.id)); }
      catch { throw new Error("errors.relationLabels.invalidOutput"); }
    }
    signal.throwIfAborted();
    await graph.saveRelationLabels(labels, {
      displayLanguage: input.contentLanguage, labelJobId: job.id,
      labelGeneration: { promptVersion: relationLabelPromptVersion, aiTaskRunId: execution.aiTaskRunId,
        profileId: execution.profileId, provider: execution.providerId, model: execution.modelId, runtime: execution.runtime }
    });
    const updated = await graph.relationLabelProgress(job.id);
    await jobs.update(job.id, { progress: total > 0 ? Math.min(1, updated / total) : 1, result: { updated, contentLanguage: input.contentLanguage } });
  }
  return { updated: await graph.relationLabelProgress(job.id), contentLanguage: input.contentLanguage };
}
