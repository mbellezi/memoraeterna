import type { DesktopApi } from "../../shared/ipc";
import { describeIndexOf, type DescribeIndex } from "./settings-model";

/**
 * What Settings v2 knows of the saved values, as a small store outside React so every rule is
 * tested without a renderer: `settings.describe` read once when the surface is shown, again on each
 * `settings.changed` (never a timer), and the resets the person asks for, one row at a time. A read
 * that failed stays visible and can be retried; a value that was shown stays shown when a later read
 * fails.
 */

export interface SettingsStoreApi {
  settings: Pick<DesktopApi["settings"], "describe" | "reset">;
  onAppEvent: DesktopApi["onAppEvent"];
}

export type DescribeRead =
  { status: "loading" } | { status: "error" } | { status: "ready"; index: DescribeIndex };

/** Where one row's reset stands: not asked, running, failed, or waiting for a step the person confirms. */
export type RowReset = "idle" | "working" | "failed" | "pending";

/** What a reset came to: done, left for the person's confirmed step, or failed. */
export type ResetOutcome = "done" | "pending" | "failed";

export interface SettingsSnapshot {
  read: DescribeRead;
  rows: Readonly<Record<string, RowReset>>;
}

export class SettingsStore {
  private snapshot: SettingsSnapshot = { read: { status: "loading" }, rows: {} };
  private readonly listeners = new Set<() => void>();
  private stops: Array<() => void> = [];
  private holders = 0;
  private started = false;
  private token = 0;
  private loading = false;
  private again = false;

  constructor(private readonly api: () => SettingsStoreApi) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SettingsSnapshot => this.snapshot;

  /**
   * Follows the bus and reads once for as long as anyone holds the store: the first holder starts it
   * and the last to let go stops it. Returns what lets go.
   */
  retain(): () => void {
    this.holders += 1;
    if (!this.started) {
      this.started = true;
      this.stops = [this.api().onAppEvent("settings.changed", () => this.load())];
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
    this.loading = false;
    this.again = false;
  }

  /** The person asked to try again after a failed first read. */
  retry(): void {
    if (!this.started) return;
    this.set({ ...this.snapshot, read: { status: "loading" } });
    this.load();
  }

  /** Reads the values again; a read already on its way is followed by one more, never two at once. */
  load(): void {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    const token = ++this.token;
    this.api()
      .settings.describe()
      .then((result) => {
        if (token === this.token)
          this.set({
            ...this.snapshot,
            read: { status: "ready", index: describeIndexOf(result.entries) }
          });
      })
      .catch(() => {
        // Values that were shown stay shown; only a first read can fail.
        if (token === this.token && this.snapshot.read.status !== "ready")
          this.set({ ...this.snapshot, read: { status: "error" } });
      })
      .finally(() => {
        if (token !== this.token) return;
        this.loading = false;
        if (this.again) {
          this.again = false;
          this.load();
        }
      });
  }

  /** Puts one setting back to its default through its own writer. */
  async reset(id: string, confirmed = false): Promise<ResetOutcome> {
    this.setRow(id, "working");
    try {
      const result = await this.api().settings.reset({ id, ...(confirmed ? { confirmed } : {}) });
      this.setRow(id, result.pending ? "pending" : "idle");
      this.load();
      return result.pending ? "pending" : "done";
    } catch {
      this.setRow(id, "failed");
      return "failed";
    }
  }

  /** Puts each of `ids` back, one after the other; the ones that wait for a confirmed step are counted. */
  async restoreAll(
    ids: readonly string[]
  ): Promise<{ done: number; pending: number; failed: number }> {
    const tally = { done: 0, pending: 0, failed: 0 };
    for (const id of ids) tally[await this.reset(id)] += 1;
    return tally;
  }

  private setRow(id: string, state: RowReset): void {
    const rows = { ...this.snapshot.rows };
    if (state === "idle") delete rows[id];
    else rows[id] = state;
    this.set({ ...this.snapshot, rows });
  }

  private set(next: SettingsSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

const stores = new WeakMap<object, SettingsStore>();

/** The one store of a `window.app` (a test hands its fake). */
export function settingsStoreOf(app: SettingsStoreApi | undefined): SettingsStore {
  const key = app ?? stores;
  let store = stores.get(key);
  if (!store) {
    store = new SettingsStore(() => {
      if (!app) throw new Error("Settings needs window.app");
      return app;
    });
    stores.set(key, store);
  }
  return store;
}
