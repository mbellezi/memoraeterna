// The overview of a topic (F2 T31, D16; F4 D17, T84): written when its Topic page opens, from the
// topic's central notes and their passages (E1..En), cached per member fingerprint (the prompt and
// the content language are provenance, F4 D9). Opening the page again makes no call. When the
// members change the overview is stale, and REFRESH keeps it current with an additive patch: the
// stored paragraphs stay byte-identical, new paragraphs cite only new evidence (numbered after the
// stored citations) and a contradiction is kept beside the prose as a Divergence, never an edit. A
// page that opens a stale overview runs the same patch at P0, or joins the one REFRESH is writing;
// REFRESH runs it at P3 as a background job (`topic-overview-job.ts`). Every write keeps the text it
// replaces as a change-set that can be undone. Every citation maps to the evidence and points at an
// exact chunk and span. A ranker then checks, without holding the overview back on a page, whether
// the passages a sentence cites support it, at the priority of the write that made the sentence.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  aiRouteKeys,
  createAiConfigRepository,
  createTopicOverviewRepository,
  type PgPool,
  type SaveTopicOverviewInput,
  type StoredTopicOverview,
  type TopicOverviewContext,
  type TopicOverviewEvidenceRow
} from "@app/db";
import {
  TopicOverviewCancelInputSchema,
  TopicOverviewInputSchema,
  TopicOverviewResultSchema,
  changeDisposition,
  overviewExcerpt,
  overviewPatchParagraphsMax,
  overviewSentences,
  overviewSupportVerdict,
  patchedOverviewSupport,
  selectOverviewEvidence,
  selectPatchEvidence,
  topicOverviewLimits,
  topicOverviewMessageKeys,
  topicOverviewRefreshConfig,
  topicReadLimits,
  validateOverviewOutput,
  validateOverviewPatch,
  type ChangeSetRisk,
  type GardenerAutonomy,
  type OverviewDivergence,
  type OverviewSentence,
  type OverviewSupportSummary,
  type OverviewSupportVerdict,
  type PatchEvidenceCandidate,
  type TopicOverviewRefreshConfig,
  type TopicOverviewState
} from "@app/domain";
import { changeSetRisk, defaultTopicTreeConfig } from "@app/domain/topic-tree";

import { ActiveDeadline } from "@app/ai";
import type { AiService, AiTaskLogContext } from "../ai-service.js";
import { publishObjectKindChanged } from "../object-events.js";
import { promptFingerprint } from "../prompt-runtime.js";
import type { TopicAiMode } from "./topic-ai.js";
import {
  buildTopicOverviewPatchPrompt,
  buildTopicOverviewPrompt,
  buildTopicOverviewRepairPrompt,
  parseTopicOverviewOutput,
  topicOverviewOperation,
  topicOverviewOutputContract,
  topicOverviewPatchOutputContract,
  topicOverviewPatchPromptVersion,
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
  /** REFRESH's typed configuration (default: the start values). */
  refreshConfig?: TopicOverviewRefreshConfig;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
}

/**
 * Who a write is for (F4 D17, M7): the page, at P0 while the owner waits, or REFRESH, at P3 as
 * background work of its job. The support check runs at the same priority as the write.
 */
interface OverviewCall {
  priority: "P0" | "P3";
  budgetClass: "interactive" | "background";
  jobId: string | null;
}

const pageCall: OverviewCall = { priority: "P0", budgetClass: "interactive", jobId: null };

interface Running<T> {
  promise: Promise<T>;
  controller: AbortController;
  /** REFRESH's write: a page joins it, but the page's Cancel never stops it (its job does). */
  background?: boolean;
}

/** What an overview is written in besides its members (provenance, never staleness: F4 D9). */
interface OverviewIdentity {
  language: string;
}

type EvidenceItem = TopicOverviewEvidenceRow & PatchEvidenceCandidate;

type WriterExecution = NonNullable<Awaited<ReturnType<OverviewAi["runDefaultTask"]>>>;

