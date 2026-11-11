import { describe, expect, it, vi } from "vitest";

import { searchIpcChannels } from "../shared/ipc-search.js";
import { createSearchApi } from "./search-api.js";

const answer = {
  requestId: "r-1",
  items: [
    {
      address: "memora://topic/00000000-0000-4000-8000-000000000001",
      kind: "topic",
      title: "Fermentação",
      arms: [{ arm: "title_trgm", rank: 1 }],
      score: 1 / 61
    }
  ],
  degraded: [],
  tookMs: 3
};

describe("window.app.search.omni", () => {
  it("sends a validated request on its channel, with the default limit, and returns the answer", async () => {
    const invoke = vi.fn(async () => answer);
    const api = createSearchApi({ invoke });
    await expect(api.omni({ query: " ferm ", mode: "quick", requestId: "r-1" })).resolves.toEqual(
      answer
    );
    expect(invoke).toHaveBeenCalledWith(searchIpcChannels.searchOmni, {
      query: "ferm",
      mode: "quick",
      limit: 20,
      requestId: "r-1"
    });
  });

  it("refuses a request that does not match before it leaves", async () => {
    const invoke = vi.fn(async () => answer);
    const api = createSearchApi({ invoke });
    await expect(api.omni({ query: "", mode: "quick", requestId: "r" })).rejects.toThrow();
    await expect(
      api.omni({ query: "a", mode: "quick", requestId: "r", kinds: ["relation"] } as never)
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an answer that does not match what the area promises", async () => {
    const api = (value: unknown) => createSearchApi({ invoke: async () => value });
    const request = { query: "a", mode: "quick", requestId: "r" } as const;
    await expect(api({ ...answer, degraded: ["graph"] }).omni(request)).rejects.toThrow();
    await expect(
      api({ ...answer, items: [{ ...answer.items[0], address: "/tmp/x" }] }).omni(request)
    ).rejects.toThrow();
    await expect(
      api({ ...answer, items: [{ ...answer.items[0], arms: [] }] }).omni(request)
    ).rejects.toThrow();
  });
});
