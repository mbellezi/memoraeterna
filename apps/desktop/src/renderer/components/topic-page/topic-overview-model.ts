import {
  overviewTextSegments,
  topicOverviewMessageKeys,
  type OverviewTextSegment,
  type TopicOverviewCitation,
  type TopicOverviewState
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

/**
 * The decisions of the overview section of a Topic page (T31) that need no renderer: which state
 * to show when the page and the slot's own request disagree, when to ask the main process, and
 * how the meta line reads. The page carries the overview state it read (no AI); only the slot's
 * request may write one, when the topic has none, or when the person asks to update it.
 */

export type ReadyOverview = Extract<TopicOverviewState, { status: "ready" }>;

/**
 * The slot's own request for one topic and what came back. A `verdict` request only waits for the
 * support verdict of an overview already shown: it writes nothing and the overview stays readable.
 */
export type OverviewRequest =
  | { status: "requesting"; force: boolean; verdict: boolean }
  | { status: "answered"; state: TopicOverviewState }
  | { status: "error"; messageKey: string };

export interface OverviewLocal {
  topicId: string;
  /** Null until the slot asked for this topic. */
  request: OverviewRequest | null;
  /** The newest ready overview an answer carried (the page may not have read it yet). */
  lastReady: ReadyOverview | null;
  /** The person canceled a writing: nothing is written again on its own for this topic. */
  canceled: boolean;
  /** The writing whose support verdict was already awaited (no second wait for it). */
  awaitedCheck: string | null;
}

/** What the section shows. */
export type OverviewView =
  | { kind: "absent"; canWrite: boolean; reasonKey: string | null }
  | { kind: "writing"; previous: ReadyOverview | null; updating: boolean }
  | { kind: "ready"; overview: ReadyOverview; noticeKey: string | null }
  | { kind: "failed"; messageKey: string };

/** The slot's state for a topic it has not asked about yet. */
export function overviewLocal(topicId: string): OverviewLocal {
  return { topicId, request: null, lastReady: null, canceled: false, awaitedCheck: null };
}

/** A request starts; an Update (`force`) clears an earlier cancel. */
export function overviewRequested(
  local: OverviewLocal,
  force: boolean,
  verdict = false
): OverviewLocal {
  return {
    ...local,
    request: { status: "requesting", force, verdict: verdict && !force },
    canceled: local.canceled && !force
  };
}

/** An answer arrived. A ready one whose support was checking has had its verdict awaited. */
export function overviewAnswered(local: OverviewLocal, state: TopicOverviewState): OverviewLocal {
  const ready = state.status === "ready" ? state : null;
  return {
    ...local,
    request: { status: "answered", state },
    lastReady:
      ready && local.lastReady ? newer(local.lastReady, ready) : (ready ?? local.lastReady),
    canceled:
      local.canceled ||
      (state.status === "absent" && state.reasonKey === topicOverviewMessageKeys.canceled),
    // A writing that comes back still checking is asked about once more, to wait for its verdict.
    awaitedCheck:
      ready &&
      (ready.support.status !== "checking" || local.lastReady?.writtenAt === ready.writtenAt)
        ? ready.writtenAt
        : local.awaitedCheck
  };
}

/** The request threw (the main process was unreachable, the topic is gone). */
export function overviewFailed(local: OverviewLocal, messageKey: string): OverviewLocal {
  return { ...local, request: { status: "error", messageKey } };
}

/** Of two ready overviews, the later writing; for the same writing, the newer reading of it. */
function newer(first: ReadyOverview, second: ReadyOverview): ReadyOverview {
  const firstAt = Date.parse(first.writtenAt);
  const secondAt = Date.parse(second.writtenAt);
  if (secondAt > firstAt) return second;
  if (firstAt > secondAt) return first;
  // The same writing: the first reading (the page's) knows the members of now; a verdict wins.
  return first.support.status === "checking" && second.support.status !== "checking"
    ? { ...first, support: second.support }
    : first;
}

/**
 * The state to show for the page's reading and the slot's own request. A request in flight shows
 * as writing over the overview it updates, except a wait for the support verdict, which shows the
 * overview as ready (its support reads "checking"); an update that did not land keeps the earlier
 * overview with a notice; a failure with nothing to keep shows the failure.
 */
export function overviewView(page: TopicOverviewState, local: OverviewLocal | null): OverviewView {
  const pageReady = page.status === "ready" ? page : null;
  const lastReady = local?.lastReady ?? null;
  const base = pageReady && lastReady ? newer(pageReady, lastReady) : (pageReady ?? lastReady);
  const request = local?.request ?? null;
  if (request?.status === "requesting" && !(request.verdict && base)) {
    return { kind: "writing", previous: base, updating: request.force };
  }
  if (request?.status === "error") {
    return base
      ? { kind: "ready", overview: base, noticeKey: "topics.overview.updateFailed" }
      : { kind: "failed", messageKey: request.messageKey };
  }
  const answer = request?.status === "answered" ? request.state : null;
  if (base) {
    let noticeKey: string | null = null;
    if (answer?.status === "failed") noticeKey = "topics.overview.updateFailed";
    else if (
      answer?.status === "absent" &&
      answer.reasonKey &&
      answer.reasonKey !== topicOverviewMessageKeys.canceled
    ) {
      noticeKey = answer.reasonKey;
    }
    return { kind: "ready", overview: base, noticeKey };
  }
  const state = answer ?? page;
  switch (state.status) {
    case "ready":
      return { kind: "ready", overview: state, noticeKey: null };
    case "writing":
      return { kind: "writing", previous: null, updating: false };
    case "failed":
      return { kind: "failed", messageKey: state.messageKey };
    case "absent":
      return { kind: "absent", canWrite: state.canWrite, reasonKey: state.reasonKey ?? null };
  }
}

/**
 * Whether the slot asks the main process now: only while shown, never twice at once, and only to
 * write a missing overview (unless the person canceled one), to join a writing in progress, or to
 * wait once for the support verdict of a writing. Opening a page whose overview is ready asks
 * nothing, and a failure waits for Retry.
 */
export function shouldRequestOverview(
  view: OverviewView,
  local: OverviewLocal | null,
  active: boolean
): boolean {
  if (!active) return false;
  const status = local?.request?.status;
  if (status === "requesting" || status === "error") return false;
  switch (view.kind) {
    case "absent":
      return view.canWrite && view.reasonKey === null && !local?.canceled;
    case "writing":
      return true;
    case "ready":
      return (
        view.overview.support.status === "checking" &&
        local?.awaitedCheck !== view.overview.writtenAt
      );
    case "failed":
      return false;
  }
}

/** The message keys the overview's states may carry; anything else reads as a generic failure. */
const knownKeys: ReadonlySet<string> = new Set([
  ...Object.values(topicOverviewMessageKeys),
  "topics.overview.updateFailed"
]);

export function overviewMessage(t: Translator, key: string | null): string {
  return t(
    (key !== null && knownKeys.has(key) ? key : "topics.overview.errors.failed") as MessageKey
  );
}

/** The error key of a request that threw: the message when it is one of ours. */
export function overviewErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const key = /topics\.overview\.[A-Za-z.]+/u.exec(message)?.[0];
  return key && knownKeys.has(key) ? key : "topics.overview.errors.failed";
}

