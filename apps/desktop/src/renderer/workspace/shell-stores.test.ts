import { describe, expect, it, vi } from "vitest";

import type { AppEventHandler, AppEventType } from "../../shared/app-events";
import {
  InboxCountStore,
  NavigatorTreeStore,
  inboxCountStoreOf,
  navigatorTreeStoreOf,
  type InboxCountApi,
  type NavigatorTreeApi
} from "./shell-stores";

type Handlers = Map<string, Set<(event: never) => void>>;

function bus() {
  const handlers: Handlers = new Map();
  const onAppEvent = vi.fn(<T extends AppEventType>(type: T, handler: AppEventHandler<T>) => {
    const set = handlers.get(type) ?? new Set();
    set.add(handler as (event: never) => void);
    handlers.set(type, set);
    return () => set.delete(handler as (event: never) => void);
  });
  const emit = (type: string, event: unknown) =>
    handlers.get(type)?.forEach((handler) => handler(event as never));
  const listening = (type: string) => handlers.get(type)?.size ?? 0;
  return { onAppEvent, emit, listening };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Inbox count", () => {
  function setup(counts: () => Promise<{ total: number }>) {
    const events = bus();
    const api = {
      inbox: { counts: vi.fn(counts) },
      onAppEvent: events.onAppEvent
    } as unknown as InboxCountApi;
    return { store: new InboxCountStore(() => api), api, events };
  }

  it("is loading until it is read, then holds the total", async () => {
    const { store } = setup(async () => ({ total: 3 }));
    expect(store.getSnapshot()).toEqual({ status: "loading" });
    const release = store.retain();
    await flush();
    expect(store.getSnapshot()).toEqual({ status: "ready", value: 3 });
    release();
  });

  it("follows inbox.changed after that, and a pushed count beats a read still on its way", async () => {
    let resolve!: (value: { total: number }) => void;
    const { store, events } = setup(() => new Promise((done) => (resolve = done)));
    const release = store.retain();
    events.emit("inbox.changed", { total: 7 });
    resolve({ total: 2 });
    await flush();
    expect(store.getSnapshot()).toEqual({ status: "ready", value: 7 });
    release();
  });

  it("fails visibly, keeps a shown count when a later read fails, and retries", async () => {
    let fail = true;
    const { store, api } = setup(async () => {
      if (fail) throw new Error("down");
      return { total: 4 };
    });
    const release = store.retain();
    await flush();
    expect(store.getSnapshot()).toEqual({ status: "error" });
    fail = false;
    store.retry();
    expect(store.getSnapshot()).toEqual({ status: "loading" });
    await flush();
    expect(store.getSnapshot()).toEqual({ status: "ready", value: 4 });
    expect(api.inbox.counts).toHaveBeenCalledTimes(2);
    release();
  });

  it("starts once for any number of holders and stops with the last", () => {
    const { store, events, api } = setup(async () => ({ total: 0 }));
    const first = store.retain();
    const second = store.retain();
    expect(events.listening("inbox.changed")).toBe(1);
    expect(api.inbox.counts).toHaveBeenCalledTimes(1);
    first();
    expect(events.listening("inbox.changed")).toBe(1);
    second();
    second();
    expect(events.listening("inbox.changed")).toBe(0);
  });

  it("is one store per window, and an inert one where there is no window", () => {
    const app = { inbox: {}, onAppEvent: vi.fn() } as never;
    expect(inboxCountStoreOf(app)).toBe(inboxCountStoreOf(app));
    expect(inboxCountStoreOf(undefined).getSnapshot()).toEqual({ status: "loading" });
  });
});

describe("the top of the tree", () => {
  const node = (id: string, title: string | null, items: number) => ({
    id,
    parentId: null,
    title,
    items,
    children: 2,
    health: "balanced"
  });
  function setup(tree: () => Promise<unknown>) {
    const events = bus();
    const api = {
      topics: { tree: vi.fn(tree) },
      onAppEvent: events.onAppEvent
    } as unknown as NavigatorTreeApi;
    return { store: new NavigatorTreeStore(() => api), api, events };
  }

  it("lists the top-level topics with the totals", async () => {
    const { store, api } = setup(async () => ({
      nodes: [node("a", "Life sciences", 128), node("b", null, 5)],
      parent: { items: 133 },
      unsorted: 3
    }));
    const release = store.retain();
    await flush();
    expect(api.topics.tree).toHaveBeenCalledWith({ parentId: null });
    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe("ready");
    if (snapshot.status === "ready") {
      expect(snapshot.value.topics.map((topic) => topic.title)).toEqual(["Life sciences", null]);
      expect(snapshot.value.total).toBe(133);
      expect(snapshot.value.unsorted).toBe(3);
    }
    release();
  });

  it("reads an empty library (no tree) as empty, not as a failure", async () => {
    const { store } = setup(async () => null);
    const release = store.retain();
    await flush();
    expect(store.getSnapshot()).toEqual({
      status: "ready",
      value: { topics: [], total: 0, unsorted: 0 }
    });
    release();
  });

  it("reads again when the tree changes, and a failed refresh keeps what was shown", async () => {
    let fail = false;
    const { store, api, events } = setup(async () => {
      if (fail) throw new Error("down");
      return { nodes: [node("a", "One", 1)], parent: { items: 1 }, unsorted: 0 };
    });
    const release = store.retain();
    await flush();
    events.emit("tree.changed", {});
    await flush();
    expect(api.topics.tree).toHaveBeenCalledTimes(2);
    fail = true;
    events.emit("tree.changed", {});
    await flush();
    expect(store.getSnapshot().status).toBe("ready");
    release();
  });

  it("fails visibly on a first read that fails", async () => {
    const { store } = setup(async () => {
      throw new Error("down");
    });
    const release = store.retain();
    await flush();
    expect(store.getSnapshot()).toEqual({ status: "error" });
    release();
    expect(navigatorTreeStoreOf(undefined).getSnapshot()).toEqual({ status: "loading" });
  });
});
