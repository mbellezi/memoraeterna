import {
  createRelationExplanationRepository,
  relationExplanationIsCurrent,
  relationExplanationPlan,
  type PgPool,
  type RelationExplanationContext,
  type RelationExplanationWriter
} from "@app/db";
import {
  RelationExplainInputSchema,
  RelationExplanationResultSchema,
  relationExplanationLimits,
  type RelationExplainOutcome,
  type RelationVetoResult
} from "@app/domain";

import { ActiveDeadline, type AiTextDelta } from "@app/ai";
import type { AiService } from "./ai-service.js";
import { relationExplanationOperation } from "./ai-task-parameters.js";
import {
  acceptRelationExplanation,
  buildRelationExplanationPrompt,
  buildRelationExplanationRepairPrompt,
  isNotRelatedAnswer,
  relationExplanationPromptVersion
} from "./relation-explanation.js";
import { DeltaCoalescer, RelationExplanationStream } from "./relation-explanation-stream.js";
import { withdrawRelationAsExplainer } from "./relation-explanation-writer.js";

export interface RelationExplanationServiceOptions {
  getPool: () => PgPool | null;
  ai: Pick<AiService, "runDefaultTask">;
  /** The content language explanations are written in. */
  getContentLanguage: () => Promise<string>;
  /**
   * Who writes an explanation now (the effective prompt and the writer model); null without a
   * writer model. The cache key includes it (F3 D22): another prompt revision or model is another
   * explanation. Absent, the key holds the facts alone.
   */
  resolveWriter?: () => Promise<RelationExplanationWriter | null>;
  /**
   * Withdraws a relation the writer found unrelated (and promotes the source relations built from
   * it again, for the roots of `homeSourceIds`); the notes whose pages changed, or null.
   */
  withdraw?: (
    pool: PgPool,
    relationId: string,
    homeSourceIds: readonly string[]
  ) => Promise<{ noteIds: string[] } | null>;
  /** After a veto: the notes whose relations changed, so open pages read them again. */
  relationsChanged?: (noteIds: string[]) => void;
  /** Source of the coalescing window; tests inject a fake clock. */
  clock?: ConstructorParameters<typeof DeltaCoalescer>[2];
}

/** Receives the explanation as it is written: the whole text so far, with note references. */
export type RelationExplanationListener = (text: string) => void;

interface Running {
  promise: Promise<RelationExplainOutcome | null>;
  controller: AbortController;
  /** The cards waiting for this relation: each sees the text streamed so far, then the rest. */
  listeners: Set<RelationExplanationListener>;
  /** The last text the writer streamed, for a card that joins the request late. */
  text: string | null;
}

const unavailableStatuses = new Set(["rejected", "archived"]);

/**
 * Explanations of note relations, written on demand (docs/plan.md decision 16). Only an owner who
 * opens a relation asks for one: nothing here runs in bulk or in the background. The writer route
 * (`text-generation`, never the decision route) writes it at interactive priority and streams it
 * (F3 D22); it is cached on the relation for the inputs it was written from, so opening the relation
 * again reuses it, with no call and no stream, until either note's idea or evidence, the type, the
 * direction, the content language, the prompt revision or the writer model changes. One request per
 * relation runs at a time, and closing the card cancels it: nothing partial is cached. An
 * explanation is a derived annotation: it changes neither note, so human-protected notes are
 * explained like any other.
 *
 * A writer that answers the sentinel found the notes unrelated: the relation is withdrawn (vetoed)
 * until the owner keeps or removes it, unless a human already decided it.
 */
export class RelationExplanationService {
  private readonly running = new Map<string, Running>();

  constructor(private readonly options: RelationExplanationServiceOptions) {}

  /**
   * The current explanation of a relation, written now when there is none; the veto when the writer
   * found the notes unrelated; null when the relation is gone. `onText` receives the text as it is
   * written: it is a preview that the returned, validated text replaces.
   */
  explain(
    input: unknown,
    onText?: RelationExplanationListener
  ): Promise<RelationExplainOutcome | null> {
    const { relationId } = RelationExplainInputSchema.parse(input);
    const current = this.running.get(relationId);
    if (current) {
      if (onText) {
        current.listeners.add(onText);
        if (current.text !== null) onText(current.text);
      }
      return current.promise;
    }
    const controller = new AbortController();
    const run: Running = {
      controller,
      listeners: new Set(onText ? [onText] : []),
      text: null,
      promise: Promise.resolve(null)
    };
    run.promise = this.write(relationId, run).finally(() => {
      if (this.running.get(relationId) === run) this.running.delete(relationId);
    });
    this.running.set(relationId, run);
    return run.promise;
  }

