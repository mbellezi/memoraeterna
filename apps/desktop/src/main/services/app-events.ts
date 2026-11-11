// The typed in-process event bus (F4 D26, F5 D16; spec 3.7). A service publishes an event after the
// work it describes committed; the bus validates it, folds events of the same type and key that
// arrive within one window into one, and sends the result to the windows (one validated preload
// channel) and to in-process subscribers. Nothing is sent by a timer of its own: a window opens with
// the first event of a type after an idle spell and closes after the type's own span (250 ms by
// default, 50 ms for a streamed text, none for a status that must never be folded).
//
// A service that has no bus in hand publishes through `appEventPort`; a sticky type (a state a new
// window must learn at once) is replayed to a window that has just loaded.
import { objectKinds, topicLimits, type BudgetSnapshot, type ChangeSetRef } from "@app/domain";

import {
  appEventJobIdsMax,
  AppEventSchema,
  ObjectChangedRefSchema,
  objectChangedRefsMax,
  settingsChangedKeysMax,
  settingsChangedStores,
  type AppEvent,
  type AppEventHandler,
  type AppEventOf,
  type AppEventType,
  type ObjectChangedRef
} from "../../shared/app-events.js";
import { ipcChannels } from "../../shared/ipc.js";
import { relationsChangedMaxNoteIds } from "./relations/relations-changed.js";

/** How long events of one type and key are folded together, unless the type says otherwise. */
export const appEventCoalesceMs = 250;
/** The window of a streamed text (`consultation.delta`, `explanation.delta`): about 20 frames a second. */
export const appEventDeltaMs = 50;

interface Coalescing<T extends AppEventType> {
  /** Events of one type with the same key fold together; different keys stay apart. */
  key(event: AppEventOf<T>): string;
  /** What two events of the same type and key become; `next` is the newer one. */
  merge(previous: AppEventOf<T>, next: AppEventOf<T>): AppEventOf<T>;
  /** A folded event that outgrew its schema leaves as several (or as its overflow form). */
  split?(event: AppEventOf<T>): AppEventOf<T>[];
  /** This type's window; 0 sends every event at once and folds nothing. Default 250. */
  windowMs?: number;
  /** The last event of each key is kept and replayed to a window that has just loaded. */
  sticky?: boolean;
  /**
   * The type whose pending event under the same key leaves first, so a newer event of this type
   * never overtakes an older one of that type (a status after its last text).
   */
  settles?: AppEventType;
}

const latest = <T extends AppEventType>(): Coalescing<T> => ({
  key: () => "",
  merge: (_previous, next) => next
});

/** Kinds in the canonical order of `objectKinds`, each once. */
function orderedKinds(
  kinds: Iterable<(typeof objectKinds)[number]>
): Array<(typeof objectKinds)[number]> {
  const present = new Set(kinds);
  return objectKinds.filter((kind) => present.has(kind));
}

function kindsOfObjectChange(event: AppEventOf<"object.changed">) {
  return "refs" in event ? event.refs.map((ref) => ref.kind) : event.kinds;
}

/**
 * The refs of two events by `kind:id`: the newest change of an object counts, except `deleted`,
 * which always wins. An overflow on either side makes the whole an overflow of the kinds that
 * changed; more than 200 refs leave as an overflow too (`split`).
 */
function mergeObjectChanged(
  previous: AppEventOf<"object.changed">,
  next: AppEventOf<"object.changed">
): AppEventOf<"object.changed"> {
  if (!("refs" in previous) || !("refs" in next))
    return {
      type: "object.changed",
      overflow: true,
      kinds: orderedKinds([...kindsOfObjectChange(previous), ...kindsOfObjectChange(next)])
    };
  const byObject = new Map<string, ObjectChangedRef>();
  for (const ref of [...previous.refs, ...next.refs]) {
    const key = `${ref.kind}:${ref.id}`;
    const held = byObject.get(key);
    byObject.set(key, held?.change === "deleted" ? held : ref);
  }
  return { type: "object.changed", refs: [...byObject.values()] };
}

