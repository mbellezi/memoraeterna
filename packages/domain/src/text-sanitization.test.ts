import { describe, expect, it } from "vitest";

import {
  findControlCharacterIndexes,
  sanitizeExtractedValue,
  sanitizeStoredValue,
  stripControlCharacters,
  stripNulCharacters
} from "./text-sanitization.js";

describe("text sanitization", () => {
  it("strips NUL and C0 controls but keeps tab, line feed and carriage return", () => {
    expect(stripControlCharacters("Q ( t ) \0 a\u0001b\u001f\tc\nd\re")).toBe(
      "Q ( t )  ab\tc\nd\re"
    );
    expect(findControlCharacterIndexes("a\0b\u0007c\td")).toEqual([1, 3]);
  });

  it("removes only NUL for storage and keeps every other character byte-identical", () => {
    const text = "Café − 😀\u0001\f line\r\n";
    expect(stripNulCharacters(`${text}\0`)).toBe(text);
    expect(stripNulCharacters("\0\0")).toBe("");
  });

  it("returns clean text and structures as the very same reference", () => {
    const clean = "Replication and Analysis of Ebbinghaus’ Forgetting Curve\n";
    expect(stripControlCharacters(clean)).toBe(clean);
    expect(stripNulCharacters(clean)).toBe(clean);
    const value = { title: clean, nested: [{ tags: ["a", "b"], at: new Date(0) }], count: 3 };
    expect(sanitizeStoredValue(value)).toBe(value);
    expect(sanitizeExtractedValue(value)).toBe(value);
  });

  it("sanitizes strings, arrays, object values and object keys deeply without mutating input", () => {
    const value = {
      title: "T\0itle",
      "key\0": ["a\0", { deep: "d\0\0" }, 7, null],
      untouched: { fine: "yes" }
    };
    const cleaned = sanitizeStoredValue(value);
    expect(cleaned).toEqual({
      title: "Title",
      key: ["a", { deep: "d" }, 7, null],
      untouched: { fine: "yes" }
    });
    expect(cleaned.untouched).toBe(value.untouched);
    expect(value.title).toBe("T\0itle");
    expect(JSON.stringify(cleaned)).not.toContain("\\u0000");
  });

  it("leaves dates, byte arrays and class instances untouched", () => {
    class Custom {
      public text = "a\0b";
    }
    const bytes = new Uint8Array([0, 1, 2]);
    const when = new Date("2026-01-01T00:00:00.000Z");
    const custom = new Custom();
    const cleaned = sanitizeStoredValue({ bytes, when, custom });
    expect(cleaned.bytes).toBe(bytes);
    expect(cleaned.when).toBe(when);
    expect(cleaned.custom).toBe(custom);
  });

  it("only the extraction guard removes the other C0 controls", () => {
    const value = { text: "a\u0001b\0c" };
    expect(sanitizeStoredValue(value)).toEqual({ text: "a\u0001bc" });
    expect(sanitizeExtractedValue(value)).toEqual({ text: "abc" });
  });
});