type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * What REFRESH did (its job's `result.status`, spec 3.1b): `applied` and `pending_review` changed
 * the overview or proposed a change; `no_change` found nothing to add; `current` found it current;
 * `deferred` met a newer version (queued again); `no_route` has no writer; `invalid` got no valid
 * answer after the repair; `stale` the topic is gone; `too_few_items` and `not_due` are not REFRESH's.
 */
export const overviewRefreshStatuses = [
  "applied",
  "pending_review",
  "no_change",
  "current",
  "deferred",
  "no_route",
  "invalid",
  "stale",
  "too_few_items",
  "not_due"
] as const;
export type OverviewRefreshStatus = (typeof overviewRefreshStatuses)[number];

export interface OverviewRefreshResult {
  status: OverviewRefreshStatus;
  /** How the text changed: a patch, a first write, or a rewrite proposal of a full topic. */
  origin?: "patch" | "write" | "rewrite";
  /** Paragraphs and Divergences the change added. */
  paragraphs?: number;
  divergences?: number;
  /** The new evidence the writer was given. */
  evidence?: number;
  version?: number;
  changeSetId?: string | null;
  proposalId?: string;
  risk?: ChangeSetRisk;
}

/** The content a write stores, with what its support check needs. */
interface Composed {
  content: SaveTopicOverviewInput;
  /** Paragraphs of the stored text before it (0 for a full write). */
  previousParagraphs: number;
  /** The previous support verdict a patch builds on; null for a full write. */
  previousSupport: OverviewSupportSummary | null;
  /** The passage citation n stands for, for the support check. */
  passages: Map<number, string>;
  sourceIds: string[];
  newDivergences: OverviewDivergence[];
  addedParagraphs: number;
  evidenceCount: number;
  candidateCount: number;
  calls: number;
}

/** Why nothing was composed. `nothing`: a patch found nothing to add (the overview is current). */
type ComposeOutcome =
  | { kind: "composed"; composed: Composed }
  | { kind: "nothing"; evidence: number }
  | { kind: "no_writer" }
  | { kind: "invalid" }
  | { kind: "empty" }
  | { kind: "too_large" };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const supportStatuses = new Set(["verified", "partial", "unchecked"]);

/** The stored support of an overview, as the contract carries it. */
function supportOf(value: Record<string, unknown>): OverviewSupportSummary {
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

/** The evidence candidates of a topic, keyed by content (D22) and by the hash a citation stores. */
function evidenceItems(rows: readonly TopicOverviewEvidenceRow[]): EvidenceItem[] {
  return rows.map((row) => ({
    ...row,
    contentKey: sha256(`${row.title}\n${row.idea}\n${row.passage}`),
    passageHash: sha256(row.passage)
  }));
}

function storedEvidenceOf(item: EvidenceItem) {
  return {
    noteId: item.noteId,
    chunkId: item.chunkId,
    sourceSpanId: item.sourceSpanId,
    sourceId: item.sourceId,
    contentHash: item.passageHash
  };
}

function citationOf(item: EvidenceItem, n: number) {
  return {
    n,
    chunkId: item.chunkId,
    sourceSpanId: item.sourceSpanId,
    noteId: item.noteId,
    excerpt: overviewExcerpt(item.passage),
    excerptHash: item.passageHash
  };
}

/**
 * A stored overview's citations numbered 1..k with nothing missing, and room left for a paragraph,
 * a citation and an evidence item: a patch continues them. A full one gets a rewrite proposal.
 */
function patchable(stored: StoredTopicOverview): boolean {
  return (
    stored.citations.every((citation, index) => citation.n === index + 1) &&
    overviewPatchParagraphsMax(stored.paragraphs.length) > 0 &&
    stored.citations.length < topicReadLimits.overviewCitationsMax &&
    stored.evidence.length < topicOverviewLimits.storedEvidenceMax
  );
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
      if (context.stored) return this.ready(context, context.stored);
      const failure = this.failures.get(context.topic.id);
      if (failure) return { status: "failed", messageKey: failure };
      return await this.absent(context);
    } catch (error) {
      this.options.logger?.warn("The overview state of a topic could not be read", error);
      return { status: "absent", canWrite: false, reasonKey: topicOverviewMessageKeys.unavailable };
    }
  }

  /**
   * `topics.overview`: the cached overview; one written now when there is none (`force` writes a
   * new one, the Update action); a stale one patched now at P0 (F4 D17). A writing in progress,
   * REFRESH's included, is joined, not repeated; while the support check of the last writing runs,
   * the call waits for its verdict. Only writing calls AI.
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
    const running = this.writes.get(topicId);
    if (running) return running.promise;
    const stored = context.stored;
    if (stored && !force && !this.isStale(context, stored)) return this.ready(context, stored);
    const reason = await this.cannotWrite(context);
    if (reason) {
      // A stale overview stays readable when nothing can be written now.
      if (stored && !force) return this.ready(context, stored);
      return { status: "absent", canWrite: false, reasonKey: reason };
    }
    // A full topic is never patched: the page keeps it with Update; REFRESH proposes a rewrite. A
    // text the owner restored with an undo is not patched again on open either.
    if (stored && !force && (!patchable(stored) || stored.restored))
      return this.ready(context, stored);
    // Another request may have started the same writing while this one read.
    const started = this.writes.get(topicId);
    if (started) return started.promise;

    this.checks.get(topicId)?.controller.abort();
    this.checks.delete(topicId);
    this.failures.delete(topicId);
    const controller = new AbortController();
    const keys = [...new Set([topicId, id])];
    const write =
      stored && !force
        ? this.pagePatch(context, stored, controller.signal)
        : this.pageWrite(context, controller.signal);
    const promise = write.finally(() => {
      for (const key of keys) {
        if (this.writes.get(key)?.controller === controller) this.writes.delete(key);
      }
    });
    for (const key of keys) this.writes.set(key, { promise, controller });
    return promise;
  }

  /**
   * `topics.overview.cancel`: stops the writing (and the support check) a page started for a topic.
   * REFRESH's writing is its job's: a page that joined it only stops waiting.
   */
  cancel(input: unknown): boolean {
    const { id } = TopicOverviewCancelInputSchema.parse(input);
    let canceled = false;
    for (const running of [this.writes.get(id), this.checks.get(id)]) {
      if (!running || running.background) continue;
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

  /**
   * REFRESH of one topic (F4 D17), for its `topic-overview` job: joins a writing in progress, then
   * keeps the overview current at P3. A stale overview is patched (a full one, of the most
   * paragraphs, gets a rewrite proposal, never an automatic rewrite); a topic opened lately that
   * has none gets its first one. The autonomy decides whether the change is applied with undo or
   * proposed (D12; a high-risk change is always proposed). The support check of the new sentences
   * runs inside the job, at its priority. A failure of the writer is thrown for the job to retry.
   */
  async refresh(input: {
    topicId: string;
    jobId: string;
    autonomy: GardenerAutonomy;
    signal: AbortSignal;
  }): Promise<OverviewRefreshResult> {
    const { topicId, signal } = input;
    // A writing in progress (a page's, at P0) is joined; what it wrote is then read below.
    await this.writes.get(topicId)?.promise.catch(() => undefined);
    signal.throwIfAborted();
    const repository = this.repository();
    const context = await repository.readContext(topicId);
    if (!context || context.topic.role === "root") return { status: "stale" };
    const id = context.topic.id;
    await this.writes.get(id)?.promise.catch(() => undefined);
    if (this.options.aiMode !== "full") return { status: "not_due" };
    const config = this.options.refreshConfig ?? topicOverviewRefreshConfig;
    if (context.members.notes < config.minPlacedNotes) return { status: "too_few_items" };
    // A proposal on a version the overview has moved past is replaced by the one made now.
    await repository.supersedeProposals(id);
    const stored = context.stored;
    if (stored && !this.isStale(context, stored)) return { status: "current" };
    if (!stored && !(await this.openedLately(context))) return { status: "not_due" };
    if (!(await this.writerReady())) return { status: "no_route" };
    // A page started writing while this read: REFRESH looks again once that writing is stored.
    const started = this.writes.get(id);
    if (started) {
      await started.promise.catch(() => undefined);
      return { status: "deferred" };
    }

    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const call: OverviewCall = { priority: "P3", budgetClass: "background", jobId: input.jobId };
    // A page that opens meanwhile joins this writing and reads what it stored, as soon as it is
    // stored: the support check that follows shows as checking, not as writing.
    let markStored!: () => void;
    const storedNow = new Promise<void>((done) => {
      markStored = done;
    });
    const release = () => {
      if (this.writes.get(id)?.controller === controller) this.writes.delete(id);
      markStored();
    };
    const run = this.refreshNow(
      context,
      stored,
      call,
      input.autonomy,
      controller.signal,
      release
    ).finally(() => {
      signal.removeEventListener("abort", abort);
      release();
    });
    this.writes.set(id, {
      promise: storedNow.then(() => this.state(id)),
      controller,
      background: true
    });
    return run;
  }

  // ----- reading

  private repository() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("topics.errors.unavailable");
    return createTopicOverviewRepository(pool);
  }

  private async identity(): Promise<OverviewIdentity> {
    return { language: await this.options.getContentLanguage() };
  }

  /** Stale on members only (F4 D9): a prompt or language change is offered as Update, never forced. */
  private isStale(context: TopicOverviewContext, stored: StoredTopicOverview): boolean {
    return stored.memberFingerprint !== context.members.fingerprint;
  }

  private ready(context: TopicOverviewContext, stored: StoredTopicOverview): TopicOverviewState {
    return TopicOverviewResultSchema.parse({
      status: "ready",
      stale: this.isStale(context, stored),
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

  /** The page of a topic without an overview was opened within REFRESH's window (D17). */
  private async openedLately(context: TopicOverviewContext): Promise<boolean> {
    const config = this.options.refreshConfig ?? topicOverviewRefreshConfig;
    const now = this.options.now?.() ?? new Date();
    const rows = await this.repository().refreshCandidates({
      treeId: context.topic.treeId,
      topicIds: [context.topic.id],
      openedSince: new Date(now.getTime() - config.openedWithinDays * 86_400_000),
      limit: 1
    });
    return rows.length > 0;
  }

  // ----- the page's writing (P0)

  /** A full write for the page: the first overview of a topic, or Update. */
  private async pageWrite(
    context: TopicOverviewContext,
    signal: AbortSignal
  ): Promise<TopicOverviewState> {
    const topicId = context.topic.id;
    const started = performance.now();
    try {
      const identity = await this.identity();
      const composed = await this.composeWrite(context, identity, pageCall, signal);
      if (composed.kind !== "composed") return this.pageOutcome(topicId, composed);
      const result = await this.repository().write({
        ...composed.composed.content,
        change: { origin: "write" }
      });
      if (result.kind !== "written") return this.pageAfterWrite(topicId);
      await this.afterSave(topicId, result.writtenAtExact, composed.composed, pageCall);
      this.logWritten(topicId, "written", started, composed.composed);
      return this.pageAfterWrite(topicId);
    } catch (error) {
      return this.pageFailure(topicId, error, signal);
    }
  }

  /** The page opened a stale overview: the same patch REFRESH makes, at P0, applied with undo. */
  private async pagePatch(
    context: TopicOverviewContext,
    stored: StoredTopicOverview,
    signal: AbortSignal
  ): Promise<TopicOverviewState> {
    const topicId = context.topic.id;
    const started = performance.now();
    try {
      const composed = await this.composePatch(context, stored, pageCall, signal);
      if (composed.kind === "nothing") {
        await this.markCurrent(context, stored);
        return this.pageAfterWrite(topicId);
      }
      if (composed.kind !== "composed") return this.pageOutcome(topicId, composed);
      const risk = this.patchRisk(composed.composed);
      const result = await this.repository().write({
        ...composed.composed.content,
        expectedVersion: stored.version,
        change: { origin: "patch", risk }
      });
      if (result.kind === "written") {
        await this.afterSave(topicId, result.writtenAtExact, composed.composed, pageCall);
        this.logWritten(topicId, "patched", started, composed.composed);
      }
      return this.pageAfterWrite(topicId);
    } catch (error) {
      return this.pageFailure(topicId, error, signal);
    }
  }

  /** The page reads what is stored now: source titles, availability and the members of now. */
  private async pageAfterWrite(topicId: string): Promise<TopicOverviewState> {
    const checking = this.checks.get(topicId);
    let fresh = await this.repository().readContext(topicId);
    // A support check that ended while the overview was read stored its verdict after that read.
    if (checking && this.checks.get(topicId) !== checking)
      fresh = await this.repository().readContext(topicId);
    if (!fresh?.stored) {
      return { status: "absent", canWrite: false, reasonKey: topicOverviewMessageKeys.unavailable };
    }
    return this.ready(fresh, fresh.stored);
  }

  private pageOutcome(
    topicId: string,
    outcome: Exclude<ComposeOutcome, { kind: "composed" }>
  ): TopicOverviewState {
    switch (outcome.kind) {
      case "no_writer":
        return { status: "absent", canWrite: false, reasonKey: topicOverviewMessageKeys.noWriter };
      case "empty":
        return { status: "absent", canWrite: false, reasonKey: topicOverviewMessageKeys.empty };
      case "too_large":
        return this.fail(topicId, topicOverviewMessageKeys.tooLarge);
      case "invalid":
        return this.fail(topicId, topicOverviewMessageKeys.invalid);
      case "nothing":
        return { status: "absent", canWrite: false, reasonKey: topicOverviewMessageKeys.empty };
    }
  }

  private pageFailure(topicId: string, error: unknown, signal: AbortSignal): TopicOverviewState {
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

  private fail(topicId: string, messageKey: string): TopicOverviewState {
    this.failures.set(topicId, messageKey);
    return { status: "failed", messageKey };
  }

  // ----- REFRESH's writing (P3)

  private async refreshNow(
    context: TopicOverviewContext,
    stored: StoredTopicOverview | null,
    call: OverviewCall,
    autonomy: GardenerAutonomy,
    signal: AbortSignal,
    /** Called once the change is stored, before the support check runs. */
    release: () => void
  ): Promise<OverviewRefreshResult> {
    const topicId = context.topic.id;
    const started = performance.now();
    const repository = this.repository();
    const patch = stored !== null && patchable(stored);
    const origin = stored === null ? "write" : patch ? "patch" : "rewrite";
    const composed = patch
      ? await this.composePatch(context, stored, call, signal)
      : await this.composeWrite(context, await this.identity(), call, signal);
    switch (composed.kind) {
      case "nothing":
        if (stored) await this.markCurrent(context, stored);
        return { status: "no_change", origin, evidence: composed.evidence };
      case "no_writer":
        return { status: "no_route" };
      case "invalid":
        return { status: "invalid", origin };
      case "empty":
      case "too_large":
        return { status: "no_change", origin, evidence: 0 };
      case "composed":
        break;
    }
    const added = composed.composed;
    // A rewrite of a full topic is always reviewed (D11, D17); a patch's risk follows its Divergences.
    const risk: ChangeSetRisk = origin === "rewrite" ? "high" : this.patchRisk(added);
    const disposition = changeDisposition({ work: "refresh", autonomy, risk });
    const change = { origin, risk, jobId: call.jobId } as const;
    const base = {
      origin,
      paragraphs: added.addedParagraphs,
      divergences: added.newDivergences.length,
      evidence: added.evidenceCount,
      risk
    } as const;
    const expectedVersion = stored?.version ?? 0;
    if (disposition === "pending_review") {
      const proposed = await repository.propose({
        ...added.content,
        expectedVersion,
        replacePending: true,
        change
      });
      if (proposed.kind === "moved") return { status: "deferred", origin };
      if (proposed.kind === "retired") return { status: "stale" };
      this.logWritten(topicId, "proposed", started, added);
      return { ...base, status: "pending_review", proposalId: proposed.id };
    }
    this.checks.get(topicId)?.controller.abort();
    this.checks.delete(topicId);
    const written = await repository.write({ ...added.content, expectedVersion, change });
    if (written.kind === "moved") return { status: "deferred", origin };
    if (written.kind === "retired") return { status: "stale" };
    const check = await this.afterSave(topicId, written.writtenAtExact, added, call, signal);
    // Stored: a page that joined reads it now (checking); the job waits for the check.
    release();
    this.logWritten(topicId, origin === "patch" ? "patched" : "written", started, added);
    await check;
    return {
      ...base,
      status: "applied",
      version: written.version,
      changeSetId: written.changeSetId
    };
  }

  /** A patch's risk (D11): medium when it keeps a Divergence beside the prose, else low. */
  private patchRisk(composed: Composed): ChangeSetRisk {
    return changeSetRisk(
      { divergence: composed.newDivergences.length > 0 ? "sideBySide" : "none" },
      defaultTopicTreeConfig
    );
  }

  /** Nothing to add: the stored text stands for the members of now (no version, no change-set). */
  private async markCurrent(
    context: TopicOverviewContext,
    stored: StoredTopicOverview
  ): Promise<void> {
    await this.repository().markCurrent({
      topicId: context.topic.id,
      expectedVersion: stored.version,
      memberFingerprint: context.members.fingerprint,
      memberCount: context.members.notes
    });
  }

  // ----- composing (one writer call and its one repair)

  private logContext(
    call: OverviewCall,
    input: {
      stage: string;
      language: string;
      promptVersion: string;
      patch: boolean;
      evidence: readonly EvidenceItem[];
    }
  ): AiTaskLogContext {
    // The class, the priority and the budget class are stated where the call is made (`ask`).
    return {
      stage: input.stage,
      operation: topicOverviewOperation,
      ...(call.jobId ? { jobId: call.jobId } : {}),
      contentLanguage: input.language,
      promptVersion: input.promptVersion,
      outputContract: input.patch ? topicOverviewPatchOutputContract : topicOverviewOutputContract,
      attempt: 0,
      isRepair: false,
      sourceItemIds: [...new Set(input.evidence.map((item) => item.sourceId))].sort(),
      chunkIds: input.evidence.map((item) => item.chunkId)
    };
  }

  /** A full overview from the topic's central notes (the first one, Update, or a rewrite). */
  private async composeWrite(
    context: TopicOverviewContext,
    identity: OverviewIdentity,
    call: OverviewCall,
    signal: AbortSignal
  ): Promise<ComposeOutcome> {
    const rows = await this.repository().readEvidence(context.topic, {
      perTopic: topicOverviewLimits.candidatesPerTopic,
      candidates: topicOverviewLimits.maxCandidates
    });
    if (rows.length === 0) return { kind: "empty" };
    const candidates = evidenceItems(rows);
    const { evidence } = selectOverviewEvidence(candidates);
    if (evidence.length === 0) return { kind: "too_large" };
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
    const logContext = this.logContext(call, {
      stage: "topic_overview",
      language: identity.language,
      promptVersion: topicOverviewPromptVersion,
      patch: false,
      evidence
    });
    const answer = await this.ask(prompt, call, logContext, signal, (output) => {
      const validation = validateOverviewOutput(parseTopicOverviewOutput(output), evidence.length);
      return validation.ok ? { ok: true as const, value: validation.overview } : validation;
    });
    if (answer.kind !== "valid") return answer;
    const { execution, value: overview } = answer;
    const cited = overview.cited.map((number) => evidence[number - 1] as EvidenceItem);
    return {
      kind: "composed",
      composed: {
        content: {
          topicId: context.topic.id,
          paragraphs: overview.paragraphs,
          evidence: evidence.map(storedEvidenceOf),
          memberFingerprint: context.members.fingerprint,
          memberCount: context.members.notes,
          inputHash: sha256(prompt),
          promptRevisionId: `${topicOverviewPromptVersion}:${promptFingerprint(["topic.overview"])}`,
          provider: execution.providerId,
          model: execution.modelId,
          runtime: execution.runtime,
          aiTaskRunId: execution.aiTaskRunId,
          language: identity.language,
          support: { status: "unchecked", unsupported: [] },
          citations: cited.map((item, index) => citationOf(item, index + 1))
        },
        previousParagraphs: 0,
        previousSupport: null,
        passages: new Map(cited.map((item, index) => [index + 1, item.passage])),
        sourceIds: logContext.sourceItemIds ?? [],
        newDivergences: [],
        addedParagraphs: overview.paragraphs.length,
        evidenceCount: evidence.length,
        candidateCount: rows.length,
        calls: answer.calls
      }
    };
  }

  /**
   * An additive patch of a stored overview (D17): the new evidence the stored overview was not
   * written from, after its paragraphs and their citations; the stored text stays byte-identical,
   * the new paragraphs and Divergences follow it in continued numbering. `nothing` when there is no
   * new evidence that fits, or the writer adds neither a paragraph nor a Divergence. Written in the
   * stored overview's language, so the text stays in one language (a language change is Update's).
   */
  private async composePatch(
    context: TopicOverviewContext,
    stored: StoredTopicOverview,
    call: OverviewCall,
    signal: AbortSignal
  ): Promise<ComposeOutcome> {
    const rows = await this.repository().readEvidence(context.topic, {
      perTopic: topicOverviewLimits.candidatesPerTopic,
      candidates: topicOverviewLimits.maxCandidates
    });
    const candidates = evidenceItems(rows);
    const k = stored.citations.length;
    const { evidence } = selectPatchEvidence(candidates, {
      evidence: stored.evidence,
      paragraphs: stored.paragraphs,
      citedExcerpts: stored.citations.map((citation) => citation.excerpt)
    });
    if (evidence.length === 0) return { kind: "nothing", evidence: 0 };
    const maxParagraphs = overviewPatchParagraphsMax(stored.paragraphs.length);
    const prompt = buildTopicOverviewPatchPrompt({
      contentLanguage: stored.language,
      topic: { title: context.topic.title, description: context.topic.description },
      paragraphs: stored.paragraphs.map((paragraph) => paragraph.text),
      cited: stored.citations.map((citation) => ({
        source: citation.sourceTitle,
        excerpt: citation.excerpt
      })),
      evidence: evidence.map((item) => ({
        title: item.title,
        idea: item.idea,
        source: item.sourceTitle,
        passage: item.passage
      })),
      maxParagraphs
    });
    const logContext = this.logContext(call, {
      stage: "topic_overview_patch",
      language: stored.language,
      promptVersion: topicOverviewPatchPromptVersion,
      patch: true,
      evidence
    });
    const answer = await this.ask(prompt, call, logContext, signal, (output) => {
      const validation = validateOverviewPatch(parseTopicOverviewOutput(output), {
        existingCitations: k,
        newEvidence: evidence.length,
        maxParagraphs,
        existingDivergences: stored.divergences.length
      });
      return validation.ok ? { ok: true as const, value: validation.patch } : validation;
    });
    if (answer.kind !== "valid") return answer;
    const { execution, value: patch } = answer;
    // Zero new paragraphs and no Divergence is no change (D17). A Divergence alone is still kept
    // beside the unchanged text, for review (R8): a contradiction is never dropped.
    if (patch.paragraphs.length === 0 && patch.divergences.length === 0)
      return { kind: "nothing", evidence: evidence.length };
    const cited = patch.cited.map((number) => evidence[number - 1] as EvidenceItem);
    const byChunk = new Map(candidates.map((item) => [item.chunkId, item.passage]));
    const passages = new Map<number, string>();
    for (const citation of stored.citations)
      passages.set(
        citation.n,
        (citation.chunkId ? byChunk.get(citation.chunkId) : undefined) ?? citation.excerpt
      );
    cited.forEach((item, index) => passages.set(k + index + 1, item.passage));
    const seen = new Set(stored.evidence.map((item) => `${item.noteId}:${item.contentHash}`));
    return {
      kind: "composed",
      composed: {
        content: {
          topicId: context.topic.id,
          paragraphs: [...stored.paragraphs, ...patch.paragraphs],
          evidence: [
            ...stored.evidence,
            ...evidence
              .filter((item) => !seen.has(`${item.noteId}:${item.passageHash}`))
              .map(storedEvidenceOf)
          ],
          memberFingerprint: context.members.fingerprint,
          memberCount: context.members.notes,
          inputHash: sha256(prompt),
          promptRevisionId: `${topicOverviewPatchPromptVersion}:${promptFingerprint([
            "topic.overview.patch"
          ])}`,
          provider: execution.providerId,
          model: execution.modelId,
          runtime: execution.runtime,
          aiTaskRunId: execution.aiTaskRunId,
          language: stored.language,
          // No new sentence keeps the stored verdict; new ones are unchecked until their check.
          support:
            patch.paragraphs.length === 0
              ? stored.support
              : patchedOverviewSupport(supportOf(stored.support), null),
          citations: [
            ...stored.citations.map((citation) => ({
              n: citation.n,
              chunkId: citation.chunkId,
              sourceSpanId: citation.sourceSpanId,
              noteId: citation.noteId,
              excerpt: citation.excerpt,
              excerptHash: citation.excerptHash
            })),
            ...cited.map((item, index) => citationOf(item, k + index + 1))
          ],
          divergences: [...stored.divergences, ...patch.divergences]
        },
        previousParagraphs: stored.paragraphs.length,
        previousSupport: supportOf(stored.support),
        passages,
        sourceIds: [
          ...new Set(
            [
              ...cited.map((item) => item.sourceId),
              ...stored.citations.map((c) => c.sourceId)
            ].filter((id): id is string => typeof id === "string")
          )
        ].sort(),
        newDivergences: patch.divergences,
        addedParagraphs: patch.paragraphs.length,
        evidenceCount: evidence.length,
        candidateCount: rows.length,
        calls: answer.calls
      }
    };
  }

  /**
   * One writer call and, when its answer is invalid, one repair with what was wrong. Resolves to
   * the validated answer, `no_writer` without a route or `invalid` after a failed repair; a failed
   * call throws.
   */
  private async ask<T>(
    prompt: string,
    call: OverviewCall,
    logContext: AiTaskLogContext,
    signal: AbortSignal,
    validate: (output: unknown) => Validated<T>
  ): Promise<
    | { kind: "valid"; value: T; execution: WriterExecution; calls: number }
    | { kind: "no_writer" }
    | { kind: "invalid" }
  > {
    // A page closed (or a writing canceled) while the evidence was read never calls the model.
    signal.throwIfAborted();
    const deadline = new ActiveDeadline(topicOverviewLimits.timeoutMs, signal);
    const limits = { maxOutputTokens: topicOverviewLimits.maxOutputTokens };
    try {
      // The write's priority and budget class (M7): P0 for the page, P3 background for REFRESH.
      let execution = await this.options.ai.runDefaultTask(
        "structured-output",
        prompt,
        {
          ...logContext,
          workloadClass: "write-fast",
          priority: call.priority,
          budgetClass: call.budgetClass
        },
        deadline.signal,
        limits
      );
      if (!execution) return { kind: "no_writer" };
      let validation = validate(execution.output);
      let calls = 1;
      if (!validation.ok) {
        calls += 1;
        execution = await this.options.ai.runDefaultTask(
          "structured-output",
          buildTopicOverviewRepairPrompt(prompt, validation.errors.join("\n")),
          {
            ...logContext,
            workloadClass: "write-fast",
            priority: call.priority,
            budgetClass: call.budgetClass,
            attempt: 1,
            isRepair: true
          },
          deadline.signal,
          limits
        );
        if (!execution) return { kind: "no_writer" };
        validation = validate(execution.output);
        if (!validation.ok) return { kind: "invalid" };
      }
      deadline.signal.throwIfAborted();
      return { kind: "valid", value: validation.value, execution, calls };
    } finally {
      deadline.dispose();
    }
  }

  // ----- the support check

  /**
   * After a save: starts the support check of the sentences the write added, at its priority, and
   * answers its promise (none without a ranker). A page's check never holds the page; REFRESH's
   * job waits for its own, which stops with the job (`parent`).
   */
  private async afterSave(
    topicId: string,
    writtenAtExact: string,
    composed: Composed,
    call: OverviewCall,
    parent?: AbortSignal
  ): Promise<Promise<void> | null> {
    // A version was just stored by every caller of this step: the topic's overview changed.
    publishObjectKindChanged("topic", [topicId], "updated");
    if (!(await this.rankerReady())) return null;
    const sentences = overviewSentences(composed.content.paragraphs).filter(
      (sentence) => sentence.paragraph >= composed.previousParagraphs
    );
    return this.startCheck(topicId, writtenAtExact, sentences, composed, call, parent);
  }

  private startCheck(
    topicId: string,
    writtenAtExact: string,
    sentences: readonly OverviewSentence[],
    composed: Composed,
    call: OverviewCall,
    parent?: AbortSignal
  ): Promise<void> {
    const controller = new AbortController();
    if (parent?.aborted) controller.abort(parent.reason);
    else parent?.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
    const promise = this.check(
      topicId,
      writtenAtExact,
      sentences,
      composed,
      call,
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
    this.checks.set(topicId, {
      promise,
      controller,
      ...(call.budgetClass === "background" ? { background: true } : {})
    });
    return promise;
  }

  /**
   * Scores every sentence the write added against the passages it cites (one ranker call each) and
   * stores the verdict for this writing only, with the verdict of the paragraphs before them. A
   * failure leaves the new sentences unchecked.
   */
  private async check(
    topicId: string,
    writtenAtExact: string,
    all: readonly OverviewSentence[],
    composed: Composed,
    call: OverviewCall,
    signal: AbortSignal
  ): Promise<void> {
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
        .map((n) => composed.passages.get(n))
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
          priority: call.priority,
          budgetClass: call.budgetClass,
          ...(call.jobId ? { jobId: call.jobId } : {}),
          sourceIds: composed.sourceIds,
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
    // Sentences past the cap were not checked: the overview is then only partly verified.
    const checked: OverviewSupportVerdict =
      all.length > sentences.length ? { ...verdict, status: "partial" } : verdict;
    const summary = composed.previousSupport
      ? patchedOverviewSupport(composed.previousSupport, checked)
      : checked;
    const support = {
      ...summary,
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
          `${verdict.sentences.supported} of ${verdict.sentences.checked} new sentences supported`
      );
    }
  }

  /** The time to display the overview, for the measurement (T31): ids and counts only. */
  private logWritten(topicId: string, what: string, started: number, composed: Composed): void {
    this.options.logger?.info(
      `Topic overview ${topicId} ${what} in ${Math.round(performance.now() - started)} ms: ` +
        `${composed.calls} writer call(s), ${composed.evidenceCount} of ${composed.candidateCount} ` +
        `candidates, ${composed.addedParagraphs} paragraph(s), ` +
        `${composed.newDivergences.length} divergence(s)`
    );
  }
}