function mergeSettingsChanged(
  previous: AppEventOf<"settings.changed">,
  next: AppEventOf<"settings.changed">
): AppEventOf<"settings.changed"> {
  const stores = settingsChangedStores.filter(
    (store) => previous.stores.includes(store) || next.stores.includes(store)
  );
  // A change without keys may be the whole store, so the fold has no keys either.
  const keys =
    previous.keys && next.keys ? [...new Set([...previous.keys, ...next.keys])] : undefined;
  return keys && keys.length <= settingsChangedKeysMax
    ? { type: "settings.changed", stores, keys }
    : { type: "settings.changed", stores };
}

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
  // The Gardener's status is a state a new window must learn at once.
  "gardener.status": { ...latest<"gardener.status">(), sticky: true },
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
  // The newest meters; a change-set or an overview per its own id.
  "budget.changed": latest(),
  "changes.changed": {
    key: (event) => `${event.kind}:${event.id}`,
    merge: (_previous, next) => next
  },
  "overview.changed": { key: (event) => event.topicId, merge: (_previous, next) => next },
  // One event per stage, never folded: a wait shorter than any window still shows.
  "consultation.status": {
    key: (event) => event.requestId,
    merge: (_previous, next) => next,
    windowMs: 0,
    settles: "consultation.delta"
  },
  // The paragraphs so far are whole, so the newest replaces the rest; a restart is never lost.
  "consultation.delta": {
    key: (event) => event.requestId,
    merge: (previous, next) => ({ ...next, restart: previous.restart || next.restart }),
    windowMs: appEventDeltaMs
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
  },
  "object.changed": {
    key: () => "",
    merge: mergeObjectChanged,
    split: (event) =>
      "refs" in event && event.refs.length > objectChangedRefsMax
        ? [
            {
              type: "object.changed",
              overflow: true,
              kinds: orderedKinds(kindsOfObjectChange(event))
            }
          ]
        : [event]
  },
  "view.changed": latest(),
  "settings.changed": { key: () => "", merge: mergeSettingsChanged },
  // The database lifecycle is sent at once and a new window learns it on load.
  "database.status": { ...latest<"database.status">(), windowMs: 0, sticky: true },
  // One model per key: its newest state is kept for a new window.
  "model.loading": {
    key: (event) => event.modelId,
    merge: (_previous, next) => next,
    sticky: true
  },
  "obsidian.sync": latest(),
  "obsidian.projection": { key: (event) => event.kind, merge: (_previous, next) => next },
  // The earliest `since` keeps every change of the window inside what a consumer re-reads.
  "monitoring.changed": {
    key: () => "",
    merge: (previous, next) => ({
      ...next,
      since: Date.parse(previous.since) <= Date.parse(next.since) ? previous.since : next.since
    })
  },
  "explanation.delta": {
    key: (event) => event.requestId,
    merge: (_previous, next) => next,
    windowMs: appEventDeltaMs
  },
  "import.progress": { key: (event) => event.runId, merge: (_previous, next) => next }
};

function coalescingOf(event: AppEvent): Coalescing<AppEventType> {
  return coalescing[event.type] as unknown as Coalescing<AppEventType>;
}

/**
 * A batch of more than 200 refs published in one call is an overflow of its kinds, as a batch that
 * grew past 200 by merging is; refs that do not match the contract stay as they are, to be rejected.
 */
function overflowOfOversizedBatch(event: AppEvent): AppEvent {
  if (event.type !== "object.changed" || !("refs" in event)) return event;
  const refs: unknown = event.refs;
  if (!Array.isArray(refs) || refs.length <= objectChangedRefsMax) return event;
  const parsed = ObjectChangedRefSchema.array().safeParse(refs);
  if (!parsed.success) return event;
  return {
    type: "object.changed",
    overflow: true,
    kinds: orderedKinds(parsed.data.map((ref) => ref.kind))
  };
}

/** The key under which a sticky event is kept, or null when its type is not sticky. */
function stickyKeyOf(event: AppEvent): string | null {
  const rules = coalescingOf(event);
  return rules.sticky ? `${event.type}\u0000${rules.key(event)}` : null;
}

export interface AppEventBusOptions {
  /** Delivers one validated, coalesced event to every window. */
  send: (event: AppEvent) => void;
  /** The window of a type that sets none of its own (default 250 ms). */
  windowMs?: number;
  /** An event that does not match the contract is reported here and never sent. */
  onInvalid?: (error: Error) => void;
  /** A sender or a subscriber that threw; the others still run. */
  onError?: (error: unknown) => void;
}

