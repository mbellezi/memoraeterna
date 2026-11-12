import { describe, expect, it, vi } from "vitest";

import { SettingsStore, type SettingsStoreApi } from "./settings-store";

type Handler = (event: { type: "settings.changed" }) => void;

function fakeApi(
  describeCalls: Array<() => Promise<unknown>>,
  reset: (input: unknown) => Promise<unknown> = () => Promise.resolve({ id: "x", value: null })
) {
  let handler: Handler | null = null;
  let stopped = 0;
  let calls = 0;
  const api = {
    settings: {
      describe: vi.fn(() => describeCalls[Math.min(calls++, describeCalls.length - 1)]!()),
      reset: vi.fn(reset)
    },
    onAppEvent: vi.fn((_type: string, next: Handler) => {
      handler = next;
      return () => {
        stopped += 1;
      };
    })
  };
  return {
    api: api as unknown as SettingsStoreApi,
    mocks: api,
    emit: () => handler?.({ type: "settings.changed" }),
    stopped: () => stopped
  };
}

const answer = (entries: unknown[]) => () => Promise.resolve({ entries });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const entry = (id: string, changed: boolean) => ({ id, value: 1, default: 0, changed });

describe("the settings store", () => {
  it("reads once when held, follows settings.changed and stops when the last holder lets go", async () => {
    const fake = fakeApi([answer([entry("a", false)]), answer([entry("a", true)])]);
    const store = new SettingsStore(() => fake.api);
    expect(store.getSnapshot().read.status).toBe("loading");
    const release = store.retain();
    const second = store.retain();
    await settle();
    expect(fake.mocks.settings.describe).toHaveBeenCalledTimes(1);
    const first = store.getSnapshot().read;
    expect(first.status === "ready" && first.index.get("a")?.changed).toBe(false);

    fake.emit();
    await settle();
    const next = store.getSnapshot().read;
    expect(next.status === "ready" && next.index.get("a")?.changed).toBe(true);

    release();
    expect(fake.stopped()).toBe(0);
    second();
    expect(fake.stopped()).toBe(1);
  });

  it("keeps a failed first read visible, retries it, and keeps shown values when a later read fails", async () => {
    const fake = fakeApi([
      () => Promise.reject(new Error("closed")),
      answer([entry("a", true)]),
      () => Promise.reject(new Error("locked"))
    ]);
    const store = new SettingsStore(() => fake.api);
    store.retain();
    await settle();
    expect(store.getSnapshot().read.status).toBe("error");
    store.retry();
    expect(store.getSnapshot().read.status).toBe("loading");
    await settle();
    expect(store.getSnapshot().read.status).toBe("ready");
    fake.emit();
    await settle();
    expect(store.getSnapshot().read.status).toBe("ready");
  });

  it("never reads twice at once: events during a read make one more read after it", async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = () => new Promise((resolve) => (release = resolve));
    const fake = fakeApi([slow, answer([entry("a", true)])]);
    const store = new SettingsStore(() => fake.api);
    store.retain();
    fake.emit();
    fake.emit();
    expect(fake.mocks.settings.describe).toHaveBeenCalledTimes(1);
    release({ entries: [entry("a", false)] });
    await settle();
    await settle();
    expect(fake.mocks.settings.describe).toHaveBeenCalledTimes(2);
  });

  it("puts a setting back through reset, reads again, and says pending or failed in the row", async () => {
    const results: Record<string, () => Promise<unknown>> = {
      done: () => Promise.resolve({ id: "done", value: 0 }),
      wait: () => Promise.resolve({ id: "wait", value: 1, pending: true }),
      bad: () => Promise.reject(new Error("no"))
    };
    const fake = fakeApi([answer([entry("done", true)])], (input) =>
      results[(input as { id: string }).id]!()
    );
    const store = new SettingsStore(() => fake.api);
    store.retain();
    await settle();
    expect(await store.reset("done")).toBe("done");
    expect(await store.reset("wait")).toBe("pending");
    expect(await store.reset("bad")).toBe("failed");
    expect(store.getSnapshot().rows).toEqual({ wait: "pending", bad: "failed" });
    expect(fake.mocks.settings.reset).toHaveBeenCalledWith({ id: "done" });
    await store.reset("wait", true);
    expect(fake.mocks.settings.reset).toHaveBeenLastCalledWith({ id: "wait", confirmed: true });
  });

  it("restores several settings one after the other and counts what is left", async () => {
    const fake = fakeApi([answer([])], (input) =>
      (input as { id: string }).id === "wait"
        ? Promise.resolve({ id: "wait", value: 1, pending: true })
        : Promise.resolve({ id: "ok", value: 0 })
    );
    const store = new SettingsStore(() => fake.api);
    store.retain();
    expect(await store.restoreAll(["ok", "wait", "ok2"])).toEqual({
      done: 2,
      pending: 1,
      failed: 0
    });
  });
});
