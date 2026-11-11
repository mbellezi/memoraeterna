import { randomUUID } from "node:crypto";

import { createQuestionRepository, type PgPool, type QuestionRepository } from "@app/db";
import {
  ConsultationInputSchema,
  createAnswerStreamReader,
  evidenceHandleOrdinal,
  formatObjectAddress,
  type AskScope,
  type ConsultationEvidence,
  type ConsultationInput,
  type QuestionAnswerInput,
  type QuestionCitationInput,
  type QuestionMode,
  type QuestionPrivacy,
  type QuestionProvenance,
  type StreamedAnswerParagraph
} from "@app/domain";
import type { AiTextDelta } from "@app/ai";

import type {
  AppEvent,
  ConsultationDeltaParagraph,
  ConsultationStage
} from "../../shared/app-events.js";
import {
  QuestionsAskInputSchema,
  QuestionsCancelInputSchema,
  type QuestionsAskInput,
  type QuestionsAskResult,
  type QuestionsCancelInput
} from "../../shared/ipc-questions.js";
import { appEventPort } from "./app-events.js";
import {
  askErrorKey,
  isAskCanceled,
  type AskHooks,
  type ConsultationService,
  type PinnedProfile
} from "./consultation-service.js";

/**
 * Ask with a stored Question (F5 D14, spec 3.6). `ask` inserts the Question row, so
 * `memora://question/<id>` is valid from the first token, and answers at once; the answer is
 * written in the background through the consultation pipeline and travels on the bus: the stages as
 * `consultation.status` (never folded), the paragraphs written so far as `consultation.delta` (whole
 * paragraphs, each replacing the last), and the question itself as `object.changed` after each
 * commit. On completion the answer version and its citations are stored in one transaction; a
 * cancel stores a canceled version with the paragraphs written so far. An Ask stores only its own
 * Question: nothing else is saved.
 *
 * A citation of an answer is its evidence handle's number: the marker `[e3]` in the Markdown is the
 * citation of ordinal 3, a passage (chunk) read inside its source.
 */

/** What this service writes: the Question, its answer versions and its status. */
export type QuestionStore = Pick<QuestionRepository, "create" | "appendAnswer" | "setStatus">;

export interface QuestionsServiceOptions {
  getPool: () => PgPool | null;
  consultation: Pick<ConsultationService, "ask" | "cancel">;
  contentLanguage: () => Promise<string>;
  /** Where events go; the process-wide port by default (it reaches the bus once attached). */
  publish?: (event: AppEvent) => void;
  /** Builds the question store for a pool; the repository by default. */
  repository?: (pool: PgPool) => QuestionStore;
  now?: () => Date;
  logger?: Pick<Console, "warn">;
}

/** The provenance every answer states before its model is known, and its route. */
const answerRoute = "class:answer";

/** One Ask that is running: what a cancel needs to find it and what a stored answer needs. */
interface ActiveAsk {
  questionId: string;
  requestId: string;
  evidence: Map<string, ConsultationEvidence>;
  provenance: QuestionProvenance;
  paragraphs: readonly StreamedAnswerParagraph[];
  canceled: boolean;
  done: Promise<void>;
}

/** The scope of a question as the consultation pipeline takes it. */
export function consultationScopeOf(scope: AskScope) {
  if (scope.kind === "topic") return { topicId: scope.topicId };
  if (scope.kind === "sources") return { sourceIds: scope.sourceIds };
  return {};
}

/** How one cited passage is addressed: its source, with the passage (and span) as the anchor. */
function citationTarget(evidence: ConsultationEvidence) {
  const anchor = {
    passage: evidence.chunkId,
    ...(evidence.sourceSpanId ? { span: evidence.sourceSpanId } : {})
  };
  return { address: formatObjectAddress({ kind: "source", id: evidence.sourceItemId }), anchor };
}

export class QuestionsService {
  private readonly active = new Map<string, ActiveAsk>();

  public constructor(private readonly options: QuestionsServiceOptions) {}

  private publish(event: AppEvent) {
    try {
      (this.options.publish ?? appEventPort.publish.bind(appEventPort))(event);
    } catch (error) {
      // Publishing never ends an Ask: the answer is stored either way.
      this.options.logger?.warn("An Ask event could not be published.", error);
    }
  }

