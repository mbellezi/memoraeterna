import {
  inboxItemKey,
  type ChangeSetRisk,
  type ChangesDiff,
  type InboxCounts,
  type InboxItem,
  type InboxKind,
  type InboxVerb
} from "@app/domain";
import type { MessageKey } from "@app/i18n";

/**
 * The state of the Inbox screen and every transition of it that needs no I/O (F4 D29), so the
 * keyboard flow, the selection, the paging and the undo are tested without a renderer. The
 * controller reads and writes through the IPC and feeds this reducer.
 */

export type InboxLoad = { status: "loading" } | { status: "error" } | { status: "ready" };

export interface InboxFilter {
  kind: InboxKind | null;
  risk: ChangeSetRisk | null;
}

/** What happened to the last verb on an item: asking, or refused with the sentence to show. */
export type InboxItemAction =
  | { status: "pending"; verb: InboxVerb | "undo" }
  | { status: "refused"; message: MessageKey; params?: Record<string, string | number> };

/** The verb the person can take back with `u` (or the banner's Undo), and where it stands. */
export interface InboxUndo {
  /** The item it was made on, as the list keyed it. */
  key: string;
  kind: InboxKind;
  id: string;
  verb: InboxVerb;
  /** What the banner says it did ("Applied"). */
  message: MessageKey;
  params: Readonly<Record<string, string | number>>;
  status: "ready" | "pending";
}

/** The before and after of a change-set that is selected. */
export type InboxDiffLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; diff: ChangesDiff };

export interface InboxState {
  load: InboxLoad;
  items: readonly InboxItem[];
  nextCursor: string | null;
  loadingMore: boolean;
  moreFailed: boolean;
  /** Null until the first counts arrive. */
  counts: InboxCounts | null;
  filter: InboxFilter;
  selectedKey: string | null;
  /** Per item key: the verb being carried out, or why it was refused. */
  actions: Readonly<Record<string, InboxItemAction>>;
  undo: InboxUndo | null;
  /** Per change-set id: its diff, loaded when its item is selected. */
  diffs: Readonly<Record<string, InboxDiffLoad>>;
  /** When the first page on screen was read: ages are measured to it (a render is not a clock). */
  readAt: number;
  helpOpen: boolean;
  /** Polite announcement of the last result, replaced as results arrive. */
  announcement: MessageKey | null;
  announcementParams: Readonly<Record<string, string | number>>;
}

export const initialInboxState = (): InboxState => ({
  load: { status: "loading" },
  items: [],
  nextCursor: null,
  loadingMore: false,
  moreFailed: false,
  counts: null,
  filter: { kind: null, risk: null },
  selectedKey: null,
  actions: {},
  undo: null,
  diffs: {},
  readAt: 0,
  helpOpen: false,
  announcement: null,
  announcementParams: {}
});

export type InboxEvent =
  | { type: "loading" }
  | { type: "loaded"; items: readonly InboxItem[]; nextCursor: string | null; at: number }
  | { type: "loadFailed" }
  | { type: "moreLoading" }
  | { type: "moreLoaded"; items: readonly InboxItem[]; nextCursor: string | null }
  | { type: "moreFailed" }
  | { type: "counts"; counts: InboxCounts }
  | { type: "select"; key: string }
  | { type: "move"; delta: 1 | -1 }
  | { type: "edge"; to: "first" | "last" }
  | { type: "filter"; filter: Partial<InboxFilter> }
  | { type: "actionPending"; key: string; verb: InboxVerb | "undo" }
  | {
      type: "actionRefused";
      key: string;
      message: MessageKey;
      params?: Record<string, string | number>;
    }
  | {
      type: "actionDone";
      key: string;
      announcement: MessageKey;
      params?: Record<string, string | number>;
    }
  | { type: "itemGone"; key: string }
  | { type: "undoable"; undo: InboxUndo }
  | { type: "undoPending" }
  | { type: "undoFinished"; announcement: MessageKey }
  | { type: "undoRefused"; message: MessageKey }
  | { type: "clearUndo" }
  | { type: "diff"; changeSetId: string; load: InboxDiffLoad | null }
  | { type: "help"; open?: boolean }
  | { type: "announce"; announcement: MessageKey; params?: Record<string, string | number> };

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

/** The key of an item in the list. */
export const keyOf = inboxItemKey;

/** Appends a page, dropping an item an earlier page already listed. */
export function mergeItems(
  items: readonly InboxItem[],
  page: readonly InboxItem[]
): readonly InboxItem[] {
  const seen = new Set(items.map(keyOf));
  return [...items, ...page.filter((item) => !seen.has(keyOf(item)))];
}

/** Where the selection goes when its item leaves the list: the next one, else the previous. */
export function selectionAfterRemoval(
  items: readonly InboxItem[],
  removedKey: string,
  selectedKey: string | null
): string | null {
  if (selectedKey !== removedKey) return selectedKey;
  const index = items.findIndex((item) => keyOf(item) === removedKey);
  if (index < 0) return selectedKey;
  const rest = items.filter((item) => keyOf(item) !== removedKey);
  const next = rest[Math.min(index, rest.length - 1)];
  return next ? keyOf(next) : null;
}

