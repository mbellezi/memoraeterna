import { describe, expect, it, vi } from "vitest";

import { subscribeAppEvent, type AppEventApi } from "./app-events";

function fakeApi() {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const onAppEvent = vi.fn(() => {
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  return { api: { onAppEvent } as unknown as AppEventApi, onAppEvent, stops };
}

describe("a view's subscription to the typed events", () => {
  it("subscribes while the view is shown and stops when it is left", () => {
    const { api, onAppEvent, stops } = fakeApi();
    const handler = vi.fn();

    const stop = subscribeAppEvent(true, () => api, "job.progress", handler);

    expect(onAppEvent).toHaveBeenCalledTimes(1);
    expect(onAppEvent).toHaveBeenCalledWith("job.progress", handler);
    expect(stops[0]).not.toHaveBeenCalled();
    stop();
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe while the view is hidden, and does not even ask for the API", () => {
    const { api, onAppEvent } = fakeApi();
    const getApi = vi.fn(() => api);

    const stop = subscribeAppEvent(false, getApi, "model.download", vi.fn());
    stop();

    expect(getApi).not.toHaveBeenCalled();
    expect(onAppEvent).not.toHaveBeenCalled();
  });

  it("subscribes again when a hidden view is shown", () => {
    const { api, onAppEvent, stops } = fakeApi();
    const handler = vi.fn();

    subscribeAppEvent(false, () => api, "job.progress", handler)();
    const stop = subscribeAppEvent(true, () => api, "job.progress", handler);

    expect(onAppEvent).toHaveBeenCalledTimes(1);
    stop();
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  it("absorbs a missing API (a renderer outside Electron) instead of throwing", () => {
    expect(() => subscribeAppEvent(true, () => undefined, "job.progress", vi.fn())()).not.toThrow();
  });
});
