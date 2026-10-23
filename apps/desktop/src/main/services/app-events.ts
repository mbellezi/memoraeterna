// The typed in-process event bus (F4 D26, spec 3.9). A service publishes an event after the work it
// describes committed; the bus validates it, folds events of the same type and key that arrive
// within one window into one, and sends the result to the windows (one validated preload channel)
// and to in-process subscribers. Nothing is sent by a timer of its own: a window opens with the
// first event after an idle spell and closes 250 ms later.
import { topicLimits } from "@app/domain";

import {
  appEventJobIdsMax,
  AppEventSchema,
  type AppEvent,
  type AppEventHandler,
  type AppEventOf,
  type AppEventType
} from "../../shared/app-events.js";
import { relationsChangedMaxNoteIds } from "./relations/relations-changed.js";

/** How long events of one type and key are folded together. */
export const appEventCoalesceMs = 250;

interface Coalescing<T extends AppEventType> {
  /** Events of one type with the same key fold together; different keys stay apart. */
  key(event: AppEventOf<T>): string;
  /** What two events of the same type and key become; `next` is the newer one. */
  merge(previous: AppEventOf<T>, next: AppEventOf<T>): AppEventOf<T>;
  /** A folded event that outgrew its schema leaves as several. */
  split?(event: AppEventOf<T>): AppEventOf<T>[];
}

const latest = <T extends AppEventType>(): Coalescing<T> => ({
  key: () => "",
  merge: (_previous, next) => next
});

const coalescing: { [T in AppEventType]: Coalescing<T> } = {
  // The newest counts; the changed IDs add up, newest first, up to the limit.
  "job.progress": {
    key: () => "",
    merge: (previous, next) => {
      const ids = [...new Set([...next.changedIds, ...previous.changedIds])];
      return {
        ...next,
        changedIds: ids.slice(0, appEventJobIdsMax),
        changedIdsTruncated:
          previous.changedIdsTruncated || next.changedIdsTruncated || ids.length > appEventJobIdsMax
      };
    }
  },
  "inbox.changed": latest(),
  "gardener.status": latest(),
  // One install per model: the newest state wins, so a terminal state is never overtaken.
  "model.download": { key: (event) => event.catalogId, merge: (_previous, next) => next },
  "tree.changed": {
    key: (event) => event.treeId,
    merge: (previous, next) => {
      const ids =
        previous.topicIds === null || next.topicIds === null
          ? null
          : [...new Set([...previous.topicIds, ...next.topicIds])].sort();
      return {
        ...next,
        generation: Math.max(previous.generation, next.generation),
        // Too many to list means "refresh everything", as the coalesced `topicsChanged` says.
        topicIds: ids && ids.length <= topicLimits.changedTopicIdsMax ? ids : null,
        changeSetId: previous.changeSetId === next.changeSetId ? next.changeSetId : null
      };
    }
  },
  "relation.created": {
    key: () => "",
    merge: (previous, next) => ({
      ...next,
      noteIds: [...new Set([...previous.noteIds, ...next.noteIds])].sort()
    }),
    split: (event) => {
      const parts: Array<AppEventOf<"relation.created">> = [];
      for (let start = 0; start < event.noteIds.length; start += relationsChangedMaxNoteIds)
        parts.push({
          ...event,
          noteIds: event.noteIds.slice(start, start + relationsChangedMaxNoteIds)
        });
      return parts;
    }
  }
};

function coalescingOf(event: AppEvent): Coalescing<AppEventType> {
  return coalescing[event.type] as unknown as Coalescing<AppEventType>;
}

export interface AppEventBusOptions {
  /** Delivers one validated, coalesced event to every window. */
  send: (event: AppEvent) => void;
  windowMs?: number;
  /** An event that does not match the contract is reported here and never sent. */
  onInvalid?: (error: Error) => void;
  /** A sender or a subscriber that threw; the others still run. */
  onError?: (error: unknown) => void;
}

export class AppEventBus {
  private readonly pending = new Map<string, AppEvent>();
  private readonly subscribers = new Map<AppEventType, Set<(event: AppEvent) => void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  public constructor(private readonly options: AppEventBusOptions) {}

  /**
   * Records an event for the window that is open (or opens one). An invalid event is reported and
   * dropped; publishing never throws into the service that committed the work.
   */
  public publish(event: AppEvent): void {
    if (this.disposed) return;
    const parsed = AppEventSchema.safeParse(event);
    if (!parsed.success) {
      this.options.onInvalid?.(new Error(`Invalid app event: ${parsed.error.message}`));
      return;
    }
    const valid = parsed.data;
    const rules = coalescingOf(valid);
    const key = `${valid.type}\u0000${rules.key(valid)}`;
    const previous = this.pending.get(key);
    this.pending.set(key, previous ? rules.merge(previous, valid) : valid);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.options.windowMs ?? appEventCoalesceMs);
    // A window never keeps a script or a test process alive on its own.
    this.timer.unref?.();
  }

  /**
   * Listens in this process (a main service that follows jobs or downloads). The listener gets the
   * coalesced event, when the window closes, exactly as a window does.
   */
  public subscribe<T extends AppEventType>(type: T, handler: AppEventHandler<T>): () => void {
    const entry = (event: AppEvent): void => (handler as (event: AppEvent) => void)(event);
    let set = this.subscribers.get(type);
    if (!set) this.subscribers.set(type, (set = new Set()));
    set.add(entry);
    return () => {
      this.subscribers.get(type)?.delete(entry);
    };
  }

  /** Sends what is pending now. */
  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const folded of events) {
      const parts = coalescingOf(folded).split?.(folded) ?? [folded];
      for (const part of parts) this.deliver(part);
    }
  }

  /** Drops what is pending and ends every subscription (shutdown). */
  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.subscribers.clear();
  }

  private deliver(event: AppEvent): void {
    // A merged event is checked again: what leaves the bus always matches the contract.
    const parsed = AppEventSchema.safeParse(event);
    if (!parsed.success) {
      this.options.onInvalid?.(new Error(`Invalid app event: ${parsed.error.message}`));
      return;
    }
    try {
      this.options.send(parsed.data);
    } catch (error) {
      this.options.onError?.(error);
    }
    for (const subscriber of [...(this.subscribers.get(parsed.data.type) ?? [])]) {
      try {
        subscriber(parsed.data);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }
}
