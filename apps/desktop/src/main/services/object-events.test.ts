import { afterEach, describe, expect, it, vi } from "vitest";

import { objectChangedRefsMax, type AppEvent } from "../../shared/app-events.js";
import { AppEventBus, appEventPort, createAppEventPort } from "./app-events.js";
import {
  objectRefs,
  publishObjectKindChanged,
  publishObjectKindsOverflow,
  publishObjectsChanged
} from "./object-events.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

afterEach(() => {
  appEventPort.detach();
  vi.useRealTimers();
});

describe("publishObjectsChanged", () => {
  it("publishes one object.changed with the refs, and nothing for none", () => {
    const publish = vi.fn();
    publishObjectsChanged([], { publish });
    publishObjectKindChanged("note", [], "updated", { publish });
    publishObjectKindsOverflow([], { publish });
    expect(publish).not.toHaveBeenCalled();

    publishObjectKindChanged("note", [id(1), id(2)], "created", { publish });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      type: "object.changed",
      refs: [
        { kind: "note", id: id(1), change: "created" },
        { kind: "note", id: id(2), change: "created" }
      ]
    });
  });

  it("folds an object listed twice into one ref: the last change counts, a deletion always wins", () => {
    const publish = vi.fn();
    publishObjectsChanged(
      [
        { kind: "note", id: id(1), change: "created" },
        { kind: "note", id: id(1), change: "updated" },
        { kind: "note", id: id(2), change: "deleted" },
        { kind: "note", id: id(2), change: "updated" },
        // The same id of another kind is another object.
        { kind: "topic", id: id(1), change: "updated" }
      ],
      { publish }
    );
    expect(publish.mock.calls[0]![0]).toEqual({
      type: "object.changed",
      refs: [
        { kind: "note", id: id(1), change: "updated" },
        { kind: "note", id: id(2), change: "deleted" },
        { kind: "topic", id: id(1), change: "updated" }
      ]
    });
  });

  it("lists the kinds of an overflow once each", () => {
    const publish = vi.fn();
    publishObjectKindsOverflow(["topic", "topic", "note"], { publish });
    expect(publish).toHaveBeenCalledWith({
      type: "object.changed",
      overflow: true,
      kinds: ["topic", "note"]
    });
  });

  it("never throws into the service that committed", () => {
    const publish = vi.fn(() => {
      throw new Error("bus closed");
    });
    expect(() => publishObjectKindChanged("source", [id(1)], "updated", { publish })).not.toThrow();
  });

  it("builds the refs of one kind with each id once", () => {
    expect(objectRefs("entity", [id(3), id(3), id(4)], "created")).toEqual([
      { kind: "entity", id: id(3), change: "created" },
      { kind: "entity", id: id(4), change: "created" }
    ]);
  });
});

describe("through the process-wide port and the real bus", () => {
  it("sends one coalesced, valid event to the window after the bus's window", () => {
    vi.useFakeTimers();
    const sent: AppEvent[] = [];
    const bus = new AppEventBus({ send: (event) => void sent.push(event) });
    appEventPort.attach(bus);

    publishObjectKindChanged("note", [id(1)], "created");
    publishObjectKindChanged("note", [id(1)], "relations");
    publishObjectKindChanged("source", [id(2)], "deleted");
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(250);

    expect(sent).toEqual([
      {
        type: "object.changed",
        refs: [
          { kind: "note", id: id(1), change: "relations" },
          { kind: "source", id: id(2), change: "deleted" }
        ]
      }
    ]);
  });

  it("turns a batch over 200 refs into an overflow of its kinds", () => {
    vi.useFakeTimers();
    const sent: AppEvent[] = [];
    appEventPort.attach(new AppEventBus({ send: (event) => void sent.push(event) }));
    publishObjectKindChanged(
      "note",
      Array.from({ length: objectChangedRefsMax + 1 }, (_unused, index) => id(index + 1)),
      "deleted"
    );
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ type: "object.changed", overflow: true, kinds: ["note"] }]);
  });

  it("drops an event published before a bus attached, with nothing to listen", () => {
    const port = createAppEventPort();
    port.publish({
      type: "object.changed",
      refs: [{ kind: "note", id: id(1), change: "created" }]
    });
    const publish = vi.fn();
    port.attach({ publish });
    expect(publish).not.toHaveBeenCalled();
  });
});
