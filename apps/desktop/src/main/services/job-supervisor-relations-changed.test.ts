import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobSupervisor } from "./job-supervisor.js";
import { captureObjectEvents, type ObjectEventCapture } from "./object-events-fixture.js";

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

// F5 T114: the same funnel tells the windows, as `object.changed` with `relations`, so a link job,
// the owner's review, a veto and an undo reach an open note panel through one place.
describe("the object.changed announcement of changed relations", () => {
  let capture: ObjectEventCapture;
  beforeEach(() => {
    capture = captureObjectEvents();
  });
  afterEach(() => capture.stop());

  it("announces each note once as `relations`, at once and not on the push's window", () => {
    const supervisor = new JobSupervisor({ getPool: () => null });
    supervisor.announceRelationsChanged(["n1", "n2", "n1"]);
    expect(capture.refs()).toEqual([
      { kind: "note", id: "n1", change: "relations" },
      { kind: "note", id: "n2", change: "relations" }
    ]);
  });

  it("announces nothing for no note", () => {
    const supervisor = new JobSupervisor({ getPool: () => null });
    supervisor.announceRelationsChanged([]);
    expect(capture.events).toEqual([]);
  });
});
