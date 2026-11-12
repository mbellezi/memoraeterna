import { describe, expect, it } from "vitest";

import { markPieces, markRanges, queryTerms } from "./highlight";

describe("marking a query in a text", () => {
  it("ignores case and accents and keeps the original letters", () => {
    const pieces = markPieces("Fermentação lática", queryTerms("fermentacao"));
    expect(pieces).toEqual([
      { text: "Fermentação", marked: true },
      { text: " lática", marked: false }
    ]);
    expect(pieces.map((piece) => piece.text).join("")).toBe("Fermentação lática");
  });

  it("marks a prefix wherever it occurs and merges touching ranges", () => {
    expect(markRanges("Alcoholic fermentation", queryTerms("ferment"))).toEqual([[10, 17]]);
    expect(markRanges("abcabc", ["abc"])).toEqual([[0, 6]]);
  });

  it("marks a one- or two-letter word only where a word begins", () => {
    expect(markRanges("estudo do pH", queryTerms("do"))).toEqual([[7, 9]]);
    expect(markRanges("Pasteur", queryTerms("s"))).toEqual([]);
  });

  it("marks each word of the query", () => {
    const text = "O ácido lático inibe patógenos";
    const marked = markPieces(text, queryTerms("lático ácido"))
      .filter((piece) => piece.marked)
      .map((piece) => piece.text);
    expect(marked).toEqual(["ácido", "lático"]);
  });

  it("returns the whole text unmarked for no terms or an empty text", () => {
    expect(markPieces("abc", [])).toEqual([{ text: "abc", marked: false }]);
    expect(markRanges("", ["a"])).toEqual([]);
  });
});
