import { describe, expect, it, vi } from "vitest";

import { createFakeAppEvents } from "../../../lib/fake-app-events";
import { uuid } from "../../../components/inbox/inbox-fixtures";
import { homeDigest } from "./home-fixtures";
import { HomeStore, type HomeStoreApi } from "./home-store";

const now = Date.UTC(2026, 10, 11, 12, 0, 0);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(
  over: { digest?: HomeStoreApi["home"]["digest"]; rows?: HomeStoreApi["library"]["rows"] } = {}
) {
  const bus = createFakeAppEvents();
  const digest = vi.fn(over.digest ?? (async () => homeDigest(now)));
  const rows = vi.fn(over.rows ?? (async () => ({ rows: [{ id: uuid(101) }], total: 1 }) as never));
  const sourceProgress = vi.fn(
    async () =>
      ({
        steps: { notes: { state: "running", soFar: 7, estimate: 18 } }
      }) as never
  );
  const resolveMany = vi.fn(
    async ({ addresses }: { addresses: string[] }) =>
      ({
        items: Object.fromEntries(
          addresses.map((address) => [address, { address, title: "Fermentação lática" }])
        ),
        missing: []
      }) as never
  );
  const undo = vi.fn(async () => ({ status: "undone", kind: "topic", id: uuid(801) }) as never);
  const api: HomeStoreApi = {
    home: { digest },
    library: { rows, sourceProgress },
    changes: { undo },
    objects: { resolveMany },
    onAppEvent: bus.api.onAppEvent
  };
  const onFirstRead = vi.fn();
  const since = vi.fn(() => "2026-11-10T22:40:00.000Z" as string | null);
  const store = new HomeStore({ api: () => api, since, now: () => now, onFirstRead });
  return { store, bus, digest, rows, sourceProgress, resolveMany, undo, onFirstRead, since };
}