/** The selection after a reload: the same item when it is still listed, else its place. */
export function selectionAfterReload(
  before: readonly InboxItem[],
  after: readonly InboxItem[],
  selectedKey: string | null
): string | null {
  if (after.length === 0) return null;
  if (selectedKey !== null && after.some((item) => keyOf(item) === selectedKey)) return selectedKey;
  const index = before.findIndex((item) => keyOf(item) === selectedKey);
  const next = after[Math.max(0, Math.min(index < 0 ? 0 : index, after.length - 1))];
  return next ? keyOf(next) : null;
}

export function selectedItem(state: Pick<InboxState, "items" | "selectedKey">): InboxItem | null {
  return state.items.find((item) => keyOf(item) === state.selectedKey) ?? null;
}

/** Whether a verb is on offer for an item right now. */
export function offers(item: InboxItem, verb: InboxVerb): boolean {
  return item.actions.includes(verb);
}

/**
 * Whether a key may carry the verb out. Continuing past the budget's pause share spends money, so it
 * is a deliberate click, never one key press.
 */
export function keyCarries(item: InboxItem, verb: InboxVerb): boolean {
  return offers(item, verb) && !(item.kind === "budget" && verb === "apply");
}

function withSelection(state: InboxState, items: readonly InboxItem[]): InboxState {
  return {
    ...state,
    items,
    selectedKey: selectionAfterReload(state.items, items, state.selectedKey)
  };
}

export function reduceInbox(state: InboxState, event: InboxEvent): InboxState {
  switch (event.type) {
    case "loading":
      return { ...state, load: { status: "loading" } };
    case "loaded":
      return {
        ...withSelection({ ...state, nextCursor: event.nextCursor, readAt: event.at }, event.items),
        load: { status: "ready" },
        loadingMore: false,
        moreFailed: false
      };
    case "loadFailed":
      return { ...state, load: { status: "error" } };
    case "moreLoading":
      return { ...state, loadingMore: true, moreFailed: false };
    case "moreLoaded":
      return {
        ...state,
        items: mergeItems(state.items, event.items),
        nextCursor: event.nextCursor,
        loadingMore: false
      };
    case "moreFailed":
      return { ...state, loadingMore: false, moreFailed: true };
    case "counts":
      return { ...state, counts: event.counts };
    case "select":
      return state.items.some((item) => keyOf(item) === event.key)
        ? { ...state, selectedKey: event.key }
        : state;
    case "move": {
      if (state.items.length === 0) return state;
      const index = state.items.findIndex((item) => keyOf(item) === state.selectedKey);
      const target = Math.max(
        0,
        Math.min(state.items.length - 1, (index < 0 ? -1 : index) + event.delta)
      );
      return { ...state, selectedKey: keyOf(state.items[target]!) };
    }
    case "edge": {
      const item = event.to === "first" ? state.items[0] : state.items.at(-1);
      return item ? { ...state, selectedKey: keyOf(item) } : state;
    }
    case "filter":
      return {
        ...state,
        filter: { ...state.filter, ...event.filter },
        load: { status: "loading" },
        items: [],
        nextCursor: null,
        selectedKey: null,
        undo: null
      };
    case "actionPending":
      return {
        ...state,
        actions: { ...state.actions, [event.key]: { status: "pending", verb: event.verb } }
      };
    case "actionRefused":
      return {
        ...state,
        actions: {
          ...state.actions,
          [event.key]: {
            status: "refused",
            message: event.message,
            ...(event.params ? { params: event.params } : {})
          }
        },
        announcement: event.message,
        announcementParams: event.params ?? {}
      };
    case "actionDone":
    case "itemGone": {
      const items = state.items.filter((item) => keyOf(item) !== event.key);
      const done: InboxState = {
        ...state,
        items,
        selectedKey: selectionAfterRemoval(state.items, event.key, state.selectedKey),
        actions: without(state.actions, event.key)
      };
      return event.type === "actionDone"
        ? { ...done, announcement: event.announcement, announcementParams: event.params ?? {} }
        : done;
    }
    case "undoable":
      return { ...state, undo: event.undo };
    case "undoPending":
      return state.undo ? { ...state, undo: { ...state.undo, status: "pending" } } : state;
    case "undoFinished":
      return { ...state, undo: null, announcement: event.announcement, announcementParams: {} };
    case "undoRefused":
      return {
        ...state,
        undo: state.undo ? { ...state.undo, status: "ready" } : null,
        announcement: event.message,
        announcementParams: {}
      };
    case "clearUndo":
      return state.undo ? { ...state, undo: null } : state;
    case "diff": {
      const diffs = without(state.diffs, event.changeSetId);
      return {
        ...state,
        diffs: event.load ? { ...diffs, [event.changeSetId]: event.load } : diffs
      };
    }
    case "help":
      return { ...state, helpOpen: event.open ?? !state.helpOpen };
    case "announce":
      return { ...state, announcement: event.announcement, announcementParams: event.params ?? {} };
  }
}
