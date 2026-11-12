import { topicErrorKeys, topicReadLimits, type TopicChangeSet, type TopicShape } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type { DesktopApi } from "../../../../../shared/ipc";
import { onTreeChanged, type TreeChangedListener } from "../../../../lib/app-events";
import { isSilentRefresh, type LoadOutcome } from "../../../../lib/hidden-view";
import { nextAnnouncement } from "../../../../components/topic-page/topic-page-model";
import { growthDays, growthRequests, subtreeGrowth } from "./shape-growth";

export type ShapeLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; shape: TopicShape };

/** One step of the zoom path: the root of the tree (`id: null`) or a branch zoomed into. */
export interface ZoomStep {
  id: string | null;
  /** The branch's name when it was zoomed into; the interface names the root itself. */
  title: string | null;
  /** The level of the topic in the whole tree (0 for the root). */
  depth: number;
}

export type ChangeActionKind = "apply" | "dismiss" | "undo";

/** What happened to the last action on a change-set: asking, refused (a message), or failed. */
export type ChangeAction =
  | { kind: ChangeActionKind; status: "pending" }
  | { kind: ChangeActionKind; status: "blocked" | "failed"; messageKey: MessageKey };

/** The before and after of a change-set that was opened. */
export type ChangeDetail =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; changeSet: TopicChangeSet };

/** The growth column: notes that arrived in each topic and under it over the last days. */
export type ShapeGrowth =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; byTopic: ReadonlyMap<string, number> };

export interface ShapeSnapshot {
  load: ShapeLoad;
  /** Read after the shape; a failure leaves the column empty and nothing else changes. */
  growth: ShapeGrowth;
  /** The root of the tree first, the branch on screen last. */
  zoom: readonly ZoomStep[];
  /** The key of the selected cell; the view falls back to the root of the chart when it is gone. */
  selectedKey: string | null;
  actions: Readonly<Record<string, ChangeAction>>;
  details: Readonly<Record<string, ChangeDetail>>;
  /** Polite announcement of the last action's result. */
  announcement: string;
  /** When the shape on screen was read: "today" is measured against it. */
  readAt: number;
}

export type ShapeApi = Pick<
  DesktopApi["topics"],
  "shape" | "changeSet" | "undo" | "review" | "history"
>;

export interface ShapeControllerDeps {
  api: () => ShapeApi;
  /** Where the tree's committed changes arrive (default: `tree.changed` on the bus). */
  onTreeChanged?: (listener: TreeChangedListener) => () => void;
  now?: () => number;
  /** Quiet time after a pushed change before the shape is read again. */
  refreshDelayMs?: number;
}

const wholeTree: readonly ZoomStep[] = Object.freeze([{ id: null, title: null, depth: 0 }]);

const initialSnapshot = (): ShapeSnapshot => ({
  load: { status: "loading" },
  growth: { status: "idle" },
  zoom: wholeTree,
  selectedKey: null,
  actions: {},
  details: {},
  announcement: "",
  readAt: 0
});

/** The failure message a handler reported (`new Error("topics.errors.…")`), or null for any other failure. */
export function topicErrorMessage(error: unknown): MessageKey | null {
  const text = String(error);
  for (const key of topicErrorKeys) if (text.includes(key)) return key;
  return null;
}

const actionFailure = (error: unknown): MessageKey =>
  topicErrorMessage(error) ?? "topics.shape.warnings.failed";

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

/** A refresh that found the same shape changes nothing; the tree generation alone is not content. */
export function sameShapeContent(a: TopicShape, b: TopicShape): boolean {
  return JSON.stringify({ ...a, generation: 0 }) === JSON.stringify({ ...b, generation: 0 });
}

/**
 * The state of the Shape view, outside React so every rule is tested without a renderer.
 *
 * Showing the view reads the tree once (`topics.shape`); nothing else is asked until the person
 * acts. A hidden view loads nothing and listens to nothing; shown again with the same branch and
 * a good last load it refreshes in place. A pushed change reads the shape again after a quiet
 * period, and a read that finds the same content changes nothing. Applying, dismissing and undoing
 * go through the topic handlers and read the shape again; a refusal stays visible beside the item.
 */
export class ShapeController {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private active = false;
  private translator: Translator | null = null;
  private attempt = 0;
  /** The newest read; an older answer arriving later is dropped. */
  private token = 0;
  private inFlightKey: string | null = null;
  private outcome: LoadOutcome | null = null;
  private wasHidden = false;
  private seenGeneration = -1;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly detailTokens = new Map<string, number>();
  private growthToken = 0;

