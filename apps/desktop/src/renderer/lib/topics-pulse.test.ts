import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAppEvents } from "./fake-app-events";
import { topicsPulseDelayMs, watchTopicsChanged } from "./topics-pulse";

const event = {
  type: "tree.changed",
  treeId: "00000000-0000-4000-8000-000000000001",
  generation: 4,
  topicIds: null,
  changeSetId: null
} as const;

/** A fake `window.app` whose bus the test drives; `listeners` counts what listens to the tree. */
function fakeApi() {
  const events = createFakeAppEvents();
  return {
    api: events.api,
    listeners: {
      get size() {
        return events.listening("tree.changed");
      }
    },
    push: () => events.emit(event)
  };
}

describe("reading where an object sits again when the tree changes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads once after a burst of commits, not once per commit", () => {
    const { api, push } = fakeApi();
    const onPulse = vi.fn();
    watchTopicsChanged(() => api, onPulse);
    push();
    vi.advanceTimersByTime(topicsPulseDelayMs / 2);
    push();
    push();
    expect(onPulse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(topicsPulseDelayMs / 2);
    expect(onPulse).toHaveBeenCalledTimes(1);
    // The next burst is a new pulse.
    push();
    vi.advanceTimersByTime(topicsPulseDelayMs);
    expect(onPulse).toHaveBeenCalledTimes(2);
  });

  it("reads nothing without a push", () => {
    const { api } = fakeApi();
    const onPulse = vi.fn();
    watchTopicsChanged(() => api, onPulse);
    vi.advanceTimersByTime(10 * topicsPulseDelayMs);
    expect(onPulse).not.toHaveBeenCalled();
  });

  it("stops listening, and drops the wait, when the view is hidden or gone", () => {
    const { api, listeners, push } = fakeApi();
    const onPulse = vi.fn();
    const stop = watchTopicsChanged(() => api, onPulse);
    expect(listeners.size).toBe(1);
    push();
    stop();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * topicsPulseDelayMs);
    expect(onPulse).not.toHaveBeenCalled();
  });

  it("waits long enough to coalesce a rebalance but not so long that the path is stale", () => {
    expect(topicsPulseDelayMs).toBeGreaterThanOrEqual(500);
    expect(topicsPulseDelayMs).toBeLessThanOrEqual(2_000);
  });
});

describe("where the path of an open object is kept current", () => {
  const sources = import.meta.glob<string>(
    [
      "../components/WhereIsThis.tsx",
      "../components/LibraryView.tsx",
      "../components/note-page/NotePage.tsx"
    ],
    { query: "?raw", import: "default", eager: true }
  );
  const read = (file: string): string => sources[file] ?? "";

  it("is read again by the source panel and by the Note page, which listen only while shown", () => {
    // The panel the Library draws for a source, and the path section of an open Note page.
    expect(read("../components/WhereIsThis.tsx")).toContain("useTopicsPulse(active)");
    expect(read("../components/note-page/NotePage.tsx")).toContain("useTopicsPulse(active)");
    expect(read("../components/LibraryView.tsx")).toContain("<WhereIsThis");
  });

  it("is read again after Place in topic without reading the whole page", () => {
    const page = read("../components/note-page/NotePage.tsx");
    expect(page).toContain("onPlaced: () => setPlacedByHand(");
    expect(page).toContain("placementAsk = topicsPulse + placedByHand");
  });
});
