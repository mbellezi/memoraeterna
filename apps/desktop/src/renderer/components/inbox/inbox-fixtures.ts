import type {
  ChangeSetSummary,
  ChangesDiff,
  InboxCounts,
  InboxItem,
  InboxKind,
  InboxList
} from "@app/domain";
import { emptyInboxCounts } from "@app/domain";

/** Items for the Inbox tests: one of every kind, with stable IDs and titles. */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const summary = (overrides: Partial<ChangeSetSummary> = {}): ChangeSetSummary => ({
  kind: "overview",
  id: uuid(900),
  titleKey: "changes.titles.overview.rewrite",
  titleParams: {},
  risk: "high",
  status: "pending_review",
  origin: "rewrite",
  subjectId: uuid(10),
  jobId: null,
  at: "2026-10-24T05:00:00.000000Z",
  undoneAt: null,
  undo: "unavailable",
  ...overrides
});

export const item = (kind: InboxKind, overrides: Partial<InboxItem> = {}): InboxItem => {
  const base: Record<InboxKind, Omit<InboxItem, "kind" | "at">> = {
    review: {
      id: `overview:${uuid(900)}`,
      risk: "high",
      variant: "overview",
      params: {},
      objects: [{ kind: "topic", id: uuid(10), title: "Sleep" }],
      changeSet: summary(),
      actions: ["apply", "dismiss"]
    },
    quarantined: {
      id: "topic-overview|topic:" + uuid(10),
      risk: "medium",
      variant: "refresh",
      params: { errorClass: "invalid_output", failures: 2 },
      objects: [{ kind: "topic", id: uuid(10), title: "Sleep" }],
      changeSet: null,
      actions: ["retry", "dismiss"]
    },
    contradiction: {
      id: uuid(20),
      risk: "medium",
      variant: "relation",
      params: { relationType: "contradicts" },
      objects: [
        { kind: "note", id: uuid(21), title: "Naps help" },
        { kind: "note", id: uuid(22), title: "Naps hurt" }
      ],
      changeSet: null,
      actions: ["apply", "dismiss"]
    },
    suggestion: {
      id: uuid(80),
      risk: "medium",
      variant: "relation",
      params: { relationType: "supports", probability: 0.64 },
      objects: [
        { kind: "note", id: uuid(81), title: "Daylight sets the body clock" },
        { kind: "note", id: uuid(82), title: "Morning light shifts sleep timing" }
      ],
      changeSet: null,
      actions: ["apply", "dismiss"]
    },
    withdrawn: {
      id: uuid(30),
      risk: "low",
      variant: "explainer",
      params: { relationType: "supports" },
      objects: [
        { kind: "note", id: uuid(31), title: "Caffeine" },
        { kind: "note", id: uuid(32), title: null }
      ],
      changeSet: null,
      actions: ["apply", "dismiss"]
    },
    duplicate: {
      id: uuid(40),
      risk: "low",
      variant: "vector",
      params: { cosine: 0.98 },
      objects: [
        { kind: "note", id: uuid(41), title: "Nap" },
        { kind: "note", id: uuid(42), title: "Siesta" }
      ],
      changeSet: null,
      actions: ["dismiss"]
    },
    obsidian_conflict: {
      id: `editorial:${uuid(50)}`,
      risk: "medium",
      variant: "editorial",
      params: { path: "Notes/Sleep.md" },
      objects: [],
      changeSet: null,
      actions: []
    },
    budget: {
      id: uuid(60),
      risk: "medium",
      variant: "money_80",
      params: { month: "2026-10", spentUsd: 4.12, capUsd: 5 },
      objects: [],
      changeSet: null,
      actions: ["apply", "dismiss"]
    },
    backlog: {
      id: uuid(70),
      risk: "low",
      variant: "match",
      params: { notes: 12 },
      objects: [],
      changeSet: null,
      actions: ["apply", "dismiss"]
    }
  };
  return { kind, at: "2026-10-24T05:00:00.000000Z", ...base[kind], ...overrides };
};

export const page = (items: readonly InboxItem[], nextCursor: string | null = null): InboxList => ({
  items: [...items],
  nextCursor
});

export const countsOf = (items: readonly InboxItem[]): InboxCounts => {
  const counts = emptyInboxCounts();
  for (const entry of items) {
    counts.total += 1;
    counts.byKind[entry.kind] += 1;
    counts.byRisk[entry.risk] += 1;
  }
  return counts;
};

export const topicDiff = (): ChangesDiff => ({
  kind: "topic",
  summary: summary({ kind: "topic", id: uuid(901), origin: "rebuild", subjectId: uuid(2) }),
  nodes: [
    {
      id: uuid(1),
      change: "context",
      existedBefore: true,
      existsAfter: true,
      parentBefore: null,
      parentAfter: null,
      titleBefore: null,
      titleAfter: null,
      itemsIn: 0,
      itemsOut: 0
    },
    {
      id: uuid(2),
      change: "moved",
      existedBefore: true,
      existsAfter: true,
      parentBefore: uuid(3),
      parentAfter: uuid(1),
      titleBefore: "Naps",
      titleAfter: "Naps",
      itemsIn: 4,
      itemsOut: 1
    },
    {
      id: uuid(3),
      change: "renamed",
      existedBefore: true,
      existsAfter: true,
      parentBefore: uuid(1),
      parentAfter: uuid(1),
      titleBefore: "Rest",
      titleAfter: "Sleep",
      itemsIn: 0,
      itemsOut: 0
    },
    {
      id: uuid(4),
      change: "added",
      existedBefore: false,
      existsAfter: true,
      parentBefore: null,
      parentAfter: uuid(3),
      titleBefore: null,
      titleAfter: null,
      itemsIn: 0,
      itemsOut: 0
    }
  ],
  hidden: 3
});
