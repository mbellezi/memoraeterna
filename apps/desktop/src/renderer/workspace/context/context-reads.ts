import { useEffect, useRef, useState } from "react";
import {
  objectResolveManyMax,
  type ObjectBacklink,
  type ObjectLocateResult,
  type ObjectResolved
} from "@app/domain";

import type { DesktopApi } from "../../../shared/ipc";
import { useAppEvent } from "../../lib/app-events";
import { useObjectChanged } from "../../lib/object-events";
import { useStableCallback } from "../../lib/stable-callback";
import { backlinkPageSize, readsMoreBacklinks } from "../context-model";

/**
 * How the context panel reads (rules/frontend.md): one read per object and tab, again after the
 * `object.changed` that names the object (never a timer), with the answer on screen kept while it is
 * read again and a failed re-read keeping it. A first read that fails says so and stays retryable.
 * Nothing is read while the tab is not on screen.
 */

export type Read<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

const appOf = (): DesktopApi | undefined =>
  typeof window === "undefined" ? undefined : window.app;

const noApp = () => Promise.reject(new Error("window.app is not available"));

/** The same answer again keeps the old object, so nothing is drawn twice for it. */
function same<T>(a: T, b: T): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export interface ContextRead<T> {
  read: Read<T>;
  /** The "Tentar de novo": shows the loading state again and reads. */
  retry: () => void;
  /** A quiet re-read that keeps what is shown. */
  reread: () => void;
}

/**
 * Reads `load(window.app)` for `key` while `active`, and again when one of `follow`'s objects
 * changes. A new `key` is a new read: the last answer is not shown for it.
 */
export function useContextRead<T>(options: {
  key: string;
  active: boolean;
  follow: readonly string[];
  load: (app: DesktopApi) => Promise<T>;
}): ContextRead<T> {
  const { key, active, follow } = options;
  const load = useStableCallback(options.load);
  const [entry, setEntry] = useState<{ key: string; read: Read<T> } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    const app = appOf();
    (app ? load(app) : noApp())
      .then((value) => {
        if (!live) return;
        setEntry((current) =>
          current?.key === key && current.read.status === "ready" && same(current.read.value, value)
            ? current
            : { key, read: { status: "ready", value } }
        );
      })
      .catch(() => {
        // A failed re-read keeps the answer that is shown; a first read says it failed.
        if (live)
          setEntry((current) =>
            current?.key === key && current.read.status === "ready"
              ? current
              : { key, read: { status: "error" } }
          );
      });
    return () => {
      live = false;
    };
  }, [key, active, attempt, load]);

  const reread = () => setAttempt((value) => value + 1);
  useObjectChanged(follow, reread, active);

  const read: Read<T> = entry?.key === key ? entry.read : { status: "loading" };
  return {
    read,
    reread,
    retry: () => {
      setEntry({ key, read: { status: "loading" } });
      setAttempt((value) => value + 1);
    }
  };
}

// ---------------------------------------------------------------------------
// Paged lists

/** One page: its items, how many exist when the read says, and where the next page starts. */
export interface PageResult<Item, Cursor> {
  items: Item[];
  total: number | null;
  next: Cursor | null;
}

export interface Paged<Item> {
  items: Item[];
  total: number | null;
  hasMore: boolean;
  /** Reading a further page: idle, in flight, or failed (the button says so and tries again). */
  more: "idle" | "loading" | "error";
}

export interface PagedRead<Item> extends ContextRead<Paged<Item>> {
  /** Reads the next page and appends it. */
  loadMore: () => void;
}

/**
 * A list read page by page. The first read asks for as many items as are shown (`wanted`), so a
 * re-read after a change keeps the list the person scrolled; a further page appends what it finds
 * and a re-read starts the pages again from the first.
 */
export function usePagedRead<Item, Cursor>(options: {
  key: string;
  active: boolean;
  follow: readonly string[];
  first: (app: DesktopApi, wanted: number) => Promise<PageResult<Item, Cursor>>;
  next: (app: DesktopApi, cursor: Cursor) => Promise<PageResult<Item, Cursor>>;
  keyOf: (item: Item) => string;
}): PagedRead<Item> {
  const { first, next, keyOf } = options;
  const shown = useRef(0);
  const firstStable = useStableCallback(first);
  const nextStable = useStableCallback(next);
  const base = useContextRead<PageResult<Item, Cursor>>({
    key: options.key,
    active: options.active,
    follow: options.follow,
    load: (app) => firstStable(app, shown.current)
  });
  const baseValue = base.read.status === "ready" ? base.read.value : null;

  const [extra, setExtra] = useState<{
    base: PageResult<Item, Cursor> | null;
    items: Item[];
    next: Cursor | null | undefined;
    more: "idle" | "loading" | "error";
  }>({ base: null, items: [], next: undefined, more: "idle" });
  // Pages read after the first belong to the first page they follow; a new first page drops them.
  const mine = extra.base === baseValue ? extra : null;
  const items = baseValue ? [...baseValue.items, ...(mine?.items ?? [])] : [];
  useEffect(() => {
    shown.current = items.length;
  });
  const cursor = mine && mine.next !== undefined ? mine.next : (baseValue?.next ?? null);

  const loadMore = () => {
    const app = appOf();
    if (!baseValue || cursor === null || mine?.more === "loading") return;
    const origin = baseValue;
    const so_far = mine?.items ?? [];
    setExtra({ base: origin, items: so_far, next: mine?.next, more: "loading" });
    (app ? nextStable(app, cursor) : noApp())
      .then((page) =>
        setExtra((current) => {
          if (current.base !== origin) return current;
          const seen = new Set([...origin.items, ...current.items].map(keyOf));
          return {
            base: origin,
            items: [...current.items, ...page.items.filter((item) => !seen.has(keyOf(item)))],
            next: page.next,
            more: "idle"
          };
        })
      )
      .catch(() =>
        setExtra((current) => (current.base === origin ? { ...current, more: "error" } : current))
      );
  };

  const read: Read<Paged<Item>> =
    base.read.status === "ready" && baseValue
      ? {
          status: "ready",
          value: {
            items,
            total: baseValue.total,
            hasMore: cursor !== null,
            more: mine?.more ?? "idle"
          }
        }
      : base.read.status === "ready"
        ? { status: "loading" }
        : base.read;
  return { read, retry: base.retry, reread: base.reread, loadMore };
}

