import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectResolved, ObjectResolveManyInput } from "@app/domain";

import {
  createPreviewBatcher,
  previewBatchMax,
  previewWindowMs,
  type PreviewBatcherOptions
} from "./preview-batcher";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number) => `memora://note/${uuid(n)}`;

function resolved(address: string): ObjectResolved {
  return {
    address,
    kind: "note",
    title: `Note ${address.slice(-4)}`,
    status: "current",
    preview: "Lactic acid lowers the pH.",
    updatedAt: "2026-11-05T10:00:00.000Z"
  };
}

function setup(missing: readonly string[] = []) {
  const calls: ObjectResolveManyInput[] = [];
  const resolveMany: PreviewBatcherOptions["resolveMany"] = (input) => {
    calls.push(input);
    return Promise.resolve({
      items: Object.fromEntries(
        input.addresses.filter((a) => !missing.includes(a)).map((a) => [a, resolved(a)])
      ),
      missing: input.addresses.filter((a) => missing.includes(a))
    });
  };
  return { calls, batcher: createPreviewBatcher({ resolveMany }) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the preview batcher", () => {
  it("sends one call for everything asked inside the 16 ms window, with the path", async () => {
    const { calls, batcher } = setup();
    expect(previewWindowMs).toBe(16);
    const first = batcher.request(note(1));
    vi.advanceTimersByTime(10);
    const second = batcher.request(note(2));
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(6);
    expect(calls).toEqual([{ addresses: [note(1), note(2)], include: { path: true } }]);
    await expect(first).resolves.toMatchObject({ status: "ready", item: { address: note(1) } });
    await expect(second).resolves.toMatchObject({ status: "ready", item: { address: note(2) } });
  });

  it("opens a new window for what comes after the call", async () => {
    const { calls, batcher } = setup();
    void batcher.request(note(1));
    vi.advanceTimersByTime(16);
    void batcher.request(note(2));
    vi.advanceTimersByTime(16);
    expect(calls.map((call) => call.addresses)).toEqual([[note(1)], [note(2)]]);
  });

  it("asks an address once, in the window and while its call is in flight", async () => {
    const { calls, batcher } = setup();
    const a = batcher.request(note(1));
    const b = batcher.request(note(1));
    vi.advanceTimersByTime(16);
    const c = batcher.request(note(1));
    expect(c).toBe(a);
    expect(await Promise.all([a, b, c])).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.addresses).toEqual([note(1)]);
  });

  it("keeps an anchored address apart from the plain one", async () => {
    const { calls, batcher } = setup();
    const anchored = `${note(1)}#passage=${uuid(9)}`;
    void batcher.request(note(1));
    void batcher.request(anchored);
    vi.advanceTimersByTime(16);
    expect(calls[0]?.addresses).toEqual([note(1), anchored]);
  });

  it("splits a window of more than 200 addresses into calls of at most 200", async () => {
    const { calls, batcher } = setup();
    expect(previewBatchMax).toBe(200);
    const asked = Array.from({ length: 450 }, (_, index) => batcher.request(note(index + 1)));
    vi.advanceTimersByTime(16);
    await Promise.all(asked);
    expect(calls.map((call) => call.addresses.length)).toEqual([200, 200, 50]);
    expect(new Set(calls.flatMap((call) => call.addresses)).size).toBe(450);
  });

  it("answers an address with no object as missing, and never sends an invalid one", async () => {
    const { calls, batcher } = setup([note(2)]);
    const present = batcher.request(note(1));
    const absent = batcher.request(note(2));
    const invalid = batcher.request("memora://note/not-a-uuid");
    vi.advanceTimersByTime(16);
    expect((await present).status).toBe("ready");
    expect(await absent).toEqual({ status: "missing" });
    expect(await invalid).toEqual({ status: "missing" });
    expect(calls[0]?.addresses).toEqual([note(1), note(2)]);
  });

  it("rejects every asker of a failed call, and asks again afterwards", async () => {
    let fail = true;
    const batcher = createPreviewBatcher({
      resolveMany: (input) =>
        fail
          ? Promise.reject(new Error("down"))
          : Promise.resolve({
              items: { [input.addresses[0] as string]: resolved(input.addresses[0] as string) },
              missing: []
            })
    });
    const first = batcher.request(note(1));
    const second = batcher.request(note(2));
    const settled = Promise.allSettled([first, second]);
    vi.advanceTimersByTime(16);
    expect((await settled).map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
    fail = false;
    const again = batcher.request(note(1));
    vi.advanceTimersByTime(16);
    expect((await again).status).toBe("ready");
  });
});
