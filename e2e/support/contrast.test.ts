import { describe, expect, it } from "vitest";

import { contrastRatio, type Rgb } from "../../scripts/contrast/contrast.js";
import {
  composite,
  effectiveColours,
  evaluateSamples,
  isClippedAway,
  parseCssColor,
  requiredRatio,
  type ClipBox,
  type ContrastSample,
  type ShapePaint
} from "./contrast.js";

const near = (value: number, expected: number, digits = 0) =>
  expect(value).toBeCloseTo(expected, digits);

describe("parseCssColor", () => {
  it.each([
    ["rgb(12, 34, 56)", { r: 12, g: 34, b: 56, a: 1 }],
    ["rgba(0, 0, 0, 0)", { r: 0, g: 0, b: 0, a: 0 }],
    ["rgb(255 128 0 / 50%)", { r: 255, g: 128, b: 0, a: 0.5 }],
    ["rgb(100% 0% 50%)", { r: 255, g: 0, b: 127.5, a: 1 }],
    ["#abc", { r: 170, g: 187, b: 204, a: 1 }],
    ["#11223380", { r: 17, g: 34, b: 51, a: 128 / 255 }],
    ["transparent", { r: 0, g: 0, b: 0, a: 0 }],
    ["color(srgb 1 0.5 0 / 0.25)", { r: 255, g: 127.5, b: 0, a: 0.25 }]
  ])("reads %s", (text, expected) => {
    const parsed = parseCssColor(text)!;
    for (const key of ["r", "g", "b", "a"] as const) near(parsed[key], expected[key], 3);
  });

  it("converts Oklch and Oklab to sRGB", () => {
    const whiteish = parseCssColor("oklch(1 0 0)")!;
    near(whiteish.r, 255);
    near(whiteish.g, 255);
    near(whiteish.b, 255);
    const black = parseCssColor("oklab(0 0 0)")!;
    expect([black.r, black.g, black.b].map(Math.round)).toEqual([0, 0, 0]);
    // CSS red is oklch(62.8% 0.2577 29.23deg).
    const red = parseCssColor("oklch(62.8% 0.2577 29.23deg / 0.5)")!;
    expect([red.r, red.g, red.b].map(Math.round)).toEqual([255, 0, 0]);
    expect(red.a).toBe(0.5);
    // Tailwind's slate-900, oklch(20.8% 0.042 265.755), is about #0f172b.
    const slate = parseCssColor("oklch(0.208 0.042 265.755)")!;
    expect(Math.abs(slate.r - 15)).toBeLessThan(2);
    expect(Math.abs(slate.g - 23)).toBeLessThan(2);
    expect(Math.abs(slate.b - 43)).toBeLessThan(2);
  });

  it("answers null for what it cannot read", () => {
    for (const text of ["color(display-p3 1 0 0)", "hsl(0 100% 50%)", "rgb(1, 2)", "var(--x)", ""])
      expect(parseCssColor(text)).toBeNull();
  });
});

describe("luminance math", () => {
  it("gives the WCAG ratios", () => {
    const white = { r: 255, g: 255, b: 255 };
    near(contrastRatio({ r: 0, g: 0, b: 0 }, white), 21, 5);
    near(contrastRatio(white, white), 1, 5);
    near(contrastRatio({ r: 0x76, g: 0x76, b: 0x76 }, white), 4.54, 2);
    near(contrastRatio({ r: 0x77, g: 0x77, b: 0x77 }, white), 4.48, 2);
  });

  it("composes straight alpha", () => {
    expect(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 })).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5
    });
  });

  it("applies the large-text and glyph minimums", () => {
    expect(requiredRatio({ kind: "text", fontSizePx: 14, fontWeight: 400 })).toBe(4.5);
    expect(requiredRatio({ kind: "text", fontSizePx: 18.66, fontWeight: 700 })).toBe(3);
    expect(requiredRatio({ kind: "text", fontSizePx: 18.66, fontWeight: 600 })).toBe(4.5);
    expect(requiredRatio({ kind: "text", fontSizePx: 24, fontWeight: 400 })).toBe(3);
    expect(requiredRatio({ kind: "glyph", fontSizePx: 12, fontWeight: 400 })).toBe(3);
  });
});

const sample = (overrides: Partial<ContrastSample>): ContrastSample => ({
  kind: "text",
  text: "Hello",
  path: "p",
  color: "rgb(0, 0, 0)",
  backgrounds: ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"],
  images: [false, false],
  opacities: [1, 1],
  fontSizePx: 14,
  fontWeight: 400,
  ...overrides
});

