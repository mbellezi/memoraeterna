import type {
  TopicNotes,
  TopicNotesInput,
  TopicPath,
  TopicReembedInput,
  TopicReembedResult,
  TopicTree,
  TopicsChangedEvent,
  TopicsStatus
} from "@app/domain";
import {
  appendNodes,
  ancestorsToOpen,
  branchDataFromTree,
  branchKeyOf,
  emptyBranch,
  hasChange,
  isStaleCursor,
  mergeChange,
  navLimits,
  noChange,
  rootBranchKey,
  topicKey,
  touchedBranches,
  unreadOpenTopics,
  unsortedKey,
  visibleBranchKeys,
  withItemsPage,
  type Branch,
  type PendingChange,
  type PlaceEntry
} from "./topic-navigation";
import { loadPlaces, type PlacesApi, type ResolvedTopic } from "./topic-places";
import type { ReembedState } from "./topic-status";

/** What the navigator reads and does; the container binds it to `window.app`. */
export interface NavigatorApi extends PlacesApi {
  notes(input: TopicNotesInput): Promise<TopicNotes | null>;
  status(): Promise<TopicsStatus>;
  reembed(input: TopicReembedInput): Promise<TopicReembedResult>;
}

export interface PlacesState {
  phase: "loading" | "ready" | "error";
  pinned: PlaceEntry[];
  recents: PlaceEntry[];
}

export interface NavigatorSnapshot {
  branches: ReadonlyMap<string, Branch>;
  /** Open topics (by ID) and the Unsorted group. */
  expanded: ReadonlySet<string>;
  places: PlacesState;
  status: TopicsStatus | null;
  reembed: ReembedState;
  /** A row to scroll into view; `token` changes for every request, even for the same row. */
  reveal: { key: string; token: number } | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** Pages looked through to find a topic that is being revealed. */
const revealPages = 6;
/** Page reads that may be needed to get past the leaves already shown. */
const itemPageReads = 4;

/**
 * The navigator's state and its loading, without React: branches of the tree read on demand, the
 * open topics, Pinned and Recents, and the engine's status. Nothing is read while the Wiki is
 * hidden, a pushed change touches only the branches that show the topics it names, and answers that
 * were overtaken by a newer read of the same branch are dropped. Views subscribe (`useSyncExternalStore`).
 */
export class TopicNavigatorStore {
  private snap: NavigatorSnapshot = {
    branches: new Map(),
    expanded: new Set(),
    places: { phase: "loading", pinned: [], recents: [] },
    status: null,
    reembed: "idle",
    reveal: null
  };
  private readonly listeners = new Set<() => void>();
  private readonly counters = new Map<string, number>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly resolved = new Map<string, ResolvedTopic | null>();
  private active = false;
  private started = false;
  private pending: PendingChange = noChange;
  private historyDirty = false;
  private flushing = false;
  private flushAgain = false;
  private placesRequest = 0;
  private statusRequest = 0;
  private revealToken = 0;

  constructor(private readonly api: NavigatorApi) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snap;

  // -------------------------------------------------------------------------
  // Visibility

  /** A hidden navigator reads nothing; shown again it reads what was pushed meanwhile. */
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (!active) return;
    if (!this.started) {
      this.started = true;
      void this.loadBranch(null, "load");
      void this.loadPlaces();
      void this.loadStatus();
      return;
    }
    // A failed load stays visible and is read again; a good one is refreshed in place.
    const root = this.snap.branches.get(rootBranchKey);
    if (!root || root.phase === "error") void this.loadBranch(null, "load");
    if (this.snap.places.phase === "error") void this.loadPlaces();
    void this.loadStatus();
    if (hasChange(this.pending) || this.historyDirty) void this.flush();
  }

  /** The tree changed (pushed after a change-set commits). */
  handleChanged(event: Pick<TopicsChangedEvent, "topicIds">) {
    if (!this.started) return;
    this.pending = mergeChange(this.pending, event);
    if (this.active) void this.flush();
  }

