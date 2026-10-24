import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { diffToneTokens } from "../../apps/desktop/src/renderer/components/topic-shape/diff-tones.ts";
import { contrastRatio, parseHexColour, parseTokenSets, type Rgb } from "./contrast.ts";

/**
 * The blocks of the structural diff are drawn on the state tints (`--state-*-soft`) and the soft
 * surface, with the glyph in the tone's ink, the name in the text colours, a 2 px selection ring in
 * the accent, a dashed outline in the strong border and a focus outline in the primary text colour.
 * `npm run contrast` checks the token pairs on the surfaces and on the state tints; these are the
 * exact pairs the diff draws (and the ones the tints add: the ring, the outline and the dashed
 * border on a tint), checked in both themes: text and glyph 4.5:1, ring, outline and border 3:1.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tokensCss = readFileSync(resolve(root, "apps/desktop/src/renderer/tokens.css"), "utf8");
const sets = parseTokenSets(tokensCss);

const theme = (name: "light" | "dark"): ((token: string) => Rgb) => {
  const values = new Map([...sets.light, ...(name === "dark" ? sets.dark : [])]);
  return (token) => {
    const rgb = parseHexColour(values.get(token) ?? "");
    if (!rgb) throw new Error(`${token} is not an opaque colour in the ${name} theme`);
    return rgb;
  };
};

describe("Icicle diff block contrast", () => {
  it("draws every tone with tokens the stylesheet defines", () => {
    for (const name of ["light", "dark"] as const) {
      const get = theme(name);
      for (const [tone, tokens] of Object.entries(diffToneTokens)) {
        expect(() => get(tokens.fill), `${tone} fill`).not.toThrow();
        expect(() => get(tokens.ink), `${tone} ink`).not.toThrow();
      }
    }
  });

  for (const name of ["light", "dark"] as const) {
    it(`keeps text, glyphs, the ring, the outline and the border readable on every tint in the ${name} theme`, () => {
      const get = theme(name);
      const failures: string[] = [];
      for (const [tone, tokens] of Object.entries(diffToneTokens)) {
        const fill = get(tokens.fill);
        const check = (token: string, minimum: number, what: string) => {
          const ratio = contrastRatio(get(token), fill);
          if (ratio < minimum)
            failures.push(`${what} ${token} on the ${tone} tint: ${ratio.toFixed(2)} < ${minimum}`);
        };
        for (const text of ["--text-primary", "--text-secondary", "--text-tertiary"])
          check(text, 4.5, "text");
        check(tokens.ink, 4.5, "glyph");
        for (const mark of ["--accent", "--text-primary", "--border-strong"])
          check(mark, 3, "mark");
      }
      expect(failures).toEqual([]);
    });
  }
});
