import {
  formatObjectAddress,
  parseObjectAddress,
  type ObjectAnchor,
  type QuestionProvenance
} from "@app/domain";

import type { AppEventOf, ConsultationStage } from "../../../../shared/app-events";
import type {
  QuestionAnswerView,
  QuestionCitationView,
  QuestionView
} from "../../../../shared/ipc-questions";

/**
 * The rules of the Ask panel and the Question page (design record §6.4, §10.3; D14), apart from the
 * screen: how the streamed paragraphs merge, which of the six stages the answer is in, how the
 * citations number in reading order, and which words a paragraph breaks into (text and chips).
 * Pure, so each rule has a test.
 */

/** The stages of one Ask, as `consultation.status` names them. */
export type AnswerStage = ConsultationStage;

export const liveStages: readonly AnswerStage[] = ["retrieving", "answering", "waitingForProvider"];
export const isLiveStage = (stage: AnswerStage): boolean => liveStages.includes(stage);
export const isEndStage = (stage: AnswerStage): boolean => !isLiveStage(stage);

/** One citation of a paragraph, from a streamed delta or a stored answer. */
export interface CitationRef {
  /** The number in the paragraph's `[e3]` marker. */
  ordinal: number;
  /** The object the passage is read in; null when that object is gone. */
  address: string | null;
  anchor?: ObjectAnchor | undefined;
  /** The cited target no longer exists. */
  unavailable: boolean;
  /** The cited target changed after the answer was stored. */
  stale: boolean;
}

export interface AnswerParagraph {
  markdown: string;
  citations: CitationRef[];
}

// ---------------------------------------------------------------------------------------------
// Addresses

/** The address a citation opens: its object with the passage and span it points at. */
export function citationAddress(citation: CitationRef): string | null {
  if (citation.address === null) return null;
  const parsed = parseObjectAddress(citation.address);
  if (!parsed) return null;
  const anchor = citation.anchor ?? parsed.anchor;
  return formatObjectAddress({
    kind: parsed.kind,
    id: parsed.id,
    ...(anchor && Object.keys(anchor).length > 0 ? { anchor } : {})
  });
}

/** The object of a citation with no anchor: where "ver a fonte" leads. */
export function citationObject(citation: CitationRef): string | null {
  if (citation.address === null) return null;
  const parsed = parseObjectAddress(citation.address);
  return parsed ? formatObjectAddress({ kind: parsed.kind, id: parsed.id }) : null;
}

// ---------------------------------------------------------------------------------------------
// The stream

/** What the bus told of the Ask that is writing this Question. */
export interface StreamState {
  requestId: string | null;
  /** Null until the first event of the request. */
  stage: AnswerStage | null;
  paragraphs: AnswerParagraph[];
  /** The message key or redacted text of a failure. */
  error?: string | undefined;
}

export const emptyStream: StreamState = { requestId: null, stage: null, paragraphs: [] };

type DeltaEvent = Pick<AppEventOf<"consultation.delta">, "requestId" | "paragraphs" | "restart">;
type StatusEvent = Pick<AppEventOf<"consultation.status">, "requestId" | "stage" | "error">;

const sameParagraphs = (a: readonly AnswerParagraph[], b: readonly AnswerParagraph[]): boolean =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

/** A streamed paragraph as the page keeps it (delta citations are never unavailable or stale). */
function fromDelta(paragraph: DeltaEvent["paragraphs"][number]): AnswerParagraph {
  return {
    markdown: paragraph.markdown,
    citations: paragraph.citations.map((citation) => ({
      ordinal: citation.ordinal,
      address: citation.address,
      ...(citation.anchor ? { anchor: citation.anchor as ObjectAnchor } : {}),
      unavailable: false,
      stale: false
    }))
  };
}

/**
 * The state a request starts from: its own, or the one it replaces. A request that is not the one
 * being tracked is a new run (Ask again) when the tracked one has ended; while one is live, another
 * request's events are not this stream's.
 */
function forRequest(state: StreamState, requestId: string): StreamState | null {
  if (state.requestId === requestId) return state;
  if (state.requestId === null || state.stage === null || isEndStage(state.stage))
    return { requestId, stage: null, paragraphs: [] };
  return null;
}

/**
 * The state after a `consultation.delta`. A delta carries every complete paragraph so far, so it
 * replaces the last one and applying it twice changes nothing; one shorter than what is shown is an
 * older one that arrived late and is dropped, and `restart` (the provider retried) voids what was
 * shown. A delta means the answer is being written, unless the request already ended.
 */
export function applyDelta(state: StreamState, event: DeltaEvent): StreamState {
  const base = forRequest(state, event.requestId);
  if (!base) return state;
  if (base.stage !== null && isEndStage(base.stage)) return base === state ? state : base;
  const paragraphs = event.paragraphs.map(fromDelta);
  const next: StreamState = {
    requestId: event.requestId,
    stage: base.stage === "waitingForProvider" || base.stage === null ? "answering" : base.stage,
    paragraphs:
      event.restart || paragraphs.length >= base.paragraphs.length ? paragraphs : base.paragraphs,
    ...(base.error === undefined ? {} : { error: base.error })
  };
  if (next.stage === "retrieving") next.stage = "answering";
  return base === state &&
    next.stage === state.stage &&
    sameParagraphs(next.paragraphs, state.paragraphs)
    ? state
    : next;
}