  /** The view history changed: Pinned and Recents are read again. */
  handleHistoryChanged() {
    if (!this.started) return;
    this.historyDirty = true;
    if (this.active) void this.flush();
  }

  // -------------------------------------------------------------------------
  // The tree

  expand(key: string) {
    if (this.snap.expanded.has(key)) return;
    this.update({ expanded: new Set([...this.snap.expanded, key]) });
    if (key !== unsortedKey) this.loadMissing();
  }

  collapse(key: string) {
    if (!this.snap.expanded.has(key)) return;
    const expanded = new Set(this.snap.expanded);
    expanded.delete(key);
    this.update({ expanded });
  }

  toggle(key: string) {
    if (this.snap.expanded.has(key)) this.collapse(key);
    else this.expand(key);
  }

  collapseAll() {
    if (this.snap.expanded.size === 0) return;
    this.update({ expanded: new Set() });
  }

  /** Reads a branch again after it failed. */
  retryBranch(parentId: string | null) {
    void this.loadBranch(parentId, "load");
  }

  retryPlaces() {
    void this.loadPlaces();
  }

  /** The next page of a topic's subtopics. */
  async loadMoreTopics(parentId: string | null): Promise<void> {
    const key = branchKeyOf(parentId);
    const branch = this.snap.branches.get(key);
    const cursor = branch?.data?.nextCursor;
    if (!branch || !cursor || branch.moreTopics === "loading") return;
    this.setBranch(key, { ...branch, moreTopics: "loading" });
    const request = this.begin(key);
    try {
      const tree = await this.api.tree({
        parentId,
        cursor,
        limit: navLimits.children,
        includeItems: false,
        itemLimit: 0
      });
      if (!this.current(key, request)) return;
      const latest = this.snap.branches.get(key);
      if (tree === null) return this.branchGone(parentId);
      if (!latest?.data) return;
      this.setBranch(key, { ...latest, data: appendNodes(latest.data, tree), moreTopics: "idle" });
      this.loadMissing();
    } catch (error) {
      if (!this.current(key, request)) return;
      // A cursor the tree has moved past is not retried: the branch is read again from the start.
      if (isStaleCursor(error)) return void this.loadBranch(parentId, "refresh");
      const latest = this.snap.branches.get(key);
      if (latest) this.setBranch(key, { ...latest, moreTopics: "error" });
    }
  }

  /** More leaves of a topic (or of the Unsorted group, `parentId` null). */
  async loadMoreItems(parentId: string | null): Promise<void> {
    const key = branchKeyOf(parentId);
    const branch = this.snap.branches.get(key);
    const start = branch?.data;
    if (!branch || !start || start.moreItems <= 0 || branch.moreItems === "loading") return;
    this.setBranch(key, { ...branch, moreItems: "loading" });
    const request = this.begin(key);
    try {
      let data = start;
      let cursor = start.itemsCursor;
      let first = cursor === null;
      for (let read = 0; read < itemPageReads; read += 1) {
        const page = await this.api.notes({
          id: start.parent.id,
          scope: "direct",
          kind: "all",
          limit: navLimits.page,
          ...(cursor ? { cursor } : {})
        });
        if (!this.current(key, request)) return;
        if (page === null) return this.branchGone(parentId);
        const next = withItemsPage(data, page, first);
        const grew = next.items.length > data.items.length;
        data = next;
        cursor = page.nextCursor;
        first = false;
        if (grew || cursor === null) break;
      }
      const latest = this.snap.branches.get(key);
      if (latest) this.setBranch(key, { ...latest, data, moreItems: "idle" });
    } catch (error) {
      if (!this.current(key, request)) return;
      if (isStaleCursor(error)) return void this.loadBranch(parentId, "refresh");
      const latest = this.snap.branches.get(key);
      if (latest) this.setBranch(key, { ...latest, moreItems: "error" });
    }
  }

