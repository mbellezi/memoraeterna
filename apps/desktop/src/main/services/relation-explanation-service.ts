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
  isRelationUnrelated,
  isRelationVeto,
  relationExplanationLimits,
  relationExplanationSentinel,
  type RelationExplainOutcome,
  type RelationUnrelatedResult,
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
  /**
   * The cards waiting for this relation, by the ID of their request (a symbol when the caller gave
   * none): each sees the text streamed so far, then the rest.
   */
  waiters: Map<string | symbol, RelationExplanationListener | null>;
  /** The last text the writer streamed, for a card that joins the request late. */
  text: string | null;
  /** The backfill's writing (F4 D18): a card joins it, but closing the card never stops it. */
  background: boolean;
}

/**
 * Who an explanation is written for: the owner who opened the relation (P0, streamed) or the
 * backfill's job (P3, background, through the RemoteBudget; F4 D18).
 */
interface ExplanationCall {
  priority: "P0" | "P3";
  budgetClass: "interactive" | "background";
  jobId: string | null;
}

const openCall: ExplanationCall = { priority: "P0", budgetClass: "interactive", jobId: null };

/**
 * What the backfill's writing of one relation did: `written` (an explanation is cached now),
 * `current` (one was cached already, or a card was writing it), `vetoed` (the writer found the notes
 * unrelated and the relation is withdrawn, for the owner to keep or remove), `unrelated` (the writer
 * disagreed with a relation that stays), `gone` (nothing to explain: removed or not listed) or
 * `no_writer`.
 */
export type RelationBackfillOutcome =
  "written" | "current" | "vetoed" | "unrelated" | "gone" | "no_writer";

const unavailableStatuses = new Set(["rejected", "archived"]);

/**
 * Explanations of note relations, written when the owner opens a relation (docs/plan.md decision
 * 16) or by the Gardener's bounded backfill (F4 D18, `relations/relation-explain-backfill.ts`),
 * one relation per job, at P3 through the RemoteBudget. The writer route (`text-generation`, never
 * the decision route) writes an opened one at interactive priority and streams it (F3 D22); it is
 * cached on the relation for the inputs it was written from, so opening the relation again reuses
 * it, with no call and no stream, until either note's idea or evidence, the type, the direction,
 * the content language, the prompt revision or the writer model changes. One request per relation
 * runs at a time, a card joins the backfill's, and closing the card cancels its own: nothing
 * partial is cached. An explanation is a derived annotation: it changes neither note, so
 * human-protected notes are explained like any other.
 *
 * A writer that answers the sentinel found the notes unrelated. The verdict is cached under the same
 * key as an explanation (a row whose text is the sentinel), so opening the relation again asks
 * nobody. A relation nobody decided is withdrawn (vetoed) until the owner keeps or removes it; one
 * that is already withdrawn stays so; one that cannot be withdrawn (a human verdict is final, and a
 * relation to an earlier version of a note would be listed nowhere) stays as it is, and the card
 * says no explanation is available.
 */
export class RelationExplanationService {
  private readonly running = new Map<string, Running>();

  constructor(private readonly options: RelationExplanationServiceOptions) {}

  /**
   * The current explanation of a relation, written now when there is none; the veto when the writer
   * found the notes unrelated; the writer's disagreement when the relation stays; null when the
   * relation is gone. `onText` receives the text as it is written: it is a preview that the
   * returned, validated text replaces.
   */
  explain(
    input: unknown,
    onText?: RelationExplanationListener
  ): Promise<RelationExplainOutcome | null> {
    const { relationId, requestId } = RelationExplainInputSchema.parse(input);
    const waiter = requestId ?? Symbol("explain");
    const current = this.running.get(relationId);
    if (current) {
      current.waiters.set(waiter, onText ?? null);
      if (onText && current.text !== null) onText(current.text);
      return current.promise;
    }
    const controller = new AbortController();
    const run: Running = {
      controller,
      waiters: new Map([[waiter, onText ?? null]]),
      text: null,
      promise: Promise.resolve(null),
      background: false
    };
    run.promise = this.write(relationId, run, openCall).finally(() => {
      if (this.running.get(relationId) === run) this.running.delete(relationId);
    });
    this.running.set(relationId, run);
    return run.promise;
  }

  /**
   * Stops the explanation being written for a relation, if any; true when one was stopped. With the
   * ID of a request, only that card stops waiting: the request goes on while another card waits for
   * it, and a request that is not waiting changes nothing. The backfill's writing is its job's: a
   * card only stops waiting for it.
   */
  cancel(input: unknown): boolean {
    const { relationId, requestId } = RelationExplainInputSchema.parse(input);
    const current = this.running.get(relationId);
    if (!current) return false;
    if (requestId !== undefined) {
      if (!current.waiters.delete(requestId)) return false;
      if (current.waiters.size > 0 || current.background) return true;
    }
    if (current.background) {
      const waited = current.waiters.size > 0;
      current.waiters.clear();
      return waited;
    }
    this.running.delete(relationId);
    current.waiters.clear();
    current.controller.abort(new DOMException("The explanation was canceled.", "AbortError"));
    return true;
  }

