import { afterEach, describe, expect, it, vi } from "vitest";

import { mapInOrder } from "./map-in-order.js";

/** A call the test settles by hand. */
function deferred<T>() {
  return Promise.withResolvers<T>();
}

/** Lets every pending callback and promise of the pool run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A small seeded generator, so a latency pattern can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

afterEach(() => vi.useRealTimers());

describe("mapInOrder", () => {
  it("returns outputs in index order whatever order the calls finish in", async () => {
    vi.useFakeTimers();
    for (const seed of [1, 2, 3, 4, 5]) {
      const next = random(seed);
      const items = Array.from({ length: 17 }, (_, index) => index);
      const finished: number[] = [];
      const started: number[] = [];
      const run = mapInOrder(items, 4, async (item, index) => {
        started.push(index);
        await new Promise((resolve) => setTimeout(resolve, Math.floor(next() * 50)));
        finished.push(item);
        return `out-${item}`;
      });
      await vi.runAllTimersAsync();
      expect(await run).toEqual(items.map((item) => `out-${item}`));
      expect(started, "calls start in index order").toEqual(items);
      expect(finished).toHaveLength(items.length);
    }
  });

  it("keeps at most `concurrency` calls in flight and reaches that peak", async () => {
    for (const concurrency of [1, 2, 3, 5]) {
      let running = 0;
      let peak = 0;
      const gates = Array.from({ length: 9 }, () => deferred<void>());
      const run = mapInOrder(gates, concurrency, async (gate) => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
        return running;
      });
      // The gates open one at a time, last index first, so calls finish out of start order.
      for (let index = gates.length - 1; index >= 0; index -= 1) {
        await settle();
        expect(running).toBeLessThanOrEqual(concurrency);
        gates[index]!.resolve();
      }
      await run;
      expect(peak).toBe(concurrency);
    }
  });

  it("runs one call at a time for a concurrency below 1 or not a number", async () => {
    for (const concurrency of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      let running = 0;
      let peak = 0;
      await mapInOrder([1, 2, 3], concurrency, async (item) => {
        running += 1;
        peak = Math.max(peak, running);
        await settle();
        running -= 1;
        return item;
      });
      expect(peak, String(concurrency)).toBe(1);
    }
  });

  it("returns an empty list for no items without a call", async () => {
    const fn = vi.fn();
    expect(await mapInOrder([], 3, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("aborts the calls in flight, starts no other and rejects with the caller's reason", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const started: number[] = [];
    const run = mapInOrder(
      [0, 1, 2, 3, 4],
      2,
      async (item, _index, signal) => {
        started.push(item);
        seen.push(signal);
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error(`call ${item} aborted`)))
        );
        return item;
      },
      controller.signal
    );
    await settle();
    expect(started).toEqual([0, 1]);
    const reason = new Error("job cancelled");
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(started, "no call starts after the abort").toEqual([0, 1]);
    expect(seen.every((signal) => signal.aborted)).toBe(true);
    expect(seen[0]?.reason).toBe(reason);
  });

  it("makes no call when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    const fn = vi.fn();
    await expect(mapInOrder([1, 2], 2, fn, controller.signal)).rejects.toBe(reason);
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws the lowest index's error, as a serial run would meet it first", async () => {
    const slow = deferred<void>();
    const run = mapInOrder([0, 1, 2, 3], 4, async (item) => {
      if (item === 1) {
        await slow.promise;
        throw new Error("one failed");
      }
      if (item === 3) throw new Error("three failed");
      return item;
    });
    await settle();
    slow.resolve();
    await expect(run).rejects.toThrow("one failed");
  });

  it("lets the calls in flight finish after a failure and starts no other", async () => {
    const inFlight = deferred<void>();
    const completed: number[] = [];
    const started: number[] = [];
    const run = mapInOrder([0, 1, 2, 3, 4, 5], 3, async (item) => {
      started.push(item);
      if (item === 0) throw new Error("zero failed");
      if (item === 1) await inFlight.promise;
      completed.push(item);
      return item;
    });
    let settled = false;
    void run.catch(() => {
      settled = true;
    });
    await settle();
    expect(settled, "the pool waits for the call still in flight").toBe(false);
    inFlight.resolve();
    await expect(run).rejects.toThrow("zero failed");
    expect(completed).toEqual([2, 1]);
    expect(started).toEqual([0, 1, 2]);
  });

  it("does not leave its listener on the caller's signal", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await mapInOrder([1, 2], 2, async (item) => item, controller.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
