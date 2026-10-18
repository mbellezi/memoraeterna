import { describe, expect, it } from "vitest";

import { stances } from "../../lib/relation-stance";
import {
  fallbackGraphPalette,
  graphStanceTokenNames,
  graphTokenNames,
  parseGraphColor,
  readGraphPalette,
  samePalette,
  watchGraphPalette,
  type ThemeChangeSource,
  type TokenStyleReader
} from "./graph-tokens";

/** A computed style that answers from a map, as the browser answers for a custom property. */
const styleOf =
  (values: Record<string, string>): TokenStyleReader =>
  () => ({ getPropertyValue: (name) => values[name] ?? "" });

const element = {} as Element;

describe("the graph token reader", () => {
  it("returns #rrggbb in lower case and refuses every other form", () => {
    expect(parseGraphColor("#A5C862")).toBe("#a5c862");
    expect(parseGraphColor("  #a5c862 ")).toBe("#a5c862");
    for (const refused of [
      "#abc",
      "#a5c862ff",
      "#a5c86",
      "a5c862",
      "rgb(165, 200, 98)",
      "rgba(165, 200, 98, 1)",
      "hsl(80 50% 55%)",
      "oklch(0.8 0.1 120)",
      "green",
      "var(--graph-object-note)",
      "",
      "   ",
      null,
      undefined
    ])
      expect(parseGraphColor(refused), String(refused)).toBeNull();
  });

  it("reads every token the graph draws with, as the element resolves them", () => {
    const palette = readGraphPalette(
      element,
      styleOf({
        [graphTokenNames.note]: "#112233",
        [graphTokenNames.label]: "#ABCDEF",
        [graphStanceTokenNames.supports]: "#010203",
        [graphStanceTokenNames.depends_on]: "#0a0b0c"
      })
    );
    expect(palette.note).toBe("#112233");
    expect(palette.label).toBe("#abcdef");
    expect(palette.stance.supports).toBe("#010203");
    expect(palette.stance.depends_on).toBe("#0a0b0c");
    // Everything it could not read falls back to the value tokens.css declares.
    expect(palette.canvasEdge).toBe(fallbackGraphPalette.canvasEdge);
    expect(palette.stance.related).toBe(fallbackGraphPalette.stance.related);
  });

  it("falls back, for a value that is not #rrggbb, to the declared colour and never uses the odd form", () => {
    const palette = readGraphPalette(
      element,
      styleOf({
        [graphTokenNames.note]: "rgb(1, 2, 3)",
        [graphStanceTokenNames.supports]: "#fff"
      })
    );
    expect(palette.note).toBe(fallbackGraphPalette.note);
    expect(palette.stance.supports).toBe(fallbackGraphPalette.stance.supports);
    for (const value of [
      palette.canvasCenter,
      palette.canvasEdge,
      palette.label,
      palette.labelMuted,
      palette.note,
      ...stances.map((stance) => palette.stance[stance])
    ])
      expect(value).toMatch(/^#[0-9a-f]{6}$/u);
  });

  it("reads the colours again on a theme change and says so only when one changed, without a rebuild", () => {
    let current: Record<string, string> = { [graphTokenNames.note]: "#a5c862" };
    let root: () => void = () => undefined;
    let scheme: () => void = () => undefined;
    const source: ThemeChangeSource = {
      observeRoot: (onChange) => {
        root = onChange;
        return () => {
          root = () => undefined;
        };
      },
      observeScheme: (onChange) => {
        scheme = onChange;
        return () => {
          scheme = () => undefined;
        };
      }
    };
    const seen: string[] = [];
    const stop = watchGraphPalette(element, (palette) => seen.push(palette.note), {
      source,
      read: (target) => styleOf(current)(target)
    });
    root();
    scheme();
    expect(seen).toEqual([]);
    current = { [graphTokenNames.note]: "#336699" };
    root();
    root();
    expect(seen).toEqual(["#336699"]);
    current = { [graphTokenNames.note]: "#112233" };
    scheme();
    expect(seen).toEqual(["#336699", "#112233"]);
    // Stopping twice is safe, and nothing is heard after it.
    stop();
    stop();
    current = { [graphTokenNames.note]: "#445566" };
    root();
    scheme();
    expect(seen).toEqual(["#336699", "#112233"]);
  });

  it("compares palettes by every colour", () => {
    const base = readGraphPalette(element, styleOf({}));
    expect(samePalette(base, readGraphPalette(element, styleOf({})))).toBe(true);
    expect(
      samePalette(
        base,
        readGraphPalette(element, styleOf({ [graphStanceTokenNames.extends]: "#000000" }))
      )
    ).toBe(false);
  });
});