  /**
   * The backfill of one relation (F4 D18), for its job: at P3, as background work of the job (the
   * RemoteBudget and the Gardener's gates hold it), never streamed. A card opened meanwhile joins
   * it; a card's writing in progress is joined instead. A writer that finds the notes unrelated
   * withdraws the relation exactly as on open, and the withdrawn relation waits in the Inbox for the
   * owner to keep or remove it. A failed call throws, for the job to retry.
   */
  async backfill(
    relationId: string,
    options: { jobId: string; signal: AbortSignal }
  ): Promise<RelationBackfillOutcome> {
    const current = this.running.get(relationId);
    if (current) {
      const joined = await current.promise.then(
        (value) => ({ ended: true as const, value }),
        () => ({ ended: false as const })
      );
      if (joined.ended) return joined.value === null ? "gone" : "current";
      // The card's writing stopped (closed or failed) and a new one may have started meanwhile.
      if (this.running.has(relationId)) return this.backfill(relationId, options);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    const run: Running = {
      controller,
      waiters: new Map(),
      text: null,
      promise: Promise.resolve(null),
      background: true
    };
    const wrote = { value: false };
    const call: ExplanationCall = {
      priority: "P3",
      budgetClass: "background",
      jobId: options.jobId
    };
    run.promise = this.write(relationId, run, call, wrote).finally(() => {
      options.signal.removeEventListener("abort", abort);
      if (this.running.get(relationId) === run) this.running.delete(relationId);
    });
    this.running.set(relationId, run);
    let result: RelationExplainOutcome | null;
    try {
      result = await run.promise;
    } catch (error) {
      if (error instanceof Error && error.message === "errors.ai.noCompatibleModel")
        return "no_writer";
      throw error;
    }
    if (result === null) return "gone";
    if (isRelationVeto(result)) return "vetoed";
    if (isRelationUnrelated(result)) return "unrelated";
    return wrote.value ? "written" : "current";
  }

  private async write(
    relationId: string,
    run: Running,
    call: ExplanationCall,
    wrote: { value: boolean } = { value: false }
  ): Promise<RelationExplainOutcome | null> {
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
    if (context.stored && relationExplanationIsCurrent(context.stored.inputHash, plan)) {
      // The writer's verdict for these inputs, cached: applied again with no call.
      if (context.stored.text === relationExplanationSentinel) return this.settle(pool, context);
      return RelationExplanationResultSchema.parse({
        relationId,
        text: context.stored.text,
        writtenBy: context.stored.model,
        writtenAt: context.stored.writtenAt.toISOString()
      });
    }
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
      stage: run.background ? "relation_explanation_backfill" : "relation_explanation",
      operation: relationExplanationOperation,
      workloadClass: "write-fast" as const,
      priority: call.priority,
      budgetClass: call.budgetClass,
      ...(call.jobId ? { jobId: call.jobId } : {}),
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
      for (const [waiter, listener] of [...run.waiters]) {
        try {
          listener?.(text);
        } catch {
          run.waiters.delete(waiter);
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
      // The first call streams its text to the cards (the backfill's streams to none); the repair
      // does not (the text it writes replaces the streamed one when the final text is returned).
      let execution = await this.options.ai.runDefaultTask(
        "text-generation",
        prompt,
        { ...logContext, ...(run.background ? {} : { onTextDelta }) },
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
      const provenance = {
        inputHash: plan.inputHash,
        promptVersion: relationExplanationPromptVersion,
        provider: execution.providerId,
        model: execution.modelId,
        runtime: execution.runtime,
        aiTaskRunId: execution.aiTaskRunId,
        language: contentLanguage
      };
      if (unrelated || resolved === null) {
        // Cache the verdict under the key of these inputs, so the next open asks nobody, then apply
        // it. Saved first: a verdict that was cached but not applied is applied by the next open.
        const verdict = await repository.save({
          relationId,
          text: relationExplanationSentinel,
          ...provenance
        });
        wrote.value = verdict !== null;
        return verdict ? await this.settle(pool, context) : null;
      }
      const saved = await repository.save({
        relationId,
        text: resolved,
        ...provenance
      });
      if (!saved) return null;
      wrote.value = true;
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
   * Applies the writer's verdict that the notes are unrelated. A relation nobody decided is withdrawn
   * (hidden everywhere until the owner keeps or removes it); one that is already withdrawn stays
   * so; one that cannot be withdrawn stays as it is: a human verdict is final, and nothing is
   * explained. `context` was read when the request started, so the answer for a relation that was
   * withdrawn then is read again: the owner may have kept it while the explanation was written.
   */
  private async settle(
    pool: PgPool,
    context: RelationExplanationContext
  ): Promise<RelationVetoResult | RelationUnrelatedResult | null> {
    if (context.withdrawn) return this.standing(pool, context.relationId);
    if (!context.vetoable) return unrelatedOutcome(context.relationId);
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
    // Withdrawn or decided by someone else while the writer was answering.
    return this.standing(pool, context.relationId);
  }

  /** The answer for a relation that the writer found unrelated, from what it is now. */
  private async standing(
    pool: PgPool,
    relationId: string
  ): Promise<RelationVetoResult | RelationUnrelatedResult | null> {
    const now = await createRelationExplanationRepository(pool).readContext(relationId);
    if (!now || !explainable(now)) return null;
    return now.withdrawn ? vetoed(relationId) : unrelatedOutcome(relationId);
  }
}

function vetoed(relationId: string): RelationVetoResult {
  return { relationId, vetoed: true };
}

function unrelatedOutcome(relationId: string): RelationUnrelatedResult {
  return { relationId, unrelated: true };
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
