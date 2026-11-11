import { describe, expect, it, vi } from "vitest";
import type { ObjectGetResult, ObjectSummary } from "@app/domain";

import type { AppEvent, AppEventOf } from "../../shared/app-events";
import { createFakeAppEvents } from "./fake-app-events";
import {
  noticeForKinds,
  noticeForTargets,
  objectTargetsOf,
  watchObject,
  watchObjectChanged,
  type ObjectState,
  type ObjectWatchApi
} from "./object-events";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = `memora://note/${id(1)}`;
const noteAnchored = `memora://note/${id(1)}#passage=${id(9)}`;
const topic = `memora://topic/${id(2)}`;

const changed = (...refs: Array<[kind: string, n: number, change: string]>): AppEvent =>
  ({
    type: "object.changed",
    refs: refs.map(([kind, n, change]) => ({ kind, id: id(n), change }))
  }) as AppEvent;
const overflow = (...kinds: string[]): AppEvent =>
  ({ type: "object.changed", overflow: true, kinds }) as AppEvent;

const summary = (address: string, overrides: Partial<ObjectSummary> = {}): ObjectSummary => ({
  address,
  kind: "note",
  title: "A note",
  status: "current",
  preview: "",
  updatedAt: "2026-11-11T10:00:00.000Z",
  ...overrides
});

describe("the addresses a panel follows", () => {
  it("keeps the kind and id of each valid address once, whatever its anchor", () => {
    expect(objectTargetsOf([note, noteAnchored, topic, "not an address"])).toEqual([
      { kind: "note", id: id(1) },
      { kind: "topic", id: id(2) }
    ]);
  });
});

describe("what an object.changed says to the objects and kinds that follow it", () => {
  const event = (value: AppEvent) => value as AppEventOf<"object.changed">;
  const targets = objectTargetsOf([note]);

  it("names the refs of the followed objects, and nothing else", () => {
    expect(
      noticeForTargets(
        event(changed(["note", 1, "updated"], ["note", 2, "updated"], ["topic", 1, "updated"])),
        targets
      )
    ).toEqual({
      refs: [{ kind: "note", id: id(1), change: "updated" }],
      overflow: false
    });
    expect(noticeForTargets(event(changed(["note", 2, "updated"])), targets)).toBeNull();
  });

  it("tells a followed kind that a batch too broad to list may have touched it", () => {
    expect(noticeForTargets(event(overflow("note", "source")), targets)).toEqual({
      refs: [],
      overflow: true
    });
    expect(noticeForTargets(event(overflow("topic")), targets)).toBeNull();
  });

  it("lets a list follow whole kinds, listed or overflowed", () => {
    expect(noticeForKinds(event(changed(["source", 4, "created"])), ["source"])).toEqual({
      refs: [{ kind: "source", id: id(4), change: "created" }],
      overflow: false
    });
    expect(noticeForKinds(event(changed(["note", 4, "created"])), ["source"])).toBeNull();
    expect(noticeForKinds(event(overflow("source")), ["source", "note"])?.overflow).toBe(true);
    expect(noticeForKinds(event(overflow("topic")), ["source"])).toBeNull();
  });
});

describe("following changes of objects on the bus", () => {
  it("calls the handler for a change of a followed object, and stops when told to", () => {
    const bus = createFakeAppEvents();
    const onChange = vi.fn();
    const stop = watchObjectChanged(() => bus.api, [noteAnchored], onChange);
    bus.emit(changed(["topic", 2, "updated"]));
    expect(onChange).not.toHaveBeenCalled();
    bus.emit(changed(["note", 1, "relations"]));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      refs: [{ kind: "note", id: id(1), change: "relations" }],
      overflow: false
    });
    expect(bus.listening("object.changed")).toBe(1);
    stop();
    expect(bus.listening("object.changed")).toBe(0);
  });

  it("subscribes to nothing when no address is valid, and where there is no bus", () => {
    const bus = createFakeAppEvents();
    watchObjectChanged(() => bus.api, ["nope"], vi.fn())();
    expect(bus.listening("object.changed")).toBe(0);
    expect(() => watchObjectChanged(() => undefined, [note], vi.fn())()).not.toThrow();
  });
});

