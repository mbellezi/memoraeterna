import { topicReadLimits } from "@app/domain";
import type { TopicNodeSummary, TopicTree, TopicTreeInput } from "@app/domain";

import { matchesFilter } from "./topic-ops";

/**
 * The browser behind "Move to..." and "Place in topic" (docs F2 T26), without React: it walks the
 * tree one level at a time from the root, so every topic is reachable by keyboard without a second
 * tree widget. The topic being moved is left out of every level, so a cycle cannot be chosen.
 */

export interface PickerApi {
  tree(input: TopicTreeInput): Promise<TopicTree | null>;
}

/** One step of the path to the level on show (the root has no name). */
export interface Crumb {
  id: string;
  title: string | null;
}

export type PickerPhase = "loading" | "ready" | "error";

export interface PickerSnapshot {
  phase: PickerPhase;
  /** From the root to the level on show; never empty once the first level is read. */
  trail: readonly Crumb[];
  /** The subtopics of the level on show, without the topic being moved. */
  nodes: readonly TopicNodeSummary[];
  nextCursor: string | null;
  more: "idle" | "loading" | "error";
  filter: string;
}

const initial = (): PickerSnapshot => ({
  phase: "loading",
  trail: [],
  nodes: [],
  nextCursor: null,
  more: "idle",
  filter: ""
});

export class TopicPickerController {
  private snapshot: PickerSnapshot = initial();
  private readonly listeners = new Set<() => void>();
  private request = 0;
  /** The level last asked for, so a failed read can be tried again. */
  private lastLoad: { parentId: string | null; above: readonly Crumb[] } = {
    parentId: null,
    above: []
  };

  /**
   * @param excludeId the topic being moved: it is not offered, so neither it nor anything under it
   *   can be reached.
   */
  constructor(
    private readonly api: () => PickerApi,
    private readonly excludeId: string | null
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PickerSnapshot => this.snapshot;

  /** The level on show, or null before the root was read. */
  get here(): Crumb | null {
    return this.snapshot.trail.at(-1) ?? null;
  }

  /** Reads the root level. */
  open(): void {
    this.snapshot = initial();
    this.emit();
    void this.load(null, []);
  }

  /** Into a subtopic. */
  enter(node: Pick<TopicNodeSummary, "id" | "title">): void {
    if (node.id === this.excludeId) return;
    void this.load(node.id, [...this.snapshot.trail]);
  }

  /** Up one level. */
  up(): void {
    const trail = this.snapshot.trail;
    if (trail.length < 2) return;
    this.goTo(trail.length - 2);
  }

  /** Back to a level of the path. */
  goTo(index: number): void {
    const trail = this.snapshot.trail;
    const target = trail[index];
    if (!target || index === trail.length - 1) return;
    void this.load(index === 0 ? null : target.id, trail.slice(0, index));
  }

  retry(): void {
    void this.load(this.lastLoad.parentId, this.lastLoad.above);
  }

  setFilter(filter: string): void {
    this.update({ filter });
  }

  /** The subtopics of the level on show that match the filter. */
  visible(): readonly TopicNodeSummary[] {
    return this.snapshot.nodes.filter((node) => matchesFilter(node.title, this.snapshot.filter));
  }

  async loadMore(): Promise<void> {
    const { nextCursor, more, trail } = this.snapshot;
    const here = trail.at(-1);
    if (!nextCursor || more === "loading" || !here) return;
    const request = this.request;
    this.update({ more: "loading" });
    try {
      const tree = await this.api().tree({
        parentId: trail.length < 2 ? null : here.id,
        cursor: nextCursor,
        limit: topicReadLimits.childrenMax,
        includeItems: false,
        itemLimit: 0
      });
      if (request !== this.request) return;
      if (tree === null) return this.update({ more: "error" });
      const known = new Set(this.snapshot.nodes.map((node) => node.id));
      this.update({
        nodes: [
          ...this.snapshot.nodes,
          ...this.allowed(tree.nodes).filter((node) => !known.has(node.id))
        ],
        nextCursor: tree.nextCursor,
        more: "idle"
      });
    } catch {
      if (request === this.request) this.update({ more: "error" });
    }
  }

  dispose(): void {
    this.request += 1;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------

  private allowed(nodes: readonly TopicNodeSummary[]): TopicNodeSummary[] {
    return nodes.filter((node) => node.id !== this.excludeId);
  }

  /** Reads the level of `parentId` (null: the root); `above` is the path that leads to it. */
  private async load(parentId: string | null, above: readonly Crumb[]): Promise<void> {
    const request = (this.request += 1);
    this.lastLoad = { parentId, above };
    this.update({ phase: "loading", filter: "", more: "idle" });
    try {
      const tree = await this.api().tree({
        parentId,
        limit: topicReadLimits.childrenMax,
        includeItems: false,
        itemLimit: 0
      });
      if (request !== this.request) return;
      if (tree === null) {
        this.update({ phase: "error" });
        return;
      }
      this.update({
        phase: "ready",
        trail: [...above, { id: tree.parent.id, title: tree.parent.title }],
        nodes: this.allowed(tree.nodes),
        nextCursor: tree.nextCursor,
        more: "idle"
      });
    } catch {
      if (request === this.request) this.update({ phase: "error" });
    }
  }

  private update(patch: Partial<PickerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