  /**
   * Opens the path to a topic so its row exists, then asks the view to scroll to it. Gives up
   * quietly when the topic is gone or sits beyond the pages looked through.
   */
  async reveal(topicId: string): Promise<void> {
    if (!this.started) return;
    let path: TopicPath | null;
    try {
      path = await this.api.path({ id: topicId });
    } catch {
      return;
    }
    if (!path) return;
    await this.loads.get(rootBranchKey);
    const rootId =
      this.snap.branches.get(rootBranchKey)?.data?.parent.id ?? path.path[0]?.id ?? null;
    let parentKey = rootBranchKey;
    for (const id of [...ancestorsToOpen(path.path, rootId), path.resolvedId]) {
      if (!(await this.ensureListed(parentKey, id))) return;
      if (id === path.resolvedId) break;
      this.expand(id);
      await this.loads.get(id);
      parentKey = id;
    }
    this.update({ reveal: { key: topicKey(path.resolvedId), token: (this.revealToken += 1) } });
  }

  // -------------------------------------------------------------------------
  // The status line

  askReembed() {
    if (this.snap.reembed === "idle" || this.snap.reembed === "failed") {
      this.update({ reembed: "confirming" });
    }
  }

  cancelReembed() {
    if (this.snap.reembed === "confirming") this.update({ reembed: "idle" });
  }

  async confirmReembed(): Promise<void> {
    if (this.snap.reembed !== "confirming") return;
    this.update({ reembed: "working" });
    try {
      await this.api.reembed({ confirm: true });
      this.update({ reembed: "queued" });
      void this.loadStatus();
    } catch {
      this.update({ reembed: "failed" });
    }
  }

  // -------------------------------------------------------------------------
  // Loading

  private loadBranch(parentId: string | null, how: "load" | "refresh"): Promise<void> {
    const promise = this.readBranch(parentId, how);
    this.loads.set(branchKeyOf(parentId), promise);
    return promise;
  }

  private async readBranch(parentId: string | null, how: "load" | "refresh"): Promise<void> {
    const key = branchKeyOf(parentId);
    const request = this.begin(key);
    const previous = this.snap.branches.get(key);
    const kept = previous?.data ?? null;
    if (how === "load" || !kept) this.setBranch(key, emptyBranch("loading", kept));
    // A refresh asks for as much as is shown, so open pages and peeked leaves do not shrink.
    const limit = kept
      ? clamp(kept.nodes.length, navLimits.children, navLimits.childrenMax)
      : navLimits.children;
    const itemLimit = kept
      ? clamp(kept.items.length, navLimits.peek, navLimits.peekMax)
      : navLimits.peek;
    let tree: TopicTree | null;
    try {
      tree = await this.api.tree({ parentId, limit, includeItems: true, itemLimit });
    } catch {
      if (!this.current(key, request)) return;
      // A refresh that failed keeps showing what is there; a load that failed says so.
      this.setBranch(
        key,
        how === "refresh" && previous && kept
          ? { ...previous, phase: "ready" }
          : emptyBranch("error", kept)
      );
      return;
    }
    if (!this.current(key, request)) return;
    if (tree === null) return this.branchGone(parentId);
    if (kept && tree.generation < kept.generation) {
      // Older than what is shown: a later read already landed.
      this.setBranch(key, { ...(previous ?? emptyBranch("ready")), phase: "ready", data: kept });
      return;
    }
    this.setBranch(key, emptyBranch("ready", branchDataFromTree(tree)));
    this.loadMissing();
  }

  /** The tree answered "nothing here": the root has no tree yet; a topic left the tree. */
  private branchGone(parentId: string | null) {
    if (parentId === null) {
      this.setBranch(rootBranchKey, emptyBranch("ready"));
      return;
    }
    const branches = new Map(this.snap.branches);
    branches.delete(parentId);
    const expanded = new Set(this.snap.expanded);
    expanded.delete(parentId);
    this.update({ branches, expanded });
    this.pending = mergeChange(this.pending, { topicIds: null });
    if (this.active) void this.flush();
  }

