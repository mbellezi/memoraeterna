import {
  createRelationExplanationRepository,
  relationExplanationPlan,
  type PgPool,
  type RelationExplanationContext
} from "@app/db";
import {
  RelationExplainInputSchema,
  RelationExplanationResultSchema,
  relationExplanationLimits,
  type RelationExplanationResult
} from "@app/domain";

import { ActiveDeadline } from "./ai-execution-queue.js";
import type { AiService } from "./ai-service.js";
import { relationExplanationOperation } from "./ai-task-parameters.js";
import {
  acceptRelationExplanation,
  buildRelationExplanationPrompt,
  buildRelationExplanationRepairPrompt,
  relationExplanationPromptVersion
} from "./relation-explanation.js";

export interface RelationExplanationServiceOptions {
  getPool: () => PgPool | null;
  ai: Pick<AiService, "runDefaultTask">;
  /** The content language explanations are written in. */
  getContentLanguage: () => Promise<string>;
}

const unavailableStatuses = new Set(["rejected", "archived"]);

/**
 * Explanations of note relations, written on demand (docs/plan.md decision 16). Only an owner who
 * opens a relation asks for one: nothing here runs in bulk or in the background. The writer route
 * (`text-generation`, never the decision route) writes it at interactive priority; it is cached on
 * the relation for the inputs it was written from, so opening the relation again reuses it until
 * either note's idea or evidence, the type, the direction or the content language changes. One
 * request per relation runs at a time, and closing the card cancels it. An explanation is a derived
 * annotation: it changes neither note, so human-protected notes are explained like any other.
 */
export class RelationExplanationService {
  private readonly running = new Map<
    string,
    { promise: Promise<RelationExplanationResult | null>; controller: AbortController }
  >();

  constructor(private readonly options: RelationExplanationServiceOptions) {}

  /** The current explanation of a relation, written now when there is none; null when it is gone. */
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
    const repository = createRelationExplanationRepository(pool);
    const context = await repository.readContext(relationId);
    if (!context || !explainable(context)) return null;
    const contentLanguage = await this.options.getContentLanguage();
    const plan = relationExplanationPlan({ ...context, language: contentLanguage });
    if (context.stored && context.stored.inputHash === plan.inputHash)
      return RelationExplanationResultSchema.parse({
        relationId,
        text: context.stored.text,
        writtenBy: context.stored.model,
        writtenAt: context.stored.writtenAt.toISOString()
      });
    const prompt = buildRelationExplanationPrompt({
      type: context.type,
      direction: plan.direction,
      first: {
        ideaStatement: plan.first.ideaStatement,
        passage: plan.first.passage?.content ?? null
      },
      second: {
        ideaStatement: plan.second.ideaStatement,
        passage: plan.second.passage?.content ?? null
      }
    });
    const logContext = {
      stage: "relation_explanation",
      operation: relationExplanationOperation,
      priority: "interactive" as const,
      contentLanguage,
      promptVersion: relationExplanationPromptVersion,
      // Only sources that still exist: a knowledge note outlives its home source, and the audit of
      // the run links its sources by foreign key.
      sourceItemIds: [
        ...new Set(
          [plan.first.homeSourceId, plan.second.homeSourceId].filter(
            (id): id is string => id !== null
          )
        )
      ],
      attempt: 0
    };
    const limits = { maxOutputTokens: relationExplanationLimits.maxOutputTokens };
    const ids = { first: plan.first.id, second: plan.second.id };
    // A card closed while the context was read never starts a model call.
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
      let resolved = acceptRelationExplanation(execution.output, ids);
      if (resolved === null) {
        execution = await this.options.ai.runDefaultTask(
          "text-generation",
          buildRelationExplanationRepairPrompt(prompt),
          { ...logContext, attempt: 1 },
          deadline.signal,
          limits
        );
        if (!execution) throw new Error("errors.ai.noCompatibleModel");
        resolved = acceptRelationExplanation(execution.output, ids);
        if (resolved === null) throw new Error("notePage.explain.errors.invalid");
      }
      deadline.signal.throwIfAborted();
      const saved = await repository.save({
        relationId,
        text: resolved,
        inputHash: plan.inputHash,
        promptVersion: relationExplanationPromptVersion,
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

/**
 * Only a relation the Note page lists is explained (relations v2 visibility, D9): never a removed
 * one, or one to a discarded or archived note.
 */
function explainable(context: RelationExplanationContext): boolean {
  return (
    context.listed &&
    !unavailableStatuses.has(context.a.status) &&
    !unavailableStatuses.has(context.b.status)
  );
}
