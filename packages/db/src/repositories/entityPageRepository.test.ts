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
    topicId: randomUUID(),
    noteId: randomUUID()
  };

  it("round-trips the whole sort key", () => {
    expect(decodeMentionCursor(encodeMentionCursor(key))).toEqual(key);
  });

  it("carries ids and counts only, so its size does not depend on any title", () => {
    expect(encodeMentionCursor(key).length).toBeLessThan(200);
    const text = Buffer.from(encodeMentionCursor(key), "base64url").toString("utf8");
    expect(JSON.parse(text)).toEqual([false, -12, key.topicId, key.noteId]);
  });

  it("refuses what the repository did not write", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of [
      "",
      "%%%",
      encode({}),
      encode([1, 2]),
      encode([false, -1.5, key.topicId, key.noteId]),
      encode([false, -1, "not-a-uuid", key.noteId]),
      encode(["no", -1, key.topicId, key.noteId]),
      // The older cursor with free text in it is refused, not read.
      encode([false, -1, "Sleep", key.topicId, "A note", key.noteId])
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
