import { afterEach, describe, expect, it, vi } from "vitest";

import { JobSupervisor } from "./job-supervisor.js";

// F3 3.19: a veto from an explanation and the owner's review reach the open Note pages through the
// supervisor's coalescing push, the same one the link jobs use, not a broadcast of their own.
afterEach(() => vi.useRealTimers());

describe("the relationsChanged push outside a link job", () => {
  it("joins the supervisor's window: one event per burst, IDs sorted and de-duplicated", () => {
    vi.useFakeTimers();
    const supervisor = new JobSupervisor({ getPool: () => null });
    const events: string[][] = [];
    supervisor.subscribeRelationsChanged((event) => void events.push(event.noteIds));
    supervisor.announceRelationsChanged(["b", "a"]);
    supervisor.announceRelationsChanged(["a", "c"]);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(events).toEqual([["a", "b", "c"]]);
    // A listener that stops hearing gets nothing more.
    const hear = vi.fn();
    const stop = supervisor.subscribeRelationsChanged(hear);
    stop();
    supervisor.announceRelationsChanged(["d"]);
    vi.advanceTimersByTime(250);
    expect(hear).not.toHaveBeenCalled();
    expect(events).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("announces nothing for no note", () => {
    vi.useFakeTimers();
    const supervisor = new JobSupervisor({ getPool: () => null });
    const heard = vi.fn();
    supervisor.subscribeRelationsChanged(heard);
    supervisor.announceRelationsChanged([]);
    vi.runAllTimers();
    expect(heard).not.toHaveBeenCalled();
  });
});
