import type {
  TopicHealth,
  TopicItemLeaf,
  TopicManagement,
  TopicNodeSummary,
  TopicNotes,
  TopicNotesInput,
  TopicPath,
  TopicPathInput,
  TopicTree,
  TopicTreeInput,
  TopicsStatus
} from "@app/domain";
import type { ViewHistoryEntry, ViewHistoryListInput } from "../../../shared/view-history";
import type { NavigatorApi } from "./topic-navigator-store";

/** A fixed UUID for test object number `n`. */
export const id = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export interface FakeTopic {
  id: string;
  parentId: string | null;
  title: string | null;
  management?: TopicManagement;
  health?: TopicHealth;
  /** Direct leaves, primary first. */
  leaves?: TopicItemLeaf[];
  /** Child IDs in display order. */
  children?: string[];
  /** Set for a retired topic: where it leads. */
  redirectTo?: string;
}

export const noteLeaf = (n: number, overrides: Partial<TopicItemLeaf> = {}): TopicItemLeaf =>
  ({
    kind: "note",
    id: id(5000 + n),
    title: `Note ${n}`,
    role: "primary",
    unsorted: false,
    sourceTitle: "A source",
    provenance: "ai",
    ...overrides
  }) as TopicItemLeaf;

export const sourceLeaf = (n: number, overrides: Partial<TopicItemLeaf> = {}): TopicItemLeaf =>
  ({
    kind: "source",
    id: id(6000 + n),
    title: `Source ${n}`,
    role: "primary",
    unsorted: false,
    noteCount: 3,
    ...overrides
  }) as TopicItemLeaf;

export function nodeSummary(
  overrides: Partial<TopicNodeSummary> & Pick<TopicNodeSummary, "id">
): TopicNodeSummary {
  return {
    parentId: null,
    title: "Topic",
    nameState: "named",
    management: "ai",
    items: 0,
    directItems: 0,
    unsorted: 0,
    children: 0,
    health: "good",
    newThisWeek: 0,
    position: 0,
    updatedAt: "2026-10-15T10:00:00.000Z",
    ...overrides
  };
}

export const historyEntry = (overrides: Partial<ViewHistoryEntry> = {}): ViewHistoryEntry => ({
  address: `memora://source/${id(1)}`,
  kind: "source",
  id: id(1),
  title: "A source",
  parentAddress: null,
  openedAt: "2026-10-15T10:00:00.000Z",
  openCount: 1,
  pinned: false,
  ...overrides
});

export interface FakeTreeOptions {
  topics: FakeTopic[];
  rootId: string;
  history?: ViewHistoryEntry[];
  status?: TopicsStatus;
  generation?: number;
}

/** Calls made, in order, so a test can say what was read and what was not. */
export interface FakeCalls {
  tree: TopicTreeInput[];
  notes: TopicNotesInput[];
  path: TopicPathInput[];
  history: ViewHistoryListInput[];
  status: number;
  reembed: number;
}

/**
 * An in-memory topic tree behind the navigator's API. Counts are derived (a topic's items are its
 * leaves plus its children's), cursors are indexes, and a test can change the tree, the generation
 * or make a call fail or wait.
 */
export class FakeTopics {
  readonly topics: Map<string, FakeTopic>;
  readonly rootId: string;
  history: ViewHistoryEntry[];
  status: TopicsStatus;
  generation: number;
  readonly calls: FakeCalls = {
    tree: [],
    notes: [],
    path: [],
    history: [],
    status: 0,
    reembed: 0
  };
  /** Makes the next call of this kind throw (the message is the error). */
  failNext: Partial<Record<"tree" | "notes" | "path" | "history" | "status" | "reembed", string>> =
    {};
  /** Holds every `tree` answer until released; for races. */
  hold: Array<() => void> | null = null;

  constructor(options: FakeTreeOptions) {
    this.topics = new Map(options.topics.map((topic) => [topic.id, topic]));
    this.rootId = options.rootId;
    this.history = options.history ?? [];
    this.generation = options.generation ?? 1;
    this.status = options.status ?? {
      phase: "active",
      counts: { items: 0, placed: 0, pending: 0, needsGate: 0 }
    };
  }

