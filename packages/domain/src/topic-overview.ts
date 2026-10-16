import { z } from "zod";

import { clipCharacters } from "./note-page.js";
import { TopicOverviewStateSchema, topicReadLimits } from "./topics.js";

// The lazy overview of a topic (F2 T31, D16): prose written when the Topic page opens, from the
// topic's central notes and their passages (the evidence E1..En), with every citation mapped to
// that evidence, a support check by the ranker and a cache per member fingerprint, prompt revision
// and content language. This module holds the contracts and the pure rules; the desktop service
// reads the evidence, calls the writer and the ranker, and stores the result.

const uuid = z.string().uuid();

/** Typed limits of an overview (rules: numbers live in typed configuration with tests). */
export const topicOverviewLimits = {
  /**
   * Estimated tokens the evidence of one overview may take. Evidence is chosen as whole items (a
   * note, its idea and its passage) in centrality order until the budget is spent; a passage is
   * never cut, and an item that does not fit is left out whole.
   */
  evidenceTokenBudget: 8_000,
  /** Evidence items at most (E1..En); every citation of the answer maps to one of them. */
  maxEvidence: 16,
  /** Central notes read per topic of the subtree, round by round (the best of each topic first). */
  candidatesPerTopic: 16,
  /** Candidates read at most for one overview, whatever the size of the subtree. */
  maxCandidates: 400,
  /** Characters per estimated token: a conservative planning bound, not a tokenizer. */
  charsPerToken: 3,
  /** Paragraphs the prompt asks for at most (the contract allows `overviewParagraphsMax`). */
  maxParagraphs: 5,
  /** The longest paragraph accepted from the model. */
  paragraphMaxChars: 1_500,
  /** Active time a writing may take (waiting for the AI queue does not count). */
  timeoutMs: 180_000,
  /** Output allowance: a few paragraphs, with room for a route that cannot turn reasoning off. */
  maxOutputTokens: 4_096,
  /** A sentence is supported when a passage it cites scores at least this (the ranker's p(yes)). */
  supportThreshold: 0.5,
  /** Sentences the support check scores at most (one ranker call each). */
  maxSupportSentences: 40,
  /** Passages one ranker call scores at most (the rank request allows 32). */
  maxSupportDocuments: 16
} as const;

/** `topics.overview`: the overview of a topic, written now when there is none (or `force`). */
export const TopicOverviewInputSchema = z
  .object({ id: uuid, force: z.boolean().optional() })
  .strict();
export type TopicOverviewInput = z.input<typeof TopicOverviewInputSchema>;

/** `topics.overview.cancel`: stops the overview being written (and checked) for a topic. */
export const TopicOverviewCancelInputSchema = z.object({ id: uuid }).strict();
export type TopicOverviewCancelInput = z.infer<typeof TopicOverviewCancelInputSchema>;

/** The answer of `topics.overview`: the same state a Topic page carries. */
export const TopicOverviewResultSchema = TopicOverviewStateSchema;

/** Message keys of the overview's own outcomes (the renderer localizes them). */
export const topicOverviewMessageKeys = {
  root: "topics.overview.reasons.root",
  empty: "topics.overview.reasons.empty",
  noWriter: "topics.overview.reasons.noWriter",
  unavailable: "topics.overview.reasons.unavailable",
  canceled: "topics.overview.reasons.canceled",
  invalid: "topics.overview.errors.invalid",
  tooLarge: "topics.overview.errors.tooLarge",
  failed: "topics.overview.errors.failed",
  timeout: "topics.overview.errors.timeout"
} as const;

// ---------------------------------------------------------------------------
// Evidence

/** A central note the overview may be written from, with its primary passage. */
export interface OverviewEvidenceCandidate {
  noteId: string;
  title: string;
  idea: string;
  passage: string;
  /** Rank of the note inside its own topic (0 = the most central one). */
  round: number;
  centrality: number | null;
  /** A content key (title, idea and passage) that orders equally central notes. */
  contentKey: string;
}

