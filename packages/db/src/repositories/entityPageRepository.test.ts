import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createEntityPageRepository,
  decodeMentionCursor,
  encodeMentionCursor,
  InvalidEntityPageCursorError
} from "./entityPageRepository.js";
import type { Queryable } from "./types.js";

describe("the mentions cursor", () => {
  const key = {
    unplaced: false,
    negativeTopicNotes: -12,
    topicTitle: "Sleep ñ “quoted”",
    topicId: randomUUID(),
    noteTitle: "A note",
    noteId: randomUUID()
  };

  it("round-trips the whole sort key, text included", () => {
    expect(decodeMentionCursor(encodeMentionCursor(key))).toEqual(key);
  });

  it("refuses what the repository did not write", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of [
      "",
      "%%%",
      encode({}),
      encode([1, 2]),
      encode([false, -1.5, "t", key.topicId, "n", key.noteId]),
      encode([false, -1, "t", "not-a-uuid", "n", key.noteId]),
      encode(["no", -1, "t", key.topicId, "n", key.noteId])
    ])
      expect(decodeMentionCursor(cursor), cursor).toBeNull();
  });
});

describe("createEntityPageRepository", () => {
  const fake = () => {
    const query = vi.fn(async () => ({ rows: [] }));
    return { query, repository: createEntityPageRepository({ query } as unknown as Queryable) };
  };

  it("answers null for an entity that does not exist, after one read", async () => {
    const { query, repository } = fake();
    expect(await repository.page({ id: randomUUID() })).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad cursor before it reads anything", async () => {
    const { query, repository } = fake();
    await expect(repository.page({ id: randomUUID(), cursor: "nope" })).rejects.toBeInstanceOf(
      InvalidEntityPageCursorError
    );
    expect(query).not.toHaveBeenCalled();
  });
});
