import { z } from "zod";

import { changeSetReadLimits, type OverviewDivergence } from "./change-sets.js";
import { clipCharacters, withinCharacters } from "./note-page.js";
import { TopicOverviewStateSchema, topicReadLimits } from "./topics.js";

// The lazy overview of a topic (F2 T31, D16): prose written when the Topic page opens, from the
// topic's central notes and their passages (the evidence E1..En), with every citation mapped to
// that evidence, a support check by the ranker and a cache per member fingerprint (F4 D9: the
// prompt and the language are provenance, never staleness). REFRESH (F4 D17, T84) keeps a stale
// overview current with additive patches: the stored text stays byte-identical and new paragraphs
// cite only new evidence, numbered after the stored citations. This module holds the contracts and
// the pure rules; the desktop service reads the evidence, calls the writer and the ranker, and
// stores the result.

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
  maxSupportDocuments: 16,
  /** Characters of a stored citation's excerpt a patch prompt shows (E1..Ek, for its Divergences). */
  patchCitedExcerptChars: 200,
  /**
   * Evidence items a stored overview keeps at most (`topic_overviews_shape`): a patch appends the
   * new evidence it offered, so it never offers more than the room left.
   */
  storedEvidenceMax: 40
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

// ---------------------------------------------------------------------------
// REFRESH (F4 D17, T84): additive patches of a stale overview

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const positive = (max: number) => z.number().positive().max(max);

/**
 * Typed configuration of REFRESH (`RULES.md` 1: numbers live in typed configuration). Start values
 * are *(cal.)*: the soak and the T84 proof confirm or revise them.
 */
export const TopicOverviewRefreshConfigSchema = z
  .object({
    /** A topic is refreshed only while its subtree holds at least this many placed notes. */
    minPlacedNotes: int(1, 100_000).default(3),
    /** A topic without an overview is refreshed only when it was opened within this many days. */
    openedWithinDays: int(1, 3_650).default(30),
    /** A request waits this long after the last placement change (an import keeps moving members). */
    debounceMs: int(0, 86_400_000).default(300_000),
    /** ...and never longer than this after the first request. */
    debounceMaxMs: int(0, 86_400_000).default(1_800_000),
    /**
     * Job priorities of REFRESH, below every other job of the model worker (they queue at 0): the
     * order among REFRESH jobs is dirtiness × views × recency, mapped onto this range.
     */
    priorityMin: int(-10_000, -1).default(-100),
    priorityMax: int(-10_000, -1).default(-1),
    /** The open count of a topic weighs half after this many days without an open. */
    viewHalfLifeDays: positive(3_650).default(14),
    /** Decayed opens at which the views factor stops growing. */
    viewsSaturation: positive(10_000).default(5),
    /** Recency halves after this many days since the last open. */
    recencyHalfLifeDays: positive(3_650).default(7),
    /** Views and recency never fall below this, so an unopened stale topic still orders by dirtiness. */
    factorFloor: z.number().min(0).max(1).default(0.05),
    /** Topics one placement change looks at most (bounded work per change). */
    maxTopicsPerChange: int(1, 10_000).default(200)
  })
  .strict()
  .refine((config) => config.priorityMin <= config.priorityMax, {
    message: "priorityMin must not exceed priorityMax"
  })
  .refine((config) => config.debounceMs <= config.debounceMaxMs, {
    message: "debounceMs must not exceed debounceMaxMs"
  });
export type TopicOverviewRefreshConfig = z.infer<typeof TopicOverviewRefreshConfigSchema>;

/** The start values, as typed configuration. */
export const topicOverviewRefreshConfig: TopicOverviewRefreshConfig =
  TopicOverviewRefreshConfigSchema.parse({});

/** An evidence item as the stored overview keeps it: its note and the hash of its passage. */
export interface OverviewEvidenceKey {
  noteId: string;
  contentHash: string;
}

/** A candidate of a patch: its note, its passage and the hash `contentHash` would store. */
export interface PatchEvidenceCandidate extends OverviewEvidenceCandidate {
  passageHash: string;
}

const evidenceKey = (noteId: string, hash: string) => `${noteId.toLowerCase()}:${hash}`;

/**
 * Dirtiness (D17): the share of the topic's current evidence candidates the stored overview was not
 * written from (a new note, or a note whose passage changed). 1 without a stored overview, 0 without
 * candidates.
 */