// ---------------------------------------------------------------------------
// Backlinks

/**
 * One page of the backlinks of `address` that belong to `vias`. Backlinks come ordered by arm, so
 * the arm a tab shows can lie after pages of another one: the read goes on, a few requests at most,
 * until it has a page of what it shows.
 */
export async function readBacklinks(
  app: DesktopApi,
  address: string,
  vias: readonly ObjectBacklink["via"][],
  from: string | null
): Promise<PageResult<ObjectBacklink, string>> {
  const found: ObjectBacklink[] = [];
  let cursor = from ?? undefined;
  let requests = 0;
  do {
    const page = await app.objects.backlinks({
      address,
      limit: backlinkPageSize,
      ...(cursor ? { cursor } : {})
    });
    requests += 1;
    found.push(...page.items.filter((item) => vias.includes(item.via)));
    cursor = page.next;
  } while (readsMoreBacklinks({ found: found.length, hasNext: cursor !== undefined, requests }));
  return { items: found, total: null, next: cursor ?? null };
}

export const backlinkKey = (item: ObjectBacklink): string =>
  `${item.via}|${item.from}|${item.anchor ?? ""}`;

// ---------------------------------------------------------------------------
// Titles and paths of the objects a list names

/**
 * What `useResolved` has asked in the current round, so an address is asked once per round. The
 * book outlives the effect that fills it: React runs an effect, its cleanup and the effect again
 * (StrictMode in development), and a list that changes while a batch is in flight runs the effect
 * again too; an answer is never thrown away for either, and an address in flight is not asked
 * twice. A round is a change of the objects or of what is asked about them: it asks everything again.
 */
export interface ResolveBook {
  /** The addresses of `wanted` not asked yet in `round`, now marked as asked. */
  take: (wanted: readonly string[], round: string) => string[];
  /** A batch that failed: its addresses may be asked again. */
  release: (addresses: readonly string[]) => void;
}

export function createResolveBook(): ResolveBook {
  let current: string | null = null;
  const asked = new Set<string>();
  return {
    take(wanted, round) {
      if (round !== current) {
        current = round;
        asked.clear();
      }
      const todo = wanted.filter((address) => !asked.has(address));
      for (const address of todo) asked.add(address);
      return todo;
    },
    release(addresses) {
      for (const address of addresses) asked.delete(address);
    }
  };
}

/** The addresses in requests of at most `objectResolveManyMax`. */
export function resolveBatches(addresses: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let at = 0; at < addresses.length; at += objectResolveManyMax)
    batches.push(addresses.slice(at, at + objectResolveManyMax));
  return batches;
}

/**
 * The summaries (title, kind, status and the topics above) of the addresses a list shows, resolved
 * in batches of at most 200 per request. A failure is quiet: the row keeps its own words and the
 * list's own read decides whether anything failed. Addresses already resolved are not asked again
 * until one of them changes (`object.changed` names it), which asks them all again; the answers
 * on screen stay until the new ones replace them.
 */
export function useResolved(
  addresses: readonly string[],
  options: { active: boolean; path: boolean }
): ReadonlyMap<string, ObjectResolved> {
  const { active, path } = options;
  const [store, setStore] = useState<ReadonlyMap<string, ObjectResolved>>(new Map());
  const [attempt, setAttempt] = useState(0);
  const book = useRef<ResolveBook | null>(null);
  const wanted = [...new Set(addresses)].sort();
  const key = wanted.join("\n");

  useEffect(() => {
    if (!active || key === "") return;
    book.current ??= createResolveBook();
    const owner = book.current;
    const app = appOf();
    for (const batch of resolveBatches(owner.take(key.split("\n"), `${attempt}|${path}`))) {
      (app ? app.objects.resolveMany({ addresses: batch, include: { path } }) : noApp())
        .then((result) =>
          setStore((current) => {
            const merged = new Map(current);
            for (const [address, item] of Object.entries(result.items)) merged.set(address, item);
            return merged;
          })
        )
        .catch(() => {
          // The rows keep their own words; asking again waits for the next change.
          owner.release(batch);
        });
    }
  }, [key, active, path, attempt]);

  // Only a change of an object the list names asks again, not every change in the library.
  useObjectChanged(
    key === "" ? [] : wanted,
    () => setAttempt((value) => value + 1),
    active && key !== ""
  );
  return store;
}

// ---------------------------------------------------------------------------
// Where an object is

/** `objects.locate` for the panel's header, read again when the tree changes. */
export function useLocate(
  address: string,
  active: boolean
): ContextRead<ObjectLocateResult | null> {
  const result = useContextRead<ObjectLocateResult | null>({
    key: address,
    active,
    follow: [address],
    load: (app) => app.objects.locate({ address })
  });
  useAppEvent("tree.changed", result.reread, active);
  return result;
}