describe("effectiveColours and evaluateSamples", () => {
  it("finds the nearest opaque ancestor and composes the layers above it", () => {
    const colours = effectiveColours(
      sample({
        backgrounds: ["rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)", "rgb(0, 0, 255)"],
        images: [false, false, true],
        opacities: [1, 1, 1]
      })
    );
    expect(colours).toEqual({
      foreground: { r: 0, g: 0, b: 0 },
      background: { r: 127.5, g: 127.5, b: 127.5 }
    });
  });

  it("falls back to the window's white and fades the text with its opacity", () => {
    const colours = effectiveColours(
      sample({ backgrounds: ["rgba(0, 0, 0, 0)"], images: [false], opacities: [0.5] })
    );
    expect(colours).toEqual({
      foreground: { r: 127.5, g: 127.5, b: 127.5 },
      background: { r: 255, g: 255, b: 255 }
    });
  });

  it("fades an opaque panel and its text together when an ancestor above it has opacity", () => {
    // A stale list under a wrapper at opacity 0.5: panel #171e28 and text #e4eaf2 both fade toward the
    // page (#10151d), so the pair is far weaker than the same colours at rest.
    const faded = sample({
      color: "rgb(228, 234, 242)",
      backgrounds: ["rgba(0, 0, 0, 0)", "rgb(23, 30, 40)", "rgba(0, 0, 0, 0)", "rgb(16, 21, 29)"],
      images: [false, false, false, false],
      opacities: [1, 1, 0.5, 1]
    });
    const colours = effectiveColours(faded) as { foreground: Rgb; background: Rgb };
    expect(colours).toEqual({
      foreground: { r: 122, g: 127.5, b: 135.5 },
      background: { r: 19.5, g: 25.5, b: 34.5 }
    });
    const rest = effectiveColours({ ...faded, opacities: [1, 1, 1, 1] }) as typeof colours;
    expect(contrastRatio(colours.foreground, colours.background)).toBeLessThan(
      contrastRatio(rest.foreground, rest.background) / 2
    );
  });

  it("composes a tint over a tinted opaque ancestor, not over white", () => {
    const colours = effectiveColours(
      sample({
        color: "rgb(232, 176, 90)",
        backgrounds: ["rgba(245, 158, 11, 0.16)", "rgb(23, 30, 40)", "rgba(0, 0, 0, 0)"],
        images: [false, false, false],
        opacities: [1, 1, 1]
      })
    );
    const { background } = colours as { background: { r: number; g: number; b: number } };
    near(background.r, 58.52, 3);
    near(background.g, 50.48, 3);
    near(background.b, 35.36, 3);
  });

  it("counts failures, passes large text at 3:1 and lists what it cannot verify", () => {
    const grey = "rgb(150, 150, 150)"; // about 2.96:1 on white
    const midGrey = "rgb(130, 130, 130)"; // 3.84:1 on white
    const result = evaluateSamples([
      sample({ text: "ok" }),
      sample({ text: "small grey", color: midGrey }),
      sample({ text: "large grey", color: midGrey, fontSizePx: 24 }),
      sample({ text: "icon", kind: "glyph", color: grey }),
      sample({ text: "over an image", images: [true, false] }),
      sample({ text: "odd colour", color: "color(display-p3 0 0 0)" })
    ]);
    expect(result.checked).toBe(4);
    expect(result.failures.map((failure) => failure.text)).toEqual(["small grey", "icon"]);
    expect(result.failures[0]).toMatchObject({ required: 4.5, ratio: 3.84 });
    expect(result.unverifiable.map((entry) => entry.text)).toEqual(["over an image", "odd colour"]);
  });
});

describe("isClippedAway", () => {
  const box = (overrides: Partial<ClipBox>): ClipBox => ({
    width: 120,
    height: 20,
    overflow: "visible",
    clip: "auto",
    clipPath: "none",
    ...overrides
  });

  it.each([
    // Tailwind's sr-only, and the older clip rule.
    ["a collapsed box that cuts its overflow", { width: 1, height: 1, overflow: "hidden" }],
    ["clip: rect(0 0 0 0)", { clip: "rect(0px, 0px, 0px, 0px)" }],
    ["clip-path: inset(50%)", { clipPath: "inset(50%)" }],
    ["clip-path: inset(100%)", { clipPath: "inset(100%)" }]
  ])("is true for %s", (_name, overrides) => {
    expect(isClippedAway(box(overrides))).toBe(true);
  });

  it.each([
    ["an ordinary box", {}],
    ["a one-pixel separator that clips nothing", { width: 1, height: 1, overflow: "visible" }],
    ["a thin bar", { width: 1, height: 16, overflow: "hidden" }],
    ["a partial clip-path", { clipPath: "inset(10%)" }]
  ])("is false for %s", (_name, overrides) => {
    expect(isClippedAway(box(overrides))).toBe(false);
  });

  it("leaves a clipped sample out of the verdict and counts it", () => {
    const hidden = sample({
      text: "Atividade: live region",
      boxes: [{ width: 1, height: 1, overflow: "hidden", clip: "auto", clipPath: "inset(50%)" }]
    });
    const result = evaluateSamples([sample({ text: "ok" }), hidden]);
    expect(result).toMatchObject({ checked: 1, hidden: 1, failures: [] });
  });
});

