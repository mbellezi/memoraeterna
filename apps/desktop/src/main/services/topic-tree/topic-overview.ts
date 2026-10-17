// The lazy overview of a topic (F2 T31, D16): written when its Topic page opens, from the topic's
// central notes and their passages (E1..En), cached per member fingerprint, prompt revision and
// content language. Opening the page again makes no call; a change of members marks the overview
// stale and the page offers Update. Every citation maps to the evidence and points at an exact
// chunk and span. A ranker then checks, without holding the overview back, whether the passages a
// sentence cites support it ("unchecked" when no validated ranker is routed). Writing runs at
// interactive priority, is cancelable and is not capped by D34 (only background topic AI is).
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  aiRouteKeys,
  createAiConfigRepository,
  createTopicOverviewRepository,
  type PgPool,
  type StoredTopicOverview,
  type TopicOverviewContext,
  type TopicOverviewEvidenceRow
} from "@app/db";
import {
  TopicOverviewCancelInputSchema,
  TopicOverviewInputSchema,
  TopicOverviewResultSchema,
  overviewExcerpt,
  overviewSentences,
  overviewSupportVerdict,
  selectOverviewEvidence,
  topicOverviewLimits,
  topicOverviewMessageKeys,
  validateOverviewOutput,
  type OverviewEvidenceCandidate,
  type TopicOverviewState
} from "@app/domain";

import { ActiveDeadline } from "@app/ai";
import type { AiService, AiTaskLogContext } from "../ai-service.js";
import { promptFingerprint } from "../prompt-runtime.js";
import type { TopicAiMode } from "./topic-ai.js";
import {
  buildTopicOverviewPrompt,
  buildTopicOverviewRepairPrompt,
  parseTopicOverviewOutput,
  topicOverviewOperation,
  topicOverviewPromptVersion,
  topicOverviewSupportInstruction
} from "./topic-prompts.js";

/** The ranker operation of the support check: `op:topic_overview_support`, else `class:decide`. */
export const topicOverviewSupportOperation = "topic_overview_support";

export type OverviewAi = Pick<AiService, "runDefaultTask" | "rank" | "decideRouteStatus">;

export interface TopicOverviewServiceOptions {
  getPool: () => PgPool | null;
  ai: OverviewAi;
  /** The library's content language (`pt-BR`): overviews are written in it. */
  getContentLanguage: () => Promise<string>;
  /** G1 (D23): a deterministic golden run writes no overview. */
  aiMode: TopicAiMode;
  /** Whether a writer route can serve the overview now (default: the routes stored in the database). */
  writerReady?: () => Promise<boolean>;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
}

interface Running<T> {
  promise: Promise<T>;
  controller: AbortController;
}

/** What an overview is cached for besides its members (D16). */
interface OverviewIdentity {
  language: string;
  promptRevisionId: string;
}

type EvidenceItem = TopicOverviewEvidenceRow & OverviewEvidenceCandidate;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const supportStatuses = new Set(["verified", "partial", "unchecked"]);

/** The stored support of an overview, as the contract carries it. */
function supportOf(value: Record<string, unknown>): {
  status: "verified" | "partial" | "unchecked";
  unsupported: number[];
  sentences?: { checked: number; supported: number };
} {
  const status = typeof value.status === "string" && supportStatuses.has(value.status);
  const unsupported = Array.isArray(value.unsupported)
    ? value.unsupported.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
    : [];
  const sentences = value.sentences as { checked?: unknown; supported?: unknown } | undefined;
  const counts =
    sentences && Number.isInteger(sentences.checked) && Number.isInteger(sentences.supported)
      ? { checked: sentences.checked as number, supported: sentences.supported as number }
      : null;
  return {
    status: status ? (value.status as "verified" | "partial" | "unchecked") : "unchecked",
    unsupported,
    ...(counts ? { sentences: counts } : {})
  };
}

