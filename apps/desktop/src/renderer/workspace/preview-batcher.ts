import {
  objectResolveManyMax,
  parseObjectAddress,
  type ObjectResolved,
  type ObjectResolveManyInput,
  type ObjectResolveManyResult
} from "@app/domain";

/**
 * One `objects.resolveMany` per window (design record §10.1, D15): every hover card, quick-look and
 * list row that asks for an object in the same 16 ms shares a single call, an address asked twice
 * is asked once, and a window with more than 200 addresses is split into calls of at most 200.
 * Nothing here polls: a request waits for one timer, set when the first of its window arrives.
 */

/** The window that gathers requests into one call. */
export const previewWindowMs = 16;
/** The most addresses one call carries (`resolveMany`'s own bound). */
export const previewBatchMax = objectResolveManyMax;

/** What a request gets: the object with its path, or that there is no object at that address. */
export type PreviewResult = { status: "ready"; item: ObjectResolved } | { status: "missing" };

export interface PreviewBatcher {
  /** Resolves `address` (an anchor previews its passage); rejects when the call fails. */
  request(address: string): Promise<PreviewResult>;
}

export interface PreviewBatcherOptions {
  resolveMany: (input: ObjectResolveManyInput) => Promise<ObjectResolveManyResult>;
  windowMs?: number;
  max?: number;
  /** Injected by tests; the defaults are `setTimeout` and `clearTimeout`. */
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Waiter {
  resolve: (result: PreviewResult) => void;
  reject: (error: unknown) => void;
}

export function createPreviewBatcher(options: PreviewBatcherOptions): PreviewBatcher {
  const windowMs = options.windowMs ?? previewWindowMs;
  const max = Math.max(1, Math.min(options.max ?? previewBatchMax, previewBatchMax));
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

  // The addresses of the open window, in the order they came; the promise every asker of one
  // address shares, from its first request until the call that answers it settles.
  let queued: string[] = [];
  let timer: unknown = null;
  const shared = new Map<string, Promise<PreviewResult>>();
  const waiters = new Map<string, Waiter>();

  const settle = (address: string, run: (waiter: Waiter) => void) => {
    const waiter = waiters.get(address);
    waiters.delete(address);
    shared.delete(address);
    if (waiter) run(waiter);
  };

  const call = (addresses: string[]) => {
    options
      .resolveMany({ addresses, include: { path: true } })
      .then((result) => {
        for (const address of addresses) {
          const item = result.items[address];
          settle(address, (waiter) =>
            waiter.resolve(item ? { status: "ready", item } : { status: "missing" })
          );
        }
      })
      .catch((error: unknown) => {
        for (const address of addresses) settle(address, (waiter) => waiter.reject(error));
      });
  };

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const taken = queued;
    queued = [];
    for (let index = 0; index < taken.length; index += max) call(taken.slice(index, index + max));
  };

  return {
    request(address) {
      // An address `resolveMany` would refuse never reaches it: it would fail the whole window.
      if (parseObjectAddress(address) === null) return Promise.resolve({ status: "missing" });
      const existing = shared.get(address);
      if (existing) return existing;
      const promise = new Promise<PreviewResult>((resolve, reject) => {
        waiters.set(address, { resolve, reject });
      });
      shared.set(address, promise);
      queued.push(address);
      if (queued.length >= max) flush();
      else if (timer === null) timer = setTimer(flush, windowMs);
      return promise;
    }
  };
}

/** The batcher the app uses: `window.app.objects.resolveMany`, created on first use. */
let appBatcher: PreviewBatcher | null = null;

export function previewBatcher(): PreviewBatcher {
  appBatcher ??= createPreviewBatcher({
    resolveMany: (input) => {
      const objects = typeof window === "undefined" ? undefined : window.app?.objects;
      return objects
        ? objects.resolveMany(input)
        : Promise.reject(new Error("objects.resolveMany is not available"));
    }
  });
  return appBatcher;
}
