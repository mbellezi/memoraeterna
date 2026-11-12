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
  /**
   * Resolves `address` (an anchor previews its passage); rejects when the call fails. `fresh` asks
   * for a read that starts now: it never joins a call already on its way (a re-read after a change).
   */
  request(address: string, options?: { fresh?: boolean }): Promise<PreviewResult>;
}

export interface PreviewBatcherOptions {
  resolveMany: (input: ObjectResolveManyInput) => Promise<ObjectResolveManyResult>;
  windowMs?: number;
  max?: number;
  /** Injected by tests; the defaults are `setTimeout` and `clearTimeout`. */
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Entry {
  promise: Promise<PreviewResult>;
  resolve: (result: PreviewResult) => void;
  reject: (error: unknown) => void;
}

export function createPreviewBatcher(options: PreviewBatcherOptions): PreviewBatcher {
  const windowMs = options.windowMs ?? previewWindowMs;
  const max = Math.max(1, Math.min(options.max ?? previewBatchMax, previewBatchMax));
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

  // The addresses of the open window, in the order they came, and the entry every asker of one
  // address shares: while it waits in the window (`open`), and from the call that sends it until
  // that call settles (`flying`, the newest call per address).
  let queued: string[] = [];
  let timer: unknown = null;
  const open = new Map<string, Entry>();
  const flying = new Map<string, Entry>();

  const call = (taken: Array<[string, Entry]>) => {
    for (const [address, entry] of taken) flying.set(address, entry);
    const settle = (address: string, entry: Entry, run: (entry: Entry) => void) => {
      if (flying.get(address) === entry) flying.delete(address);
      run(entry);
    };
    options
      .resolveMany({ addresses: taken.map(([address]) => address), include: { path: true } })
      .then((result) => {
        for (const [address, entry] of taken) {
          const item = result.items[address];
          settle(address, entry, (one) =>
            one.resolve(item ? { status: "ready", item } : { status: "missing" })
          );
        }
      })
      .catch((error: unknown) => {
        for (const [address, entry] of taken) settle(address, entry, (one) => one.reject(error));
      });
  };

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const taken = queued.flatMap((address): Array<[string, Entry]> => {
      const entry = open.get(address);
      return entry ? [[address, entry]] : [];
    });
    queued = [];
    open.clear();
    for (let index = 0; index < taken.length; index += max) call(taken.slice(index, index + max));
  };

  return {
    request(address, requestOptions) {
      // An address `resolveMany` would refuse never reaches it: it would fail the whole window.
      if (parseObjectAddress(address) === null) return Promise.resolve({ status: "missing" });
      const waiting = open.get(address);
      if (waiting) return waiting.promise;
      // A read that follows a change must not join a call that began before the commit.
      const inFlight = requestOptions?.fresh ? undefined : flying.get(address);
      if (inFlight) return inFlight.promise;
      let resolve!: Entry["resolve"];
      let reject!: Entry["reject"];
      const promise = new Promise<PreviewResult>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      open.set(address, { promise, resolve, reject });
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
