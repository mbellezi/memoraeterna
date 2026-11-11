import { describe, expect, it, vi } from "vitest";

import type { AppEvent } from "../../shared/app-events";
import {
  watchExplanationDelta,
  watchImportProgress,
  watchViewHistoryChanged
} from "./bus-followers";
import { createFakeAppEvents } from "./fake-app-events";

const requestId = "00000000-0000-4000-8000-0000000000a1";
const relationId = "00000000-0000-4000-8000-0000000000b1";

const delta = (overrides: Record<string, unknown> = {}): AppEvent =>
  ({ type: "explanation.delta", requestId, relationId, text: "so far", ...overrides }) as AppEvent;
const progress = (runId: string, fraction = 0.5): AppEvent =>
  ({ type: "import.progress", runId, fileIndex: 0, fraction }) as AppEvent;

describe("an explanation card follows the deltas of its own request", () => {
  it("takes the text of its request and its relation", () => {
    const bus = createFakeAppEvents();
    const onText = vi.fn();
    watchExplanationDelta(() => bus.api, { requestId, relationId }, onText);
    bus.emit(delta());
    expect(onText).toHaveBeenCalledExactlyOnceWith("so far");
  });

  it("ignores the deltas of a canceled request and of another relation, which every window gets", () => {
    const bus = createFakeAppEvents();
    const onText = vi.fn();
    watchExplanationDelta(() => bus.api, { requestId, relationId }, onText);
    bus.emit(delta({ requestId: "00000000-0000-4000-8000-0000000000a2" }));
    bus.emit(delta({ relationId: "00000000-0000-4000-8000-0000000000b2" }));
    expect(onText).not.toHaveBeenCalled();
  });

  it("stops listening when stopped", () => {
    const bus = createFakeAppEvents();
    const onText = vi.fn();
    const stop = watchExplanationDelta(() => bus.api, { requestId, relationId }, onText);
    stop();
    expect(bus.listening("explanation.delta")).toBe(0);
    bus.emit(delta());
    expect(onText).not.toHaveBeenCalled();
  });
});

describe("the import card follows the progress of its own run", () => {
  it("takes the events of the run it shows, read at each event", () => {
    const bus = createFakeAppEvents();
    const onProgress = vi.fn();
    let run: string | null = null;
    watchImportProgress(
      () => bus.api,
      true,
      () => run,
      onProgress
    );
    // No run shown yet: nothing is its own.
    bus.emit(progress("run-1"));
    expect(onProgress).not.toHaveBeenCalled();
    run = "run-1";
    bus.emit(progress("run-1", 0.2));
    expect(onProgress).toHaveBeenCalledTimes(1);
    // Another window's run, then an earlier run once a new one started.
    bus.emit(progress("run-other"));
    run = "run-2";
    bus.emit(progress("run-1", 0.9));
    expect(onProgress).toHaveBeenCalledTimes(1);
    // The run ended: a late event changes nothing.
    run = null;
    bus.emit(progress("run-2"));
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("listens to nothing while the view is hidden", () => {
    const bus = createFakeAppEvents();
    watchImportProgress(
      () => bus.api,
      false,
      () => "run-1",
      vi.fn()
    );
    expect(bus.listening("import.progress")).toBe(0);
  });
});

describe("the recents list follows the view history", () => {
  it("reads again on each view.changed while shown, and not once hidden", () => {
    const bus = createFakeAppEvents();
    const onChanged = vi.fn();
    watchViewHistoryChanged(() => bus.api, true, onChanged);
    bus.emit({ type: "view.changed" });
    bus.emit({ type: "view.changed" });
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(bus.listening("view.changed")).toBe(1);

    const hidden = createFakeAppEvents();
    watchViewHistoryChanged(() => hidden.api, false, vi.fn());
    expect(hidden.listening("view.changed")).toBe(0);
  });
});
