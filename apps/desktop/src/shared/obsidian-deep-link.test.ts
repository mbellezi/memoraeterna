import { it, expect } from "vitest";
import { formatObjectAddress } from "@app/domain";
import { parseObsidianDeepLink } from "./obsidian-deep-link.js";
const id = "b14cde4a-ce8d-41b8-804f-6412779354f2";
it("accepts only typed read-only routes and exact historical evidence identifiers", () => {
  expect(parseObsidianDeepLink(`memora://open/wiki/${id}?revision=${id}&evidence=${id}`)).toEqual({
    kind: "wiki",
    id,
    revision: id,
    evidence: id
  });
  for (const raw of [
    `https://open/wiki/${id}`,
    `memora://open/settings/${id}`,
    `memora://open/wiki/${id}?delete=true`,
    `memora://open/wiki/${id}?revision=${id}&revision=${id}`,
    `memora://user@open/wiki/${id}`,
    `memora://open/wiki/${id}/extra`
  ])
    expect(parseObsidianDeepLink(raw)).toBeNull();
});

it("reads the topic address a topic map carries, exactly as the projection writes it", () => {
  const address = formatObjectAddress({ kind: "topic", id });
  expect(address).toBe(`memora://topic/${id}`);
  expect(parseObsidianDeepLink(address)).toEqual({ kind: "topic", id });
  // The address is case-insensitive in its ID; the link carries the canonical lowercase one.
  expect(parseObsidianDeepLink(`memora://topic/${id.toUpperCase()}`)).toEqual({
    kind: "topic",
    id
  });
});

it("rejects a topic link that is not exactly one topic ID", () => {
  for (const raw of [
    "memora://topic",
    "memora://topic/",
    "memora://topic/not-a-uuid",
    `memora://topic/${id}/`,
    `memora://topic/${id}/extra`,
    `memora://topic/${id}?revision=${id}`,
    `memora://topic/${id}#span=${id}`,
    `memora://topic:80/${id}`,
    `memora://user@topic/${id}`,
    `memora://topics/${id}`,
    `https://topic/${id}`,
    // The `open` route keeps to wiki pages and sources; a topic has one spelling.
    `memora://open/topic/${id}`
  ])
    expect(parseObsidianDeepLink(raw), raw).toBeNull();
});