const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000]
];

/** "2 days ago", "há 2 dias", "just now" in the interface language. */
export function relativeWhen(t: Translator, iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const elapsed = Math.max(0, now.getTime() - at);
  const format = new Intl.RelativeTimeFormat(t.locale, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return format.format(0, "second");
}

/** "written by AI from 5 of 23 notes". */
export function overviewHint(t: Translator, evidence: ReadyOverview["evidence"]): string {
  const number = new Intl.NumberFormat(t.locale);
  if (evidence.total <= 1 && evidence.used <= 1) return t("topics.overview.hintOne");
  return t("topics.overview.hint", {
    values: { used: number.format(evidence.used), total: number.format(evidence.total) }
  });
}

/** Distinct sources the citations name (by source, else by title). */
export function citedSourceCount(citations: readonly TopicOverviewCitation[]): number {
  return new Set(citations.map((citation) => citation.sourceId ?? `title:${citation.sourceTitle}`))
    .size;
}

export function sourcesCitedLabel(
  t: Translator,
  citations: readonly TopicOverviewCitation[]
): string {
  const count = citedSourceCount(citations);
  return count === 1
    ? t("topics.overview.sourcesCitedOne")
    : t("topics.overview.sourcesCited", {
        values: { count: new Intl.NumberFormat(t.locale).format(count) }
      });
}

export type SupportTone = "success" | "warning" | "neutral";

/** The support verdict as words and a tone; the view pairs the tone with a glyph. */
export function supportView(
  t: Translator,
  support: ReadyOverview["support"]
): { text: string; tone: SupportTone; busy: boolean } {
  switch (support.status) {
    case "verified":
      return { text: t("topics.overview.support.verified"), tone: "success", busy: false };
    case "partial": {
      const number = new Intl.NumberFormat(t.locale);
      return {
        text: t("topics.overview.support.partial", {
          values: {
            supported: number.format(support.sentences?.supported ?? 0),
            checked: number.format(support.sentences?.checked ?? 0)
          }
        }),
        tone: "warning",
        busy: false
      };
    }
    case "checking":
      return { text: t("topics.overview.support.checking"), tone: "neutral", busy: true };
    case "unchecked":
      return { text: t("topics.overview.support.unchecked"), tone: "neutral", busy: false };
  }
}

/** A paragraph as text and citation markers that name citations of the overview. */
export function paragraphSegments(
  text: string,
  citations: readonly TopicOverviewCitation[]
): OverviewTextSegment[] {
  const known = new Set(citations.map((citation) => citation.n));
  return overviewTextSegments(text, (n) => known.has(n));
}

/** The citations a paragraph lists that its text does not mark: shown after it. */
export function unmarkedCitations(
  paragraph: { text: string; citations: readonly number[] },
  citations: readonly TopicOverviewCitation[]
): number[] {
  const marked = new Set(
    paragraphSegments(paragraph.text, citations).flatMap((segment) =>
      segment.kind === "citation" ? segment.numbers : []
    )
  );
  const known = new Set(citations.map((citation) => citation.n));
  return paragraph.citations.filter((n) => !marked.has(n) && known.has(n));
}

/** Where "open at the exact passage" leads: the cited note in its source, else the source. */
export function citationTarget(
  citation: TopicOverviewCitation
): { kind: "note"; id: string } | { kind: "source"; id: string } | null {
  if (citation.noteId) return { kind: "note", id: citation.noteId };
  if (citation.sourceId) return { kind: "source", id: citation.sourceId };
  return null;
}

export function citationLabel(t: Translator, citation: TopicOverviewCitation): string {
  return t("topics.overview.citation.label", {
    values: {
      n: citation.n,
      source: citation.sourceTitle || t("topics.overview.citation.unknownSource")
    }
  });
}