/** The state after a `consultation.status`: the end stages stick, and the live ones move forward. */
export function applyStatus(state: StreamState, event: StatusEvent): StreamState {
  const base = forRequest(state, event.requestId);
  if (!base) return state;
  if (base.stage !== null && isEndStage(base.stage)) {
    if (base === state) return state;
    // A new request ended before it said anything: it starts from its own stage.
  }
  const next: StreamState = {
    requestId: event.requestId,
    stage: event.stage,
    paragraphs: base.paragraphs,
    ...(event.error === undefined ? {} : { error: event.error })
  };
  // A stage never goes back from answering to retrieving (a late event); waiting may return.
  if (base.stage !== null && isLiveStage(base.stage) && event.stage === "retrieving")
    next.stage = base.stage;
  return base === state && next.stage === state.stage && next.error === state.error ? state : next;
}

/** A stream that starts for a request the page asked for (Ask again): its first stage is retrieving. */
export function streamFor(requestId: string): StreamState {
  return { requestId, stage: "retrieving", paragraphs: [] };
}

// ---------------------------------------------------------------------------------------------
// What the page shows

/** The answer as the page shows it now: a stream that is live or just ended, or a stored version. */
export interface ShownAnswer {
  stage: AnswerStage;
  paragraphs: AnswerParagraph[];
  /** The answer is still being written (the stage is live). */
  live: boolean;
  /** "May be outdated": a cited source changed after the answer was stored. */
  stale: boolean;
  /** The message key or redacted text of a failure. */
  error?: string | undefined;
  completedAt?: string | undefined;
  provenance?: QuestionProvenance | undefined;
  /** The stored version on screen (1-based), or 0 while the answer is the stream's. */
  version: number;
  versions: number;
}

const answerStage = (status: QuestionAnswerView["status"]): AnswerStage =>
  status === "complete" ? "done" : status === "canceled" ? "canceled" : "failed";

const questionStage = (status: QuestionView["status"]): AnswerStage =>
  status === "running"
    ? "retrieving"
    : status === "complete"
      ? "done"
      : status === "canceled"
        ? "canceled"
        : "failed";

const fromStored = (citation: QuestionCitationView): CitationRef => ({
  ordinal: citation.ordinal,
  address: citation.address,
  ...(citation.anchor ? { anchor: citation.anchor as ObjectAnchor } : {}),
  unavailable: citation.unavailable,
  stale: citation.stale
});

/** The stored paragraphs of one answer version. */
export function storedParagraphs(answer: QuestionAnswerView): AnswerParagraph[] {
  return answer.paragraphs.map((paragraph) => ({
    markdown: paragraph.markdown,
    citations: paragraph.citations.map(fromStored)
  }));
}

/**
 * What to show of a Question: the stream while an Ask is writing it (and until the stored answer
 * is read after the stream ended), else the stored version `picked` (1-based; the newest by
 * default). A Question that failed or was stopped before any version was stored shows what the
 * stream had written.
 */
export function shownAnswer(
  question: QuestionView,
  stream: StreamState,
  picked: number | null = null
): ShownAnswer {
  const versions = question.answers.length;
  if (question.status === "running") {
    // An Ask is writing it: the stream is the answer (a stored version waits for the new one), and
    // an ended stream whose stored answer is not read yet still shows what it wrote.
    const stage = stream.stage ?? "retrieving";
    return {
      stage,
      paragraphs: stream.paragraphs,
      live: isLiveStage(stage),
      stale: false,
      error: stream.error,
      version: 0,
      versions
    };
  }
  const index = picked === null ? versions : Math.min(Math.max(picked, 1), versions);
  const answer = index > 0 ? question.answers[index - 1] : undefined;
  if (!answer) {
    // Nothing stored: a failure or a stop before the first version keeps the stream's paragraphs.
    const stage = questionStage(question.status);
    return {
      stage,
      paragraphs: stream.paragraphs,
      live: false,
      stale: false,
      error: question.errorKey ?? stream.error,
      version: 0,
      versions
    };
  }
  const stage = index === versions ? questionStage(question.status) : answerStage(answer.status);
  return {
    stage: stage === "retrieving" ? answerStage(answer.status) : stage,
    paragraphs: storedParagraphs(answer),
    live: false,
    stale: answer.stale && answer.status === "complete",
    error: index === versions ? question.errorKey : undefined,
    completedAt: answer.completedAt,
    provenance: answer.model,
    version: index,
    versions
  };
}

// ---------------------------------------------------------------------------------------------
// Citations in reading order

/** One entry of the sources list, numbered as its chips are. */
export interface SourceEntry {
  /** The number the chips show: reading order, from 1. */
  number: number;
  citation: CitationRef;
  /** The passage the entry opens, or null when its object is gone. */
  open: string | null;
}

