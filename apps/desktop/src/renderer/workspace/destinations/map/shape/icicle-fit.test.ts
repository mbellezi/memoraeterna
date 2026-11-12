import { describe, expect, it } from "vitest";

import {
  createKeyAssigner,
  fitDiffLabel,
  fitMapLabel,
  keyLetters,
  mapNoLabelBelow,
  type MeasureText
} from "./icicle-fit";

/** Every character is 7 px: a name's width is easy to reason about. */
const measure: MeasureText = (text) => text.length * 7;

describe("the Map chart's labels", () => {
  const name = "Alimentos fermentados";
  const count = "6 notas";

  it("has no label under 14 px, whatever the room", () => {
    expect(fitMapLabel({ widthPx: 400, heightPx: mapNoLabelBelow - 1, name, count, measure })).toBe(
      "none"
    );
    expect(fitMapLabel({ widthPx: 400, heightPx: mapNoLabelBelow, name, count, measure })).toBe(
      "nameCount"
    );
  });

  it("says name and count on one line, and only the name when both do not fit", () => {
    // "Alimentos fermentados 6 notas" is 29 characters: 203 px, and 16 px of padding.
    expect(fitMapLabel({ widthPx: 219, heightPx: 20, name, count, measure })).toBe("nameCount");
    expect(fitMapLabel({ widthPx: 218, heightPx: 20, name, count, measure })).toBe("name");
  });

  it("puts the count under the name in a block tall enough for two lines", () => {
    expect(fitMapLabel({ widthPx: 160, heightPx: 40, name, count, measure })).toBe("stacked");
    // A count too wide for the block is never shown cut: the name stands alone.
    expect(fitMapLabel({ widthPx: 40, heightPx: 40, name, count, measure })).toBe("name");
  });

  it("never shows a count alone", () => {
    for (const widthPx of [10, 30, 60, 120, 400])
      for (const heightPx of [10, 14, 20, 34, 80])
        expect(
          fitMapLabel({ widthPx, heightPx, name, count, measure }),
          `${widthPx}x${heightPx}`
        ).not.toBe("count");
  });
});

describe("the Inbox diff's labels", () => {
  const name = "Horários das refeições";
  const count = "+3 notas";

  it("steps from name and count to a letter key to nothing", () => {
    // Name 22 characters = 154 px, plus 16 of padding and 20 of glyph.
    expect(fitDiffLabel({ widthPx: 190, name, count, measure })).toBe("nameCount");
    expect(fitDiffLabel({ widthPx: 189, name, count, measure })).toBe("key");
    expect(fitDiffLabel({ widthPx: 60, name, count, measure })).toBe("key");
    expect(fitDiffLabel({ widthPx: 19, name, count, measure })).toBe("none");
  });

  it("drops the count before the name when only the count is too wide", () => {
    const wide = "+3 notas que saem daqui e vão para outro tópico";
    expect(fitDiffLabel({ widthPx: 190, name, count: wide, measure })).toBe("name");
  });

  it("is never a bare number", () => {
    for (let widthPx = 0; widthPx <= 400; widthPx += 4)
      expect(fitDiffLabel({ widthPx, name, count: "12", measure })).not.toBe("count");
  });
});

describe("the keys of a legend", () => {
  it("gives a, b, c in the order asked and keeps a topic's key", () => {
    const key = createKeyAssigner();
    expect(key("x")).toBe("a");
    expect(key("y")).toBe("b");
    expect(key("x")).toBe("a");
    expect(key("z")).toBe("c");
  });

  it("stops after the 26th letter", () => {
    const key = createKeyAssigner();
    for (let n = 0; n < keyLetters.length; n += 1) expect(key(`t${n}`)).toBe(keyLetters[n]);
    expect(key("one-more")).toBeNull();
    expect(key("t0")).toBe("a");
  });
});
