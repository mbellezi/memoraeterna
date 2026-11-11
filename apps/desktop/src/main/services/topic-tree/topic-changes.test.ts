import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureObjectEvents, type ObjectEventCapture } from "../object-events-fixture.js";
import { TopicChangeCoalescer, topicsChangedCoalesceMs } from "./topic-changes.js";
import type { TopicsChangedEvent } from "./topic-changes.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const treeA = uuid(1);
const treeB = uuid(2);

describe("topicsChanged (D15)", () => {
  let events: TopicsChangedEvent[];
  let coalescer: TopicChangeCoalescer;
  let capture: ObjectEventCapture;

  beforeEach(() => {
    vi.useFakeTimers();
    capture = captureObjectEvents();
    events = [];
    coalescer = new TopicChangeCoalescer();
    coalescer.subscribe((event) => events.push(event));
  });

  afterEach(() => {
    capture.stop();
    coalescer.dispose();
    vi.useRealTimers();
  });

  it("coalesces commits over 250 ms into one event with the union of topics", () => {
    coalescer.record({ treeId: treeA, generation: 4, topicIds: [uuid(11)], changeSetId: uuid(21) });
    coalescer.record({
      treeId: treeA,
      generation: 5,
      topicIds: [uuid(12), uuid(11)],
      changeSetId: uuid(22)
    });
    vi.advanceTimersByTime(topicsChangedCoalesceMs - 1);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([
      { treeId: treeA, generation: 5, topicIds: [uuid(11), uuid(12)], changeSetId: null }
    ]);
  });

  it("announces the topics of a committed change as updated objects, and a broad one as an overflow", () => {
    coalescer.record({
      treeId: treeA,
      generation: 4,
      topicIds: [uuid(11), uuid(12)],
      changeSetId: null
    });
    expect(capture.refs()).toEqual([
      { kind: "topic", id: uuid(11), change: "updated" },
      { kind: "topic", id: uuid(12), change: "updated" }
    ]);
    capture.clear();
    coalescer.record({ treeId: treeA, generation: 5, topicIds: null, changeSetId: null });
    expect(capture.events).toEqual([{ type: "object.changed", overflow: true, kinds: ["topic"] }]);
  });

  it("announces nothing until a change is recorded", () => {
    coalescer.record({ treeId: treeA, generation: 4, topicIds: [], changeSetId: null });
    coalescer.flush();
    vi.advanceTimersByTime(topicsChangedCoalesceMs);
    expect(capture.events).toEqual([]);
  });

  it("names the change-set when exactly one was coalesced", () => {
    coalescer.record({ treeId: treeA, generation: 1, topicIds: [uuid(11)], changeSetId: uuid(21) });
    coalescer.flush();
    expect(events[0]?.changeSetId).toBe(uuid(21));
  });

  it("sends null topics when a change is too broad to list", () => {
    coalescer.record({
      treeId: treeA,
      generation: 1,
      topicIds: Array.from({ length: 201 }, (_, index) => uuid(1000 + index)),
      changeSetId: uuid(21)
    });
    coalescer.record({ treeId: treeA, generation: 2, topicIds: [uuid(11)], changeSetId: uuid(21) });
    coalescer.flush();
    expect(events).toEqual([
      { treeId: treeA, generation: 2, topicIds: null, changeSetId: uuid(21) }
    ]);
  });

  it("flushes the pending change of one tree before recording another tree's", () => {
    coalescer.record({ treeId: treeA, generation: 9, topicIds: [uuid(11)], changeSetId: uuid(21) });
    coalescer.record({ treeId: treeB, generation: 0, topicIds: null, changeSetId: null });
    expect(events.map((event) => event.treeId)).toEqual([treeA]);
    vi.advanceTimersByTime(topicsChangedCoalesceMs);
    expect(events.map((event) => event.treeId)).toEqual([treeA, treeB]);
  });

  it("emits nothing without a commit, and a failing listener does not stop the others", () => {
    vi.advanceTimersByTime(10 * topicsChangedCoalesceMs);
    expect(events).toEqual([]);
    const error = vi.fn();
    const quiet = new TopicChangeCoalescer({ logger: { error } });
    const received: TopicsChangedEvent[] = [];
    quiet.subscribe(() => {
      throw new Error("renderer gone");
    });
    quiet.subscribe((event) => received.push(event));
    quiet.record({ treeId: treeA, generation: 1, topicIds: [], changeSetId: null });
    quiet.flush();
    expect(received).toHaveLength(1);
    expect(error).toHaveBeenCalledOnce();
  });
});