/** What a sticky replay needs of a window: Electron's `webContents` fits. */
export interface AppEventWindow {
  isDestroyed?(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export class AppEventBus {
  private readonly pending = new Map<string, AppEvent>();
  private readonly sticky = new Map<string, AppEvent>();
  private readonly subscribers = new Map<AppEventType, Set<(event: AppEvent) => void>>();
  private readonly timers = new Map<AppEventType, ReturnType<typeof setTimeout>>();
  private disposed = false;

  public constructor(private readonly options: AppEventBusOptions) {}

  /**
   * Records an event for the window of its type that is open (or opens one); a type whose window
   * is 0 leaves at once. An invalid event is reported and dropped; publishing never throws into the
   * service that committed the work.
   */
  public publish(event: AppEvent): void {
    if (this.disposed) return;
    const parsed = AppEventSchema.safeParse(overflowOfOversizedBatch(event));
    if (!parsed.success) {
      this.options.onInvalid?.(new Error(`Invalid app event: ${parsed.error.message}`));
      return;
    }
    const valid = parsed.data;
    const rules = coalescingOf(valid);
    const stickyKey = stickyKeyOf(valid);
    if (stickyKey) this.sticky.set(stickyKey, valid);
    const windowMs = rules.windowMs ?? this.options.windowMs ?? appEventCoalesceMs;
    if (rules.settles) this.settle(rules.settles, rules.key(valid));
    if (windowMs <= 0) {
      this.deliverFolded(valid);
      return;
    }
    const key = `${valid.type}\u0000${rules.key(valid)}`;
    const previous = this.pending.get(key);
    this.pending.set(key, previous ? rules.merge(previous, valid) : valid);
    if (this.timers.has(valid.type)) return;
    const timer = setTimeout(() => this.flushType(valid.type), windowMs);
    // A window never keeps a script or a test process alive on its own.
    timer.unref?.();
    this.timers.set(valid.type, timer);
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

  /**
   * Sends a window that has just loaded (`did-finish-load`) the last value of every sticky type
   * and key, so it starts with the database state and the loaded models and not a blank. Only that
   * window hears them; subscribers in this process already did.
   */
  public replaySticky(target: AppEventWindow): void {
    for (const event of this.sticky.values()) {
      if (target.isDestroyed?.()) return;
      try {
        target.send(ipcChannels.appEvents, event);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  /** Sends what is pending now. */
  public flush(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const folded of events) this.deliverFolded(folded);
  }

  /** Drops what is pending and ends every subscription (shutdown). */
  public dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.sticky.clear();
    this.subscribers.clear();
  }

  /** The window of one type closed: its pending events leave, the others keep waiting. */
  private flushType(type: AppEventType): void {
    this.timers.delete(type);
    const due: AppEvent[] = [];
    for (const [key, event] of this.pending) {
      if (event.type !== type) continue;
      due.push(event);
      this.pending.delete(key);
    }
    for (const folded of due) this.deliverFolded(folded);
  }

  /** Sends at once the pending event of one type and key, when there is one. */
  private settle(type: AppEventType, key: string): void {
    const pendingKey = `${type}\u0000${key}`;
    const held = this.pending.get(pendingKey);
    if (!held) return;
    this.pending.delete(pendingKey);
    if (![...this.pending.values()].some((event) => event.type === type)) {
      const timer = this.timers.get(type);
      if (timer) clearTimeout(timer);
      this.timers.delete(type);
    }
    this.deliverFolded(held);
  }

  private deliverFolded(folded: AppEvent): void {
    const parts = coalescingOf(folded).split?.(folded) ?? [folded];
    for (const part of parts) this.deliver(part);
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

/**
 * Where a service publishes without holding the bus (F5 D16): no constructor changes, and no event
 * is lost to the order of start-up for the states a window needs. Before a bus attaches, the last
 * value of each sticky type and key is kept and every other event is dropped (nothing listened);
 * `attach` hands the kept ones to the bus and publishes straight through from then on.
 */
export interface AppEventPort {
  publish(event: AppEvent): void;
  attach(bus: Pick<AppEventBus, "publish">): void;
  /** Stops publishing to the bus (shutdown and tests); sticky values are kept again from here. */
  detach(): void;
}

export function createAppEventPort(): AppEventPort {
  let bus: Pick<AppEventBus, "publish"> | null = null;
  const buffered = new Map<string, AppEvent>();
  return {
    publish(event) {
      if (bus) {
        bus.publish(event);
        return;
      }
      // Checked here too: the key of a malformed event cannot be trusted, and the bus would drop it.
      const parsed = AppEventSchema.safeParse(event);
      if (!parsed.success) return;
      const key = stickyKeyOf(parsed.data);
      if (key) buffered.set(key, parsed.data);
    },
    attach(next) {
      bus = next;
      const events = [...buffered.values()];
      buffered.clear();
      for (const event of events) next.publish(event);
    },
    detach() {
      bus = null;
    }
  };
}

/** The process-wide port the main services publish through. */
export const appEventPort: AppEventPort = createAppEventPort();

/**
 * The change-set service's hooks on the bus (F4 D10, D26): a change-set that changed status after
 * an undo or a review, and a topic overview written again by one.
 */
export function changeSetEventHooks(bus: Pick<AppEventBus, "publish">): {
  changed: (ref: ChangeSetRef) => void;
  overviewChanged: (topicId: string) => void;
} {
  return {
    changed: (ref) => bus.publish({ type: "changes.changed", kind: ref.kind, id: ref.id }),
    overviewChanged: (topicId) => bus.publish({ type: "overview.changed", topicId })
  };
}

/** The RemoteBudget's meters on the bus after they moved (F4 D14, D26). */
export function budgetEventPublisher(
  bus: Pick<AppEventBus, "publish">
): (budget: BudgetSnapshot) => void {
  return (budget) => bus.publish({ type: "budget.changed", budget });
}
