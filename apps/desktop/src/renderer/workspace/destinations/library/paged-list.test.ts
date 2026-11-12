import { describe, expect, it } from "vitest";

import {
  createPagedList,
  type PageRequest,
  type PageResult,
  type PageSource,
  type PagedState,
  type Scheduler
} from "./paged-list";

interface Item {
  id: string;
}
type Facets = { count: number };

/** A scheduler the test fires by hand. */
function manualScheduler() {
  const queue = new Map<number, () => void>();
  let next = 0;
  const scheduler: Scheduler = {
    set(callback) {
      next += 1;
      queue.set(next, callback);
      return next;
    },
    clear(handle) {
      queue.delete(handle as number);
    }
  };
  return {
    scheduler,
    pending: () => queue.size,
    fire() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback();
    }
  };
}

const items = (from: number, to: number): Item[] =>
  Array.from({ length: to - from }, (_, index) => ({ id: `r${from + index}` }));

interface Pending {
  request: PageRequest;
  resolve: (result: PageResult<Item, Facets>) => void;
  reject: (error: Error) => void;
}

/** A source whose answers the test gives one at a time. */
function controlledSource() {
  const pending: Pending[] = [];
  const source: PageSource<Item, Facets> = {
    read: (request) =>
      new Promise((resolve, reject) => {
        pending.push({ request, resolve, reject });
      })
  };
  return { source, pending };
}

/** Lets the promise callbacks that are already queued run. */
const flush = async () => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

function setup(overrides: { refreshCap?: number } = {}) {
  const clock = manualScheduler();
  const states: PagedState<Item, Facets>[] = [];
  const list = createPagedList<Item, Facets>({
    pageSize: 3,
    refreshPage: 4,
    refreshCap: overrides.refreshCap ?? 8,
    refreshDelayMs: 400,
    key: (item) => item.id,
    schedule: clock.scheduler,
    onChange: (state) => states.push(state)
  });
  return { list, clock, states, last: () => states.at(-1) as PagedState<Item, Facets> };
}

describe("the first page of a query", () => {
  it("is loading until it arrives, then ready with the rows, the total and the counts", async () => {
    const { list, last } = setup();
    const { source, pending } = controlledSource();
    list.load(source, { facets: true });
    expect(last().status).toBe("loading");
    expect(pending[0]?.request).toEqual({ cursor: undefined, limit: 3, facets: true });
    pending[0]?.resolve({ items: items(0, 3), next: "c1", total: 8, facets: { count: 8 } });
    await flush();
    expect(last()).toMatchObject({
      status: "ready",
      total: 8,
      hasMore: true,
      facets: { count: 8 },
      stale: false
    });
    expect(last().items.map((item) => item.id)).toEqual(["r0", "r1", "r2"]);
  });

  it("knows the total of a source that does not count once the last page is in", async () => {
    const { list, last } = setup();
    const { source, pending } = controlledSource();
    list.load(source, { facets: false });
    pending[0]?.resolve({ items: items(0, 2) });
    await flush();
    expect(last()).toMatchObject({ status: "ready", total: 2, hasMore: false });
  });

  it("fails as a whole when the first page fails, and tries again on retry", async () => {
    const { list, last } = setup();
    const { source, pending } = controlledSource();
    list.load(source, { facets: true });
    pending[0]?.reject(new Error("down"));
    await flush();
    expect(last()).toMatchObject({ status: "error", items: [] });
    list.retry();
    expect(last().status).toBe("loading");
    pending[1]?.resolve({ items: items(0, 1), facets: { count: 1 } });
    await flush();
    expect(last().status).toBe("ready");
  });
});

describe("a new query", () => {
  it("keeps the rows on screen, dimmed, until its first page arrives, and drops an older answer", async () => {
    const { list, last } = setup();
    const first = controlledSource();
    list.load(first.source, { facets: true });
    first.pending[0]?.resolve({ items: items(0, 3), total: 3, facets: { count: 3 } });
    await flush();

    const slow = controlledSource();
    const fast = controlledSource();
    list.load(slow.source, { facets: false });
    expect(last()).toMatchObject({ status: "ready", stale: true });
    expect(last().items).toHaveLength(3);
    list.load(fast.source, { facets: false });
    fast.pending[0]?.resolve({ items: items(10, 11), total: 1 });
    await flush();
    slow.pending[0]?.resolve({ items: items(20, 25), total: 5 });
    await flush();
    expect(last().items.map((item) => item.id)).toEqual(["r10"]);
    expect(last().stale).toBe(false);
    // The counts stay when a query did not ask for them again.
    expect(last().facets).toEqual({ count: 3 });
  });

  it("fails without rows when the new query's first page fails", async () => {
    const { list, last } = setup();
    const first = controlledSource();
    list.load(first.source, { facets: true });
    first.pending[0]?.resolve({ items: items(0, 3), total: 3 });
    await flush();
    const next = controlledSource();
    list.load(next.source, { facets: false });
    next.pending[0]?.reject(new Error("down"));
    await flush();
    expect(last()).toMatchObject({ status: "error", items: [], stale: false });
  });
});

