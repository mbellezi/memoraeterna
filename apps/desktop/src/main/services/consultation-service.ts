import { estimateAiPlanningTokens } from "./ai-task-parameters.js";
import { compareContent } from "./content-order.js";
import {
  capturePromptPin,
  joinPrompts,
  promptFingerprint,
  renderPrompt,
  withOutputLanguageInstruction,
  withPromptPin
} from "./prompt-runtime.js";
import { z } from "zod";
import {
  createConsultationRepository,
  createKnowledgeConsultationRepository,
  type PgPool
} from "@app/db";
import {
  ConsultationAnswerSchema,
  ConsultationEvidenceSchema,
  ConsultationInputSchema,
  ConsultationResultSchema,
  consultationVersion,
  type ConsultationContext,
  type ConsultationEvidence,
  type ConsultationInput,
  type ConsultationRelation,
  type ConsultationResult
} from "@app/domain";
import { ActiveDeadline } from "./ai-execution-queue.js";
import type { AiService } from "./ai-service.js";

/** Equal scores break on document position (source title, chunk position); chunk IDs are random per import. */
const compareChunkPosition = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  compareContent(String(a.sourceTitle ?? ""), String(b.sourceTitle ?? "")) ||
  Number(a.chunkIndex ?? 0) - Number(b.chunkIndex ?? 0) ||
  String(a.chunkId).localeCompare(String(b.chunkId));
export function rankConsultationCandidates(
  rows: Array<Record<string, any>>,
  vector: Array<{ id: string; score: number }>,
  limit = 12
) {
  const scores = new Map<string, number>();
  for (const signal of ["text", "title", "concept", "note", "entity", "relation"]) {
    const ranked = rows
      .filter((r) => Number(r[signal]) > 0)
      .toSorted((a, b) => Number(b[signal]) - Number(a[signal]) || compareChunkPosition(a, b));
    ranked.forEach((r, i) => scores.set(r.chunkId, (scores.get(r.chunkId) ?? 0) + 1 / (61 + i)));
  }
  vector
    .filter((v) => v.score >= ((scores.get(v.id) ?? 0) > 0 ? 0.4 : 0.48))
    .forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (61 + i)));
  const ranked = rows
    .filter((r) => (scores.get(r.chunkId) ?? 0) > 0)
    .toSorted(
      (a, b) =>
        (scores.get(b.chunkId) ?? 0) - (scores.get(a.chunkId) ?? 0) || compareChunkPosition(a, b)
    );
  const used = new Set<string>(),
    picked: typeof rows = [];
  for (const r of ranked)
    if (!used.has(r.rootId ?? r.sourceItemId)) {
      picked.push(r);
      used.add(r.rootId ?? r.sourceItemId);
      if (picked.length === limit) break;
    }
  for (const r of ranked) if (picked.length < limit && !picked.includes(r)) picked.push(r);
  return picked;
}

/** The AI profile a question is pinned to. The AI service owns its shape. */
type PinnedProfile = Awaited<ReturnType<AiService["pinOrganizationProfile"]>>;
type PromptPin = ReturnType<typeof capturePromptPin>;

/**
 * What the prompt reads from a prepared question. Structural on purpose: prompt tooling renders
 * the same wording from its own synthetic snapshots without a database.
 */
export interface ConsultationPromptSnapshot {
  consultationVersion?: string | undefined;
  consultationIntent?: string | undefined;
  contentLanguage: string;
  instructions: { slots: unknown };
  evidence: readonly unknown[];
  contexts: readonly unknown[];
  relations: readonly unknown[];
}
/** A question prepared for an answer: the passages and optional context it may cite. */
export interface ConsultationSnapshot extends ConsultationPromptSnapshot {
  promptPin: PromptPin | null;
  consultationScope?: { sourceIds: string[]; includeDescendants: boolean } | undefined;
  sourceIds: string[];
  profile: PinnedProfile;
  instructions: { slots: { guidance: string; advanced: string } };
  /** A synthetic snapshot has no database state to validate. */
  sample: boolean;
  evidence: ConsultationEvidence[];
  contexts: ConsultationContext[];
  relations: ConsultationRelation[];
}