export function overviewDirtiness(
  candidates: ReadonlyArray<Pick<PatchEvidenceCandidate, "noteId" | "passageHash">>,
  stored: readonly OverviewEvidenceKey[] | null
): number {
  if (candidates.length === 0) return 0;
  if (stored === null) return 1;
  const seen = new Set(stored.map((item) => evidenceKey(item.noteId, item.contentHash)));
  const fresh = candidates.filter((item) => !seen.has(evidenceKey(item.noteId, item.passageHash)));
  return fresh.length / candidates.length;
}

/**
 * How much a REFRESH matters, in [0, 1]: dirtiness × views × recency (D17). Views are the open
 * count decayed by the age of the last open; recency halves every `recencyHalfLifeDays`. A topic
 * never opened keeps the floor on both, so it still orders by dirtiness.
 */
export function topicOverviewRefreshScore(
  input: { dirtiness: number; openCount: number; openedDaysAgo: number | null },
  config: TopicOverviewRefreshConfig = topicOverviewRefreshConfig
): number {
  const dirtiness = Math.min(
    1,
    Math.max(0, Number.isFinite(input.dirtiness) ? input.dirtiness : 0)
  );
  const age =
    input.openedDaysAgo === null || !Number.isFinite(input.openedDaysAgo)
      ? null
      : Math.max(0, input.openedDaysAgo);
  const decayed =
    age === null ? 0 : Math.max(0, input.openCount) * 0.5 ** (age / config.viewHalfLifeDays);
  const views = Math.min(1, decayed / config.viewsSaturation);
  const recency = age === null ? 0 : 0.5 ** (age / config.recencyHalfLifeDays);
  return dirtiness * Math.max(views, config.factorFloor) * Math.max(recency, config.factorFloor);
}

/** The job priority of a REFRESH request: its score mapped onto the configured range. */
export function topicOverviewRefreshPriority(
  score: number,
  config: TopicOverviewRefreshConfig = topicOverviewRefreshConfig
): number {
  const bounded = Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0));
  return config.priorityMin + Math.round(bounded * (config.priorityMax - config.priorityMin));
}

/** Paragraphs a patch may add to an overview of `existing` paragraphs (0 when it is full). */
export function overviewPatchParagraphsMax(existing: number): number {
  return Math.max(
    0,
    Math.min(topicOverviewLimits.maxParagraphs, topicReadLimits.overviewParagraphsMax - existing)
  );
}

/** A stored citation's excerpt as the patch prompt shows it: cut at a word near the bound. */
export function overviewPatchCitedExcerpt(excerpt: string): string {
  const text = excerpt.replace(/\s+/gu, " ").trim();
  const max = topicOverviewLimits.patchCitedExcerptChars;
  if (Array.from(text).length <= max) return text;
  const clipped = clipCharacters(text, max - 1);
  const space = clipped.lastIndexOf(" ");
  return `${space > max / 2 ? clipped.slice(0, space) : clipped}…`;
}

/**
 * What the patch prompt spends before its new evidence: the stored paragraphs and the short
 * excerpts of the citations they make, with their framing.
 */
export function overviewPatchBaseTokens(
  paragraphs: ReadonlyArray<{ text: string }>,
  citedExcerpts: readonly string[] = []
): number {
  const text = (value: string, framing: number) => estimateOverviewTokens(value) + framing;
  return (
    paragraphs.reduce((total, paragraph) => total + text(paragraph.text, 8), 0) +
    citedExcerpts.reduce(
      (total, excerpt) => total + text(overviewPatchCitedExcerpt(excerpt), 16),
      0
    )
  );
}

/**
 * The new evidence of a patch (D17): the candidates the stored overview was not written from, in
 * evidence order, as whole items within the evidence budget minus the stored paragraphs and their
 * citations' excerpts, and at most as many as citations and stored evidence have room left (the
 * patched row keeps the stored evidence and every item offered). A candidate the overview already
 * saw is never offered again.
 */
