import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ObjectKind } from "@app/domain";

import type { SearchOmniInput, SearchOmniItem, SearchOmniResult } from "../../shared/ipc-search";
import { latestKeySeq, markPaint, markSend } from "./omni-marks";

/**
 * The renderer's one reader of `search.omni` (F5 D12, spec 3.4): Cmd-K asks in quick mode and the
 * search results panel in full mode, both through this hook.
 *
 * It keeps one request in flight and sends no debounced guess: the query the person wants is the
 * latest one. An answer to a query that is no longer the wanted one is dropped, and the latest
 * query is sent at once. So a person who types faster than the service answers costs one request
 * at a time, and the screen never shows an answer older than the one before it.
 */

/** What one request asks: the trimmed text, the mode and the optional narrowing. */
export interface OmniParams {
  query: string;
  mode: "quick" | "full";
  /** Only these kinds (`#` asks for topics, `@` for entities). */
  kinds?: readonly ObjectKind[];
  /** Only this topic's subtree. */
  topicId?: string;
  limit?: number;
}

/** A stable text for a set of params: two equal asks have one key. */
export function omniKey(params: OmniParams): string {
  return JSON.stringify([
    params.query,
    params.mode,
    params.kinds ? [...params.kinds].sort() : null,
    params.topicId ?? null,
    params.limit ?? null
  ]);
}

export type OmniStatus = "idle" | "loading" | "ready" | "error";

export interface OmniSnapshot {
  /**
   * `idle`: nothing is wanted. `loading`: a query is wanted and its answer has not come; `items`
   * still hold the answer to the query before it. `ready`: `items` answer the wanted query.
   * `error`: the wanted query could not be answered.
   */
  status: OmniStatus;
  /** The params `items` answer; null before the first answer. */
  answered: OmniParams | null;
  items: readonly SearchOmniItem[];
  degraded: readonly ("ann" | "fts")[];
  tookMs: number | null;
  /** The key sequence number the answering request was sent at (the latency marks). */
  seq: number | null;
  /** Counts the answers that reached the screen, so two answers to one query differ. */
  version: number;
}

export const idleOmni: OmniSnapshot = {
  status: "idle",
  answered: null,
  items: [],
  degraded: [],
  tookMs: null,
  seq: null,
  version: 0
};

export interface OmniControllerOptions {
  search: (input: SearchOmniInput) => Promise<SearchOmniResult>;
  /** The sequence number a request is sent at (the latest key); default none. */
  seq?: () => number;
  /** Told when a request leaves (the latency marks). */
  onSend?: (seq: number, requestId: string) => void;
  /** The request ids; the default counts up from a random prefix. */
  newId?: () => string;
}

interface InFlight {
  id: string;
  key: string;
  params: OmniParams;
  seq: number;
  /** A refresh in place: its failure leaves the answer on screen as it was. */
  quiet: boolean;
}

/** The state behind `useOmni`, with no React in it, so the rules can be proven on their own. */
export class OmniController {
  private wanted: OmniParams | null = null;
  private wantedKey: string | null = null;
  private inFlight: InFlight | null = null;
  private snapshot: OmniSnapshot = idleOmni;
  private readonly listeners = new Set<() => void>();
  private readonly prefix = Math.random().toString(36).slice(2, 8);
  private counter = 0;