export function parseConsultationAnswer(
  output: unknown,
  snapshot: {
    evidence: ReadonlyArray<{ handle: string }>;
    contexts: ReadonlyArray<{ id: string; handles: readonly string[] }>;
    relations: ReadonlyArray<{ id: string; sourceHandle: string; targetHandle: string }>;
    consultationIntent?: string | undefined;
  }
) {
  if (typeof output === "string") {
    if (output.length > 45000) throw new Error("consultation.errors.invalid");
    const raw = output.trim(),
      fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(raw);
    try {
      output = JSON.parse(fence?.[1] ?? raw);
    } catch {
      throw new Error("consultation.errors.invalid");
    }
  }
  const answer = ConsultationAnswerSchema.parse(output);
  if (
    snapshot.consultationIntent === "investigation" &&
    (!answer.change || (answer.change.meaningful && !answer.change.explanation.length))
  )
    throw new Error("consultation.errors.invalid");
  for (const paragraph of answer.paragraphs) {
    if (paragraph.citations.some((h) => !snapshot.evidence.some((e) => e.handle === h)))
      throw new Error("consultation.errors.evidence");
    for (const match of paragraph.markdown.matchAll(/\[(e\d{1,3})\]/g))
      if (!paragraph.citations.includes(match[1]!)) throw new Error("consultation.errors.evidence");
    for (const id of paragraph.contextIds) {
      const context = snapshot.contexts.find((c) => c.id === id),
        relation = snapshot.relations.find((r) => r.id === id),
        handles =
          context?.handles ?? (relation ? [relation.sourceHandle, relation.targetHandle] : null);
      if (!handles || handles.some((h) => !paragraph.citations.includes(h)))
        throw new Error("consultation.errors.evidence");
    }
  }
  return answer;
}
export function consultationPrompt(
  snapshot: ConsultationPromptSnapshot,
  question: string,
  pageSections: unknown = []
) {
  const { contentLanguage: language, evidence, contexts, relations } = snapshot;
  if (snapshot.consultationVersion === consultationVersion)
    return joinPrompts(
      renderPrompt("consultation.knowledge", {
        content_language: language,
        question,
        guidance: snapshot.instructions.slots,
        original_evidence: evidence,
        related_knowledge: contexts,
        current_page: Array.isArray(pageSections) ? {} : pageSections,
        relations
      }),
      snapshot.consultationIntent === "comparison"
        ? renderPrompt("consultation.comparison")
        : snapshot.consultationIntent === "investigation"
          ? renderPrompt("consultation.investigation")
          : "",
      renderPrompt("consultation.gaps")
    );
  return renderPrompt("consultation.answer", {
    content_language: language,
    question: question,
    guidance: snapshot.instructions.slots,
    original_evidence: evidence,
    related_knowledge: contexts,
    relations: relations,
    current_page: pageSections
  });
}
export function consultationFits(
  snapshot: ConsultationPromptSnapshot & {
    profile: { provider: string; contextWindow: number | null };
  },
  question: string
) {
  const prompt = consultationPrompt(snapshot, question);
  return (
    estimateAiPlanningTokens(
      withOutputLanguageInstruction(prompt, snapshot.contentLanguage),
      snapshot.profile.provider === "openai-codex"
        ? renderPrompt("shared.codex_adapter_instruction")
        : "",
      2048
    ) <= (snapshot.profile.contextWindow ?? 8192)
  );
}
/**
 * Keeps as many complete passages as the model's context takes, in rank order and at most twelve,
 * then the optional context and relations whose passages all made it. A passage is never cut.
 */
