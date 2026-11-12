import { describe, expect, it } from "vitest";

import { ellipsis, fitLabel, fitLines, type Measure } from "./label-fit";

/** One px per character: the rules do not depend on the font, only on the widths. */
const chars: Measure = (text) => [...text].length;

const titles = [
  "Microbiologia dos alimentos, cap. 3",
  "Temperatura controla a acidez final",
  "Bactérias láticas toleram meio ácido",
  "Fermentação lática alcoólica",
  "O ácido lático inibe patógenos ao baixar o pH",
  "Conservação por barreiras múltiplas",
  "Imunologia",
  "Teoria musical e harmonia funcional no século XIX"
];

describe("fitting a label into a width", () => {
  it("keeps a label that fits, and one in a row that is not laid out yet", () => {
    expect(fitLabel("Imunologia", chars, 10)).toEqual({ text: "Imunologia", cut: false });
    expect(fitLabel(titles[1]!, chars, 0)).toEqual({ text: titles[1], cut: false });
    expect(fitLabel("  two   words ", chars, 40)).toEqual({ text: "two words", cut: false });
  });

  it("keeps whole head words, an ellipsis and whole tail words", () => {
    expect(fitLabel("Temperatura controla a acidez final", chars, 17).text).toBe(
      `Temperatura${ellipsis}final`
    );
    expect(fitLabel("Bactérias láticas toleram meio ácido", chars, 17).text).toBe(
      `Bactérias${ellipsis}ácido`
    );
  });

  it("takes the word before a tail word too short to tell labels apart", () => {
    expect(fitLabel("Microbiologia dos alimentos, cap. 3", chars, 20).text).toBe(
      `Microbiologia${ellipsis}cap. 3`
    );
  });

  it("gives a leading ellipsis to the tail words when no head word fits", () => {
    expect(fitLabel("Fermentação lática alcoólica", chars, 12).text).toBe(`${ellipsis}alcoólica`);
  });

  it("keeps the start, whole words and an ellipsis, when the tail would be a lone thin word", () => {
    const title = "History of science and of the scientific method from the Renaissance on";
    // The two tail words fit with a leading ellipsis; the thin "on" is never left alone.
    expect(fitLabel(title, chars, 15).text).toBe(`${ellipsis}Renaissance on`);
    expect(fitLabel(title, chars, 10).text).toBe(`History${ellipsis}`);
    expect(fitLabel(title, chars, 22).text).toBe(`History${ellipsis}Renaissance on`);
  });

  it("leaves the end to the caller's tail ellipsis only when not even a whole word fits", () => {
    expect(fitLabel("Fermentação lática alcoólica", chars, 5)).toEqual({
      text: "Fermentação lática alcoólica",
      cut: true
    });
    expect(fitLabel("Anticonstitucionalissimamente", chars, 8)).toEqual({
      text: "Anticonstitucionalissimamente",
      cut: true
    });
  });

  it("never cuts inside a word while a whole-word form fits", () => {
    for (const title of titles)
      for (let width = 1; width <= 60; width += 1) {
        const { text, cut } = fitLabel(title, chars, width);
        if (!cut) {
          expect(text, `${title} @${width}`).toBe(title);
          continue;
        }
        const original = new Set(title.split(/\s+/u));
        const shown = text
          .split(ellipsis)
          .flatMap((part) => part.split(/\s+/u))
          .filter(Boolean);
        const shortest = `${title.split(/\s+/u)[0]}${ellipsis}`;
        // A cut label is made of whole words of the title, unless even its last word does not fit.
        if (width >= chars(shortest))
          for (const word of shown)
            expect(original.has(word), `${title} @${width}: ${word}`).toBe(true);
        expect(chars(text) <= width || width < chars(shortest), `${title} @${width}`).toBe(true);
      }
  });
});

describe("wrapping a label that must show its name", () => {
  it("fits in the lines it has and says nothing was left out", () => {
    expect(fitLines("O ácido lático inibe patógenos", chars, 16, 2)).toEqual({
      lines: ["O ácido lático", "inibe patógenos"],
      cut: false
    });
  });

  it("ends the last line after its last whole word, with an ellipsis", () => {
    const { lines, cut } = fitLines(
      "O ácido lático inibe patógenos ao baixar o pH do alimento fermentado",
      chars,
      16,
      2
    );
    expect(cut).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`${ellipsis}$`, "u"));
    for (const line of lines) expect(chars(line)).toBeLessThanOrEqual(16);
    const original = new Set(
      "O ácido lático inibe patógenos ao baixar o pH do alimento fermentado".split(" ")
    );
    for (const word of lines.join(" ").replace(ellipsis, "").split(" ").filter(Boolean))
      expect(original.has(word), word).toBe(true);
  });

  it("keeps a word longer than a line whole, on its own line", () => {
    const { lines } = fitLines("Anticonstitucionalissimamente rápido", chars, 10, 2);
    expect(lines[0]).toBe("Anticonstitucionalissimamente");
  });
});