  private pool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("consultation.errors.unavailable");
    return pool;
  }

  private repository(): QuestionStore {
    const pool = this.pool();
    return (this.options.repository ?? createQuestionRepository)(pool);
  }

  /**
   * Stores the Question and answers with its ids; the answer is written in the background. A
   * request the consultation pipeline would refuse is refused here, before a row exists for it.
   */
  public async ask(raw: QuestionsAskInput): Promise<QuestionsAskResult> {
    const input = QuestionsAskInputSchema.parse(raw);
    const scope: AskScope = input.scope ?? { kind: "library" };
    const privacy: QuestionPrivacy = input.privacy ?? "offline_only";
    const mode: QuestionMode = input.mode ?? "text";
    const requestId = randomUUID();
    const consultation = ConsultationInputSchema.parse({
      requestId,
      question: input.text,
      ...consultationScopeOf(scope),
      privacy,
      mode
    });
    const repository = this.repository();
    const language = await this.options.contentLanguage();
    const question = await repository.create({ text: input.text, language, scope, privacy, mode });
    this.publish({
      type: "object.changed",
      refs: [{ kind: "question", id: question.id, change: "created" }]
    });
    this.begin(repository, question.id, requestId, consultation);
    return { questionId: question.id, requestId };
  }

  /**
   * Ends the Ask of `requestId`. Its paragraphs so far are stored as a canceled version by the Ask
   * itself as it winds down. Null when no such Ask runs (it ended, or never was).
   */
  public async cancel(raw: QuestionsCancelInput): Promise<null> {
    const { requestId } = QuestionsCancelInputSchema.parse(raw);
    const ask = this.active.get(requestId);
    if (!ask) return null;
    ask.canceled = true;
    await this.options.consultation.cancel(requestId);
    return null;
  }

  /** Resolves when every Ask that is running has stored its end (tests, and a quiet shutdown). */
  public async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  /** Starts the background run of one Ask whose Question exists. */
  private begin(
    repository: QuestionStore,
    questionId: string,
    requestId: string,
    consultation: ConsultationInput
  ) {
    const ask: ActiveAsk = {
      questionId,
      requestId,
      evidence: new Map(),
      provenance: { route: answerRoute },
      paragraphs: [],
      canceled: false,
      done: Promise.resolve()
    };
    this.active.set(requestId, ask);
    ask.done = this.run(repository, ask, consultation)
      .catch((error: unknown) =>
        this.options.logger?.warn("An Ask ended without storing its end.", error)
      )
      .finally(() => this.active.delete(requestId));
  }

  private status(ask: ActiveAsk, stage: ConsultationStage, error?: string) {
    this.publish({
      type: "consultation.status",
      requestId: ask.requestId,
      questionId: ask.questionId,
      stage,
      ...(error === undefined ? {} : { error })
    });
  }

  /** The delta paragraphs of what the reader holds: citations whose passage is unknown are left out. */
  private deltaParagraphs(
    ask: ActiveAsk,
    paragraphs: readonly StreamedAnswerParagraph[]
  ): ConsultationDeltaParagraph[] {
    return paragraphs.map((paragraph) => ({
      markdown: paragraph.markdown,
      citations: paragraph.citations.flatMap((handle) => {
        const evidence = ask.evidence.get(handle);
        const ordinal = evidenceHandleOrdinal(handle);
        if (!evidence || ordinal === null) return [];
        return [{ ordinal, ...citationTarget(evidence) }];
      })
    }));
  }

  private delta(ask: ActiveAsk, paragraphs: ConsultationDeltaParagraph[], restart: boolean) {
    this.publish({
      type: "consultation.delta",
      requestId: ask.requestId,
      questionId: ask.questionId,
      paragraphs,
      restart
    });
  }

  /** The paragraphs and citations to store for what was written: only citations that resolve. */
  private storedAnswer(
    ask: ActiveAsk,
    paragraphs: readonly StreamedAnswerParagraph[]
  ): Pick<QuestionAnswerInput, "paragraphs" | "citations"> {
    const citations = new Map<number, QuestionCitationInput>();
    const stored = paragraphs.map((paragraph) => {
      const ordinals: number[] = [];
      for (const handle of paragraph.citations) {
        const evidence = ask.evidence.get(handle);
        const ordinal = evidenceHandleOrdinal(handle);
        if (!evidence || ordinal === null) continue;
        ordinals.push(ordinal);
        citations.set(ordinal, {
          ordinal,
          kind: "chunk",
          targetId: evidence.chunkId,
          ...(evidence.sourceSpanId ? { anchor: { span: evidence.sourceSpanId } } : {})
        });
      }
      return { markdown: paragraph.markdown, citations: ordinals };
    });
    return { paragraphs: stored, citations: [...citations.values()] };
  }

  private async run(
    repository: QuestionStore,
    ask: ActiveAsk,
    consultation: ConsultationInput
  ): Promise<void> {
    const now = this.options.now ?? (() => new Date());
    const startedAt = now();
    const reader = createAnswerStreamReader();
    const hooks: AskHooks = {
      onStatus: (stage) => this.status(ask, stage),
      onPrepared: ({ evidence, profile, promptFingerprint }) => {
        ask.evidence = new Map(evidence.map((entry) => [entry.handle, entry]));
        ask.provenance = provenanceOf(profile, promptFingerprint);
      },
      onText: (event: AiTextDelta) => {
        if (event.restart) {
          // The provider wrote the answer again: what was shown is void, and the next delta says so.
          reader.reset();
          ask.paragraphs = [];
          this.delta(ask, [], true);
        }
        const before = reader.state().paragraphs;
        const after = reader.push(event.delta).paragraphs;
        if (after === before) return;
        ask.paragraphs = after;
        this.delta(ask, this.deltaParagraphs(ask, after), false);
      }
    };
    try {
      const result = await this.options.consultation.ask(consultation, hooks);
      // The stored answer is the one the whole output parsed to; the stream was a preview of it.
      const final: StreamedAnswerParagraph[] = result.answer.paragraphs.map((paragraph) => ({
        markdown: paragraph.markdown,
        citations: paragraph.citations
      }));
      const completedAt = now();
      const stored = await repository.appendAnswer(ask.questionId, {
        ...this.storedAnswer(ask, final),
        provenance: {
          ...ask.provenance,
          ...(result.inputTokens === null ? {} : { inputTokens: result.inputTokens }),
          ...(result.outputTokens === null ? {} : { outputTokens: result.outputTokens }),
          ...(result.costEstimate === null ? {} : { costEstimate: result.costEstimate })
        },
        status: "complete",
        startedAt,
        completedAt
      });
      if (!stored) {
        // The owner deleted the question while it ran: nothing is stored and the Ask is over.
        this.status(ask, "canceled");
        return;
      }
      ask.paragraphs = final;
      this.delta(ask, this.deltaParagraphs(ask, final), false);
      this.publish({
        type: "object.changed",
        refs: [{ kind: "question", id: ask.questionId, change: "updated" }]
      });
      this.status(ask, "done");
    } catch (error) {
      await this.end(repository, ask, error, startedAt, now());
    }
  }

  /** Stores how an Ask that did not complete ended, and says so. */
  private async end(
    repository: QuestionStore,
    ask: ActiveAsk,
    error: unknown,
    startedAt: Date,
    endedAt: Date
  ) {
    const canceled = ask.canceled || isAskCanceled(error);
    const errorKey = askErrorKey(error);
    try {
      let kept = true;
      if (canceled) {
        const stored = await repository.appendAnswer(ask.questionId, {
          ...this.storedAnswer(ask, ask.paragraphs),
          provenance: ask.provenance,
          status: "canceled",
          startedAt,
          completedAt: endedAt
        });
        kept = stored !== null;
      } else {
        kept = await repository.setStatus(ask.questionId, "failed", errorKey);
      }
      if (kept)
        this.publish({
          type: "object.changed",
          refs: [{ kind: "question", id: ask.questionId, change: "updated" }]
        });
    } catch (storeError) {
      this.options.logger?.warn("The end of an Ask could not be stored.", storeError);
    }
    if (canceled) this.status(ask, "canceled");
    else this.status(ask, "failed", errorKey);
  }
}

/** Who wrote an answer: the route, provider, model and runtime of the pinned profile and the prompt. */
function provenanceOf(profile: PinnedProfile, promptFingerprint: string): QuestionProvenance {
  return {
    route: answerRoute,
    provider: profile.provider,
    model: profile.modelId,
    runtime: profile.runtime,
    promptRevisionId: promptFingerprint
  };
}

export function createQuestionsService(options: QuestionsServiceOptions): QuestionsService {
  return new QuestionsService(options);
}