export function packConsultationSnapshot(original: ConsultationSnapshot, question: string) {
  const snapshot = structuredClone(original);
  snapshot.evidence = [];
  snapshot.contexts = [];
  snapshot.relations = [];
  for (const evidence of original.evidence) {
    if (snapshot.evidence.length >= 12) break;
    snapshot.evidence.push(evidence);
    if (!consultationFits(snapshot, question)) snapshot.evidence.pop();
  }
  if (!snapshot.evidence.length) throw new Error("consultation.errors.context");
  const handles = new Set(snapshot.evidence.map((e) => e.handle));
  for (const context of original.contexts) {
    if (context.handles.some((h) => !handles.has(h))) continue;
    snapshot.contexts.push(context);
    if (!consultationFits(snapshot, question)) snapshot.contexts.pop();
  }
  for (const relation of original.relations) {
    if (!handles.has(relation.sourceHandle) || !handles.has(relation.targetHandle)) continue;
    snapshot.relations.push(relation);
    if (!consultationFits(snapshot, question)) snapshot.relations.pop();
  }
  return snapshot;
}
/** Guidance wording comes from the prompt catalog; there is no per-library override. */
function consultationInstructions(question: string, language: string) {
  const values = { page_title: question, content_language: language };
  return {
    slots: {
      guidance: renderPrompt("consultation.guidance", values),
      advanced: renderPrompt("consultation.advanced", values)
    }
  };
}
/** What the person sees when an answer fails, whatever layer failed. */
function askFailure(error: unknown, canceled: AbortSignal, active: AbortSignal) {
  if (canceled.aborted) return new Error("consultation.errors.canceled");
  if (active.aborted) return new Error("consultation.errors.deadline");
  if (/organization\.errors\.model/.test(String(error)))
    return new Error("consultation.errors.model");
  return error;
}

