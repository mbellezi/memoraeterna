import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fillShares } from "../../apps/desktop/src/renderer/components/topic-shape/icicle-layout.ts";
import { contrastRatio, parseHexColour, parseTokenSets, type Rgb } from "./contrast.ts";

/**
 * The blocks of the Shape icicle are drawn on a mix of the topic colour and a surface
 * (`color-mix(in srgb, var(--object-topic) N%, var(--surface-raised))`), which `npm run contrast`
 * cannot see: it checks token pairs on the surfaces. These are the pairs a block adds, checked on
 * every level's mix in both themes: text (title, count, "+n") 4.5:1, glyphs and rings 3:1.
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

/** `color-mix(in srgb, from share, onto)` on the 0-255 channels. */
const mix = (from: Rgb, share: number, onto: Rgb): Rgb => ({
  r: from.r * share + onto.r * (1 - share),
  g: from.g * share + onto.g * (1 - share),
  b: from.b * share + onto.b * (1 - share)
});

describe("Shape block contrast", () => {
  it("covers every tint level the chart draws", () => {
    expect(fillShares.length).toBeGreaterThanOrEqual(3);
    for (const share of fillShares) expect(share).toBeGreaterThan(0);
    expect([...fillShares]).toEqual([...fillShares].sort((a, b) => b - a));
  });

  for (const name of ["light", "dark"] as const) {
    it(`keeps text and glyphs readable on every block fill in the ${name} theme`, () => {
      const get = theme(name);
      const fills: Array<[string, Rgb]> = [
        ["the root block", get("--surface-soft")],
        ...fillShares.map((share): [string, Rgb] => [
          `a ${share}% block`,
          mix(get("--object-topic"), share / 100, get("--surface-raised"))
        ])
      ];
      const failures: string[] = [];
      for (const [fill, background] of fills) {
        for (const text of ["--text-primary", "--text-secondary", "--text-tertiary"]) {
          const ratio = contrastRatio(get(text), background);
          if (ratio < 4.5) failures.push(`${text} on ${fill}: ${ratio.toFixed(2)} < 4.5`);
        }
        for (const mark of ["--state-warning", "--state-danger", "--accent", "--text-primary"]) {
          const ratio = contrastRatio(get(mark), background);
          if (ratio < 3) failures.push(`${mark} on ${fill}: ${ratio.toFixed(2)} < 3`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
