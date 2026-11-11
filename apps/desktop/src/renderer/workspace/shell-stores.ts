import type { TopicNodeSummary } from "@app/domain";

import type { DesktopApi } from "../../shared/ipc";

/**
 * What the shell chrome reads, as two small stores outside React so every rule is tested without a
 * renderer: the Inbox count behind the rail's badge, and the top level of the tree behind the
 * navigator host. Both read once when they start, follow the bus after that (never a timer) and
 * keep a failure visible and retryable (design record §5.12).
 */

/** A read that is loading, failed (and can be retried), or answered. */
export type Read<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

abstract class Store<T> {
  protected snapshot: Read<T> = { status: "loading" };
  private readonly listeners = new Set<() => void>();
  private stops: Array<() => void> = [];
  private started = false;
  private holders = 0;
  protected token = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): Read<T> => this.snapshot;

  /**
   * Follows the bus and reads once, for as long as anyone holds the store: the first holder starts
   * it and the last to let go stops it. Returns what lets go.
   */
  retain(): () => void {
    this.holders += 1;
    if (!this.started) {
      this.started = true;
      this.stops = this.follow();
      this.load();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (this.holders === 0) this.stop();
    };
  }

  private stop(): void {
    this.started = false;
    for (const stop of this.stops.splice(0)) stop();
    this.token += 1;
  }

  /** The person asked to try again after a failure. */
  retry(): void {
    if (!this.started) return;
    this.snapshot = { status: "loading" };
    this.emit();
    this.load();
  }

  protected abstract follow(): Array<() => void>;
  protected abstract load(): void;

  protected set(next: Read<T>): void {
    this.snapshot = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

// ---------------------------------------------------------------------------
// The Inbox count

/** What the count needs of `window.app`. */
export interface InboxCountApi {
  inbox: Pick<DesktopApi["inbox"], "counts">;
  onAppEvent: DesktopApi["onAppEvent"];
}

/** How many items wait for the person: every kind the Inbox holds. */
export class InboxCountStore extends Store<number> {
  constructor(private readonly api: () => InboxCountApi) {
    super();
  }

  protected follow(): Array<() => void> {
    return [
      this.api().onAppEvent("inbox.changed", (event) => {
        // A pushed count is newer than a read that is still on its way.
        this.token += 1;
        this.set({ status: "ready", value: event.total });
      })
    ];
  }

  protected load(): void {
    const token = ++this.token;
    this.api()
      .inbox.counts()
      .then((counts) => {
        if (token === this.token) this.set({ status: "ready", value: counts.total });
      })
      .catch(() => {
        // A count that was shown stays shown; only a first read can fail.
        if (token === this.token && this.snapshot.status !== "ready") this.set({ status: "error" });
      });
  }
}

// ---------------------------------------------------------------------------
// The top of the tree

/** What the navigator host needs of `window.app`. */
export interface NavigatorTreeApi {
  topics: Pick<DesktopApi["topics"], "tree">;
  onAppEvent: DesktopApi["onAppEvent"];
}

/** One top-level topic as the host lists it. */
export type NavigatorTopic = Pick<
  TopicNodeSummary,
  "id" | "title" | "items" | "children" | "health"
>;

export interface NavigatorTree {
  /** The top-level topics, in the tree's own order. */
  topics: NavigatorTopic[];
  /** Every item below the root (notes and sources). */
  total: number;
  /** Items that wait for a place. */
  unsorted: number;
}

/** The top level of the topic tree; an empty library (no topics, no items) reads as empty. */
export class NavigatorTreeStore extends Store<NavigatorTree> {
  constructor(private readonly api: () => NavigatorTreeApi) {
    super();
  }

  protected follow(): Array<() => void> {
    return [this.api().onAppEvent("tree.changed", () => this.load())];
  }

  protected load(): void {
    const token = ++this.token;
    this.api()
      .topics.tree({ parentId: null })
      .then((tree) => {
        if (token !== this.token) return;
        this.set({
          status: "ready",
          value: tree
            ? {
                topics: tree.nodes.map(({ id, title, items, children, health }) => ({
                  id,
                  title,
                  items,
                  children,
                  health
                })),
                total: tree.parent.items,
                unsorted: tree.unsorted
              }
            : { topics: [], total: 0, unsorted: 0 }
        });
      })
      .catch(() => {
        // A tree that was shown stays shown when a refresh fails.
        if (token === this.token && this.snapshot.status !== "ready") this.set({ status: "error" });
      });
  }
}

// ---------------------------------------------------------------------------
// One store per `window.app`, shared by the chrome that reads it

const inboxCounts = new WeakMap<object, InboxCountStore>();
const navigatorTrees = new WeakMap<object, NavigatorTreeStore>();

/** A server render (and a test without a window) has no `window.app`: its stores never start. */
const noApp = (): never => {
  throw new Error("window.app is not available");
};
const inertInbox = new InboxCountStore(noApp);
const inertTree = new NavigatorTreeStore(noApp);

/** The window's Inbox count: the rail and the shell read the same store. */
export function inboxCountStoreOf(app: DesktopApi | undefined): InboxCountStore {
  if (!app) return inertInbox;
  let store = inboxCounts.get(app);
  if (!store) {
    store = new InboxCountStore(() => app);
    inboxCounts.set(app, store);
  }
  return store;
}

/** The window's top-level tree: the navigator host and the shell read the same store. */
export function navigatorTreeStoreOf(app: DesktopApi | undefined): NavigatorTreeStore {
  if (!app) return inertTree;
  let store = navigatorTrees.get(app);
  if (!store) {
    store = new NavigatorTreeStore(() => app);
    navigatorTrees.set(app, store);
  }
  return store;
}
