import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppEventDispatcher } from "../../shared/app-events";
import { subscribe, subscribeAppEvent, type AppEventApi } from "./app-events";

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

describe("the typed subscribe(type, fn)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("listens through window.app and stops when told", () => {
    const { api, onAppEvent, stops } = fakeApi();
    vi.stubGlobal("window", { app: api });
    const handler = vi.fn();

    const stop = subscribe("object.changed", handler);

    expect(onAppEvent).toHaveBeenCalledWith("object.changed", handler);
    stop();
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  it("hands the handler the payload of its schema, validated by the dispatcher the preload uses", () => {
    let deliver: ((payload: unknown) => void) | null = null;
    const dispatcher = createAppEventDispatcher({
      attach: (next) => {
        deliver = next;
        return () => undefined;
      }
    });
    vi.stubGlobal("window", { app: { onAppEvent: dispatcher.subscribe } });
    const seen: string[] = [];

    subscribe("object.changed", (event) => {
      // `refs` exists on one side of the union only: the type narrows by the schema.
      if ("refs" in event) seen.push(...event.refs.map((ref) => `${ref.kind}:${ref.change}`));
      else seen.push(`overflow:${event.kinds.join(",")}`);
    });
    const push = (payload: unknown) => (deliver as ((payload: unknown) => void) | null)?.(payload);
    push({
      type: "object.changed",
      refs: [{ kind: "note", id: "00000000-0000-4000-8000-000000000001", change: "updated" }]
    });
    push({ type: "object.changed", overflow: true, kinds: ["topic"] });
    push({ type: "object.changed", refs: [{ kind: "graph", id: "x", change: "updated" }] });

    expect(seen).toEqual(["note:updated", "overflow:topic"]);
  });

  it("returns a no-op where there is no window.app", () => {
    vi.stubGlobal("window", {});
    expect(() => subscribe("view.changed", vi.fn())()).not.toThrow();
  });
});