export function selectPatchEvidence<T extends PatchEvidenceCandidate>(
  candidates: readonly T[],
  stored: {
    evidence: readonly OverviewEvidenceKey[];
    paragraphs: ReadonlyArray<{ text: string }>;
    /** The excerpts of the stored citations E1..Ek, in citation order. */
    citedExcerpts: readonly string[];
  }
): { evidence: T[]; tokens: number; budget: number } {
  const seen = new Set(stored.evidence.map((item) => evidenceKey(item.noteId, item.contentHash)));
  const fresh = candidates.filter((item) => !seen.has(evidenceKey(item.noteId, item.passageHash)));
  const budget = Math.max(
    0,
    topicOverviewLimits.evidenceTokenBudget -
      overviewPatchBaseTokens(stored.paragraphs, stored.citedExcerpts)
  );
  const maxItems = Math.max(
    0,
    Math.min(
      topicOverviewLimits.maxEvidence,
      topicReadLimits.overviewCitationsMax - stored.citedExcerpts.length,
      topicOverviewLimits.storedEvidenceMax - stored.evidence.length
    )
  );
  if (maxItems === 0 || fresh.length === 0) return { evidence: [], tokens: 0, budget };
  return { ...selectOverviewEvidence(fresh, { budget, maxItems }), budget };
}

/**
 * The wire contract of a patch (`topic.overview.patch`, strict): new paragraphs whose markers cite
 * the stored citations E1..Ek or the new evidence Ek+1.., and Divergences between a stored citation
 * and a new item. The meaning is checked by {@link validateOverviewPatch}.
 */
export const TopicOverviewPatchOutputSchema = z.object({
  paragraphs: z.array(z.string()),
  divergences: z.array(z.object({ existing: z.string(), new: z.string(), summary: z.string() }))
});
export type TopicOverviewPatchOutput = z.infer<typeof TopicOverviewPatchOutputSchema>;

export interface OverviewPatchNumbering {
  /** Citations of the stored overview: E1..Ek. */
  existingCitations: number;
  /** New evidence items: Ek+1..Ek+m. */
  newEvidence: number;
  /** Paragraphs the patch may add (the prompt asked for at most this many). */
  maxParagraphs: number;
  /** Divergences the stored overview already keeps. */
  existingDivergences?: number;
}

export interface ValidatedOverviewPatch {
  /**
   * The new paragraphs in stored numbering: a stored citation keeps its number, a new item cited
   * first gets k+1, the next k+2, in order of first appearance (paragraphs, then Divergences).
   */
  paragraphs: Array<{ text: string; citations: number[] }>;
  /** `cited[j]` is the new evidence item (1-based among the new ones) citation k+1+j stands for. */
  cited: number[];
  /** Divergences in stored numbering (`E<n>`), each naming a stored citation and a new one. */
  divergences: OverviewDivergence[];
}

export type OverviewPatchValidation =
  { ok: true; patch: ValidatedOverviewPatch } | { ok: false; errors: string[] };

const divergenceRefPattern = /^\s*E?(\d{1,3})\s*$/iu;

/**
 * Checks a patch against the numbering it was written for: at most `maxParagraphs` paragraphs of
 * plain text, each citing at least one new item, every number one of E1..Ek+m, every Divergence a
 * stored citation and a new item with a one-sentence summary. A valid patch continues the stored
 * numbering (D17): its new citations read k+1, k+2 in order of first use and the markers in its
 * text follow. Zero paragraphs is a valid patch (no change). Errors are written for the repair.
 */
