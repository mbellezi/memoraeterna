import type { ImportEstimate } from "@app/domain";

import type { AppEventHandler, AppEventType } from "../../../../shared/app-events";
import type { DesktopApi, SourceDetail } from "../../../../shared/ipc";
import type { LibrarySourceProgress } from "../../../../shared/ipc-library";
import type { ViewHistoryRecordInput } from "../../../../shared/view-history";
import { subscribe } from "../../../lib/app-events";
import { defaultProcessingPlan } from "../../../components/ProcessingPlanPicker";
import { noticeForKinds, noticeForTargets, type ObjectTarget } from "../../../lib/object-events";
import { isUnsorted, ribbonSegments } from "../../PathRibbon";
import { stripModel } from "./source-strip-model";

/**
 * The state of one Source panel, outside React so every rule is tested without a renderer.
 *
 * It reads the source (`knowledge.getSourceDetail`) and the generation strip's values
 * (`library.sourceProgress`) once when the panel is shown, and again only when the bus says
 * something changed: `object.changed` for the source or any note, `tree.changed` for the places of
 * its notes, and `job.progress` only while the strip is live. A hidden panel loads nothing and
 * listens to nothing. Reads are coalesced (one in flight, one waiting) and a failed re-read keeps
 * what is shown. There is no timer that asks again: a quiet period after a pushed change only joins
 * the changes of one burst into one read.
 */

export type SourceLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; detail: SourceDetail };

export type StripRead =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; progress: NonNullable<LibrarySourceProgress> };

/** Where a note sits in the tree: the crumbs of its primary path. */
export type NotePath =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unplaced" }
  | { status: "placed"; crumbs: ReadonlyArray<{ id: string; title: string }> };

/** The money line of the strip: the import estimate, once, from the passages indexed. */
export type CostRead =
  { status: "idle" } | { status: "error" } | { status: "ready"; estimate: ImportEstimate };

export type RunActionState = { status: "idle" } | { status: "pending" } | { status: "failed" };

export interface SourceSnapshot {
  load: SourceLoad;
  strip: StripRead;
  paths: ReadonlyMap<string, NotePath>;
  cost: CostRead;
  action: RunActionState;
  /** The only source in the library: the strip's hint also introduces the Gardener (A6). */
  firstSource: boolean;
  /** When the answer on screen was read; "agora mesmo" and the time left are measured against it. */
  readAt: number;
}

export type SourceApi = {
  knowledge: Pick<DesktopApi["knowledge"], "getSourceDetail">;
  library: Pick<DesktopApi["library"], "sourceProgress" | "rows">;
  objects: Pick<DesktopApi["objects"], "locate">;
  budget: Pick<DesktopApi["budget"], "estimateImport">;
  ingestion: Pick<DesktopApi["ingestion"], "process">;
};

export type Subscribe = <T extends AppEventType>(
  type: T,
  handler: AppEventHandler<T>
) => () => void;

export interface SourceControllerDeps {
  api: () => SourceApi;
  /** Where the bus's events arrive; the app's by default. */
  subscribe?: Subscribe;
  record: (input: ViewHistoryRecordInput) => void;
  now?: () => number;
  /** Quiet time after a pushed change before the panel is read again. */
  refreshDelayMs?: number;
}

const initialSnapshot = (): SourceSnapshot => ({
  load: { status: "loading" },
  strip: { status: "loading" },
  paths: new Map(),
  cost: { status: "idle" },
  action: { status: "idle" },
  firstSource: false,
  readAt: 0
});

/** Note places read at the same time. */
const locateConcurrency = 3;

export class SourceController {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private sourceId: string | null = null;
  private active = false;
  /** The newest full read; an older answer arriving later is dropped. */
  private token = 0;
  private progressToken = 0;
  private reading = false;
  private again = false;
  private wasHidden = false;
  private recorded = false;
  private firstSourceAsked = false;
  private unsubscribers: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly wanted = new Set<string>();
  private readonly queue: string[] = [];
  private locating = 0;
  /** Note ids whose place was read: a change of a note or of the tree reads it again, in place. */
  private stale = new Set<string>();