/** Time an Ask may spend working; waiting for the AI queue does not count. */
export const askTimeoutMs = 120_000;
export class ConsultationService {
  private active = new Map<string, AbortController>();
  constructor(
    private readonly options: {
      getPool: () => PgPool | null;
      ai: Pick<
        AiService,
        "pinOrganizationProfile" | "runOrganizationTask" | "runConsultationEmbedding"
      >;
      contentLanguage: () => Promise<string>;
      /** Unused since an answer stopped creating jobs; the main wiring still passes it. */
      wake?: () => void;
    }
  ) {}
  cancel(id: string) {
    this.active.get(id)?.abort();
    return null;
  }
  private pool() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("consultation.errors.unavailable");
    return pool;
  }
  /** Rejects a snapshot whose passages, relations or context changed since it was prepared. */
  private async fresh(snapshot: ConsultationSnapshot) {
    if (snapshot.sample) return;
    const grounding = createKnowledgeConsultationRepository(this.pool());
    if (snapshot.consultationScope) {
      const allowed = await grounding.scope(snapshot.consultationScope);
      if (snapshot.evidence.some((e) => !allowed.includes(e.sourceItemId)))
        throw new Error("consultation.errors.scope");
    }
    await grounding.validate(snapshot);
  }
  async ask(raw: ConsultationInput): Promise<ConsultationResult> {
    const input = ConsultationInputSchema.parse(raw);
    if (this.active.has(input.requestId)) throw new Error("consultation.errors.wait");
    const controller = new AbortController();
    this.active.set(input.requestId, controller);
    // The timeout runs while the question is prepared and answered, not while it waits for the AI queue.
    const deadline = new ActiveDeadline(askTimeoutMs, controller.signal);
    const signal = deadline.signal;
    try {
      return await withPromptPin(capturePromptPin(), async () => {
        const { snapshot, metadata } = await this.prepare(input, signal);
        const { answer, inputTokens, outputTokens, costEstimate } = await this.generate(
          snapshot,
          input.question,
          signal
        );
        let stale = false;
        try {
          await this.fresh(snapshot);
        } catch {
          stale = true;
        }
        signal.throwIfAborted();
        return ConsultationResultSchema.parse({
          ...metadata,
          answer,
          inputTokens,
          outputTokens,
          costEstimate,
          coverage: { ...metadata.coverage, stale }
        });
      });
    } catch (error) {
      throw askFailure(error, controller.signal, signal);
    } finally {
      deadline.dispose();
      this.active.delete(input.requestId);
    }
  }
  async prepare(input: ConsultationInput, signal: AbortSignal) {
    const pool = this.pool(),
      retrieval = createConsultationRepository(pool),
      grounding = createKnowledgeConsultationRepository(pool);
    const sourceIds = await grounding.scope(input);
    if (!sourceIds.length) throw new Error("consultation.errors.noRelevantEvidence");
    const profile = await this.options.ai.pinOrganizationProfile(input.profileId, input.privacy);
    let vectorState: "disabled" | "available" | "unavailable" =
      input.mode === "text" ? "disabled" : "unavailable";
    let vectors: Array<{ id: string; score: number }> = [];
    if (input.mode === "hybrid")
      try {
        const embedded = await this.options.ai.runConsultationEmbedding(
          input.question,
          profile.privacy,
          sourceIds,
          signal
        );
        if (embedded && Array.isArray(embedded.output) && embedded.embeddingSpaceKey) {
          vectors = await retrieval.vector(sourceIds, {
            embedding: embedded.output.map(Number),
            model: embedded.modelId,
            provider: embedded.providerId,
            runtime: embedded.runtime,
            spaceKey: embedded.embeddingSpaceKey
          });
          vectorState = "available";
        }
      } catch {
        signal.throwIfAborted();
      }
    const candidates = await retrieval.candidates(
      sourceIds,
      input.question,
      input.reviewedOnly,
      vectors.map((v) => v.id)
    );
    const selected = rankConsultationCandidates(
      candidates.filter((c) => c.excerpt.length <= 12000),
      vectors
    );
    if (!selected.length) throw new Error("consultation.errors.noRelevantEvidence");
    const evidence = selected.map((c, i) =>
      ConsultationEvidenceSchema.parse({
        ...Object.fromEntries(
          Object.keys(ConsultationEvidenceSchema.shape)
            .filter((k) => k !== "handle")
            .map((k) => [k, c[k]])
        ),
        handle: `e${i + 1}`
      })
    );
    const handleOf = (chunkId: string) => evidence.find((e) => e.chunkId === chunkId)!.handle;
    const contexts: ConsultationContext[] = (
      await grounding.contexts(
        sourceIds,
        evidence.map((e) => e.chunkId),
        input.reviewedOnly
      )
    )
      .map(({ chunkIds, ...c }) => ({ ...c, handles: chunkIds.map(handleOf) }))
      .slice(0, 60);
    const relations: ConsultationRelation[] = [];
    if (input.relationContext)
      for (const r of await grounding.relations(sourceIds)) {
        const a = evidence.find((e) => e.chunkId === r.sourceChunkId),
          b = evidence.find((e) => e.chunkId === r.targetChunkId);
        if (!a || !b || (input.reviewedOnly && r.review !== "accepted")) continue;
        relations.push({
          id: r.id,
          evidenceId: r.evidenceId,
          fingerprint: r.fingerprint,
          sourceItemId: r.sourceItemId,
          targetSourceItemId: r.targetSourceItemId,
          review: r.review,
          updatedAt: r.updatedAt,
          sourceIdea: r.sourceIdea,
          targetIdea: r.targetIdea,
          explanation: r.explanation,
          sourceHandle: a.handle,
          targetHandle: b.handle,
          dependencies: await grounding.relationDependencies(r.evidenceId)
        });
        if (relations.length === 6) break;
      }
    const language = z
      .enum(["en", "pt-BR", "it", "fr", "es"])
      .parse(await this.options.contentLanguage());
    const unpacked: ConsultationSnapshot = {
      promptPin: capturePromptPin(),
      consultationVersion,
      consultationIntent: input.intent,
      consultationScope: {
        sourceIds: input.sourceIds,
        includeDescendants: input.includeDescendants
      },
      sourceIds,
      profile,
      contentLanguage: language,
      instructions: consultationInstructions(input.question, language),
      sample: false,
      evidence,
      contexts,
      relations
    };
    const snapshot = packConsultationSnapshot(unpacked, input.question);
    snapshot.sourceIds = [...new Set(snapshot.evidence.map((e) => e.sourceItemId))];
    return {
      snapshot,
      metadata: {
        version: input.version,
        id: input.requestId,
        question: input.question,
        scope: {
          sourceIds: input.sourceIds,
          includeDescendants: input.includeDescendants,
          reviewedOnly: input.reviewedOnly
        },
        evidence: snapshot.evidence,
        contexts: snapshot.contexts,
        coverage: {
          retrieved: Math.max(candidates.length, evidence.length),
          selected: snapshot.evidence.length,
          sourceCount: sourceIds.length,
          limited:
            (candidates[0]?.total ?? 0) > snapshot.evidence.length ||
            snapshot.contexts.length < contexts.length ||
            snapshot.relations.length < relations.length,
          vector: vectorState,
          signals: [
            ...["text", "title", "concept", "note", "entity", "relation"].filter((key) =>
              selected.some((c) => Number(c[key]) > 0)
            ),
            ...(vectors.length ? ["vector"] : [])
          ],
          stale: false
        },
        model: profile.modelId,
        promptFingerprint: promptFingerprint(
          ["consultation.knowledge"],
          snapshot.promptPin ?? undefined,
          profile.provider
        )
      }
    };
  }
  async generate(snapshot: ConsultationSnapshot, question: string, signal: AbortSignal) {
    return withPromptPin(snapshot.promptPin, async () => {
      try {
        return await this.generatePinned(snapshot, question, signal);
      } catch (error) {
        if (String(error).includes("errors.ai.contextWindowLimit"))
          throw new Error("consultation.errors.context");
        throw error;
      }
    });
  }
  private async generatePinned(
    snapshot: ConsultationSnapshot,
    question: string,
    signal: AbortSignal
  ) {
    const { contentLanguage: language, profile, sourceIds } = snapshot;
    const base = consultationPrompt(snapshot, question);
    if (!consultationFits(snapshot, question)) throw new Error("consultation.errors.context");
    const auditIds: string[] = [];
    let answer: ReturnType<typeof parseConsultationAnswer> | null = null,
      inputTokens: number | null = 0,
      outputTokens: number | null = 0,
      costEstimate: number | null = 0;
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      signal.throwIfAborted();
      await this.fresh(snapshot);
      const prompt = joinPrompts(base, attempt ? renderPrompt("consultation.repair") : "");
      const result = await this.options.ai.runOrganizationTask(
        profile,
        prompt,
        {
          sourceItemIds: snapshot.sample ? [] : sourceIds,
          operation: "wiki-consultation",
          stage: "answer",
          origin: "consultation",
          promptVersion: snapshot.consultationVersion ?? "wiki-answer-v1",
          contentLanguage: language,
          attempt: attempt + 1
        },
        signal,
        2048,
        () => this.fresh(snapshot)
      );
      auditIds.push(result.aiTaskRunId);
      inputTokens =
        inputTokens === null || result.inputTokens === undefined
          ? null
          : inputTokens + result.inputTokens;
      outputTokens =
        outputTokens === null || result.outputTokens === undefined
          ? null
          : outputTokens + result.outputTokens;
      costEstimate =
        costEstimate === null || result.costEstimate === undefined
          ? null
          : costEstimate + result.costEstimate;
      signal.throwIfAborted();
      try {
        answer = parseConsultationAnswer(result.output, snapshot);
      } catch {
        if (attempt || (inputTokens !== null && inputTokens > 30000))
          throw new Error("consultation.errors.invalid");
      }
    }
    return { answer: answer!, auditIds, inputTokens, outputTokens, costEstimate };
  }
}
