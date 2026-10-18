import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  relationsPulseDelayMs,
  watchRelationsChanged,
  type RelationsPulseApi
} from "./relations-pulse";

const note = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

function fakeApi() {
  const listeners = new Set<(event: { noteIds: readonly string[] }) => void>();
  const api: RelationsPulseApi = {
    subscribeChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return {
    api,
    listeners,
    push: (...noteIds: string[]) => listeners.forEach((listener) => listener({ noteIds }))
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
    expect(listeners.size).toBe(1);
    push(note);
    stop();
    expect(listeners.size).toBe(0);
    vi.advanceTimersByTime(10 * relationsPulseDelayMs);
    expect(onPulse).not.toHaveBeenCalled();
    // Stopping twice is harmless.
    stop();
  });
});
