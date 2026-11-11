import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAppEvents } from "./fake-app-events";
import { relationsPulseDelayMs, watchRelationsChanged } from "./relations-pulse";

const note = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

/** A fake `window.app` whose bus the test drives; `listeners` counts what listens to relations. */
function fakeApi() {
  const events = createFakeAppEvents();
  return {
    api: events.api,
    events,
    listeners: {
      get size() {
        return events.listening("relation.created") + events.listening("object.changed");
      }
    },
    push: (...noteIds: string[]) => events.emit({ type: "relation.created", noteIds })
  };
}

describe("reading a note's relations again when they changed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads once after a burst of pushes about the note", () => {
    const { api, push } = fakeApi();
    const onPulse = vi.fn();
    watchRelationsChanged(() => api, note, onPulse);
    push(note);
    vi.advanceTimersByTime(relationsPulseDelayMs / 2);
    push(other, note);
    push(note);
    expect(onPulse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(relationsPulseDelayMs / 2);
    expect(onPulse).toHaveBeenCalledTimes(1);
    // The next burst is a new pulse.
    push(note);
    vi.advanceTimersByTime(relationsPulseDelayMs);
    expect(onPulse).toHaveBeenCalledTimes(2);
  });

  it("ignores a push that does not name the note, and reads nothing without a push", () => {
    const { api, push } = fakeApi();
    const onPulse = vi.fn();
    watchRelationsChanged(() => api, note, onPulse);
    push(other);
    vi.advanceTimersByTime(10 * relationsPulseDelayMs);
    expect(onPulse).not.toHaveBeenCalled();
  });

  it("stops listening, and drops the wait, when the page is hidden or gone", () => {
    const { api, listeners, push } = fakeApi();
    const onPulse = vi.fn();
    const stop = watchRelationsChanged(() => api, note, onPulse);
    // `relation.created` and `object.changed`.
    expect(listeners.size).toBe(2);
    push(note);
    stop();
    expect(listeners.size).toBe(0);
    vi.advanceTimersByTime(10 * relationsPulseDelayMs);
    expect(onPulse).not.toHaveBeenCalled();
    // Stopping twice is harmless.
    stop();
  });

  it("also reads again when object.changed says the note's relations changed", () => {
    const { api, events } = fakeApi();
    const onPulse = vi.fn();
    watchRelationsChanged(() => api, note, onPulse);
    events.emit({
      type: "object.changed",
      refs: [{ kind: "note", id: note, change: "relations" }]
    });
    vi.advanceTimersByTime(relationsPulseDelayMs);
    expect(onPulse).toHaveBeenCalledTimes(1);
  });

  it("ignores object.changed about other notes, other kinds and other changes", () => {
    const { api, events } = fakeApi();
    const onPulse = vi.fn();
    watchRelationsChanged(() => api, note, onPulse);
    events.emit({
      type: "object.changed",
      refs: [{ kind: "note", id: other, change: "relations" }]
    });
    events.emit({
      type: "object.changed",
      refs: [{ kind: "topic", id: note, change: "relations" }]
    });
    events.emit({ type: "object.changed", refs: [{ kind: "note", id: note, change: "updated" }] });
    events.emit({ type: "object.changed", overflow: true, kinds: ["topic", "source"] });
    vi.advanceTimersByTime(10 * relationsPulseDelayMs);
    expect(onPulse).not.toHaveBeenCalled();
  });

  it("reads again after an overflow that names notes, which lists no ids", () => {
    const { api, events } = fakeApi();
    const onPulse = vi.fn();
    watchRelationsChanged(() => api, note, onPulse);
    events.emit({ type: "object.changed", overflow: true, kinds: ["note"] });
    vi.advanceTimersByTime(relationsPulseDelayMs);
    expect(onPulse).toHaveBeenCalledTimes(1);
  });

  it("reads once for a burst that arrives on both events", () => {
    const { api, events, push } = fakeApi();
    const onPulse = vi.fn();
    watchRelationsChanged(() => api, note, onPulse);
    push(note);
    events.emit({
      type: "object.changed",
      refs: [{ kind: "note", id: note, change: "relations" }]
    });
    vi.advanceTimersByTime(relationsPulseDelayMs);
    expect(onPulse).toHaveBeenCalledTimes(1);
  });
});
