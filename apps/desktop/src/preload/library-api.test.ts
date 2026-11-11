import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { libraryChannels } from "../shared/ipc-library.js";
import { createLibraryApi } from "./library-api.js";

const row = {
  id: randomUUID(),
  title: "A source",
  type: "Book",
  authors: [],
  addedAt: "2026-01-01T10:00:00.000000Z",
  updatedAt: "2026-01-01T10:00:00.000000Z",
  status: "storedOnly",
  reason: null,
  noteCount: 0,
  place: null,
  hasCover: false
};

describe("window.app.library", () => {
  it("sends a validated request on its channel and returns a validated answer", async () => {
    const answer = { rows: [row], total: 1 };
    const invoke = vi.fn(async () => answer);
    const api = createLibraryApi(invoke);
    await expect(api.rows({ sort: "added", dir: "desc", limit: 50 })).resolves.toEqual(answer);
    expect(invoke).toHaveBeenCalledWith(libraryChannels.rows, {
      sort: "added",
      dir: "desc",
      limit: 50
    });
    const progressInvoke = vi.fn(async () => null);
    const sourceId = randomUUID();
    await expect(createLibraryApi(progressInvoke).sourceProgress({ sourceId })).resolves.toBeNull();
    expect(progressInvoke).toHaveBeenCalledWith(libraryChannels.sourceProgress, { sourceId });
  });

  it("refuses a request that does not match before it leaves", async () => {
    const invoke = vi.fn(async () => null);
    const api = createLibraryApi(invoke);
    await expect(api.rows({ limit: 0 })).rejects.toThrow();
    await expect(api.rows({ filter: { status: "done" } } as never)).rejects.toThrow();
    await expect(api.sourceProgress({ sourceId: "nope" })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an answer that does not match what the area promises", async () => {
    await expect(
      createLibraryApi(async () => ({ rows: [{ ...row, status: "unknown" }], total: 1 })).rows({})
    ).rejects.toThrow();
    await expect(
      createLibraryApi(async () => ({ steps: {} })).sourceProgress({ sourceId: randomUUID() })
    ).rejects.toThrow();
  });
});
