import type { SchedulerClock } from "./types.js";

/** Lets every pending microtask and promise continuation run (real `setImmediate`). */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A manual clock for scheduler tests: time moves only through `advance`. */
export function fakeSchedulerClock(): {
  clock: SchedulerClock;
  now: () => number;
  advance: (milliseconds: number) => Promise<void>;
} {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: SchedulerClock = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = ++nextId;
      timers.set(id, { at: now + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    }
  };
  const advance = async (milliseconds: number) => {
    const target = now + milliseconds;
    for (;;) {
      await flush();
      let due: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of timers)
        if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].callback();
    }
    now = target;
    await flush();
  };
  return { clock, now: () => now, advance };
}