describe("an object panel's own read (useObject)", () => {
  function setup(get: (address: string) => Promise<ObjectGetResult>) {
    const bus = createFakeAppEvents();
    const objects = { get: vi.fn(async ({ address }: { address: string }) => get(address)) };
    const api = { ...bus.api, objects } as ObjectWatchApi;
    const states: ObjectState[] = [];
    const stop = watchObject(
      () => api,
      note,
      (state) => states.push(state)
    );
    return { bus, objects, states, stop };
  }
  const last = (states: ObjectState[]) => states[states.length - 1];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("reads the object once, then again each time the bus names it", async () => {
    let title = "First title";
    const { bus, objects, states } = setup(async (address) => summary(address, { title }));
    expect(states).toEqual([{ status: "loading" }]);
    await settle();
    expect(objects.get).toHaveBeenCalledExactlyOnceWith({ address: note });
    expect(last(states)).toEqual({ status: "ready", object: summary(note, { title }) });

    title = "Second title";
    bus.emit(changed(["note", 1, "updated"]));
    await settle();
    expect(objects.get).toHaveBeenCalledTimes(2);
    expect(last(states)).toMatchObject({ status: "ready", object: { title: "Second title" } });

    // Another note, and another kind with the same id, change nothing here.
    bus.emit(changed(["note", 5, "updated"], ["topic", 1, "updated"]));
    await settle();
    expect(objects.get).toHaveBeenCalledTimes(2);
  });

  it("reads again after a batch too broad to list that names its kind", async () => {
    const { bus, objects } = setup(async (address) => summary(address));
    await settle();
    bus.emit(overflow("note"));
    await settle();
    expect(objects.get).toHaveBeenCalledTimes(2);
  });

  it("shows a deleted object as missing, and a merged topic's redirect as the read answers it", async () => {
    let answer: ObjectGetResult | null = null;
    const { bus, states } = setup(async (address) => answer ?? summary(address));
    await settle();
    answer = { status: "missing" };
    bus.emit(changed(["note", 1, "deleted"]));
    await settle();
    expect(last(states)).toEqual({ status: "missing" });
    answer = summary(note, { status: "redirected", redirectTo: topic });
    bus.emit(changed(["note", 1, "moved"]));
    await settle();
    expect(last(states)).toMatchObject({ status: "ready", object: { status: "redirected" } });
  });

  it("keeps the object on screen when a re-read fails, and says a first read failed", async () => {
    let fail = true;
    const first = setup(async (address) => {
      if (fail) throw new Error("boom");
      return summary(address);
    });
    await settle();
    expect(last(first.states)).toEqual({ status: "error" });

    fail = false;
    const second = setup(async (address) => {
      if (fail) throw new Error("boom");
      return summary(address);
    });
    await settle();
    fail = true;
    second.bus.emit(changed(["note", 1, "updated"]));
    await settle();
    expect(last(second.states)).toMatchObject({ status: "ready" });
  });

  it("keeps the newest answer when two reads overlap", async () => {
    const resolvers: Array<(value: ObjectGetResult) => void> = [];
    const { bus, states } = setup(() => new Promise((resolve) => resolvers.push(resolve)));
    bus.emit(changed(["note", 1, "updated"]));
    await settle();
    expect(resolvers).toHaveLength(2);
    resolvers[1]!(summary(note, { title: "Newest" }));
    await settle();
    resolvers[0]!(summary(note, { title: "Stale" }));
    await settle();
    expect(last(states)).toMatchObject({ status: "ready", object: { title: "Newest" } });
  });

  it("stops reading and listening when told to, and drops an answer that arrives late", async () => {
    const resolvers: Array<(value: ObjectGetResult) => void> = [];
    const { bus, states, stop, objects } = setup(
      () => new Promise((resolve) => resolvers.push(resolve))
    );
    stop();
    expect(bus.listening("object.changed")).toBe(0);
    resolvers[0]!(summary(note));
    await settle();
    expect(states).toEqual([{ status: "loading" }]);
    bus.emit(changed(["note", 1, "updated"]));
    expect(objects.get).toHaveBeenCalledTimes(1);
  });
});
