import type { NotePage, NotePageEvidence, NotePageRelation } from "@app/domain";
import { createTranslator, type Translator } from "@app/i18n";

import type { NotePageLoad, NotePageViewProps } from "./NotePageView";

/** Synthetic Note page data for tests: no real library content. */
export const idleMore = {
  shown: { status: "idle" },
  withdrawn: { status: "idle" },
  earlier: { status: "idle" }
} as const;

export const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const fixtureAt = "2026-10-14T15:20:00.000Z";

export function evidenceItem(overrides: Partial<NotePageEvidence> = {}): NotePageEvidence {
  return {
    chunkId: fixtureId(40),
    sourceItemId: fixtureId(3),
    documentId: fixtureId(41),
    sourceSpanId: fixtureId(42),
    sourceTitle: "A fictional memory study",
    workTitle: null,
    chunkIndex: 17,
    range: { start: 412, end: 618 },
    page: null,
    excerpt: "Retention fell quickly in the first hour and slowly afterwards.",
    language: "en",
    primary: true,
    current: true,
    sourceAvailable: true,
    ...overrides
  };
}

export function relationItem(overrides: Partial<NotePageRelation> = {}): NotePageRelation {
  return {
    id: fixtureId(60),
    type: "supports",
    direction: "outgoing",
    directionSource: null,
    state: "applied",
    band: null,
    calibration: null,
    probability: null,
    vetoSource: null,
    decidedBy: { model: "decider-model", kind: null },
    typedBy: null,
    explainedBy: null,
    explanation: null,
    other: {
      id: fixtureId(61),
      title: "Spacing",
      ideaStatement: "Spaced repetition flattens the forgetting curve.",
      language: "en",
      status: "active",
      superseded: false,
      authorship: "ai",
      sourceItemId: fixtureId(62),
      sourceTitle: "Spacing handbook",
      passage: {
        chunkId: fixtureId(63),
        sourceSpanId: null,
        chunkIndex: 4,
        excerpt: "Spaced practice beat massed practice a week later.",
        language: "en"
      }
    },
    ...overrides
  };
}

export function notePage(overrides: Partial<NotePage> = {}): NotePage {
  return {
    note: {
      id: fixtureId(1),
      title: "Forgetting curve",
      ideaStatement: "Forgetting is fastest right after learning and then slows down.",
      bodyMarkdown:
        "The fictional study measured savings at several delays.\n\nThe curve is steep at first.",
      language: "en",
      status: "active",
      superseded: false,
      ownership: "source",
      humanProtected: false,
      authorship: "ai",
      generationModel: "writer-model",
      homeSourceId: fixtureId(3),
      createdAt: fixtureAt,
      updatedAt: fixtureAt,
      reviewedAt: null,
      lastEditedAt: null
    },
    successors: [],
    evidence: { items: [evidenceItem()], total: 1 },
    placement: {
      object: { kind: "note", id: fixtureId(1), title: "Forgetting curve" },
      primaryPath: [
        { kind: "topic", id: fixtureId(40), title: "" },
        { kind: "topic", id: fixtureId(41), title: "Memory" },
        { kind: "source", id: fixtureId(2), title: "Fictional classics" },
        { kind: "source", id: fixtureId(3), title: "A fictional memory study" },
        { kind: "note", id: fixtureId(1), title: "Forgetting curve" }
      ],
      alsoIn: [{ kind: "topic", id: fixtureId(7), title: "Recall" }],
      citedBy: [],
      counts: { alsoIn: 1, citedBy: 0, notes: 0, passages: 1, children: 0 }
    },
    relations: { items: [relationItem()], total: 1 },
    withdrawn: { items: [], total: 0 },
    earlierVersions: { items: [], total: 0 },
    ...overrides
  };
}

const noop = () => undefined;

/** The props of a Note page view with nothing open and nothing pending, for markup tests. */
export function viewProps(
  load: NotePageLoad,
  overrides: Partial<NotePageViewProps> = {},
  t: Translator = createTranslator("en")
): NotePageViewProps {
  return {
    t,
    backLabel: "Back to library",
    load,
    editing: null,
    review: { pending: false, failed: false },
    openCard: null,
    explanations: {},
    reviews: {},
    more: idleMore,
    relationFocus: null,
    withdrawnOpen: false,
    openFailed: false,
    announcement: "",
    onBack: noop,
    onRetry: noop,
    onMarkReviewed: noop,
    onStartEdit: noop,
    onDraftChange: noop,
    onSave: noop,
    onCancelEdit: noop,
    onDiscardAndReload: noop,
    onEscapeEdit: noop,
    onOpenNote: noop,
    onOpenPassage: noop,
    onOpenPlacement: noop,
    onCardEvent: noop,
    onRetryExplanation: noop,
    onReview: noop,
    onRelationFocusHandled: noop,
    onToggleWithdrawn: noop,
    onShowMore: noop,
    ...overrides
  };
}
