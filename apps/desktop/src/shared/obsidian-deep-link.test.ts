import { describe, expect, it } from "vitest";
import { formatObjectAddress, type ObjectKind } from "@app/domain";

import { deepLinkSchema, parseDeepLink, readDeepLink } from "./obsidian-deep-link.js";

const id = "b14cde4a-ce8d-41b8-804f-6412779354f2";
const relation = "0d7f2c1e-5a43-4c58-9a0b-3a6f0a6a1b11";
const chunk = "5a2b6c1d-7e8f-4a90-8b12-c3d4e5f60718";
const span = "9c8b7a65-4d3e-4f21-a0b9-8c7d6e5f4a3b";

describe("a deep link, on each form the vault and the app write", () => {
  it.each(["source", "note", "topic", "question", "entity"] as const)(
    "opens the canonical %s address",
    (kind: ObjectKind) => {
      const address = formatObjectAddress({ kind, id });
      expect(parseDeepLink(address)).toEqual({ kind: "object", address });
      // The ID is case-insensitive; the link carries the canonical lowercase one.
      expect(parseDeepLink(`memora://${kind}/${id.toUpperCase()}`)).toEqual({
        kind: "object",
        address
      });
    }
  );

  it("keeps the anchors of a canonical address, in canonical order", () => {
    expect(parseDeepLink(`memora://source/${id}#span=${span}&passage=${chunk}`)).toEqual({
      kind: "object",
      address: `memora://source/${id}#passage=${chunk}&span=${span}`
    });
    expect(parseDeepLink(`memora://note/${id}#relation=${relation}`)).toEqual({
      kind: "object",
      address: `memora://note/${id}#relation=${relation}`
    });
  });

  it("reads the legacy source link the projections wrote", () => {
    expect(parseDeepLink(`memora://open/source/${id}`)).toEqual({
      kind: "object",
      address: `memora://source/${id}`
    });
  });

  it("reads the legacy source link with a relation as the relation anchor", () => {
    expect(parseDeepLink(`memora://open/source/${id}?relation=${relation}`)).toEqual({
      kind: "object",
      address: `memora://source/${id}#relation=${relation}`
    });
  });

  it("reads a legacy wiki link, with or without its fields, as the retired page", () => {
    const retired = { kind: "retired-wiki", id };
    expect(parseDeepLink(`memora://open/wiki/${id}`)).toEqual(retired);
    expect(parseDeepLink(`memora://open/wiki/${id}?revision=${chunk}&evidence=${span}`)).toEqual(
      retired
    );
  });

  it("gives the renderer only shapes its schema accepts", () => {
    for (const raw of [
      `memora://topic/${id}`,
      `memora://open/source/${id}?relation=${relation}`,
      `memora://open/wiki/${id}`
    ])
      expect(deepLinkSchema.safeParse(parseDeepLink(raw)).success, raw).toBe(true);
  });
});

describe("a link that is not an object", () => {
  it.each([
    [`https://open/source/${id}`, "scheme"],
    [`memora://open/settings/${id}`, "kind"],
    [`memora://settings`, "kind"],
    [`memora://library`, "kind"],
    [`memora://search?q=x`, "kind"],
    [`memora://user@open/source/${id}`, "kind"],
    [`memora://topics/${id}`, "kind"],
    [`memora://open/topic/${id}`, "kind"],
    ["memora://topic", "id"],
    ["memora://topic/", "id"],
    ["memora://topic/not-a-uuid", "id"],
    [`memora://topic/${id}/extra`, "id"],
    [`memora://open/source/${id}/extra`, "id"],
    [`memora://topic/${id}?revision=${id}`, "query"],
    [`memora://open/wiki/${id}?delete=true`, "query"],
    [`memora://open/wiki/${id}?revision=${id}&revision=${id}`, "query"],
    [`memora://open/source/${id}?revision=${id}`, "query"],
    [`memora://topic/${id}#span=not-a-uuid`, "anchor"],
    [`memora://topic/${id}#nothing=${id}`, "anchor"]
  ] as const)("is refused: %s (%s)", (raw, reason) => {
    expect(parseDeepLink(raw)).toBeNull();
    expect(readDeepLink(raw)).toEqual({ ok: false, reason });
  });
});