  private items(topicId: string): number {
    const topic = this.topics.get(topicId)!;
    const direct = (topic.leaves ?? []).filter((leaf) => leaf.role === "primary").length;
    return direct + (topic.children ?? []).reduce((sum, child) => sum + this.items(child), 0);
  }

  summary(topicId: string): TopicNodeSummary {
    const topic = this.topics.get(topicId)!;
    const primary = (topic.leaves ?? []).filter((leaf) => leaf.role === "primary");
    const root = topicId === this.rootId;
    return nodeSummary({
      id: topic.id,
      parentId: topic.parentId,
      title: topic.title,
      nameState: topic.title === null ? "unnamed" : "named",
      management: topic.management ?? "ai",
      health: topic.health ?? "good",
      items: this.items(topicId),
      directItems: primary.length,
      unsorted: root ? primary.length : primary.filter((leaf) => leaf.unsorted).length,
      children: (topic.children ?? []).length
    });
  }

  private async gate() {
    if (this.hold) await new Promise<void>((release) => this.hold!.push(release));
  }

  private maybeFail(kind: keyof FakeTopics["failNext"]) {
    const message = this.failNext[kind];
    if (message === undefined) return;
    delete this.failNext[kind];
    throw new Error(message);
  }

  readonly api: NavigatorApi = {
    tree: async (input) => {
      this.calls.tree.push(input);
      this.maybeFail("tree");
      const parentId = input.parentId ?? this.rootId;
      const parent = this.topics.get(parentId);
      const limit = input.limit ?? 100;
      const from = input.cursor ? Number(input.cursor) : 0;
      if (Number.isNaN(from)) throw new Error("topics.errors.stale");
      const children = parent?.children ?? [];
      const leaves = parent?.leaves ?? [];
      const itemLimit = input.includeItems ? (input.itemLimit ?? 5) : 0;
      const shown = leaves.slice(0, itemLimit);
      // The answer is what the tree held when it was asked; with `hold` it may arrive late.
      const answer: TopicTree | null =
        !parent || parent.redirectTo
          ? null
          : {
              generation: this.generation,
              parent: this.summary(parentId),
              nodes: children.slice(from, from + limit).map((child) => this.summary(child)),
              items: shown,
              moreItems: input.includeItems ? leaves.length - shown.length : 0,
              unsorted: this.summary(parentId).unsorted,
              nextCursor: from + limit < children.length ? String(from + limit) : null
            };
      await this.gate();
      return answer;
    },
    notes: async (input) => {
      this.calls.notes.push(input);
      this.maybeFail("notes");
      const topic = this.topics.get(input.id);
      if (!topic) return null;
      const leaves = topic.leaves ?? [];
      const limit = input.limit ?? 50;
      const from = input.cursor ? Number(input.cursor) : 0;
      return {
        items: leaves.slice(from, from + limit),
        nextCursor: from + limit < leaves.length ? String(from + limit) : null
      } satisfies TopicNotes;
    },
    path: async (input) => {
      this.calls.path.push(input);
      this.maybeFail("path");
      let current = this.topics.get(input.id);
      const redirectedFrom = current?.redirectTo ? input.id : null;
      for (let hop = 0; current?.redirectTo && hop < 4; hop += 1) {
        current = this.topics.get(current.redirectTo);
      }
      if (!current) return null;
      const path: TopicPath["path"] = [];
      for (
        let node: FakeTopic | undefined = current;
        node;
        node = node.parentId ? this.topics.get(node.parentId) : undefined
      ) {
        path.unshift({ id: node.id, title: node.title });
      }
      return { resolvedId: current.id, redirectedFrom, path } satisfies TopicPath;
    },
    status: async () => {
      this.calls.status += 1;
      this.maybeFail("status");
      return this.status;
    },
    reembed: async () => {
      this.calls.reembed += 1;
      this.maybeFail("reembed");
      return { queued: 1 };
    },
    history: async (input) => {
      this.calls.history.push(input);
      this.maybeFail("history");
      return this.history;
    }
  };
}

/** Lets every pending promise callback run (the fake answers without real waiting). */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