/** Estimated tokens of a text: a planning bound (`charsPerToken`), never a tokenizer count. */
export function estimateOverviewTokens(text: string): number {
  return Math.ceil(Array.from(text).length / topicOverviewLimits.charsPerToken);
}

/** What one evidence item costs in the prompt: its title, idea and whole passage, plus framing. */
export function overviewEvidenceTokens(item: {
  title: string;
  idea: string;
  passage: string;
}): number {
  return (
    estimateOverviewTokens(item.title) +
    estimateOverviewTokens(item.idea) +
    estimateOverviewTokens(item.passage) +
    16
  );
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Evidence order (D22, `rules/ai.md`): the most central note of every topic of the subtree first,
 * then the second of each, and so on; inside a round by centrality, then by content. An ID only
 * breaks a tie between notes with the same content.
 */
export function orderOverviewCandidates<T extends OverviewEvidenceCandidate>(
  candidates: readonly T[]
): T[] {
  return [...candidates].sort(
    (a, b) =>
      a.round - b.round ||
      (b.centrality ?? Number.NEGATIVE_INFINITY) - (a.centrality ?? Number.NEGATIVE_INFINITY) ||
      compareText(a.contentKey, b.contentKey) ||
      compareText(a.noteId, b.noteId)
  );
}

/**
 * The evidence E1..En: whole items in evidence order within the token budget, at most `maxItems`.
 * An item that does not fit is left out whole and a smaller one after it may still fit; nothing
 * is ever cut. The same note is never taken twice.
 */
export function selectOverviewEvidence<T extends OverviewEvidenceCandidate>(
  candidates: readonly T[],
  options: { budget?: number; maxItems?: number } = {}
): { evidence: T[]; tokens: number } {
  const budget = options.budget ?? topicOverviewLimits.evidenceTokenBudget;
  const maxItems = options.maxItems ?? topicOverviewLimits.maxEvidence;
  const evidence: T[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  for (const candidate of orderOverviewCandidates(candidates)) {
    if (evidence.length >= maxItems) break;
    if (seen.has(candidate.noteId)) continue;
    const cost = overviewEvidenceTokens(candidate);
    if (tokens + cost > budget) continue;
    seen.add(candidate.noteId);
    evidence.push(candidate);
    tokens += cost;
  }
  return { evidence, tokens };
}

/** The excerpt a citation keeps for display: the passage, cut at a word near the contract bound. */
export function overviewExcerpt(passage: string): string {
  const text = passage.replace(/\s+/gu, " ").trim();
  const max = topicReadLimits.overviewExcerptMax;
  if (Array.from(text).length <= max) return text;
  const clipped = clipCharacters(text, max - 1);
  const space = clipped.lastIndexOf(" ");
  return `${space > max / 2 ? clipped.slice(0, space) : clipped}…`;
}

// ---------------------------------------------------------------------------
// The model's answer

/** The wire contract of the answer; meaning (every citation maps to evidence) is checked below. */
export const TopicOverviewOutputSchema = z.object({
  paragraphs: z
    .array(
      z.object({
        text: z.string(),
        citations: z.array(z.union([z.number(), z.string()])).default([])
      })
    )
    .min(1)
});

/** A marker in the text: `[2]`, `[1, 3]`, `[2-4]` or `[E2]`. */
const markerPattern = /\[\s*E?\d{1,3}(?:\s*(?:[,;]|[-–])\s*E?\d{1,3})*\s*\]/giu;
const tagPattern = /<\/?[a-z][a-z0-9-]*\b[^>]*>/iu;

/** The evidence numbers a marker names, ranges expanded. */
function markerNumbers(marker: string): number[] {
  const numbers: number[] = [];
  for (const part of marker.slice(1, -1).split(/[,;]/u)) {
    const range = /^\s*E?(\d{1,3})\s*(?:[-–]\s*E?(\d{1,3}))?\s*$/iu.exec(part);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (to < from || to - from > topicReadLimits.overviewCitationsMax) {
      numbers.push(from, to);
      continue;
    }
    for (let n = from; n <= to; n += 1) numbers.push(n);
  }
  return numbers;
}

function listedNumber(value: number | string): number | null {
  const parsed = typeof value === "number" ? value : /^\s*E?(\d{1,3})\s*$/iu.exec(value)?.[1];
  const n = typeof parsed === "string" ? Number(parsed) : parsed;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

export interface ValidatedOverview {
  /** Paragraphs whose markers and citations are renumbered 1..k in order of first citation. */
  paragraphs: Array<{ text: string; citations: number[] }>;
  /** `cited[k - 1]` is the evidence number (1-based) that citation k stands for. */
  cited: number[];
}

export type OverviewValidation =
  { ok: true; overview: ValidatedOverview } | { ok: false; errors: string[] };

/**
 * Checks an answer against the evidence it was written from: at most `maxParagraphs` paragraphs of
 * plain text, each citing at least one evidence item, and every number (in a marker or the list)
 * one of E1..En. A valid answer is renumbered so its citations read 1, 2, 3 in order of first
 * appearance, the markers in the text included. Errors are written for the repair prompt.
 */
export function validateOverviewOutput(output: unknown, evidenceCount: number): OverviewValidation {
  const parsed = TopicOverviewOutputSchema.safeParse(output);
  if (!parsed.success)
    return { ok: false, errors: ["The answer is not the JSON shape asked for."] };
  const errors: string[] = [];
  const paragraphs = parsed.data.paragraphs;
  if (paragraphs.length > topicOverviewLimits.maxParagraphs) {
    errors.push(
      `Write at most ${topicOverviewLimits.maxParagraphs} paragraphs (the answer has ${paragraphs.length}).`
    );
  }
  const drafts: Array<{ text: string; order: number[] }> = [];
  paragraphs.forEach((paragraph, index) => {
    const label = `Paragraph ${index + 1}`;
    const text = paragraph.text.replace(/\s+/gu, " ").trim();
    if (!text) {
      errors.push(`${label} is empty.`);
      return;
    }
    if (tagPattern.test(text)) errors.push(`${label} contains markup; write plain text.`);
    if (Array.from(text).length > topicOverviewLimits.paragraphMaxChars) {
      errors.push(`${label} is longer than ${topicOverviewLimits.paragraphMaxChars} characters.`);
    }
    const order: number[] = [];
    for (const marker of text.match(markerPattern) ?? []) order.push(...markerNumbers(marker));
    for (const value of paragraph.citations) {
      const n = listedNumber(value);
      if (n === null) errors.push(`${label} lists a citation that is not an evidence number.`);
      else order.push(n);
    }
    const unknown = [...new Set(order.filter((n) => n < 1 || n > evidenceCount))];
    if (unknown.length > 0) {
      errors.push(
        `${label} cites ${unknown.map((n) => `[${n}]`).join(", ")}, which is not in the evidence ` +
          `(the evidence is numbered 1 to ${evidenceCount}).`
      );
    }
    if (order.length === 0) errors.push(`${label} cites no evidence; cite what supports it.`);
    drafts.push({ text, order });
  });
  if (errors.length > 0) return { ok: false, errors };

  const renumber = new Map<number, number>();
  const cited: number[] = [];
  const numberOf = (evidence: number) => {
    let n = renumber.get(evidence);
    if (n === undefined) {
      cited.push(evidence);
      n = cited.length;
      renumber.set(evidence, n);
    }
    return n;
  };
  const result = drafts.map((draft) => {
    for (const evidence of draft.order) numberOf(evidence);
    const text = draft.text.replace(markerPattern, (marker) => {
      const numbers = [...new Set(markerNumbers(marker).map(numberOf))].sort((a, b) => a - b);
      return `[${numbers.join(", ")}]`;
    });
    const citations = [...new Set(draft.order.map(numberOf))].sort((a, b) => a - b);
    return { text, citations };
  });
  if (cited.length > topicReadLimits.overviewCitationsMax) {
    return {
      ok: false,
      errors: [`Cite at most ${topicReadLimits.overviewCitationsMax} evidence items.`]
    };
  }
  return { ok: true, overview: { paragraphs: result, cited } };
}

// ---------------------------------------------------------------------------
// Text segments (the renderer shows markers as citation buttons) and the support check

export type OverviewTextSegment =
  { kind: "text"; text: string } | { kind: "citation"; numbers: number[] };

/** A stored paragraph as text and citation markers; a marker naming no citation stays text. */
export function overviewTextSegments(
  text: string,
  known: (n: number) => boolean = () => true
): OverviewTextSegment[] {
  const segments: OverviewTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(markerPattern)) {
    const index = match.index ?? 0;
    const numbers = [...new Set(markerNumbers(match[0]))].filter(known);
    if (numbers.length === 0) continue;
    if (index > last) segments.push({ kind: "text", text: text.slice(last, index) });
    segments.push({ kind: "citation", numbers });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

export interface OverviewSentence {
  paragraph: number;
  /** The sentence without its markers: the ranker's query. */
  text: string;
  /** The citations it makes, or its paragraph's when it makes none. */
  citations: number[];
}

/** Shorter pieces (a closing remark, a split abbreviation) join the sentence before them. */
const minSentenceChars = 24;
/**
 * Where a sentence ends: final punctuation, closing quotes and citation markers, then space before a
 * capital, a digit or an opening quote ("e.g. at noon" does not end a sentence).
 */
const sentenceBoundary = /(?<=[.!?…]["'”’)]*(?:\s*\[[^\]]*\])*)\s+(?=["“'‘(]?[\p{Lu}\p{N}])/u;

/**
 * The sentences of an overview as the support check scores them: each with the citations its own
 * markers make, or, without markers, with every citation of its paragraph.
 */
export function overviewSentences(
  paragraphs: ReadonlyArray<{ text: string; citations: readonly number[] }>
): OverviewSentence[] {
  const sentences: OverviewSentence[] = [];
  paragraphs.forEach((paragraph, index) => {
    const pieces: string[] = [];
    for (const piece of paragraph.text.split(sentenceBoundary)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const previous = pieces.length - 1;
      if (previous >= 0 && trimmed.replace(markerPattern, "").trim().length < minSentenceChars) {
        pieces[previous] = `${pieces[previous]} ${trimmed}`;
      } else pieces.push(trimmed);
    }
    for (const piece of pieces) {
      const own = [...new Set((piece.match(markerPattern) ?? []).flatMap(markerNumbers))].filter(
        (n) => paragraph.citations.includes(n)
      );
      const text = piece
        .replace(markerPattern, "")
        .replace(/\s+/gu, " ")
        .replace(/\s+([.,;:!?…])/gu, "$1")
        .trim();
      if (!text) continue;
      sentences.push({
        paragraph: index,
        text,
        citations: own.length > 0 ? own.sort((a, b) => a - b) : [...paragraph.citations]
      });
    }
  });
  return sentences;
}

export interface OverviewSupportVerdict {
  status: "verified" | "partial";
  unsupported: number[];
  sentences: { checked: number; supported: number };
}

/**
 * The verdict of the support check: a sentence is supported when one of the passages it cites
 * scores at least the threshold; a paragraph with an unsupported sentence is listed.
 */
export function overviewSupportVerdict(
  sentences: ReadonlyArray<Pick<OverviewSentence, "paragraph">>,
  bestScores: readonly number[],
  threshold: number = topicOverviewLimits.supportThreshold
): OverviewSupportVerdict {
  const unsupported = new Set<number>();
  let supported = 0;
  sentences.forEach((sentence, index) => {
    if ((bestScores[index] ?? 0) >= threshold) supported += 1;
    else unsupported.add(sentence.paragraph);
  });
  return {
    status: unsupported.size === 0 ? "verified" : "partial",
    unsupported: [...unsupported].sort((a, b) => a - b),
    sentences: { checked: sentences.length, supported }
  };
}