  constructor(private readonly deps: ShapeControllerDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ShapeSnapshot => this.snapshot;

  /** Called whenever the visibility or the language changes. */
  show(active: boolean, t: Translator): void {
    this.translator = t;
    if (!active) {
      this.active = false;
      this.wasHidden = true;
      this.stopListening();
      return;
    }
    this.active = true;
    this.listen();
    const key = this.key();
    const silent = isSilentRefresh(this.wasHidden, this.outcome, key);
    this.wasHidden = false;
    if (this.inFlightKey === key) return;
    // A key that already finished is left alone, a failed one stays visible and retryable.
    if (this.outcome?.key === key && !silent) return;
    this.load(silent);
  }

  /** The person asked to try again after a failure. */
  retry(): void {
    if (!this.active) return;
    this.attempt += 1;
    this.load(false);
  }

  /**
   * Stops listening; `show` brings the view back. A read that is in flight is kept: React
   * unmounts and mounts a component again while developing, and the answer is still the shape.
   */
  dispose(): void {
    this.active = false;
    this.wasHidden = true;
    this.stopListening();
  }

  select(key: string): void {
    if (this.snapshot.selectedKey === key) return;
    this.update({ selectedKey: key });
  }

  /**
   * Shows one branch alone: the chart starts at this topic. `depth` is the topic's level in the
   * chart on screen (the chart starts at level 0).
   */
  zoomInto(topicId: string, title: string | null, depth: number): void {
    const current = this.snapshot.zoom.at(-1);
    if (!current || current.id === topicId) return;
    this.moveZoom(
      [...this.snapshot.zoom, { id: topicId, title, depth: current.depth + depth }],
      `topic:${topicId}`
    );
  }

  /** Goes back up the zoom path to the step at `index` (0 is the whole tree). */
  zoomTo(index: number): void {
    const { zoom } = this.snapshot;
    if (index < 0 || index >= zoom.length - 1) return;
    const step = zoom[index]!;
    this.moveZoom(zoom.slice(0, index + 1), step.id === null ? null : `topic:${step.id}`);
  }

  /** Applies or dismisses a proposal that waits for the person (docs D29). */
  async review(changeSetId: string, decision: "apply" | "dismiss"): Promise<void> {
    if (this.snapshot.actions[changeSetId]?.status === "pending") return;
    this.setAction(changeSetId, { kind: decision, status: "pending" });
    try {
      await this.deps.api().review({ changeSetId, decision });
      this.clearAction(changeSetId);
      this.announce(
        decision === "apply" ? "topics.shape.warnings.applied" : "topics.shape.warnings.dismissed"
      );
    } catch (error) {
      this.setAction(changeSetId, {
        kind: decision,
        status: "failed",
        messageKey: actionFailure(error)
      });
      this.announce(actionFailure(error));
    }
    // What the proposal changed (or found changed under it) is read again either way.
    this.refresh();
  }

  /** Undoes a change of today. */
  async undo(changeSetId: string): Promise<void> {
    if (this.snapshot.actions[changeSetId]?.status === "pending") return;
    this.setAction(changeSetId, { kind: "undo", status: "pending" });
    try {
      const result = await this.deps.api().undo({ changeSetId });
      if (result.status === "undone") {
        this.clearAction(changeSetId);
        this.announce("topics.shape.changed.undone");
      } else {
        this.setAction(changeSetId, {
          kind: "undo",
          status: "blocked",
          messageKey: "topics.shape.changed.blocked"
        });
        this.announce("topics.shape.changed.blocked");
      }
    } catch (error) {
      const messageKey = topicErrorMessage(error) ?? "topics.shape.changed.failed";
      this.setAction(changeSetId, { kind: "undo", status: "failed", messageKey });
      this.announce(messageKey);
    }
    this.refresh();
  }

  /** Opens or closes the before and after of a change-set; opening reads it. */
  toggleDetails(changeSetId: string): void {
    if (this.snapshot.details[changeSetId] !== undefined) {
      this.detailTokens.set(changeSetId, (this.detailTokens.get(changeSetId) ?? 0) + 1);
      this.update({ details: without(this.snapshot.details, changeSetId) });
      return;
    }
    void this.loadDetails(changeSetId);
  }

  retryDetails(changeSetId: string): void {
    if (this.snapshot.details[changeSetId]?.status === "loading") return;
    void this.loadDetails(changeSetId);
  }

  // -------------------------------------------------------------------------

  private rootId(): string | null {
    return this.snapshot.zoom.at(-1)?.id ?? null;
  }

  private key(): string {
    return `${this.rootId() ?? "tree"}|${this.attempt}`;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private moveZoom(zoom: readonly ZoomStep[], selectedKey: string | null): void {
    this.token += 1;
    this.inFlightKey = null;
    this.outcome = null;
    this.seenGeneration = -1;
    this.clearTimer();
    this.snapshot = {
      ...this.snapshot,
      zoom,
      selectedKey,
      load: { status: "loading" },
      growth: { status: "idle" },
      actions: {},
      details: {}
    };
    this.emit();
    if (this.active) this.load(false);
  }

  private load(silent: boolean): void {
    const rootId = this.rootId();
    const key = this.key();
    const token = ++this.token;
    this.inFlightKey = key;
    if (!silent) this.update({ load: { status: "loading" } });
    this.deps
      .api()
      .shape({
        rootId,
        depth: topicReadLimits.shapeDepthMax,
        nodeLimit: topicReadLimits.shapeNodesMax
      })
      .then((shape) => {
        if (token !== this.token) return;
        this.inFlightKey = null;
        this.outcome = { key, ok: true, hasData: shape !== null };
        if (shape === null) {
          this.update({ load: { status: "missing" } });
          return;
        }
        this.seenGeneration = Math.max(this.seenGeneration, shape.generation);
        const current = this.snapshot.load;
        // The same content is not shown again: no render.
        if (current.status !== "ready" || !sameShapeContent(current.shape, shape)) {
          this.update({ load: { status: "ready", shape }, readAt: this.now() });
          void this.loadGrowth(shape.nodes);
        }
      })
      .catch(() => {
        if (token !== this.token) return;
        this.inFlightKey = null;
        this.outcome = { key, ok: false, hasData: false };
        // A failed refresh keeps the shape that is shown.
        if (!silent || this.snapshot.load.status !== "ready")
          this.update({ load: { status: "error" } });
      });
  }

  /**
   * The growth of every topic read: one `topics.history` per 200 topics, one after the other. A
   * newer shape drops the answer of an older one, and a failure shows "—" in the column.
   */
  private async loadGrowth(nodes: TopicShape["nodes"]): Promise<void> {
    const token = ++this.growthToken;
    const keep = this.snapshot.growth.status === "ready";
    if (!keep) this.update({ growth: { status: "loading" } });
    try {
      const series = [];
      for (const topicIds of growthRequests(nodes)) {
        const part = await this.deps.api().history({ topicIds, days: growthDays });
        if (token !== this.growthToken) return;
        series.push(...part);
      }
      this.update({ growth: { status: "ready", byTopic: subtreeGrowth(nodes, series) } });
    } catch {
      if (token === this.growthToken && !keep) this.update({ growth: { status: "error" } });
    }
  }

  /** A read in place: the shape on screen stays until the new one arrives. */
  private refresh(): void {
    if (!this.active) return;
    this.attempt += 1;
    this.load(this.snapshot.load.status === "ready");
  }

  private listen(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = (this.deps.onTreeChanged ?? onTreeChanged)((event) => {
      if (!this.active || this.snapshot.load.status !== "ready") return;
      if (event.generation <= this.seenGeneration) return;
      if (this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.refresh();
      }, this.deps.refreshDelayMs ?? 1_000);
    });
  }

  private stopListening(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async loadDetails(changeSetId: string): Promise<void> {
    const token = (this.detailTokens.get(changeSetId) ?? 0) + 1;
    this.detailTokens.set(changeSetId, token);
    this.update({ details: { ...this.snapshot.details, [changeSetId]: { status: "loading" } } });
    let detail: ChangeDetail;
    try {
      const changeSet = await this.deps.api().changeSet({ id: changeSetId });
      detail = changeSet === null ? { status: "missing" } : { status: "ready", changeSet };
    } catch {
      detail = { status: "error" };
    }
    // Closed meanwhile, or asked again: this answer is not wanted.
    if (this.detailTokens.get(changeSetId) !== token) return;
    this.update({ details: { ...this.snapshot.details, [changeSetId]: detail } });
  }

  private setAction(changeSetId: string, action: ChangeAction): void {
    this.update({ actions: { ...this.snapshot.actions, [changeSetId]: action } });
  }

  private clearAction(changeSetId: string): void {
    this.update({ actions: without(this.snapshot.actions, changeSetId) });
  }

  private announce(key: MessageKey): void {
    const t = this.translator;
    if (!t) return;
    this.update({ announcement: nextAnnouncement(this.snapshot.announcement, t(key)) });
  }

  private update(change: Partial<ShapeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