export class TopicOverviewService {
  private readonly writes = new Map<string, Running<TopicOverviewState>>();
  private readonly checks = new Map<string, Running<void>>();
  /** The last failed writing of a topic, shown until the next attempt. */
  private readonly failures = new Map<string, string>();

  constructor(private readonly options: TopicOverviewServiceOptions) {}

  /** The overview state a Topic page shows. It never calls AI, and a failure never fails the page. */
  async state(topicId: string): Promise<TopicOverviewState> {
    if (this.writes.has(topicId)) return { status: "writing" };
    try {
      const context = await this.repository().readContext(topicId);
      if (!context) return { status: "absent", canWrite: false };
      if (this.writes.has(context.topic.id)) return { status: "writing" };
      if (context.stored) return this.ready(context, context.stored, await this.identity());
      const failure = this.failures.get(context.topic.id);
      if (failure) return { status: "failed", messageKey: failure };
      return await this.absent(context);
    } catch (error) {
      this.options.logger?.warn("The overview state of a topic could not be read", error);
      return { status: "absent", canWrite: false, reasonKey: topicOverviewMessageKeys.unavailable };
    }
  }

  /**
   * `topics.overview`: the cached overview, or one written now when there is none (`force` writes
   * a new one, the Update action). A writing in progress is joined, not repeated; while the support
   * check of the last writing runs, the call waits for its verdict. Only writing calls AI.
   */
  async overview(input: unknown): Promise<TopicOverviewState> {
    const { id, force = false } = TopicOverviewInputSchema.parse(input);
    const joined = this.writes.get(id);
    if (joined) return joined.promise;
    const checking = this.checks.get(id);
    if (checking && !force) {
      await checking.promise;
      return this.state(id);
    }
    const context = await this.repository().readContext(id);
    if (!context) throw new Error("topics.errors.notFound");
    const topicId = context.topic.id;
    const identity = await this.identity();
    const running = this.writes.get(topicId);
    if (running) return running.promise;
    if (context.stored && !force) return this.ready(context, context.stored, identity);
    const reason = await this.cannotWrite(context);
    if (reason) return { status: "absent", canWrite: false, reasonKey: reason };
    // Another request may have started the same writing while this one read.
    const started = this.writes.get(topicId);
    if (started) return started.promise;

    this.checks.get(topicId)?.controller.abort();
    this.checks.delete(topicId);
    this.failures.delete(topicId);
    const controller = new AbortController();
    const keys = [...new Set([topicId, id])];
    const promise = this.write(context, identity, controller.signal).finally(() => {
      for (const key of keys) {
        if (this.writes.get(key)?.controller === controller) this.writes.delete(key);
      }
    });
    for (const key of keys) this.writes.set(key, { promise, controller });
    return promise;
  }

  /** `topics.overview.cancel`: stops the writing (and the support check) of a topic. */
  cancel(input: unknown): boolean {
    const { id } = TopicOverviewCancelInputSchema.parse(input);
    let canceled = false;
    for (const running of [this.writes.get(id), this.checks.get(id)]) {
      if (!running) continue;
      running.controller.abort(new DOMException("The overview was canceled.", "AbortError"));
      canceled = true;
    }
    return canceled;
  }

  /** Stops everything in progress (shutdown). */
  dispose(): void {
    for (const running of [...this.writes.values(), ...this.checks.values()]) {
      running.controller.abort(new DOMException("The app is closing.", "AbortError"));
    }
  }

  /** Resolves when the support check of a topic (if any) has finished; for scripts and tests. */
  async settled(topicId: string): Promise<void> {
    await this.writes.get(topicId)?.promise.catch(() => undefined);
    await this.checks.get(topicId)?.promise;
  }

  // ----- reading

