import { describe, expect, it } from "vitest";

import { createFakeApi, isSubscription } from "./fake-api";

type App = {
  inbox: { list(query: unknown): Promise<unknown> };
  onAppEvent(type: string, handler: unknown): () => void;
};

const pending = Symbol("pending");
/** Settles within a tick, or reports that the promise is still pending. */
const settled = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message })
    ),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(pending), 20))
  ]);

describe("the fake window.app", () => {
  it("keeps every call pending in loading", async () => {
    const { app } = createFakeApi("loading", { "inbox.list": 1 });
    expect(await settled((app as App).inbox.list({}))).toBe(pending);
  });

  it("rejects every call in error, even one with a fixture", async () => {
    const { app } = createFakeApi("error", { "inbox.list": 1 });
    expect(await settled((app as App).inbox.list({}))).toEqual({
      error: "fake window.app: inbox.list fails"
    });
  });

  it("answers from the fixtures in success and empty: a value, or a function of the arguments", async () => {
    const success = createFakeApi("success", {
      "inbox.list": (query: { n: number }) => query.n + 1
    });
    expect(await (success.app as App).inbox.list({ n: 1 })).toBe(2);
    const empty = createFakeApi("empty", { "inbox.list": { items: [] } });
    expect(await (empty.app as App).inbox.list({})).toEqual({ items: [] });
    expect(success.calls).toEqual([{ path: "inbox.list", args: [{ n: 1 }] }]);
  });

  it("lists a call without a fixture as missing and rejects it", async () => {
    const fake = createFakeApi("success", {});
    expect(await settled((fake.app as App).inbox.list({}))).toEqual({
      error: "fake window.app: no fixture for inbox.list"
    });
    expect(fake.missing()).toEqual(["inbox.list"]);
  });

  it("turns a fixture that throws into a rejection", async () => {
    const fake = createFakeApi("success", {
      "inbox.list": () => {
        throw new Error("boom");
      }
    });
    expect(await settled((fake.app as App).inbox.list({}))).toEqual({ error: "boom" });
  });

  it("answers the calls an error fixture set names and rejects the others, without listing them as missing", async () => {
    const fake = createFakeApi(
      "error",
      { "other.read": 1 },
      {
        "inbox.list": { items: [] },
        "inbox.count": () => {
          throw new Error("boom");
        }
      }
    );
    const app = fake.app as App & { inbox: { count(): Promise<unknown> } };
    expect(await app.inbox.list({})).toEqual({ items: [] });
    expect(await settled(app.inbox.count())).toEqual({ error: "boom" });
    expect(
      await settled((fake.app as { other: { read(): Promise<unknown> } }).other.read())
    ).toEqual({
      error: "fake window.app: other.read fails"
    });
    expect(fake.missing()).toEqual([]);
  });

  it("answers the calls a loading fixture set names and keeps the others pending", async () => {
    const fake = createFakeApi("loading", {}, {}, { "inbox.list": { items: [] } });
    const app = fake.app as App & { inbox: { count(): Promise<unknown> } };
    expect(await app.inbox.list({})).toEqual({ items: [] });
    expect(await settled(app.inbox.count())).toBe(pending);
    expect(fake.missing()).toEqual([]);
  });

  it("makes subscriptions no-ops in every mode, at any depth", () => {
    for (const mode of ["loading", "empty", "error", "success"] as const) {
      const { app, missing } = createFakeApi(mode);
      const stop = (app as App).onAppEvent("inbox.changed", () => undefined);
      expect(stop()).toBeUndefined();
      const nested = (app as unknown as { topics: { subscribeChanged(h: unknown): () => void } })
        .topics;
      expect(nested.subscribeChanged(() => undefined)()).toBeUndefined();
      expect(missing()).toEqual([]);
    }
    expect(isSubscription("subscribeChanged")).toBe(true);
    expect(isSubscription("onAppEvent")).toBe(true);
    expect(isSubscription("once")).toBe(false);
    expect(isSubscription("online")).toBe(false);
  });

  it("is never thenable, so awaiting a namespace does not hang", async () => {
    const { app } = createFakeApi("loading");
    expect(await Promise.resolve((app as { inbox: unknown }).inbox)).toBeTypeOf("function");
  });
});