// Real computed values of the dark theme: the page canvas, a raised surface (a pill, a row) and the
// tokens that paint the glyphs under test (tokens.css: --surface-*, --state-success, --text-secondary).
const darkCanvas = "rgb(16, 21, 29)";
const darkRaised = "rgb(23, 30, 40)";
const glyph = (overrides: Partial<ContrastSample>): ContrastSample =>
  sample({
    kind: "glyph",
    text: "Atividade: Sua biblioteca está em dia.",
    // The svg root of a solid glyph: its own `fill` is the default black, its `stroke` is none.
    color: "rgb(0, 0, 0)",
    backgrounds: ["rgba(0, 0, 0, 0)", darkRaised],
    ...overrides
  });
const shape = (overrides: Partial<ShapePaint>): ShapePaint => ({
  tag: "path",
  fill: "none",
  stroke: "none",
  fillOpacity: 1,
  strokeOpacity: 1,
  opacity: 1,
  area: 100,
  ...overrides
});

describe("an icon's colour is the paint of its shapes, not its root's default", () => {
  // SolidCheck: a disc filled with currentColor and a check stroked in the surface colour.
  const solidCheck = [
    shape({ fill: "rgb(95, 208, 143)", area: 283.5 }),
    shape({ stroke: "rgb(23, 30, 40)", area: 55 })
  ];

  it("reads the disc of a solid glyph, not the black of the svg root", () => {
    const colours = effectiveColours(glyph({ shapes: solidCheck }));
    expect(colours).toEqual({
      foreground: { r: 95, g: 208, b: 143 },
      background: { r: 23, g: 30, b: 40 }
    });
    const result = evaluateSamples([glyph({ shapes: solidCheck })]);
    expect(result.failures).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it("still fails a solid glyph whose disc really is too dim for 3:1", () => {
    const dim = [shape({ fill: "rgb(40, 52, 68)", area: 283.5 }), solidCheck[1] as ShapePaint];
    const result = evaluateSamples([glyph({ shapes: dim })]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ kind: "glyph", foreground: "rgb(40, 52, 68)" });
  });

  it("reads the stroke of a line sample whose children carry the stroke", () => {
    // LineSample: <line stroke="currentColor"> in an svg that has no stroke of its own.
    const legend = glyph({
      text: "Legenda",
      backgrounds: ["rgba(0, 0, 0, 0)", darkCanvas],
      shapes: [shape({ stroke: "rgb(182, 195, 211)", area: 30 })]
    });
    expect(evaluateSamples([legend]).failures).toEqual([]);
    expect(effectiveColours(legend)).toMatchObject({ foreground: { r: 182, g: 195, b: 211 } });
  });

  it("does not count the default fill of a line, which has no interior", () => {
    // LineSample's <line>: computed fill is black, the stroke is the legend's text colour.
    const line = glyph({
      text: "Legenda",
      backgrounds: ["rgba(0, 0, 0, 0)", darkCanvas],
      shapes: [shape({ tag: "line", fill: "rgb(0, 0, 0)", stroke: "rgb(182, 195, 211)", area: 30 })]
    });
    expect(effectiveColours(line)).toMatchObject({ foreground: { r: 182, g: 195, b: 211 } });
    expect(evaluateSamples([line]).failures).toEqual([]);
  });

  it("takes the filled shape over a stroke when both are drawn, and the largest of several", () => {
    const colours = effectiveColours(
      glyph({
        shapes: [
          shape({ stroke: "rgb(255, 0, 0)", area: 900 }),
          shape({ fill: "rgb(10, 10, 10)", area: 4 }),
          shape({ fill: "rgb(200, 200, 200)", area: 50 })
        ]
      })
    );
    expect(colours).toMatchObject({ foreground: { r: 200, g: 200, b: 200 } });
  });

  it("applies the paint opacity and the shape's own opacity", () => {
    const colours = effectiveColours(
      glyph({
        backgrounds: ["rgba(0, 0, 0, 0)", "rgb(0, 0, 0)"],
        shapes: [shape({ fill: "rgb(200, 200, 200)", fillOpacity: 0.5, opacity: 0.5 })]
      })
    );
    expect(colours).toMatchObject({ foreground: { r: 50, g: 50, b: 50 } });
  });

  it("ignores shapes that paint nothing and falls back to the root's paint", () => {
    const outline = glyph({
      color: "rgb(182, 195, 211)",
      shapes: [shape({}), shape({ fill: "rgb(255, 0, 0)", fillOpacity: 0 })]
    });
    expect(effectiveColours(outline)).toMatchObject({ foreground: { r: 182, g: 195, b: 211 } });
    // A sample from before shapes existed has none, and keeps its root colour.
    const legacy = sample({ kind: "glyph", color: "rgb(182, 195, 211)" });
    expect(effectiveColours(legacy)).toMatchObject({ foreground: { r: 182, g: 195, b: 211 } });
  });

  it("lists a gradient paint as unverifiable instead of guessing", () => {
    const result = evaluateSamples([glyph({ shapes: [shape({ fill: 'url("#g")' })] })]);
    expect(result.checked).toBe(0);
    expect(result.unverifiable).toHaveLength(1);
  });
});