  /** Open topics that are on screen but not read yet are read now. */
  private loadMissing() {
    for (const id of unreadOpenTopics(this.snap.branches, this.snap.expanded)) {
      void this.loadBranch(id, "load");
    }
  }

  private async ensureListed(parentKey: string, id: string): Promise<boolean> {
    for (let page = 0; page < revealPages; page += 1) {
      await this.loads.get(parentKey);
      const data = this.snap.branches.get(parentKey)?.data;
      if (!data) return false;
      if (data.nodes.some((node) => node.id === id)) return true;
      if (!data.nextCursor) return false;
      await this.loadMoreTopics(parentKey === rootBranchKey ? null : parentKey);
    }
    return false;
  }

  /**
   * Applies what was pushed: visible branches that show a changed topic are read again, hidden
   * ones are dropped (read when opened), and the places and the status follow. One run at a time;
   * a change that arrives meanwhile makes one more.
   */
  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        const change = this.pending;
        const historyDirty = this.historyDirty;
        this.pending = noChange;
        this.historyDirty = false;
        const work: Promise<unknown>[] = [];
        if (hasChange(change)) {
          work.push(this.refreshBranches(change));
          work.push(this.loadStatus());
        }
        if (this.invalidatePlaces(change) || historyDirty) work.push(this.loadPlaces());
        await Promise.all(work);
      } while (this.flushAgain && this.active);
    } finally {
      this.flushing = false;
    }
  }

  private async refreshBranches(change: PendingChange): Promise<void> {
    const touched = touchedBranches(this.snap.branches, change);
    if (touched.length === 0) return;
    const visible = visibleBranchKeys(this.snap.branches, this.snap.expanded);
    const hidden = touched.filter((key) => !visible.has(key));
    if (hidden.length > 0) {
      const branches = new Map(this.snap.branches);
      for (const key of hidden) branches.delete(key);
      this.update({ branches });
    }
    await Promise.all(
      touched
        .filter((key) => visible.has(key))
        .map((key) => this.loadBranch(key === rootBranchKey ? null : key, "refresh"))
    );
  }

  /** Forgets the cached topics a change touches; true when a list shown has to be built again. */
  private invalidatePlaces(change: PendingChange): boolean {
    let stale = false;
    for (const [id, topic] of this.resolved) {
      if (change.all || change.ids.has(id) || (topic !== null && change.ids.has(topic.id))) {
        this.resolved.delete(id);
        stale = true;
      }
    }
    return stale;
  }

  private async loadPlaces(): Promise<void> {
    const request = (this.placesRequest += 1);
    if (this.snap.places.phase !== "ready") {
      this.update({ places: { phase: "loading", pinned: [], recents: [] } });
    }
    try {
      const places = await loadPlaces(this.api, this.resolved);
      if (request !== this.placesRequest) return;
      this.update({ places: { phase: "ready", ...places } });
    } catch {
      if (request !== this.placesRequest) return;
      // A list that was shown stays; a first load that failed says so.
      if (this.snap.places.phase !== "ready") {
        this.update({ places: { phase: "error", pinned: [], recents: [] } });
      }
    }
  }

  private async loadStatus(): Promise<void> {
    const request = (this.statusRequest += 1);
    try {
      const status = await this.api.status();
      if (request !== this.statusRequest) return;
      // Once the model is no longer a problem, the re-embedding offer starts over.
      const settled = status.blocked !== "space_changed" ? "idle" : this.snap.reembed;
      this.update({ status, reembed: settled });
    } catch {
      // The status line is informative only; the last one stays.
    }
  }

  // -------------------------------------------------------------------------
  // State

  private begin(key: string): number {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  private current(key: string, request: number): boolean {
    return this.counters.get(key) === request;
  }

  private setBranch(key: string, branch: Branch) {
    const branches = new Map(this.snap.branches);
    branches.set(key, branch);
    this.update({ branches });
  }

  private update(patch: Partial<NavigatorSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