  constructor(private readonly deps: SourceControllerDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SourceSnapshot => this.snapshot;

  /** Called whenever the source or its visibility changes. */
  show(sourceId: string, active: boolean): void {
    const changed = sourceId !== this.sourceId;
    this.sourceId = sourceId;
    if (!active) {
      this.active = false;
      this.wasHidden = true;
      this.stopListening();
      return;
    }
    const wasActive = this.active;
    this.active = true;
    this.listen();
    if (changed) this.reset();
    if (changed || this.snapshot.load.status !== "ready") {
      if (!wasActive || changed) void this.readAll(false);
      return;
    }
    if (this.wasHidden) {
      this.wasHidden = false;
      void this.readAll(true);
    }
  }

  /** "Tentar de novo" on a failed read. */
  retry(): void {
    if (!this.active || this.sourceId === null) return;
    void this.readAll(false);
  }

  /** The strip's own retry: only its values are read again. */
  retryStrip(): void {
    if (!this.active || this.sourceId === null) return;
    this.update({ strip: { status: "loading" } });
    void this.readProgress();
  }

  /** Stops listening; `show` brings the panel back. */
  dispose(): void {
    this.active = false;
    this.wasHidden = true;
    this.stopListening();
  }

  /**
   * The notes whose places the panel draws. A place is read once and kept; a note that changed, or
   * a tree change, reads it again in place, so a row never flashes back to a skeleton.
   */
  want(noteIds: readonly string[]): void {
    this.wanted.clear();
    for (const id of noteIds) {
      this.wanted.add(id);
      if (!this.snapshot.paths.has(id) || this.stale.has(id)) this.enqueue(id);
    }
  }

  /**
   * Starts the work this source lacks: its notes, or the stage that failed. The strip shows the
   * run as soon as the queue admits it (`object.changed` and `job.progress` tell it so).
   */
  async run(request: "notes" | "retry"): Promise<void> {
    const sourceId = this.sourceId;
    const load = this.snapshot.load;
    if (sourceId === null || load.status !== "ready" || this.snapshot.action.status === "pending")
      return;
    this.update({ action: { status: "pending" } });
    try {
      const searchOnly =
        request === "retry" &&
        this.snapshot.strip.status === "ready" &&
        this.snapshot.strip.progress.steps.notes.state === "notApplicable";
      await this.deps.api().ingestion.process({
        plan: {
          ...defaultProcessingPlan(searchOnly ? "search_ready" : "full_knowledge"),
          targetSourceItemIds: [sourceId],
          scope: load.detail.documents.length > 0 ? "source_only" : "children_only"
        },
        runKind: "missing_stages",
        trigger: "library_action"
      });
      if (this.sourceId !== sourceId) return;
      this.update({ action: { status: "idle" } });
      this.schedule();
    } catch {
      if (this.sourceId === sourceId) this.update({ action: { status: "failed" } });
    }
  }

  // -------------------------------------------------------------------------

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private reset(): void {
    this.token += 1;
    this.progressToken += 1;
    this.reading = false;
    this.again = false;
    this.recorded = false;
    this.firstSourceAsked = false;
    this.wanted.clear();
    this.queue.length = 0;
    this.stale = new Set();
    this.clearTimer();
    this.snapshot = initialSnapshot();
    this.emit();
  }

  /** The source and its strip, together: one coalesced read; a second request waits for the first. */
  private async readAll(silent: boolean): Promise<void> {
    const sourceId = this.sourceId;
    if (sourceId === null) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    const token = ++this.token;
    if (!silent) this.update({ load: { status: "loading" }, strip: { status: "loading" } });
    const api = this.deps.api();
    const detail = api.knowledge
      .getSourceDetail(sourceId)
      .then((value) => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const }));
    const strip = this.readStrip(sourceId);
    const [detailRead] = await Promise.all([detail, strip]);
    this.reading = false;
    if (token !== this.token || this.sourceId !== sourceId) return;
    if (!detailRead.ok) {
      // A failed refresh keeps the panel that is shown.
      if (!silent || this.snapshot.load.status !== "ready")
        this.update({ load: { status: "error" } });
    } else if (detailRead.value === null) {
      this.update({ load: { status: "missing" } });
    } else {
      this.update({ load: { status: "ready", detail: detailRead.value }, readAt: this.now() });
      this.recordOpen(detailRead.value);
    }
    this.afterRead();
    if (this.again) {
      this.again = false;
      void this.readAll(true);
    }
  }

  private async readStrip(sourceId: string): Promise<void> {
    const token = ++this.progressToken;
    try {
      const progress = await this.deps.api().library.sourceProgress({ sourceId });
      if (token !== this.progressToken || this.sourceId !== sourceId) return;
      // `null`: the source is not there; the detail read says so, the strip has nothing to show.
      if (progress === null) return;
      this.update({ strip: { status: "ready", progress }, readAt: this.now() });
    } catch {
      if (token !== this.progressToken || this.sourceId !== sourceId) return;
      if (this.snapshot.strip.status !== "ready") this.update({ strip: { status: "error" } });
    }
  }

  /** The strip alone, on `job.progress`: the source's own reading did not change. */
  private async readProgress(): Promise<void> {
    const sourceId = this.sourceId;
    if (sourceId === null) return;
    await this.readStrip(sourceId);
    this.afterRead();
  }

  /** What a fresh read makes worth asking: the money line and the first-source hint, once each. */
  private afterRead(): void {
    const strip = this.snapshot.strip;
    if (strip.status !== "ready") return;
    const model = stripModel(strip.progress, this.now());
    if (model.kind !== "running") return;
    if (this.snapshot.cost.status === "idle" && model.indexed > 0)
      void this.readCost(model.indexed);
    if (!this.firstSourceAsked) {
      this.firstSourceAsked = true;
      void this.readFirstSource();
    }
  }

  private async readCost(chunkCount: number): Promise<void> {
    const sourceId = this.sourceId;
    try {
      const estimate = await this.deps.api().budget.estimateImport({ chunkCount });
      if (this.sourceId === sourceId) this.update({ cost: { status: "ready", estimate } });
    } catch {
      if (this.sourceId === sourceId) this.update({ cost: { status: "error" } });
    }
  }

  private async readFirstSource(): Promise<void> {
    const sourceId = this.sourceId;
    try {
      const rows = await this.deps.api().library.rows({ limit: 1 });
      if (this.sourceId === sourceId && rows.total === 1) this.update({ firstSource: true });
    } catch {
      // The hint is a courtesy: without the answer it keeps the ordinary words.
    }
  }

  /** A pushed change reads the panel again after a short quiet period, once per burst. */
  private schedule(): void {
    if (!this.active || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.readAll(true);
    }, this.deps.refreshDelayMs ?? 300);
  }

  private listen(): void {
    if (this.unsubscribers.length > 0) return;
    const on: Subscribe = this.deps.subscribe ?? subscribe;
    this.unsubscribers = [
      on("object.changed", (event) => {
        const id = this.sourceId;
        if (!this.active || id === null) return;
        const targets: ObjectTarget[] = [{ kind: "source", id }];
        const own = noticeForTargets(event, targets);
        const notes = noticeForKinds(event, ["note"]);
        const topics = noticeForKinds(event, ["topic"]);
        if (notes) {
          if (notes.overflow)
            for (const noteId of this.snapshot.paths.keys()) this.stale.add(noteId);
          for (const ref of notes.refs) this.stale.add(ref.id);
        }
        if (topics) for (const noteId of this.snapshot.paths.keys()) this.stale.add(noteId);
        if (own || notes) this.schedule();
        else if (topics) this.requeueStale();
      }),
      on("tree.changed", () => {
        if (!this.active) return;
        for (const noteId of this.snapshot.paths.keys()) this.stale.add(noteId);
        this.requeueStale();
      }),
      on("job.progress", () => {
        // Only a strip that is live follows the jobs; a finished one is read again by `object.changed`.
        if (!this.active || this.reading) return;
        const strip = this.snapshot.strip;
        if (strip.status !== "ready") return;
        const kind = stripModel(strip.progress, this.now()).kind;
        if (kind === "running" || kind === "paused" || kind === "needsYou")
          void this.readProgress();
      })
    ];
  }

  private stopListening(): void {
    for (const stop of this.unsubscribers) stop();
    this.unsubscribers = [];
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** The places on screen that a change made stale are read again, in place. */
  private requeueStale(): void {
    for (const id of this.wanted) if (this.stale.has(id)) this.enqueue(id);
  }

  private enqueue(noteId: string): void {
    if (this.queue.includes(noteId)) return;
    this.queue.push(noteId);
    this.pump();
  }

  private pump(): void {
    while (this.locating < locateConcurrency && this.queue.length > 0) {
      const noteId = this.queue.shift() as string;
      if (!this.wanted.has(noteId)) continue;
      this.locating += 1;
      void this.locate(noteId).finally(() => {
        this.locating -= 1;
        this.pump();
      });
    }
  }

  private async locate(noteId: string): Promise<void> {
    const sourceId = this.sourceId;
    const known = this.snapshot.paths.has(noteId);
    this.stale.delete(noteId);
    if (!known) this.setPath(noteId, { status: "loading" });
    try {
      const located = await this.deps.api().objects.locate({ address: `memora://note/${noteId}` });
      if (this.sourceId !== sourceId) return;
      if (!located || isUnsorted(located)) {
        this.setPath(noteId, { status: "unplaced" });
        return;
      }
      this.setPath(noteId, {
        status: "placed",
        crumbs: ribbonSegments(located).map((crumb) => ({ id: crumb.id, title: crumb.title }))
      });
    } catch {
      // A failed re-read keeps the place that is shown.
      if (this.sourceId === sourceId && !known) this.setPath(noteId, { status: "error" });
    }
  }

  private setPath(noteId: string, path: NotePath): void {
    const paths = new Map(this.snapshot.paths);
    paths.set(noteId, path);
    this.update({ paths });
  }

  /** One recorded open per showing of the panel (Recentes). */
  private recordOpen(detail: SourceDetail): void {
    if (this.recorded || !this.active) return;
    this.recorded = true;
    this.deps.record({ kind: "source", id: detail.id, title: detail.title });
  }

  private update(patch: Partial<SourceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
