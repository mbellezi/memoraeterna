import { describe, expect, it, vi } from "vitest";

import type { PgPool } from "../client.js";
import { createQuestionRepository, questionCursorMessage } from "./questionRepository.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const id = "0194c8a1-2b3c-7d4e-8f50-123456789abc";

/** A pool that records the query: a refused cursor must never reach it. */
function recordingPool() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return { pool: { query } as unknown as PgPool, query };
}

describe("questions.list cursor", () => {
  it.each([
    ["a date PostgreSQL cannot read", encode(["March 7", id])],
    ["36 dashes for the id", encode(["2026-03-07 10:20:30.123456+00", "-".repeat(36)])],
    ["an id that is not 8-4-4-4-12 hex", encode(["2026-03-07 10:20:30+00", "0".repeat(36)])],
    ["a month that does not exist", encode(["2026-13-07 10:20:30+00", id])],
    ["February 30", encode(["2026-02-30 10:20:30+00", id])],
    ["a timestamp without a zone", encode(["2026-03-07 10:20:30", id])],
    ["a number instead of the timestamp", encode([20260307, id])]
  ])("refuses %s with the cursor message key", async (_name, cursor) => {
    const { pool, query } = recordingPool();
    await expect(createQuestionRepository(pool).list({ cursor })).rejects.toThrow(
      questionCursorMessage
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts what the encoder writes: created_at::text and a UUID", async () => {
    for (const createdAt of [
      "2026-03-07 10:20:30.123456+00",
      "2026-03-07 10:20:30+01:30",
      "2026-03-07 10:20:30.5-03"
    ]) {
      const { pool, query } = recordingPool();
      await createQuestionRepository(pool).list({ cursor: encode([createdAt, id]) });
      expect(query).toHaveBeenCalledTimes(1);
    }
  });
});