  /** Stops the explanation being written for a relation, if any; true when one was stopped. */
  cancel(input: unknown): boolean {
    const { relationId } = RelationExplainInputSchema.parse(input);
    const current = this.running.get(relationId);
    if (!current) return false;
    this.running.delete(relationId);
    current.listeners.clear();
    current.controller.abort(new DOMException("The explanation was canceled.", "AbortError"));
    return true;
  }

  private async write(relationId: string, run: Running): Promise<RelationExplainOutcome | null> {
    const signal = run.controller.signal;
    const pool = this.options.getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    const repository = createRelationExplanationRepository(pool);
    const context = await repository.readContext(relationId);
    if (!context || !explainable(context)) return null;
    // A relation the writer already withdrew stays withdrawn: its verdict is the answer, with no
    // call, until the owner keeps or removes it.
    if (context.withdrawn && context.vetoSource === "explainer") return vetoed(relationId);
    const contentLanguage = await this.options.getContentLanguage();
    const writer = this.options.resolveWriter ? await this.options.resolveWriter() : undefined;
    const plan = relationExplanationPlan({ ...context, language: contentLanguage, writer });
    if (context.stored && relationExplanationIsCurrent(context.stored.inputHash, plan))
      return RelationExplanationResultSchema.parse({
        relationId,
        text: context.stored.text,
        writtenBy: context.stored.model,
        writtenAt: context.stored.writtenAt.toISOString()
      });
    // Without a writer model nothing can be written (an explanation of the same facts, whoever
    // wrote it, was returned above).
    if (writer === null) throw new Error("errors.ai.noCompatibleModel");
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
      workloadClass: "write-fast" as const,
      priority: "P0" as const,
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
    // A preview that cannot be delivered (a closed window) never stops the explanation.
    const publish = (text: string) => {
      run.text = text;
      for (const listener of run.listeners) {
        try {
          listener(text);
        } catch {
          run.listeners.delete(listener);
        }
      }
    };
    const preview = new RelationExplanationStream(ids);
    const coalescer = new DeltaCoalescer(
      publish,
      relationExplanationLimits.streamCoalesceMs,
      this.options.clock
    );
    const onTextDelta = (event: AiTextDelta) => {
      preview.push(event.delta, event.restart);
      const text = preview.visible();
      if (text !== null) coalescer.update(text);
    };
    try {
      // The first call streams its text; the repair does not (the text it writes replaces the
      // streamed one when the final text is returned).
      let execution = await this.options.ai.runDefaultTask(
        "text-generation",
        prompt,
        { ...logContext, onTextDelta },
        deadline.signal,
        limits
      );
      if (!execution) throw new Error("errors.ai.noCompatibleModel");
      let unrelated = isNotRelatedAnswer(execution.output);
      let resolved = unrelated ? null : acceptRelationExplanation(execution.output, ids);
      if (!unrelated && resolved === null) {
        // The streamed text is refused: the card goes back to writing while the repair runs.
        preview.clear();
        const cleared = preview.visible();
        if (cleared !== null) coalescer.update(cleared);
        coalescer.flush();
        execution = await this.options.ai.runDefaultTask(
          "text-generation",
          buildRelationExplanationRepairPrompt(prompt),
          { ...logContext, attempt: 1 },
          deadline.signal,
          limits
        );
        if (!execution) throw new Error("errors.ai.noCompatibleModel");
        unrelated = isNotRelatedAnswer(execution.output);
        resolved = unrelated ? null : acceptRelationExplanation(execution.output, ids);
        if (!unrelated && resolved === null) throw new Error("notePage.explain.errors.invalid");
      }
      deadline.signal.throwIfAborted();
      if (unrelated || resolved === null) return await this.withdraw(pool, context);
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
      coalescer.dispose();
      deadline.dispose();
    }
  }

  /**
   * The writer found the notes unrelated. A relation nobody decided is withdrawn (hidden everywhere
   * until the owner keeps or removes it); one that is already withdrawn stays so; one with a human
   * verdict is final, and nothing is explained.
   */
  private async withdraw(
    pool: PgPool,
    context: RelationExplanationContext
  ): Promise<RelationVetoResult | null> {
    if (context.withdrawn) return vetoed(context.relationId);
    if (!context.vetoable) return null;
    const homeSourceIds = [context.a.homeSourceId, context.b.homeSourceId].filter(
      (id): id is string => id !== null
    );
    const written = await (this.options.withdraw ?? withdrawRelationAsExplainer)(
      pool,
      context.relationId,
      homeSourceIds
    );
    if (written) {
      this.options.relationsChanged?.(written.noteIds);
      return vetoed(context.relationId);
    }
    // Withdrawn or decided by someone else while the writer was answering: ask what it is now.
    const now = await createRelationExplanationRepository(pool).readContext(context.relationId);
    return now?.withdrawn ? vetoed(context.relationId) : null;
  }
}

function vetoed(relationId: string): RelationVetoResult {
  return { relationId, vetoed: true };
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
