import { describe, expect, it } from "vitest";

import {
  CreatorSchema,
  SourceDescriptorSchema,
  isbn10To13,
  isValidIsbn10,
  isValidIsbn13,
  mergeDescriptorFields
} from "./source-descriptor.js";

describe("source descriptors", () => {
  it("validates structured creators", () => {
    expect(CreatorSchema.parse({ name: "Ursula K. Le Guin", role: "author" })).toEqual({
      name: "Ursula K. Le Guin",
      role: "author"
    });
    expect(CreatorSchema.safeParse({ name: "", role: "writer" }).success).toBe(false);
  });

  it("validates type-specific descriptors", () => {
    const book = SourceDescriptorSchema.parse({
      type: "Book",
      title: "The Dispossessed",
      language: "en",
      creators: [{ name: "Ursula K. Le Guin", role: "author" }],
      isbn10: "0061054887",
      tags: [],
      subjects: [],
      provenance: { title: { source: "manual" } }
    });
    expect(book.type).toBe("Book");
    expect(SourceDescriptorSchema.safeParse({ ...book, isbn13: "9780000000000" }).success).toBe(false);
    expect(SourceDescriptorSchema.safeParse({ type: "DailyNote", title: "Today", noteDate: "15/07/2026" }).success).toBe(false);
  });

  it("normalizes and validates ISBN-10 and ISBN-13", () => {
    expect(isValidIsbn10("0-306-40615-2")).toBe(true);
    expect(isbn10To13("0-306-40615-2")).toBe("9780306406157");
    expect(isValidIsbn13("978-0-306-40615-7")).toBe(true);
  });

  it("preserves manual fields and requires acceptance before enrichment replaces extraction", () => {
    const current = {
      title: "Extracted title",
      publisher: "Manual publisher",
      provenance: {
        title: { source: "extracted" as const },
        publisher: { source: "manual" as const }
      }
    };
    const incoming = {
      title: "Enriched title",
      publisher: "Enriched publisher",
      provenance: {
        title: { source: "enriched" as const },
        publisher: { source: "enriched" as const }
      }
    };
    expect(mergeDescriptorFields(current, incoming).title).toBe("Extracted title");
    const accepted = mergeDescriptorFields(current, incoming, { acceptEnrichedOverExtracted: true });
    expect(accepted.title).toBe("Enriched title");
    expect(accepted.publisher).toBe("Manual publisher");
    expect(accepted.provenance.publisher?.source).toBe("manual");
  });
});
