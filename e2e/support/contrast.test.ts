import { describe, expect, it } from "vitest";

import { contrastRatio } from "../../scripts/contrast/contrast.js";
import {
  composite,
  effectiveColours,
  evaluateSamples,
  parseCssColor,
  requiredRatio,
  type ContrastSample
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
