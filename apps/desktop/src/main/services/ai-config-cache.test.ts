import { aiConfigGeneration } from "@app/db";
import { describe, expect, it, vi } from "vitest";

import { AiConfigCache } from "./ai-config-cache.js";

function cache() {
  const clock = { generation: 0, pool: {} as unknown };
  return {
    clock,
    cache: new AiConfigCache({ generation: () => clock.generation, pool: () => clock.pool })
  };
}

describe("AiConfigCache (F3 D38)", () => {
  it("loads once per key while the generation holds", async () => {
    const { cache: store } = cache();
    const load = vi.fn(async () => ({ model: "m" }));
    await store.route("a", load);
    await store.route("a", load);
    await store.route("b", load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.stats()).toMatchObject({ hits: 1, loads: 2, drops: 0 });
  });

  it("drops everything when the generation moves, adapters included", async () => {
    const { cache: store, clock } = cache();
    const providers = vi.fn(async () => [{ id: "p" }]);
    const credential = vi.fn(async () => "secret");
    const adapter = vi.fn(async () => ({ built: true }));
    await store.providers(providers);
    await store.credential("ref", credential);
    const first = await store.adapter("config", adapter);
    expect(await store.adapter("config", adapter)).toBe(first);
    clock.generation += 1;
    await store.providers(providers);
    await store.credential("ref", credential);
    expect(await store.adapter("config", adapter)).not.toBe(first);
    expect([providers, credential, adapter].map((load) => load.mock.calls.length)).toEqual([
      2, 2, 2
    ]);
    expect(store.stats().drops).toBe(1);
  });

  it("drops everything when the database is another one", async () => {
    const { cache: store, clock } = cache();
    const load = vi.fn(async () => ({}));
    await store.localModel("id", load);
    clock.pool = {};
    await store.localModel("id", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one load between callers that ask at the same time", async () => {
    const { cache: store } = cache();
    const gate = Promise.withResolvers<{ model: string }>();
    const load = vi.fn(() => gate.promise);
    const calls = [store.route("a", load), store.route("a", load), store.route("a", load)];
    gate.resolve({ model: "m" });
    expect(await Promise.all(calls)).toEqual([{ model: "m" }, { model: "m" }, { model: "m" }]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not keep a load that failed", async () => {
    const { cache: store } = cache();
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("keychain locked"))
      .mockResolvedValue("secret");
    await expect(store.credential("ref", load)).rejects.toThrow("keychain locked");
    await expect(store.credential("ref", load)).resolves.toBe("secret");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not store a read that was in flight when the configuration changed", async () => {
    const { cache: store, clock } = cache();
    const stale = Promise.withResolvers<{ model: string }>();
    const slow = store.route("a", () => stale.promise);
    clock.generation += 1;
    const fresh = vi.fn(async () => ({ model: "new" }));
    expect(await store.route("a", fresh)).toEqual({ model: "new" });
    stale.resolve({ model: "old" });
    // The caller that started before the write gets what it read; nobody after it does.
    expect(await slow).toEqual({ model: "old" });
    expect(await store.route("a", fresh)).toEqual({ model: "new" });
    expect(fresh).toHaveBeenCalledOnce();
  });

  it("hands out copies of the rows, so one caller cannot change another's", async () => {
    const { cache: store } = cache();
    const load = async () => ({ parameters: { temperature: 0.2 } });
    const first = await store.route("a", load);
    first.parameters.temperature = 9;
    expect(await store.route("a", load)).toEqual({ parameters: { temperature: 0.2 } });
    // A null route is a cached answer too.
    const none = vi.fn(async () => null);
    await store.route("none", none);
    await store.route("none", none);
    expect(none).toHaveBeenCalledOnce();
  });

  it("drops on invalidate, which also reports the write to the other caches of the process", async () => {
    const real = new AiConfigCache();
    const load = vi.fn(async () => ({}));
    await real.route("a", load);
    const before = aiConfigGeneration();
    real.invalidate();
    expect(aiConfigGeneration()).toBe(before + 1);
    await real.route("a", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