  constructor(private readonly options: OmniControllerOptions) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): OmniSnapshot => this.snapshot;

  /** Whether a request is on its way; at most one ever is. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** The query the person wants now; null when they want none (an empty box). */
  request(params: OmniParams | null): void {
    const trimmed = params === null ? null : { ...params, query: params.query.trim() };
    const next = trimmed !== null && trimmed.query !== "" ? trimmed : null;
    const key = next === null ? null : omniKey(next);
    if (key === this.wantedKey) return;
    this.wanted = next;
    this.wantedKey = key;
    if (next === null) {
      // Whatever is on its way is dropped when it returns.
      this.set(idleOmni);
      return;
    }
    this.set({ ...this.snapshot, status: "loading" });
    if (this.inFlight === null) this.send();
  }

  /** Asks again after a failure. */
  retry(): void {
    if (this.snapshot.status !== "error" || this.wanted === null) return;
    this.set({ ...this.snapshot, status: "loading" });
    if (this.inFlight === null) this.send();
  }

  /**
   * Asks the wanted query again without leaving the answer on screen: for a view shown again after
   * it was hidden. Only a ready answer is refreshed (a failure stays visible and retryable), and a
   * failed refresh keeps the answer it replaces.
   */
  refresh(): void {
    if (this.snapshot.status !== "ready" || this.wanted === null || this.inFlight !== null) return;
    this.send(true);
  }

  private newId(): string {
    return this.options.newId ? this.options.newId() : `omni-${this.prefix}-${++this.counter}`;
  }

  private send(quiet = false): void {
    const params = this.wanted;
    const key = this.wantedKey;
    if (params === null || key === null) return;
    const seq = this.options.seq?.() ?? 0;
    const id = this.newId();
    const flight: InFlight = { id, key, params, seq, quiet };
    this.inFlight = flight;
    this.options.onSend?.(seq, id);
    const input: SearchOmniInput = {
      query: params.query,
      mode: params.mode,
      requestId: id,
      ...(params.kinds ? { kinds: [...params.kinds] } : {}),
      ...(params.topicId ? { scope: { topicId: params.topicId } } : {}),
      ...(params.limit ? { limit: params.limit } : {})
    };
    let call: Promise<SearchOmniResult>;
    try {
      call = Promise.resolve(this.options.search(input));
    } catch (error) {
      call = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    call.then(
      (result) => this.settle(flight, result),
      () => this.settle(flight, null)
    );
  }

  private settle(flight: InFlight, result: SearchOmniResult | null): void {
    if (this.inFlight !== flight) return;
    this.inFlight = null;
    // A stale answer (another query is wanted now, or the box was emptied) is dropped, and the
    // latest query goes out in its place.
    if (this.wantedKey !== flight.key) {
      if (this.wanted !== null) this.send();
      return;
    }
    // An answer to another request is not an answer to this one: the query failed.
    if (result === null || result.requestId !== flight.id) {
      if (flight.quiet) return;
      this.set({ ...this.snapshot, status: "error" });
      return;
    }
    this.set({
      status: "ready",
      answered: flight.params,
      items: result.items,
      degraded: result.degraded,
      tookMs: result.tookMs,
      seq: flight.seq,
      version: this.snapshot.version + 1
    });
  }

  private set(next: OmniSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** `window.app.search.omni`, or a rejection where there is no window. */
const defaultSearch = (input: SearchOmniInput): Promise<SearchOmniResult> => {
  const api = typeof window === "undefined" ? undefined : window.app?.search;
  return api ? api.omni(input) : Promise.reject(new Error("search.omni is not available"));
};

export interface UseOmniOptions {
  /** False asks for nothing (the palette is closed); default true. */
  enabled?: boolean;
  /**
   * With `enabled` false: keep the last answer and the wanted query instead of dropping them, and
   * refresh in place when enabled again (a hidden panel that keeps its data and its scroll). A hook
   * never enabled asks for nothing.
   */
  retain?: boolean;
  /** Write the latency marks of spec 3.5 (Cmd-K only). */
  instrument?: boolean;
  /** Tests and screens: the reader. */
  search?: OmniControllerOptions["search"];
}

/**
 * The answer to `params` (null asks for nothing). The request leaves in the layout effect of the
 * render that changed the query: before the browser paints, in the same task as the keystroke.
 */
export function useOmni(
  params: OmniParams | null,
  options: UseOmniOptions = {}
): OmniSnapshot & { retry: () => void } {
  const enabled = options.enabled ?? true;
  const instrument = options.instrument ?? false;
  const [controller] = useState(
    () =>
      new OmniController({
        search: options.search ?? defaultSearch,
        ...(instrument ? { seq: latestKeySeq, onSend: markSend } : {})
      })
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const retain = options.retain ?? false;
  const shown = useRef(false);
  const wasEnabled = useRef(false);
  // Equal asks are one ask (`request` compares keys), so this may run on every render.
  useLayoutEffect(() => {
    const was = shown.current;
    const wasOn = wasEnabled.current;
    wasEnabled.current = enabled;
    if (enabled) shown.current = true;
    // Hidden, a retaining hook leaves the answer and the wanted query as they are.
    if (!enabled && retain && was) return;
    controller.request(enabled ? params : null);
    // Shown again: the answer stays, and is asked for again in place when its query is unchanged.
    if (enabled && retain && was && !wasOn) controller.refresh();
  }, [controller, params, enabled, retain]);

  // The answer is on the screen after this commit's next frame.
  const painted = snapshot.seq;
  const took = snapshot.tookMs;
  useLayoutEffect(() => {
    if (!instrument || painted === null || snapshot.version === 0) return undefined;
    const frame = requestAnimationFrame(() => markPaint(painted, took));
    return () => cancelAnimationFrame(frame);
  }, [instrument, painted, took, snapshot.version]);

  return { ...snapshot, retry: () => controller.retry() };
}
