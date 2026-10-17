// The in-flight registry of relation calls (F3 D24): one process-wide map of the work a link job is
// paying for right now, keyed by note pair (typing) or by source-pair key (judging). A second job
// that needs the same key waits for the first and then reads its cached answer, so two jobs on the
// `relations` worker never pay for the same call.

/** What one claim holds: the keys it took and, for the others, the moment their holder ends. */
export interface InFlightLease {
  /** The keys this lease holds; the caller does their work and then calls `release`. */
  readonly claimed: ReadonlySet<string>;
  /** Keys another lease held when this one was taken, each with the end of that lease. */
  readonly held: ReadonlyMap<string, Promise<void>>;
  /** Frees the claimed keys; waiters wake up. Idempotent. */
  release(): void;
}

export class InFlightRegistry {
  private readonly holders = new Map<string, Promise<void>>();

  /**
   * Takes every key that is free, at once; the keys another lease holds are returned with the end
   * of that lease. A lease never waits for a key it holds itself, and a holder that releases before
   * it waits on anyone cannot deadlock.
   */
  public claim(keys: Iterable<string>): InFlightLease {
    const claimed = new Set<string>();
    const held = new Map<string, Promise<void>>();
    let release!: () => void;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const key of keys) {
      if (claimed.has(key) || held.has(key)) continue;
      const holder = this.holders.get(key);
      if (holder) held.set(key, holder);
      else {
        claimed.add(key);
        this.holders.set(key, ended);
      }
    }
    let released = false;
    return {
      claimed,
      held,
      release: () => {
        if (released) return;
        released = true;
        for (const key of claimed) if (this.holders.get(key) === ended) this.holders.delete(key);
        release();
      }
    };
  }

  /** Keys held right now (diagnostics and tests). */
  public get size(): number {
    return this.holders.size;
  }

  /**
   * Runs `work` on `keys` so that no key is worked on by two callers at once: the free keys are
   * claimed and worked on, then the caller waits for the keys others held and works on those once
   * they are free (by then their holder has usually cached the answer). Resolves with every
   * round's result, in order. A cancelled `signal` rejects while waiting.
   */
  public async run<T>(
    keys: readonly string[],
    work: (claimed: readonly string[]) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T[]> {
    const results: T[] = [];
    let pending = [...new Set(keys)];
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const lease = this.claim(pending);
      try {
        const mine = pending.filter((key) => lease.claimed.has(key));
        if (mine.length > 0) results.push(await work(mine));
      } finally {
        lease.release();
      }
      pending = pending.filter((key) => lease.held.has(key));
      if (pending.length > 0) await abortable(Promise.all(lease.held.values()), signal);
    }
    return results;
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("Canceled.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
