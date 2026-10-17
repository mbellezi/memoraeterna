import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveDeadline } from "./active-deadline.js";

describe("active deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out after the active time is used up", async () => {
    const deadline = new ActiveDeadline(1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("does not run while the owner waits for a lane and continues with what is left", async () => {
    const deadline = new ActiveDeadline(1_000);
    await vi.advanceTimersByTimeAsync(400);
    deadline.pause();
    expect(deadline.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.elapsedMs).toBe(400);
    deadline.resume();
    await vi.advanceTimersByTimeAsync(599);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.elapsedMs).toBe(999);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
  });

  it("stays paused until every wait is over", async () => {
    const deadline = new ActiveDeadline(100);
    deadline.pause();
    deadline.pause();
    deadline.resume();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deadline.signal.aborted).toBe(false);
    deadline.resume();
    deadline.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(deadline.signal.aborted).toBe(true);
  });

  it("follows the cancellation of its parent and is found from its signal", () => {
    const parent = new AbortController();
    const deadline = new ActiveDeadline(1_000, parent.signal);
    expect(ActiveDeadline.of(deadline.signal)).toBe(deadline);
    expect(ActiveDeadline.of(parent.signal)).toBeUndefined();
    expect(ActiveDeadline.of(undefined)).toBeUndefined();
    parent.abort(new Error("canceled"));
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({ message: "canceled" });
    deadline.dispose();
  });

  it("joins extra cancellation to the deadline, which the scheduler still finds and pauses", async () => {
    const parent = new AbortController();
    const clock = new AbortController();
    const deadline = new ActiveDeadline(1_000, parent.signal);
    const joined = deadline.join(clock.signal);
    expect(joined).not.toBe(deadline.signal);
    expect(ActiveDeadline.of(joined)).toBe(deadline);
    // Waiting for a lane through the joined signal stops the clock like the deadline's own.
    ActiveDeadline.of(joined)!.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joined.aborted).toBe(false);
    ActiveDeadline.of(joined)!.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(joined.aborted).toBe(true);
    expect(joined.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("ends a joined signal with the cancellation of its parent or of the joined work", () => {
    const parent = new AbortController();
    const clock = new AbortController();
    const first = new ActiveDeadline(60_000, parent.signal);
    const joinedFirst = first.join(clock.signal);
    clock.abort(new Error("clock closed"));
    expect(joinedFirst.aborted).toBe(true);
    expect(joinedFirst.reason).toMatchObject({ message: "clock closed" });
    expect(first.signal.aborted).toBe(false);
    const second = new ActiveDeadline(60_000, parent.signal);
    const joinedSecond = second.join(new AbortController().signal);
    parent.abort(new Error("canceled"));
    expect(joinedSecond.aborted).toBe(true);
    expect(joinedSecond.reason).toMatchObject({ message: "canceled" });
    first.dispose();
    second.dispose();
  });

  it("stops for good when disposed", async () => {
    const deadline = new ActiveDeadline(100);
    deadline.pause();
    deadline.dispose();
    deadline.resume();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deadline.signal.aborted).toBe(false);
  });

  it("aborts with the reason it was given, such as a classified provider timeout", async () => {
    const reason = new Error("AI provider request exceeded its 50 ms deadline.");
    const deadline = new ActiveDeadline(50, undefined, { reason: () => reason });
    await vi.advanceTimersByTimeAsync(50);
    expect(deadline.signal.reason).toBe(reason);
  });
});
