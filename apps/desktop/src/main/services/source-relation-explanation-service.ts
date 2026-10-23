import {
  createSourceRelationExplanationRepository,
  sourceRelationExplainable,
  sourceRelationExplanationPlan,
  type PgPool
} from "@app/db";
import {
  RelationExplainInputSchema,
  RelationExplanationResultSchema,
  relationExplanationLimits,
  type RelationExplanationResult
} from "@app/domain";

import { ActiveDeadline } from "@app/ai";
import type { AiService } from "./ai-service.js";
import { sourceRelationExplanationOperation } from "./ai-task-parameters.js";
import {
  acceptSourceRelationExplanation,
  buildSourceRelationExplanationPrompt,
  buildSourceRelationExplanationRepairPrompt,
  sourceRelationExplanationPromptVersion
} from "./source-relation-explanation.js";

export interface SourceRelationExplanationServiceOptions {
  getPool: () => PgPool | null;
  ai: Pick<AiService, "runDefaultTask">;
  /** The content language explanations are written in. */
  getContentLanguage: () => Promise<string>;
}

/**
 * Explanations of source relations decided without prose, written on demand (docs/plan.md decision
 * 17): only an owner who opens a relation asks for one, never in bulk or in the background. The
 * writer route (`text-generation`, never the decision route) writes it at interactive priority from
 * both sources' titles and current evidence passages, the type and the direction; it is cached for
 * those inputs and the content language. One request per relation runs at a time, and closing the
 * relation cancels it. A relation the owner rejected, one that keeps the prose of the earlier
 * matcher, or one without current evidence on both sides is not explained (null).
 */
export class SourceRelationExplanationService {
  private readonly running = new Map<
    string,
    { promise: Promise<RelationExplanationResult | null>; controller: AbortController }
  >();

  constructor(private readonly options: SourceRelationExplanationServiceOptions) {}

  /** The current explanation of a relation, written now when there is none; null when there is none to write. */
  explain(input: unknown): Promise<RelationExplanationResult | null> {
    const { relationId } = RelationExplainInputSchema.parse(input);
    const current = this.running.get(relationId);
    if (current) return current.promise;
    const controller = new AbortController();
    const promise = this.write(relationId, controller.signal).finally(() => {
      if (this.running.get(relationId)?.controller === controller) this.running.delete(relationId);
    });
    this.running.set(relationId, { promise, controller });
    return promise;
  }

  /** Stops the explanation being written for a relation, if any; true when one was stopped. */
  cancel(input: unknown): boolean {
    const { relationId } = RelationExplainInputSchema.parse(input);
    const current = this.running.get(relationId);
    if (!current) return false;
    this.running.delete(relationId);
    current.controller.abort(new DOMException("The explanation was canceled.", "AbortError"));
    return true;
  }

  private async write(
    relationId: string,
    signal: AbortSignal
  ): Promise<RelationExplanationResult | null> {
    const pool = this.options.getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    const repository = createSourceRelationExplanationRepository(pool);
    const context = await repository.readContext(relationId);
    if (!context || !sourceRelationExplainable(context)) return null;
    const contentLanguage = await this.options.getContentLanguage();
    const plan = sourceRelationExplanationPlan(context, contentLanguage);
    if (context.stored && context.stored.inputHash === plan.inputHash)
      return RelationExplanationResultSchema.parse({
        relationId,
        text: context.stored.text,
        writtenBy: context.stored.model,
        writtenAt: context.stored.writtenAt.toISOString()
      });
    const prompt = buildSourceRelationExplanationPrompt({
      type: context.type,
      direction: plan.direction,
      first: {
        title: plan.first.title,
        passages: plan.first.passages.map((passage) => passage.content)
      },
      second: {
        title: plan.second.title,
        passages: plan.second.passages.map((passage) => passage.content)
      }
    });
    const logContext = {
      stage: "source_relation_explanation",
      operation: sourceRelationExplanationOperation,
      workloadClass: "write-fast" as const,
      priority: "P0" as const,
      budgetClass: "interactive" as const,
      contentLanguage,
      promptVersion: sourceRelationExplanationPromptVersion,
      sourceItemIds: [plan.first.id, plan.second.id],
      attempt: 0
    };
    const limits = { maxOutputTokens: relationExplanationLimits.maxOutputTokens };
    const ids = { first: plan.first.id, second: plan.second.id };
    // A relation closed while the context was read never starts a model call.
    signal.throwIfAborted();
    const deadline = new ActiveDeadline(relationExplanationLimits.timeoutMs, signal);
    try {
      let execution = await this.options.ai.runDefaultTask(
        "text-generation",
        prompt,
        logContext,
        deadline.signal,
        limits
      );
      if (!execution) throw new Error("errors.ai.noCompatibleModel");
      let resolved = acceptSourceRelationExplanation(execution.output, ids);
      if (resolved === null) {
        execution = await this.options.ai.runDefaultTask(
          "text-generation",
          buildSourceRelationExplanationRepairPrompt(prompt),
          { ...logContext, attempt: 1 },
          deadline.signal,
          limits
        );
        if (!execution) throw new Error("errors.ai.noCompatibleModel");
        resolved = acceptSourceRelationExplanation(execution.output, ids);
        if (resolved === null) throw new Error("notePage.explain.errors.invalid");
      }
      deadline.signal.throwIfAborted();
      const saved = await repository.save({
        relationId,
        text: resolved,
        inputHash: plan.inputHash,
        promptVersion: sourceRelationExplanationPromptVersion,
        provider: execution.providerId,
        model: execution.modelId,
        runtime: execution.runtime,
        aiTaskRunId: execution.aiTaskRunId,
        language: contentLanguage
      });
      if (!saved) return null;
      return RelationExplanationResultSchema.parse({
        relationId,
        text: resolved,
        writtenBy: execution.modelId,
        writtenAt: saved.writtenAt.toISOString()
      });
    } finally {
      deadline.dispose();
    }
  }
}