const markerPattern = /(\s*)\[e(\d{1,3})\]/g;

/** The ordinals of the markers in a paragraph's Markdown, in order. */
function markerOrdinals(markdown: string): number[] {
  return [...markdown.matchAll(markerPattern)].map((match) => Number(match[2]));
}

/**
 * The citations of an answer numbered in reading order: the first one the text reaches is 1. A
 * citation a paragraph lists but its text never marks follows that paragraph's marked ones. The
 * sources list, the chips and the tray all read these numbers, so they always agree.
 */
export function numberCitations(paragraphs: readonly AnswerParagraph[]): {
  sources: SourceEntry[];
  numberOf: ReadonlyMap<number, number>;
} {
  const numberOf = new Map<number, number>();
  const sources: SourceEntry[] = [];
  const take = (citation: CitationRef) => {
    if (numberOf.has(citation.ordinal)) return;
    const number = sources.length + 1;
    numberOf.set(citation.ordinal, number);
    sources.push({ number, citation, open: citationAddress(citation) });
  };
  for (const paragraph of paragraphs) {
    const byOrdinal = new Map(paragraph.citations.map((citation) => [citation.ordinal, citation]));
    for (const ordinal of markerOrdinals(paragraph.markdown)) {
      const citation = byOrdinal.get(ordinal);
      if (citation) take(citation);
    }
    for (const citation of paragraph.citations) take(citation);
  }
  return { sources, numberOf };
}

/** A run of a paragraph: words, or a citation chip. */
export type AnswerPiece =
  | { type: "text"; text: string }
  | { type: "cite"; ordinal: number; number: number; attached: boolean };

/**
 * A paragraph broken into its words and its chips. A chip attaches to the word before it (the
 * renderer joins them with a no-break thin space) and punctuation follows it directly; a marker
 * whose citation is not in the paragraph (it did not resolve) is dropped with its space.
 */
export function splitParagraph(
  paragraph: AnswerParagraph,
  numberOf: ReadonlyMap<number, number>
): AnswerPiece[] {
  const known = new Set(paragraph.citations.map((citation) => citation.ordinal));
  const pieces: AnswerPiece[] = [];
  let last = 0;
  const text = paragraph.markdown;
  for (const match of text.matchAll(markerPattern)) {
    const start = match.index ?? 0;
    const ordinal = Number(match[2]);
    const before = text.slice(last, start);
    last = start + match[0].length;
    if (before !== "") pieces.push({ type: "text", text: before });
    const number = numberOf.get(ordinal);
    if (known.has(ordinal) && number !== undefined)
      pieces.push({ type: "cite", ordinal, number, attached: (match[1] ?? "") !== "" });
  }
  const rest = text.slice(last);
  if (rest !== "") pieces.push({ type: "text", text: rest });
  return pieces;
}

/** The paragraph's words with no chips, for the compact form. */
export function plainText(markdown: string): string {
  return markdown
    .replace(markerPattern, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(memora:\/\/[^)]+\)/g, "$1")
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Copy and scope

/** The distinct sources behind the citations, for "6 fontes". */
export function citedObjectCount(sources: readonly SourceEntry[]): number {
  return new Set(sources.map((entry) => entry.open?.split("#")[0] ?? `gone:${entry.number}`)).size;
}

/**
 * The message key of a failure when it is one of ours, else null (a redacted provider text is
 * never shown as the sentence).
 */
export function failureKey(error: string | undefined): string | null {
  return error !== undefined && /^(questions|consultation)\.errors\.[A-Za-z]+$/.test(error)
    ? error
    : null;
}

/**
 * The message keys the consultation fails with when nothing in the library can rest an answer. The
 * backend never stores a finished answer with no paragraph: this failure is how "found nothing"
 * reaches the page, and asking again would fail the same way.
 */
const noEvidenceKeys: readonly string[] = [
  "consultation.errors.noRelevantEvidence",
  "consultation.errors.noTopicEvidence"
];

/** The Ask found nothing in the library to answer from (design record §6.4). */
export function foundNothing(shown: Pick<ShownAnswer, "stage" | "paragraphs" | "error">): boolean {
  if (shown.paragraphs.length > 0) return false;
  return (
    shown.stage === "done" ||
    (shown.stage === "failed" && shown.error !== undefined && noEvidenceKeys.includes(shown.error))
  );
}

/**
 * Whether the model that wrote an answer runs on this Mac or in the cloud, when its provenance says
 * so; null until it does. The Question's stored privacy is never read: routing ignores it, so it
 * would tell the person their question stayed on this Mac when it may not have.
 */
export function aiPlace(provenance: QuestionProvenance | undefined): "cloud" | "local" | null {
  const lane = `${provenance?.lane ?? ""} ${provenance?.runtime ?? ""} ${provenance?.route ?? ""}`;
  if (/local|mlx|llama|ollama/i.test(lane)) return "local";
  if (provenance?.provider !== undefined && provenance.provider !== "") return "cloud";
  return null;
}
