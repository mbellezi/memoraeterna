import type { EntitiesApi } from "../../../../shared/ipc-entities";
import { appendMentions, type EntityLoad } from "./entity-model";

/**
 * Reads the page of one entity and keeps it current. The state lives here, outside React, so the
 * rules are tested without a renderer:
 *
 * - a hidden panel loads nothing; shown again it reads once more, quietly, unless its last load
 *   failed (a failed load stays visible and retryable);
 * - a read the bus asks for keeps the page that is shown until the new one arrives, and a read that
 *   fails keeps it; the newest answer wins;
 * - changes that arrive while a read is under way ask for one more read, not one per change;
 * - more mentions are read by the cursor of the page, one request at a time, and an answer that
 *   belongs to an older page is dropped.
 */

export interface EntityControllerDeps {
  api: () => Pick<EntitiesApi, "page"> | undefined;
}

export class EntityPageController {
  private readonly listeners = new Set<() => void>();
  private load: EntityLoad = { status: "loading" };
  private id: string | null = null;
  private active = false;
  /** A change arrived while hidden: the next time the panel is shown it reads again. */
  private stale = false;
  /** The generation of the page: a new entity, a retry or a quiet read ends older answers. */
  private generation = 0;
  private reading = false;
  private again = false;

  constructor(private readonly deps: EntityControllerDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): EntityLoad => this.load;

  /** Shows the entity `id`; `active` is whether the panel is on screen. */
  show(id: string, active: boolean): void {
    const wasActive = this.active;
    this.active = active;
    if (id !== this.id) {
      this.id = id;
      this.stale = false;
      this.generation += 1;
      this.reading = false;
      this.again = false;
      this.set({ status: "loading" });
      if (active) this.read(false);
      return;
    }
    if (!active || wasActive) return;
    // Shown again: a page that was read and a page that changed meanwhile read again in place; a
    // page that never loaded (hidden since the start) loads; a failure stays until "retry".
    if (this.load.status === "loading" && !this.reading) this.read(false);
    else if (this.load.status === "ready" || this.load.status === "missing") this.read(true);
    this.stale = false;
  }

  /** "Tentar de novo" after a failure: the skeleton again, then the page. */
  retry(): void {
    if (this.id === null) return;
    this.generation += 1;
    this.reading = false;
    this.again = false;
    this.set({ status: "loading" });
    this.read(false);
  }

  /** The entity, its notes or their topics changed: read the page again in place. */
  reread(): void {
    if (this.id === null) return;
    if (!this.active) {
      this.stale = true;
      return;
    }
    // A failed first read waits for its retry; everything else shows the newer page.
    if (this.load.status === "error") return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.read(true);
  }

  /** The next page of mentions, by the cursor of what is loaded. */
  loadMore(): void {
    const load = this.load;
    const id = this.id;
    const api = this.deps.api();
    if (load.status !== "ready" || id === null || load.more === "loading") return;
    const cursor = load.page.mentions.next;
    if (cursor === undefined) return;
    if (!api) {
      this.set({ ...load, more: "error" });
      return;
    }
    const generation = this.generation;
    this.set({ ...load, more: "loading" });
    api
      .page({ id, cursor })
      .then((next) => {
        const current = this.load;
        if (generation !== this.generation || current.status !== "ready") return;
        if (next === null) this.set({ ...current, more: "error" });
        else this.set({ status: "ready", page: appendMentions(current.page, next), more: "idle" });
      })
      .catch(() => {
        const current = this.load;
        if (generation !== this.generation || current.status !== "ready") return;
        this.set({ ...current, more: "error" });
      });
  }

  /** Reads the first page. `quiet` keeps what is shown until the answer arrives or fails. */
  private read(quiet: boolean): void {
    const id = this.id;
    if (id === null) return;
    const api = this.deps.api();
    const generation = ++this.generation;
    this.reading = true;
    const finish = (apply: () => void) => {
      if (generation !== this.generation) return;
      this.reading = false;
      apply();
      if (this.again) {
        this.again = false;
        if (this.active) this.read(true);
        else this.stale = true;
      }
    };
    if (!api) {
      finish(() => {
        if (!quiet) this.set({ status: "error" });
      });
      return;
    }
    api
      .page({ id })
      .then((page) =>
        finish(() =>
          this.set(page === null ? { status: "missing" } : { status: "ready", page, more: "idle" })
        )
      )
      .catch(() =>
        finish(() => {
          // A failed re-read keeps the page that is shown; a first read says it failed.
          const current = this.load;
          if (!quiet || current.status === "loading") this.set({ status: "error" });
          // The read ended the answer of a "more" request that was under way: it can ask again.
          else if (current.status === "ready" && current.more === "loading")
            this.set({ ...current, more: "idle" });
        })
      );
  }

  private set(load: EntityLoad): void {
    this.load = load;
    for (const listener of [...this.listeners]) listener();
  }
}