describe("Home's store", () => {
  it("reads the digest since the last visit and the sources that still generate", async () => {
    const { store, digest, rows, sourceProgress } = setup();
    store.start();
    await flush();
    const read = store.getSnapshot().read;
    expect(read.status).toBe("ready");
    expect(digest).toHaveBeenCalledWith({ since: "2026-11-10T22:40:00.000Z" });
    expect(rows).toHaveBeenCalledWith({ filter: { status: "processing" }, limit: 50 });
    if (read.status !== "ready") throw new Error("not ready");
    expect(read.data.generating).toEqual({ total: 1, ids: [uuid(101)] });
    expect(read.data.progress).toEqual({ [uuid(101)]: { done: 7, estimate: 18 } });
    expect(read.data.lastVisit).toBe("2026-11-10T22:40:00.000Z");
    expect(read.data.readAt).toBe(now);
    expect(sourceProgress).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("resolves the titles of the topics the recent questions were asked in, and reads without them when that fails", async () => {
    const { store, resolveMany } = setup();
    store.start();
    await flush();
    const read = store.getSnapshot().read;
    if (read.status !== "ready") throw new Error("not ready");
    expect(resolveMany).toHaveBeenCalledWith({ addresses: [`memora://topic/${uuid(12)}`] });
    expect(read.data.topicTitles).toEqual({ [uuid(12)]: "Fermentação lática" });
    store.stop();

    const failing = setup();
    failing.resolveMany.mockRejectedValue(new Error("down"));
    failing.store.start();
    await flush();
    const after = failing.store.getSnapshot().read;
    expect(after.status).toBe("ready");
    if (after.status === "ready") expect(after.data.topicTitles).toEqual({});
    failing.store.stop();
  });

  it("looks back a week when Home was never opened", async () => {
    const { store, digest, since } = setup();
    since.mockReturnValue(null);
    store.start();
    await flush();
    expect(digest).toHaveBeenCalledWith({ since: null });
    store.stop();
  });

  it("keeps `since` within one visit, so what arrived does not vanish once Home is recorded as opened", async () => {
    const { store, digest, since, bus } = setup();
    store.start();
    await flush();
    since.mockReturnValue("2026-11-11T12:00:00.000Z");
    bus.emit({ type: "inbox.changed", total: 0, byKind: {}, byRisk: {} } as never);
    await flush();
    expect(since).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenLastCalledWith({ since: "2026-11-10T22:40:00.000Z" });
    store.stop();
  });

  it("reads each visit since the previous one and records each, when Home leaves and comes back", async () => {
    const { store, digest, since, onFirstRead } = setup();
    store.start();
    await flush();
    expect(digest).toHaveBeenLastCalledWith({ since: "2026-11-10T22:40:00.000Z" });
    expect(onFirstRead).toHaveBeenCalledTimes(1);
    store.stop();
    // The first visit was recorded as opened at 09:00; the person is back at 15:00.
    since.mockReturnValue("2026-11-11T09:00:00.000Z");
    store.start();
    await flush();
    expect(digest).toHaveBeenLastCalledWith({ since: "2026-11-11T09:00:00.000Z" });
    const read = store.getSnapshot().read;
    if (read.status !== "ready") throw new Error("not ready");
    expect(read.data.lastVisit).toBe("2026-11-11T09:00:00.000Z");
    expect(onFirstRead).toHaveBeenCalledTimes(2);
    store.stop();
  });

  it("finds the source of an arrival whose address carries an anchor", async () => {
    const base = homeDigest(now);
    const { store, sourceProgress } = setup({
      digest: async () => ({
        ...base,
        new: {
          ...base.new,
          sources: {
            ...base.new.sources,
            items: base.new.sources.items.map((item, index) =>
              index === 0
                ? {
                    ...item,
                    object: {
                      ...item.object,
                      address: `memora://source/${uuid(101)}#section=${uuid(9)}`
                    }
                  }
                : item
            )
          }
        }
      })
    });
    store.start();
    await flush();
    expect(sourceProgress).toHaveBeenCalledWith({ sourceId: uuid(101) });
    store.stop();
  });

  it("says Home was opened once, after the first answer", async () => {
    const { store, onFirstRead, bus } = setup();
    store.start();
    expect(onFirstRead).not.toHaveBeenCalled();
    await flush();
    expect(onFirstRead).toHaveBeenCalledTimes(1);
    bus.emit({ type: "view.changed" });
    await flush();
    expect(onFirstRead).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("opens without the generating clause when the library read fails", async () => {
    const { store, onFirstRead } = setup({
      rows: async () => {
        throw new Error("no library");
      }
    });
    store.start();
    await flush();
    const read = store.getSnapshot().read;
    expect(read.status).toBe("ready");
    if (read.status === "ready") expect(read.data.generating).toBeNull();
    expect(onFirstRead).toHaveBeenCalled();
    store.stop();
  });

  it("reads again on the bus events it follows, and never on a timer", async () => {
    const { store, digest, bus } = setup();
    store.start();
    await flush();
    expect(digest).toHaveBeenCalledTimes(1);
    for (const event of [
      { type: "object.changed", refs: [{ kind: "note", id: uuid(5), change: "created" }] },
      { type: "changes.changed", kind: "topic", id: uuid(801) },
      { type: "view.changed" },
      { type: "tree.changed" }
    ])
      bus.emit(event as never);
    await flush();
    expect(digest.mock.calls.length).toBeGreaterThan(1);
    expect(bus.listening("object.changed")).toBe(1);
    store.stop();
    expect(bus.listening("object.changed")).toBe(0);
    expect(bus.listening("inbox.changed")).toBe(0);
  });

  it("shows a failure of the first read, with the unavailable reason, and tries again on request", async () => {
    let calls = 0;
    const { store } = setup({
      digest: async () => {
        calls += 1;
        if (calls === 1) throw new Error("home.errors.unavailable");
        return homeDigest(now);
      }
    });
    store.start();
    await flush();
    expect(store.getSnapshot().read).toEqual({ status: "error", unavailable: true });
    store.retry();
    expect(store.getSnapshot().read.status).toBe("loading");
    await flush();
    expect(store.getSnapshot().read.status).toBe("ready");
    store.stop();
  });

  it("keeps what was shown when a later read fails", async () => {
    let calls = 0;
    const { store, bus } = setup({
      digest: async () => {
        calls += 1;
        if (calls > 1) throw new Error("boom");
        return homeDigest(now);
      }
    });
    store.start();
    await flush();
    bus.emit({ type: "view.changed" });
    await flush();
    expect(store.getSnapshot().read.status).toBe("ready");
    store.stop();
  });

  it("undoes a change and keeps the row as undone", async () => {
    const { store, undo } = setup();
    store.start();
    await flush();
    const pending = store.undo({ kind: "topic", id: uuid(801) });
    expect(store.getSnapshot().undo[`topic:${uuid(801)}`]).toEqual({ status: "pending" });
    await pending;
    expect(undo).toHaveBeenCalledWith({ kind: "topic", id: uuid(801) });
    expect(store.getSnapshot().undo[`topic:${uuid(801)}`]).toEqual({ status: "undone" });
    store.stop();
  });

  it("names what blocks an undo, and says plainly when it failed", async () => {
    const { store, undo } = setup();
    undo.mockResolvedValueOnce({
      status: "blocked",
      blockers: [{ code: "later_change", changeSet: null }],
      more: 0
    } as never);
    await store.undo({ kind: "topic", id: uuid(802) });
    expect(store.getSnapshot().undo[`topic:${uuid(802)}`]).toEqual({
      status: "blocked",
      messageKey: "changes.blockers.later_change"
    });
    undo.mockRejectedValueOnce(new Error("x"));
    await store.undo({ kind: "topic", id: uuid(803) });
    expect(store.getSnapshot().undo[`topic:${uuid(803)}`]).toEqual({
      status: "failed",
      messageKey: "activity.done.undoFailed"
    });
  });

  it("does not undo twice while one is under way", async () => {
    const { store, undo } = setup();
    const first = store.undo({ kind: "topic", id: uuid(801) });
    void store.undo({ kind: "topic", id: uuid(801) });
    await first;
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
