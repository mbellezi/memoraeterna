import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchOmniInput, SearchOmniResult } from "../../shared/ipc-search";
import { latestKeySeq, markKey, resetOmniMarks } from "./omni-marks";
import { OmniController, omniKey, type OmniParams } from "./use-omni";

/** A reader the test settles by hand: one pending call per request. */
function reader() {
  const calls: Array<{
    input: SearchOmniInput;
    resolve: (items?: string[]) => void;
    reject: () => void;
  }> = [];
  const search = (input: SearchOmniInput) =>
    new Promise<SearchOmniResult>((resolve, reject) => {
      calls.push({
        input,
        resolve: (items = [input.query]) =>
          resolve({
            requestId: input.requestId,
            items: items.map((title, index) => ({
              address: `memora://note/00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
              kind: "note" as const,
              title,
              arms: [{ arm: "title_trgm" as const, rank: index + 1 }],
              score: 0.1
            })),
            degraded: [],
            tookMs: 3
          }),
        reject: () => reject(new Error("failed"))
      });
    });
  return { calls, search };
}

const ask = (query: string, extra: Partial<OmniParams> = {}): OmniParams => ({
  query,
  mode: "quick",
  ...extra
});
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => resetOmniMarks());

describe("the omni controller", () => {
  it("sends the first query at once and shows its answer", async () => {
    const { calls, search } = reader();
    const omni = new OmniController({ search });
    omni.request(ask("fer"));
    expect(calls).toHaveLength(1);
    expect(omni.getSnapshot().status).toBe("loading");
    calls[0]?.resolve();
    await settle();
    expect(omni.getSnapshot()).toMatchObject({ status: "ready", tookMs: 3 });
    expect(omni.getSnapshot().items[0]?.title).toBe("fer");
  });

  it("keeps one request in flight and sends only the latest query when it returns", async () => {
    const { calls, search } = reader();
    const omni = new OmniController({ search });
    omni.request(ask("f"));
    omni.request(ask("fe"));
    omni.request(ask("fer"));
    omni.request(ask("ferm"));
    expect(calls).toHaveLength(1);
    expect(omni.busy).toBe(true);
    calls[0]?.resolve();
    await settle();
    // The answer to "f" is stale: dropped, and only "ferm" goes out ("fe" and "fer" never do).
    expect(omni.getSnapshot().status).toBe("loading");
    expect(omni.getSnapshot().items).toEqual([]);
    expect(calls.map((call) => call.input.query)).toEqual(["f", "ferm"]);
    calls[1]?.resolve();
    await settle();
    expect(omni.getSnapshot()).toMatchObject({ status: "ready" });
    expect(omni.getSnapshot().answered?.query).toBe("ferm");
  });

  it("keeps the last answer on screen while the next query is on its way", async () => {
    const { calls, search } = reader();
    const omni = new OmniController({ search });
    omni.request(ask("fe"));
    calls[0]?.resolve();
    await settle();
    omni.request(ask("fer"));
    expect(omni.getSnapshot()).toMatchObject({ status: "loading" });
    expect(omni.getSnapshot().items).toHaveLength(1);
    expect(omni.getSnapshot().answered?.query).toBe("fe");
  });

  it("asks nothing again for an equal ask, and trims the text", () => {
    const { calls, search } = reader();
    const omni = new OmniController({ search });
    omni.request(ask(" fer "));
    omni.request(ask("fer"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.query).toBe("fer");
    expect(omniKey(ask("a", { kinds: ["note", "topic"] }))).toBe(
      omniKey(ask("a", { kinds: ["topic", "note"] }))
    );
  });

  it("drops the answer of a box that was emptied meanwhile", async () => {
    const { calls, search } = reader();
    const omni = new OmniController({ search });
    omni.request(ask("fer"));
    omni.request(null);
    expect(omni.getSnapshot().status).toBe("idle");
    calls[0]?.resolve();
    await settle();
    expect(omni.getSnapshot().status).toBe("idle");
    expect(calls).toHaveLength(1);
  });

  it("treats an answer to another request as a failure, never asking again by itself", async () => {
    const calls: SearchOmniInput[] = [];
    const omni = new OmniController({
      search: (input) => {
        calls.push(input);
        return Promise.resolve({ requestId: "other", items: [], degraded: [], tookMs: 1 });
      }
    });
    omni.request(ask("fer"));
    await settle();
    expect(omni.getSnapshot().status).toBe("error");
    expect(calls).toHaveLength(1);
  });

  it("reports a failure, and asks again on retry", async () => {
    const { calls, search } = reader();
    const omni = new OmniController({ search });
    omni.request(ask("fer"));
    calls[0]?.reject();
    await settle();
    expect(omni.getSnapshot().status).toBe("error");
    omni.retry();
    expect(omni.getSnapshot().status).toBe("loading");
    expect(calls).toHaveLength(2);
    calls[1]?.resolve();
    await settle();
    expect(omni.getSnapshot().status).toBe("ready");
  });

  it("sends the kinds, the scope and the limit, and the sequence number of the latest key", async () => {
    const { calls, search } = reader();
    const sent: Array<[number, string]> = [];
    const omni = new OmniController({
      search,
      seq: latestKeySeq,
      onSend: (seq, id) => sent.push([seq, id])
    });
    markKey(1, "f");
    markKey(2, "fe");
    omni.request(ask("fe", { kinds: ["topic"], topicId: "t", limit: 30 }));
    expect(calls[0]?.input).toMatchObject({
      query: "fe",
      kinds: ["topic"],
      scope: { topicId: "t" },
      limit: 30
    });
    expect(sent).toEqual([[2, calls[0]?.input.requestId]]);
    calls[0]?.resolve();
    await settle();
    expect(omni.getSnapshot().seq).toBe(2);
  });

  it("notifies subscribers of every change", async () => {
    const { calls, search } = reader();
    const omni = new OmniController({ search });
    const listener = vi.fn();
    const off = omni.subscribe(listener);
    omni.request(ask("fer"));
    calls[0]?.resolve();
    await settle();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    omni.request(ask("ferm"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
