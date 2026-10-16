import { describe, expect, it } from "vitest";
import { WikiQuerySchema, WikiResultsSchema } from "./wiki.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("source scope search contracts", () => {
  it("defaults to a bounded search of sources", () => {
    expect(WikiQuerySchema.parse({})).toEqual({
      text: "",
      sourceIds: [],
      includeDescendants: true,
      kind: "source",
      limit: 30,
      offset: 0
    });
    expect(WikiQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
    expect(WikiQuerySchema.safeParse({ sourceIds: ["not-an-id"] }).success).toBe(false);
  });
  it("searches sources only and takes no page, review or version filters", () => {
    for (const input of [
      { kind: "page" },
      { kind: "atomic_note" },
      { pageId: id },
      { reviewedOnly: true },
      { currentOnly: false }
    ])
      expect(WikiQuerySchema.safeParse(input).success).toBe(false);
  });
  it("accepts only source results", () => {
    const item = {
      id,
      kind: "source",
      title: "A source",
      excerpt: "",
      sourceItemId: id,
      sourceType: "Book",
      catalogOnly: false,
      breadcrumb: "A source",
      exact: true
    };
    expect(WikiResultsSchema.parse({ items: [item], hasMore: false }).items).toHaveLength(1);
    expect(
      WikiResultsSchema.safeParse({ items: [{ ...item, kind: "page" }], hasMore: false }).success
    ).toBe(false);
  });
});
