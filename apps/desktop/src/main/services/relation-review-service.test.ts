import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { PgPool } from "@app/db";

import { ipcChannels } from "../../shared/ipc.js";
import { registerRelationReviewIpc } from "./relation-review-ipc.js";
import { RelationReviewService } from "./relation-review-service.js";

// The writer runs against a real database in `relation-review.sidecar.test.ts`; these tests pin the
// boundary: what is validated, what is announced and what reaches the renderer.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pool = {} as PgPool;
const kept = {
  result: { relationId: id(1), outcome: "kept" as const, changed: true },
  noteIds: [id(2), id(3)]
};

describe("RelationReviewService", () => {
  it("writes the verdict, announces the notes whose pages changed and answers it", async () => {
    const review = vi.fn(async () => kept);
    const relationsChanged = vi.fn();
    const service = new RelationReviewService({ getPool: () => pool, relationsChanged, review });
    expect(await service.review({ relationId: id(1), verdict: "keep" })).toEqual(kept.result);
    expect(review).toHaveBeenCalledWith(pool, { relationId: id(1), verdict: "keep" });
    expect(relationsChanged).toHaveBeenCalledWith([id(2), id(3)]);
  });

  it("announces nothing for a verdict that was already final, and null for a relation that is gone", async () => {
    const relationsChanged = vi.fn();
    const answers = [
      { result: { relationId: id(1), outcome: "removed" as const, changed: false }, noteIds: [] },
      null
    ];
    const review = vi.fn(async () => answers.shift() ?? null);
    const service = new RelationReviewService({ getPool: () => pool, relationsChanged, review });
    expect(await service.review({ relationId: id(1), verdict: "keep" })).toMatchObject({
      outcome: "removed",
      changed: false
    });
    expect(await service.review({ relationId: id(1), verdict: "keep" })).toBeNull();
    expect(relationsChanged).not.toHaveBeenCalled();
  });

  it("refuses a request that breaks the contract, an answer that does, and a missing database", async () => {
    const review = vi.fn(async () => kept);
    const service = new RelationReviewService({ getPool: () => pool, review });
    for (const input of [
      undefined,
      {},
      { relationId: "nope", verdict: "keep" },
      { relationId: id(1), verdict: "approve" },
      { relationId: id(1), verdict: "keep", extra: true }
    ])
      await expect(service.review(input)).rejects.toThrow();
    expect(review).not.toHaveBeenCalled();
    const broken = new RelationReviewService({
      getPool: () => pool,
      review: async () => ({ ...kept, result: { ...kept.result, outcome: "approved" as never } })
    });
    await expect(broken.review({ relationId: id(1), verdict: "keep" })).rejects.toThrow();
    await expect(
      new RelationReviewService({ getPool: () => null, review }).review({
        relationId: id(1),
        verdict: "keep"
      })
    ).rejects.toThrow("objects.errors.unavailable");
  });
});

describe("relation review IPC registration", () => {
  it("handles the channel and validates the payload before the service", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const service = { review: vi.fn(async () => kept.result) };
    registerRelationReviewIpc(ipc as unknown as IpcMain, service as never);
    expect(ipcChannels.relationsReview).toBe("app:relations:review");
    const handler = handlers.get(ipcChannels.relationsReview)!;
    expect(() => handler({}, { relationId: "nope", verdict: "keep" })).toThrow();
    expect(() => handler({}, { relationId: id(1), verdict: "maybe" })).toThrow();
    expect(service.review).not.toHaveBeenCalled();
    await handler({}, { relationId: id(1), verdict: "remove" });
    expect(service.review).toHaveBeenCalledWith({ relationId: id(1), verdict: "remove" });
  });
});