  private repository() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("topics.errors.unavailable");
    return createTopicOverviewRepository(pool);
  }

  private async identity(): Promise<OverviewIdentity> {
    return {
      language: await this.options.getContentLanguage(),
      promptRevisionId: `${topicOverviewPromptVersion}:${promptFingerprint(["topic.overview"])}`
    };
  }

  private ready(
    context: TopicOverviewContext,
    stored: StoredTopicOverview,
    identity: OverviewIdentity
  ): TopicOverviewState {
    const stale =
      stored.memberFingerprint !== context.members.fingerprint ||
      stored.language !== identity.language ||
      stored.promptRevisionId !== identity.promptRevisionId;
    return TopicOverviewResultSchema.parse({
      status: "ready",
      stale,
      paragraphs: stored.paragraphs,
      citations: stored.citations.map((citation) => ({
        n: citation.n,
        ...(citation.chunkId ? { chunkId: citation.chunkId } : {}),
        ...(citation.sourceSpanId ? { sourceSpanId: citation.sourceSpanId } : {}),
        ...(citation.noteId ? { noteId: citation.noteId } : {}),
        ...(citation.sourceId ? { sourceId: citation.sourceId } : {}),
        sourceTitle: citation.sourceTitle,
        excerpt: citation.excerpt,
        available: citation.available
      })),
      evidence: { used: stored.evidence.length, total: stored.memberCount },
      writtenAt: stored.writtenAt.toISOString(),
      model: stored.model,
      language: stored.language,
      support: this.checks.has(context.topic.id)
        ? { status: "checking", unsupported: [] }
        : supportOf(stored.support)
    });
  }

  private async absent(context: TopicOverviewContext): Promise<TopicOverviewState> {
    const reason = await this.cannotWrite(context);
    return reason
      ? { status: "absent", canWrite: false, reasonKey: reason }
      : { status: "absent", canWrite: true };
  }

  /** Why no overview can be written now, or null when one can. */
  private async cannotWrite(context: TopicOverviewContext): Promise<string | null> {
    if (this.options.aiMode !== "full") return topicOverviewMessageKeys.unavailable;
    if (context.topic.role === "root") return topicOverviewMessageKeys.root;
    if (context.members.notes === 0) return topicOverviewMessageKeys.empty;
    if (!(await this.writerReady())) return topicOverviewMessageKeys.noWriter;
    return null;
  }

  private async writerReady(): Promise<boolean> {
    try {
      if (this.options.writerReady) return await this.options.writerReady();
      const pool = this.options.getPool();
      if (!pool) return false;
      const selection = await createAiConfigRepository(pool).getDefaultTask(
        "structured-output",
        undefined,
        aiRouteKeys("structured-output", {
          operation: topicOverviewOperation,
          workloadClass: "write-fast"
        })
      );
      return selection !== null;
    } catch (error) {
      this.options.logger?.warn("The overview writer route could not be read", error);
      return false;
    }
  }

  private async rankerReady(): Promise<boolean> {
    try {
      return (await this.options.ai.decideRouteStatus(topicOverviewSupportOperation)) === "ready";
    } catch {
      return false;
    }
  }

  // ----- writing

  private async write(
    context: TopicOverviewContext,
    identity: OverviewIdentity,
    signal: AbortSignal
  ): Promise<TopicOverviewState> {
    const topicId = context.topic.id;
    const started = performance.now();
    try {
      const repository = this.repository();
      const rows = await repository.readEvidence(context.topic, {
        perTopic: topicOverviewLimits.candidatesPerTopic,
        candidates: topicOverviewLimits.maxCandidates
      });
      if (rows.length === 0) {
        return { status: "absent", canWrite: false, reasonKey: topicOverviewMessageKeys.empty };
      }
      const candidates: EvidenceItem[] = rows.map((row) => ({
        ...row,
        contentKey: sha256(`${row.title}\n${row.idea}\n${row.passage}`)
      }));
      const { evidence } = selectOverviewEvidence(candidates);
      if (evidence.length === 0) return this.fail(topicId, topicOverviewMessageKeys.tooLarge);
      const prompt = buildTopicOverviewPrompt({
        contentLanguage: identity.language,
        topic: { title: context.topic.title, description: context.topic.description },
        evidence: evidence.map((item) => ({
          title: item.title,
          idea: item.idea,
          source: item.sourceTitle,
          passage: item.passage
        }))
      });
      const sourceItemIds = [...new Set(evidence.map((item) => item.sourceId))].sort();
      const logContext: AiTaskLogContext = {
        stage: "topic_overview",
        operation: topicOverviewOperation,
        workloadClass: "write-fast",
        priority: "P0",
        contentLanguage: identity.language,
        promptVersion: topicOverviewPromptVersion,
        attempt: 0,
        sourceItemIds,
        chunkIds: evidence.map((item) => item.chunkId)
      };
      const limits = { maxOutputTokens: topicOverviewLimits.maxOutputTokens };
      // A page closed (or a writing canceled) while the evidence was read never calls the model.
      signal.throwIfAborted();
      const deadline = new ActiveDeadline(topicOverviewLimits.timeoutMs, signal);
      try {
        let execution = await this.options.ai.runDefaultTask(
          "structured-output",
          prompt,
          logContext,
          deadline.signal,
          limits
        );
        if (!execution) {
          return {
            status: "absent",
            canWrite: false,
            reasonKey: topicOverviewMessageKeys.noWriter
          };
        }
        let validation = validateOverviewOutput(
          parseTopicOverviewOutput(execution.output),
          evidence.length
        );
        let calls = 1;
        if (!validation.ok) {
          calls += 1;
          execution = await this.options.ai.runDefaultTask(
            "structured-output",
            buildTopicOverviewRepairPrompt(prompt, validation.errors.join("\n")),
            { ...logContext, attempt: 1 },
            deadline.signal,
            limits
          );
          if (!execution) {
            return {
              status: "absent",
              canWrite: false,
              reasonKey: topicOverviewMessageKeys.noWriter
            };
          }
          validation = validateOverviewOutput(
            parseTopicOverviewOutput(execution.output),
            evidence.length
          );
          if (!validation.ok) return this.fail(topicId, topicOverviewMessageKeys.invalid);
        }
        deadline.signal.throwIfAborted();
        const overview = validation.overview;
        const cited = overview.cited.map((number) => evidence[number - 1] as EvidenceItem);
        const ranker = await this.rankerReady();
        const saved = await repository.save({
          topicId,
          paragraphs: overview.paragraphs,
          evidence: evidence.map((item) => ({
            noteId: item.noteId,
            chunkId: item.chunkId,
            sourceSpanId: item.sourceSpanId,
            sourceId: item.sourceId,
            contentHash: sha256(item.passage)
          })),
          memberFingerprint: context.members.fingerprint,
          memberCount: context.members.notes,
          inputHash: sha256(prompt),
          promptRevisionId: identity.promptRevisionId,
          provider: execution.providerId,
          model: execution.modelId,
          runtime: execution.runtime,
          aiTaskRunId: execution.aiTaskRunId,
          language: identity.language,
          support: { status: "unchecked", unsupported: [] },
          citations: cited.map((item, index) => ({
            n: index + 1,
            chunkId: item.chunkId,
            sourceSpanId: item.sourceSpanId,
            noteId: item.noteId,
            excerpt: overviewExcerpt(item.passage),
            excerptHash: sha256(item.passage)
          }))
        });
        if (!saved) {
          return {
            status: "absent",
            canWrite: false,
            reasonKey: topicOverviewMessageKeys.unavailable
          };
        }
        if (ranker) {
          this.startCheck(topicId, saved.writtenAtExact, overview.paragraphs, cited, sourceItemIds);
        }
        // Read back as a page reads it: source titles, availability and the members of now.
        const fresh = await repository.readContext(topicId);
        if (!fresh?.stored) {
          return {
            status: "absent",
            canWrite: false,
            reasonKey: topicOverviewMessageKeys.unavailable
          };
        }
        // The time to display the overview, for the measurement (T31): ids and counts only.
        this.options.logger?.info(
          `Topic overview ${topicId} written in ${Math.round(performance.now() - started)} ms: ` +
            `${calls} writer call(s), ${evidence.length} of ${rows.length} candidates, ` +
            `${cited.length} citations, support ${ranker ? "checking" : "unchecked"}`
        );
        return this.ready(fresh, fresh.stored, identity);
      } finally {
        deadline.dispose();
      }
    } catch (error) {
      if (signal.aborted) {
        return { status: "absent", canWrite: true, reasonKey: topicOverviewMessageKeys.canceled };
      }
      const timeout = error instanceof DOMException && error.name === "TimeoutError";
      this.options.logger?.warn("A topic overview could not be written", error);
      return this.fail(
        topicId,
        timeout ? topicOverviewMessageKeys.timeout : topicOverviewMessageKeys.failed
      );
    }
  }

  private fail(topicId: string, messageKey: string): TopicOverviewState {
    this.failures.set(topicId, messageKey);
    return { status: "failed", messageKey };
  }

  // ----- the support check

  private startCheck(
    topicId: string,
    writtenAtExact: string,
    paragraphs: ReadonlyArray<{ text: string; citations: number[] }>,
    cited: readonly EvidenceItem[],
    sourceIds: string[]
  ): void {
    const controller = new AbortController();
    const promise = this.check(
      topicId,
      writtenAtExact,
      paragraphs,
      cited,
      sourceIds,
      controller.signal
    )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          this.options.logger?.warn("The support check of a topic overview failed", error);
        }
      })
      .finally(() => {
        if (this.checks.get(topicId)?.controller === controller) this.checks.delete(topicId);
      });
    this.checks.set(topicId, { promise, controller });
  }

  /**
   * Scores every sentence against the passages it cites (one ranker call each) and stores the
   * verdict for this writing only. A failure leaves the overview "unchecked".
   */
  private async check(
    topicId: string,
    writtenAtExact: string,
    paragraphs: ReadonlyArray<{ text: string; citations: number[] }>,
    cited: readonly EvidenceItem[],
    sourceIds: string[],
    signal: AbortSignal
  ): Promise<void> {
    const all = overviewSentences(paragraphs);
    const sentences = all.slice(0, topicOverviewLimits.maxSupportSentences);
    if (sentences.length === 0) return;
    const instruction = topicOverviewSupportInstruction();
    const best: number[] = [];
    const runIds: string[] = [];
    let model: string | null = null;
    let truncated = 0;
    for (const sentence of sentences) {
      signal.throwIfAborted();
      const documents = sentence.citations
        .slice(0, topicOverviewLimits.maxSupportDocuments)
        .map((n) => cited[n - 1]?.passage)
        .filter((passage): passage is string => typeof passage === "string");
      if (documents.length === 0) {
        best.push(0);
        continue;
      }
      const result = await this.options.ai.rank(
        {
          operation: topicOverviewSupportOperation,
          instruction,
          query: sentence.text,
          documents,
          priority: "P0",
          sourceIds,
          stage: "topic_overview_support"
        },
        signal
      );
      best.push(Math.max(...result.scores));
      runIds.push(result.aiTaskRunId);
      truncated += result.truncated.filter(Boolean).length;
      model = result.modelId;
    }
    const verdict = overviewSupportVerdict(sentences, best);
    const support = {
      ...verdict,
      // Sentences past the cap were not checked: the overview is then only partly verified.
      status: all.length > sentences.length ? "partial" : verdict.status,
      model,
      aiTaskRunIds: runIds.slice(0, 40),
      truncated,
      checkedAt: (this.options.now?.() ?? new Date()).toISOString()
    };
    signal.throwIfAborted();
    const stored = await this.repository().saveSupport({ topicId, writtenAtExact, support });
    if (stored) {
      this.options.logger?.info(
        `Topic overview ${topicId} support ${support.status}: ` +
          `${verdict.sentences.supported} of ${verdict.sentences.checked} sentences supported`
      );
    }
  }
}
