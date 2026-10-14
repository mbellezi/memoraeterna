import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveDeadline, AiExecutionQueue, type AiQueuePriority } from "./ai-execution-queue.js";

describe("AI execution queue priority classes", () => {
  /** Holds the slot with a running call so that later admissions have to wait. */
  async function occupied(queue = new AiExecutionQueue()) {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const running = queue.run(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    return { queue, release: () => gate.resolve(), running };
  }

  it("admits interactive work before every waiting background call, first come first served", async () => {
    const { queue, release, running } = await occupied();
    const order: string[] = [];
    const call = (name: string, priority: AiQueuePriority) =>
      queue.run(async () => void order.push(name), undefined, { priority });
    const calls = [
      call("background 1", "background"),
      call("background 2", "background"),
      call("interactive 1", "interactive"),
      call("interactive 2", "interactive"),
      call("background 3", "background")
    ];
    release();
    await Promise.all([running, ...calls]);
    expect(order).toEqual([
      "interactive 1",
      "interactive 2",
      "background 1",
      "background 2",
      "background 3"
    ]);
  });

  it("treats a call without a priority as background work", async () => {
    const { queue, release, running } = await occupied();
    const order: string[] = [];
    const calls = [
      queue.run(async () => void order.push("default")),
      queue.run(async () => void order.push("interactive"), undefined, {
        priority: "interactive"
      })
    ];
    release();
    await Promise.all([running, ...calls]);
    expect(order).toEqual(["interactive", "default"]);
  });

  it("never preempts a running call, so interactive work waits for at most that one", async () => {
    const { queue, release, running } = await occupied();
    const order: string[] = [];
    const interactive = queue.run(async () => void order.push("interactive"), undefined, {
      priority: "interactive"
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);
    release();
    await Promise.all([running, interactive]);
    expect(order).toEqual(["interactive"]);
  });

  it("lets admissions of the same tick compete by priority when the queue is idle", async () => {
    const queue = new AiExecutionQueue();
    const order: string[] = [];
    await Promise.all([
      queue.run(async () => void order.push("background")),
      queue.run(async () => void order.push("interactive"), undefined, { priority: "interactive" })
    ]);
    expect(order).toEqual(["interactive", "background"]);
  });

  it("reports the wait of a call that was served before older background work", async () => {
    let clock = 0;
    const { queue, release, running } = await occupied(new AiExecutionQueue(() => clock));
    const waits: Record<string, number> = {};
    const background = queue.run(async ({ queueMs }) => void (waits.background = queueMs));
    clock = 500;
    const interactive = queue.run(
      async ({ queueMs }) => void (waits.interactive = queueMs),
      undefined,
      { priority: "interactive" }
    );
    clock = 2_000;
    release();
    await Promise.all([running, background, interactive]);
    expect(waits).toEqual({ interactive: 1_500, background: 2_000 });
  });

  it("cancels a waiting interactive call without disturbing the others and reports busy", async () => {
    const { queue, release, running } = await occupied();
    const controller = new AbortController();
    const canceled = vi.fn(async () => 1);
    const rejected = expect(
      queue.run(canceled, controller.signal, { priority: "interactive" })
    ).rejects.toThrow("changed my mind");
    const background = queue.run(async () => 2);
    controller.abort(new Error("changed my mind"));
    await rejected;
    expect(queue.busy).toBe(true);
    release();
    await running;
    expect(await background).toBe(2);
    expect(canceled).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queue.busy).toBe(false);
  });
});

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

  it("does not run while the owner waits for the AI queue and continues with what is left", async () => {
    const deadline = new ActiveDeadline(1_000);
    await vi.advanceTimersByTimeAsync(400);
    deadline.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deadline.signal.aborted).toBe(false);
    deadline.resume();
    await vi.advanceTimersByTimeAsync(599);
    expect(deadline.signal.aborted).toBe(false);
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

  it("joins extra cancellation to the deadline, which the queue still finds and pauses", async () => {
    const parent = new AbortController();
    const clock = new AbortController();
    const deadline = new ActiveDeadline(1_000, parent.signal);
    const joined = deadline.join(clock.signal);
    expect(joined).not.toBe(deadline.signal);
    expect(ActiveDeadline.of(joined)).toBe(deadline);
    // Waiting for an AI slot through the joined signal stops the clock like the deadline's own.
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
});
