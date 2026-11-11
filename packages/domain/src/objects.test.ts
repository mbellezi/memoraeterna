import { describe, expect, it } from "vitest";

import {
  decodeBacklinkCursor,
  encodeBacklinkCursor,
  ObjectBacklinkSchema,
  ObjectBacklinksInputSchema,
  ObjectGetResultSchema,
  ObjectResolveManyInputSchema,
  ObjectResolveManyResultSchema,
  ObjectSummarySchema,
  objectResolveManyMax,
  plainText
} from "./objects.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const summary = {
  address: `memora://note/${id(1)}`,
  kind: "note",
  title: "A note",
  status: "current",
  preview: "Plain text.",
  updatedAt: "2026-11-11T10:00:00.000Z"
};

describe("plainText", () => {
  it("removes the Markdown a person would not read", () => {
    expect(
      plainText(
        "# Title\n\nShort **bold** and *italic* and _under_ with [a link](https://x.test/a_b) and `code`.\n\n> quoted\n\n1. one\n- two\n\n![alt text](img.png)",
        280
      )
    ).toBe("Title Short bold and italic and under with a link and code. quoted one two alt text");
  });

  it("keeps snake_case words, escaped markers and plain asterisks in arithmetic", () => {
    expect(plainText("use snake_case_names, 2 * 3 and \\*literal\\*", 280)).toBe(
      "use snake_case_names, 2 * 3 and *literal*"
    );
  });

  it("reduces memora links and references to their text, and drops code fences, tables and HTML", () => {
    expect(
      plainText(
        "See [the note](memora://note/00000000-0000-4000-8000-000000000001)[^1] <b>now</b>\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
        280
      )
    ).toBe("See the note now const x = 1; a b 1 2");
  });

  it("drops a marker whose partner was cut off", () => {
    expect(plainText("**Bold start that never closes", 280)).toBe("Bold start that never closes");
  });

  it("cuts to the limit with an ellipsis, by characters and never inside one", () => {
    const text = plainText("é😀 ".repeat(200), 280);
    expect(Array.from(text).length).toBeLessThanOrEqual(280);
    expect(text.endsWith("…")).toBe(true);
    expect(plainText("short", 280)).toBe("short");
    expect(plainText("exactly ten", 11)).toBe("exactly ten");
    expect(plainText("a b c d e f g h i j", 5)).toBe("a b…");
    expect(plainText("", 10)).toBe("");
  });
});

describe("objects schemas", () => {
  it("parses a summary, a missing result and a resolved batch", () => {
    expect(ObjectSummarySchema.parse(summary)).toEqual(summary);
    expect(ObjectGetResultSchema.parse({ status: "missing" })).toEqual({ status: "missing" });
    expect(ObjectGetResultSchema.parse(summary)).toEqual(summary);
    expect(
      ObjectResolveManyResultSchema.parse({
        items: {
          [summary.address]: { ...summary, path: [{ kind: "topic", id: id(2), title: "T" }] }
        },
        missing: []
      }).items[summary.address]?.path
    ).toHaveLength(1);
  });

  it("refuses a preview over 280 characters, an unknown status and an extra field", () => {
    expect(ObjectSummarySchema.safeParse({ ...summary, preview: "x".repeat(281) }).success).toBe(
      false
    );
    expect(ObjectSummarySchema.safeParse({ ...summary, status: "gone" }).success).toBe(false);
    expect(ObjectSummarySchema.safeParse({ ...summary, secret: 1 }).success).toBe(false);
    expect(ObjectGetResultSchema.safeParse({ status: "missing", title: "x" }).success).toBe(false);
  });

  it("limits resolveMany to 200 unique addresses", () => {
    const addresses = Array.from(
      { length: objectResolveManyMax },
      (_, n) => `memora://note/${id(n)}`
    );
    expect(ObjectResolveManyInputSchema.safeParse({ addresses }).success).toBe(true);
    expect(
      ObjectResolveManyInputSchema.safeParse({
        addresses: [...addresses, `memora://note/${id(999)}`]
      }).success
    ).toBe(false);
    expect(
      ObjectResolveManyInputSchema.safeParse({ addresses: [addresses[0], addresses[0]] }).success
    ).toBe(false);
    expect(ObjectResolveManyInputSchema.safeParse({ addresses: ["not an address"] }).success).toBe(
      false
    );
    expect(ObjectResolveManyInputSchema.parse({ addresses: [], include: { path: true } })).toEqual({
      addresses: [],
      include: { path: true }
    });
  });

  it("limits backlinks to 50 per page and defaults to 50", () => {
    const address = `memora://source/${id(1)}`;
    expect(ObjectBacklinksInputSchema.parse({ address }).limit).toBe(50);
    expect(ObjectBacklinksInputSchema.safeParse({ address, limit: 51 }).success).toBe(false);
    expect(ObjectBacklinksInputSchema.safeParse({ address, limit: 0 }).success).toBe(false);
  });

  it("types a backlink: its via, an address-shaped anchor and a snippet of at most 160", () => {
    const base = { from: `memora://note/${id(1)}`, via: "evidence" };
    expect(ObjectBacklinkSchema.safeParse({ ...base, anchor: `passage=${id(2)}` }).success).toBe(
      true
    );
    expect(
      ObjectBacklinkSchema.safeParse({ ...base, anchor: `passage=${id(2)}&span=${id(3)}` }).success
    ).toBe(true);
    expect(ObjectBacklinkSchema.safeParse({ ...base, anchor: "passage=nope" }).success).toBe(false);
    expect(ObjectBacklinkSchema.safeParse({ ...base, snippet: "x".repeat(161) }).success).toBe(
      false
    );
    expect(ObjectBacklinkSchema.safeParse({ ...base, via: "mentions" }).success).toBe(false);
  });
});

describe("backlink cursor", () => {
  const cursor = { arm: 4, createdAt: "2026-11-11T10:00:00.123456Z", id: id(7) };

  it("round trips as URL-safe text", () => {
    const text = encodeBacklinkCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeBacklinkCursor(text)).toEqual(cursor);
  });

  it("is refused when it is not a cursor", () => {
    expect(decodeBacklinkCursor("not-a-cursor")).toBeNull();
    expect(decodeBacklinkCursor("")).toBeNull();
    expect(decodeBacklinkCursor(btoa(JSON.stringify({ ...cursor, arm: 9 })))).toBeNull();
    expect(decodeBacklinkCursor(btoa(JSON.stringify({ ...cursor, id: "x" })))).toBeNull();
    expect(
      decodeBacklinkCursor(btoa(JSON.stringify({ ...cursor, createdAt: "yesterday" })))
    ).toBeNull();
    expect(decodeBacklinkCursor(btoa(JSON.stringify({ ...cursor, extra: 1 })))).toBeNull();
  });
});
