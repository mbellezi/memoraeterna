import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { changesObjectChannels } from "../shared/ipc-changes-object.js";
import { createChangesObjectApi } from "./changes-object-api.js";

describe("createChangesObjectApi", () => {
  const id = randomUUID();
  const item = {
    kind: "relation",
    id: randomUUID(),
    titleKey: "changes.titles.relation.match",
    titleParams: {},
    risk: "low",
    status: "applied",
    origin: "match",
    subjectId: null,
    jobId: null,
    at: "2026-11-11T10:00:00.000Z",
    undoneAt: null,
    undo: "available"
  };

  it("validates a request before it leaves and an answer before the page sees it", async () => {
    const invoke = vi.fn(async () => ({ items: [item] }));
    const api = createChangesObjectApi(invoke);
    expect(await api.forObject({ kind: "note", id })).toEqual({ items: [item] });
    expect(invoke).toHaveBeenCalledWith(changesObjectChannels.forObject, { kind: "note", id });
    await expect(api.forObject({ kind: "note", id: "nope" })).rejects.toThrow();
    await expect(api.forObject({ kind: "note", id, limit: 21 })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    const bad = createChangesObjectApi(async () => ({ items: [{ ...item, status: "lost" }] }));
    await expect(bad.forObject({ kind: "note", id })).rejects.toThrow();
    const many = createChangesObjectApi(async () => ({ items: Array(21).fill(item) }));
    await expect(many.forObject({ kind: "note", id })).rejects.toThrow();
  });
});