describe("more pages", () => {
  it("reads the next page by its cursor once, keeps each row once and stops at the last page", async () => {
    const { list, last } = setup();
    const { source, pending } = controlledSource();
    list.load(source, { facets: true });
    pending[0]?.resolve({ items: items(0, 3), next: "c1", total: 5 });
    await flush();
    list.more();
    list.more();
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request).toEqual({ cursor: "c1", limit: 3, facets: false });
    expect(last().loadingMore).toBe(true);
    // The page edge moved: r2 comes again.
    pending[1]?.resolve({ items: items(2, 5), total: 5 });
    await flush();
    expect(last().items.map((item) => item.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(last()).toMatchObject({ hasMore: false, loadingMore: false, total: 5 });
    list.more();
    expect(pending).toHaveLength(2);
  });

  it("says once that a page failed, keeps the rows, and reads it again on retry", async () => {
    const { list, last } = setup();
    const { source, pending } = controlledSource();
    list.load(source, { facets: false });
    pending[0]?.resolve({ items: items(0, 3), next: "c1", total: 6 });
    await flush();
    list.more();
    pending[1]?.reject(new Error("down"));
    await flush();
    expect(last()).toMatchObject({ status: "ready", moreFailed: true, loadingMore: false });
    expect(last().items).toHaveLength(3);
    list.retry();
    expect(pending[2]?.request.cursor).toBe("c1");
    pending[2]?.resolve({ items: items(3, 6), total: 6 });
    await flush();
    expect(last()).toMatchObject({ moreFailed: false, hasMore: false });
    expect(last().items).toHaveLength(6);
  });
});

describe("a re-read after a change", () => {
  async function loaded() {
    const context = setup();
    const { source, pending } = controlledSource();
    context.list.load(source, { facets: true });
    pending[0]?.resolve({ items: items(0, 3), next: "c1", total: 7, facets: { count: 7 } });
    await flush();
    context.list.more();
    pending[1]?.resolve({ items: items(3, 6), next: "c2", total: 7 });
    await flush();
    return { ...context, pending };
  }

  it("gathers a burst of changes into one re-read that starts after the delay", async () => {
    const { list, clock, pending } = await loaded();
    list.refresh();
    list.refresh();
    list.refresh();
    expect(clock.pending()).toBe(1);
    expect(pending).toHaveLength(2);
    clock.fire();
    // It re-reads what is loaded (6 rows) in pages of 4, asking for the counts once.
    expect(pending[2]?.request).toEqual({ cursor: undefined, limit: 4, facets: true });
  });

  it("brings back the rows that were loaded, with fresh counts, and keeps the scroll's rows", async () => {
    const { list, clock, pending, last } = await loaded();
    list.refresh();
    clock.fire();
    pending[2]?.resolve({ items: items(100, 104), next: "d1", total: 8, facets: { count: 8 } });
    await flush();
    expect(pending[3]?.request).toEqual({ cursor: "d1", limit: 2, facets: false });
    pending[3]?.resolve({ items: items(104, 106), next: "d2", total: 8 });
    await flush();
    expect(last().items.map((item) => item.id)).toEqual([
      "r100",
      "r101",
      "r102",
      "r103",
      "r104",
      "r105"
    ]);
    expect(last()).toMatchObject({ total: 8, facets: { count: 8 }, hasMore: true });
  });

  it("keeps the rows when the re-read fails, and says nothing", async () => {
    const { list, clock, pending, last } = await loaded();
    list.refresh();
    clock.fire();
    pending[2]?.reject(new Error("down"));
    await flush();
    expect(last()).toMatchObject({ status: "ready", moreFailed: false });
    expect(last().items).toHaveLength(6);
  });

  it("waits for a page that is being read, and re-reads right after it", async () => {
    const { list, clock, pending } = await loaded();
    list.more();
    expect(pending[2]?.request.cursor).toBe("c2");
    list.refresh();
    expect(clock.pending()).toBe(0);
    pending[2]?.resolve({ items: items(6, 7), total: 7 });
    await flush();
    clock.fire();
    expect(pending[3]?.request.cursor).toBeUndefined();
  });

  it("brings back no more than the cap, and drops a re-read of an older query", async () => {
    const context = setup({ refreshCap: 4 });
    const { source, pending } = controlledSource();
    context.list.load(source, { facets: false });
    pending[0]?.resolve({ items: items(0, 3), next: "c1", total: 20 });
    await flush();
    context.list.more();
    pending[1]?.resolve({ items: items(3, 6), next: "c2", total: 20 });
    await flush();
    context.list.refresh();
    context.clock.fire();
    expect(pending[2]?.request.limit).toBe(4);
    const other = controlledSource();
    context.list.load(other.source, { facets: false });
    pending[2]?.resolve({ items: items(50, 54), next: "x", total: 20 });
    await flush();
    other.pending[0]?.resolve({ items: items(70, 71), total: 1 });
    await flush();
    expect(context.last().items.map((item) => item.id)).toEqual(["r70"]);
  });

  it("keeps the rows past the cap when a deeper list is re-read, and pages on from where it ended", async () => {
    const context = setup({ refreshCap: 4 });
    const { source, pending } = controlledSource();
    context.list.load(source, { facets: false });
    pending[0]?.resolve({ items: items(0, 3), next: "c1", total: 20 });
    await flush();
    context.list.more();
    pending[1]?.resolve({ items: items(3, 6), next: "c2", total: 20 });
    await flush();
    context.list.more();
    pending[2]?.resolve({ items: items(6, 9), next: "c3", total: 20 });
    await flush();
    context.list.refresh();
    context.clock.fire();
    // The head (4 rows) is read again: a new row leads, r3 slid out of it.
    pending[3]?.resolve({ items: [{ id: "new" }, ...items(0, 3)], next: "d1", total: 21 });
    await flush();
    expect(context.last().items.map((item) => item.id)).toEqual([
      "new",
      "r0",
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
      "r8"
    ]);
    expect(context.last()).toMatchObject({ total: 21, hasMore: true });
    // The next page still continues from the end of what was loaded.
    context.list.more();
    expect(pending[4]?.request.cursor).toBe("c3");
  });

  it("re-reads after a first page that was being read when the change came", async () => {
    const { list, clock, last } = setup();
    const { source, pending } = controlledSource();
    list.load(source, { facets: true });
    // The change is pushed while the first page is in flight: its snapshot may not hold it.
    list.refresh();
    expect(clock.pending()).toBe(0);
    pending[0]?.resolve({ items: items(0, 2), total: 2, facets: { count: 2 } });
    await flush();
    expect(last().status).toBe("ready");
    expect(clock.pending()).toBe(1);
    clock.fire();
    expect(pending[1]?.request.cursor).toBeUndefined();
    pending[1]?.resolve({ items: items(0, 3), total: 3, facets: { count: 3 } });
    await flush();
    expect(last().items).toHaveLength(3);
  });

  it("re-reads after a re-query that was being read when the change came", async () => {
    const { list, clock, last } = setup();
    const first = controlledSource();
    list.load(first.source, { facets: true });
    first.pending[0]?.resolve({ items: items(0, 2), total: 2 });
    await flush();
    const next = controlledSource();
    list.load(next.source, { facets: false });
    expect(last().stale).toBe(true);
    list.refresh();
    next.pending[0]?.resolve({ items: items(5, 7), total: 2 });
    await flush();
    expect(clock.pending()).toBe(1);
    clock.fire();
    expect(next.pending).toHaveLength(2);
  });

  it("does nothing before the first page has arrived or after it failed", async () => {
    const { list, clock } = setup();
    const { source, pending } = controlledSource();
    list.refresh();
    expect(clock.pending()).toBe(0);
    list.load(source, { facets: false });
    pending[0]?.reject(new Error("down"));
    await flush();
    list.refresh();
    expect(clock.pending()).toBe(0);
  });
});

describe("when the list is gone", () => {
  it("reads again once it is resumed (React runs a cleanup and a setup on a kept state)", async () => {
    const { list, last } = setup();
    const { source, pending } = controlledSource();
    list.load(source, { facets: true });
    list.dispose();
    list.resume();
    pending[0]?.resolve({ items: items(0, 3), total: 3 });
    await flush();
    // The answer to the load that was dropped is not taken ...
    expect(last().status).toBe("loading");
    // ... and a load after the resume reports again.
    list.load(source, { facets: true });
    pending[1]?.resolve({ items: items(0, 3), total: 3 });
    await flush();
    expect(last().status).toBe("ready");
  });

  it("never reports an answer that comes late, and starts no re-read", async () => {
    const { list, clock, states } = setup();
    const { source, pending } = controlledSource();
    list.load(source, { facets: true });
    const before = states.length;
    list.dispose();
    pending[0]?.resolve({ items: items(0, 3), total: 3 });
    await flush();
    expect(states).toHaveLength(before);
    list.refresh();
    expect(clock.pending()).toBe(0);
  });
});