export function validateOverviewPatch(
  output: unknown,
  numbering: OverviewPatchNumbering
): OverviewPatchValidation {
  const parsed = TopicOverviewPatchOutputSchema.safeParse(output);
  if (!parsed.success)
    return { ok: false, errors: ["The answer is not the JSON shape asked for."] };
  const k = numbering.existingCitations;
  const total = k + numbering.newEvidence;
  const errors: string[] = [];
  const paragraphs = parsed.data.paragraphs;
  if (paragraphs.length > numbering.maxParagraphs) {
    errors.push(
      `Write at most ${numbering.maxParagraphs} new paragraphs (the answer has ${paragraphs.length}).`
    );
  }
  const drafts: Array<{ text: string; order: number[] }> = [];
  paragraphs.forEach((raw, index) => {
    const label = `New paragraph ${index + 1}`;
    const text = raw.replace(/\s+/gu, " ").trim();
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
    const unknown = [...new Set(order.filter((n) => n < 1 || n > total))];
    if (unknown.length > 0) {
      errors.push(
        `${label} cites ${unknown.map((n) => `[${n}]`).join(", ")}, which is not in the evidence ` +
          `(the evidence is numbered 1 to ${total}).`
      );
    }
    if (!order.some((n) => n > k && n <= total)) {
      errors.push(
        `${label} cites no new evidence; cite the new item (${k + 1} to ${total}) it adds.`
      );
    }
    drafts.push({ text, order });
  });
  const unique = new Map<string, { existing: number; new: number; summary: string }>();
  parsed.data.divergences.forEach((raw, index) => {
    const label = `Divergence ${index + 1}`;
    const existing = Number(divergenceRefPattern.exec(raw.existing)?.[1] ?? Number.NaN);
    const added = Number(divergenceRefPattern.exec(raw.new)?.[1] ?? Number.NaN);
    const summary = raw.summary.replace(/\s+/gu, " ").trim();
    if (!(existing >= 1 && existing <= k))
      errors.push(`${label} names "${raw.existing}" as existing; use one of E1 to E${k}.`);
    if (!(added > k && added <= total))
      errors.push(`${label} names "${raw.new}" as new; use one of E${k + 1} to E${total}.`);
    if (!summary) errors.push(`${label} has no summary.`);
    else if (tagPattern.test(summary)) errors.push(`${label} contains markup; write plain text.`);
    else if (!withinCharacters(summary, changeSetReadLimits.divergenceSummaryMax))
      errors.push(
        `${label} is longer than ${changeSetReadLimits.divergenceSummaryMax} characters.`
      );
    if (!unique.has(`${existing}:${added}`))
      unique.set(`${existing}:${added}`, { existing, new: added, summary });
  });
  const divergencesLeft = changeSetReadLimits.divergencesMax - (numbering.existingDivergences ?? 0);
  if (unique.size > Math.max(0, divergencesLeft)) {
    errors.push(`Name at most ${Math.max(0, divergencesLeft)} divergences.`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const renumber = new Map<number, number>();
  const cited: number[] = [];
  const numberOf = (n: number) => {
    if (n <= k) return n;
    let next = renumber.get(n);
    if (next === undefined) {
      cited.push(n - k);
      next = k + cited.length;
      renumber.set(n, next);
    }
    return next;
  };
  const result = drafts.map((draft) => {
    for (const n of draft.order) numberOf(n);
    const text = draft.text.replace(markerPattern, (marker) => {
      const numbers = [...new Set(markerNumbers(marker).map(numberOf))].sort((a, b) => a - b);
      return `[${numbers.join(", ")}]`;
    });
    const citations = [...new Set(draft.order.map(numberOf))].sort((a, b) => a - b);
    return { text, citations };
  });
  const divergences = [...unique.values()].map((divergence) => ({
    existing: `E${divergence.existing}`,
    new: `E${numberOf(divergence.new)}`,
    summary: divergence.summary
  }));
  if (k + cited.length > topicReadLimits.overviewCitationsMax) {
    return {
      ok: false,
      errors: [
        `Cite at most ${topicReadLimits.overviewCitationsMax - k} new evidence items in all.`
      ]
    };
  }
  return { ok: true, patch: { paragraphs: result, cited, divergences } };
}

/** A stored support verdict, as the overview row keeps it (other fields are provenance). */
export type OverviewSupportSummary = {
  status: "verified" | "partial" | "unchecked";
  unsupported: number[];
  sentences?: { checked: number; supported: number };
};

/**
 * The support of a patched overview: the stored verdict of its old paragraphs with the verdict of
 * the new sentences (`added`, paragraph indexes counted from the first paragraph), or with the new
 * paragraphs unchecked (`added` null: no ranker, or while the check runs). Verified only when both
 * sides are; an unchecked side makes the whole at most partial.
 */
export function patchedOverviewSupport(
  previous: OverviewSupportSummary,
  added: OverviewSupportVerdict | null
): OverviewSupportSummary {
  if (added === null) {
    return {
      status: previous.status === "unchecked" ? "unchecked" : "partial",
      unsupported: [...previous.unsupported],
      ...(previous.sentences ? { sentences: { ...previous.sentences } } : {})
    };
  }
  const unsupported = [...new Set([...previous.unsupported, ...added.unsupported])].sort(
    (a, b) => a - b
  );
  const sentences = previous.sentences
    ? {
        checked: previous.sentences.checked + added.sentences.checked,
        supported: previous.sentences.supported + added.sentences.supported
      }
    : { ...added.sentences };
  return {
    status: previous.status === "verified" && added.status === "verified" ? "verified" : "partial",
    unsupported,
    sentences
  };
}
