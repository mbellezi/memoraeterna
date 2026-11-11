// The contrast scan of every journey step (F5 T137, exit bar X12). At a step screenshot the page
// reports each visible text node, input value or placeholder and top-level icon with its computed
// colour, the background colours of its ancestors, their background images and opacities; this
// module composes the effective background, measures the WCAG ratio and applies AA: 4.5:1 for text,
// 3:1 for large text (24 px, or 18.66 px at weight 700 or more) and for icons and glyphs. Disabled
// controls are exempt (WCAG 1.4.3). A colour it cannot parse, or a background image under the text,
// makes the sample unverifiable: listed apart, never a pass.
import type { Page } from "@playwright/test";

import {
  contrastRatio,
  glyphMinimum,
  textMinimum,
  type Rgb
} from "../../scripts/contrast/contrast.js";

export interface Rgba extends Rgb {
  readonly a: number;
}

const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A number, a percentage of `percentOf`, or `none` (0). */
function component(text: string, percentOf: number): number | null {
  if (text === "none") return 0;
  const match = /^(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)(%|deg)?$/iu.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] === "%" ? (value / 100) * percentOf : value;
}

/** `a b c / alpha` or `a, b, c, alpha` into the channel texts and the alpha (default 1). */
function splitArguments(inner: string): { channels: string[]; alpha: number } | null {
  const [main, slash] = inner.split("/");
  const channels = (main ?? "")
    .trim()
    .split(/[\s,]+/u)
    .filter(Boolean);
  let alphaText = slash?.trim();
  if (alphaText === undefined && channels.length === 4) alphaText = channels.pop();
  const alpha = alphaText === undefined ? 1 : component(alphaText, 1);
  if (channels.length !== 3 || alpha === null) return null;
  return { channels, alpha: clamp(alpha, 0, 1) };
}

function gamma(linear: number): number {
  const value = clamp(linear, 0, 1);
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** Oklab (L 0-1) to gamma-encoded sRGB 0-255, clipped to the gamut (Björn Ottosson's matrices). */
export function oklabToRgb(lightness: number, a: number, b: number): Rgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 255 * gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: 255 * gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: 255 * gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  };
}

/**
 * Parses the colour forms Chromium's computed styles use: `rgb()`/`rgba()`, `oklch()`, `oklab()`,
 * `color(srgb …)`, `color(srgb-linear …)`, hex and `transparent`. Null for anything else.
 */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.exec(text)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const byte = (index: number) => Number.parseInt(full.slice(index, index + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 };
  }
  const call = /^([a-z-]+)\((.*)\)$/u.exec(text);
  if (!call) return null;
  const [, name, inner = ""] = call;
  if (name === "color") {
    const [space, ...rest] = inner.trim().split(/\s+/u);
    const parsed = splitArguments(rest.join(" "));
    if (!parsed) return null;
    const values = parsed.channels.map((channel) => component(channel, 1));
    if (values.some((entry) => entry === null)) return null;
    const [r, g, b] = values as [number, number, number];
    if (space === "srgb")
      return {
        r: 255 * clamp(r, 0, 1),
        g: 255 * clamp(g, 0, 1),
        b: 255 * clamp(b, 0, 1),
        a: parsed.alpha
      };
    if (space === "srgb-linear")
      return { r: 255 * gamma(r), g: 255 * gamma(g), b: 255 * gamma(b), a: parsed.alpha };
    return null;
  }
  const parsed = splitArguments(inner);
  if (!parsed) return null;
  const [first = "", second = "", third = ""] = parsed.channels;
  if (name === "rgb" || name === "rgba") {
    const values = [first, second, third].map((channel) => component(channel, 255));
    if (values.some((entry) => entry === null)) return null;
    const [r, g, b] = (values as number[]).map((entry) => clamp(entry, 0, 255)) as [
      number,
      number,
      number
    ];
    return { r, g, b, a: parsed.alpha };
  }
  if (name === "oklch" || name === "oklab") {
    const lightness = component(first, 1);
    const x = component(second, 0.4);
    const y = component(third, name === "oklch" ? 1 : 0.4);
    if (lightness === null || x === null || y === null) return null;
    const [a, b] =
      name === "oklch"
        ? [x * Math.cos((y * Math.PI) / 180), x * Math.sin((y * Math.PI) / 180)]
        : [x, y];
    return { ...oklabToRgb(lightness, a, b), a: parsed.alpha };
  }
  return null;
}

/** `top` drawn over the opaque `bottom` (straight alpha). */
export function composite(top: Rgba, bottom: Rgb): Rgb {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a)
  };
}

/** What the page reports for one text, input or icon (see `collectInPage`). */
export interface ContrastSample {
  kind: "text" | "glyph";
  /** The text (cut to 80 characters) or the icon's label. */
  text: string;
  /** A short CSS path of the element, for the report. */
  path: string;
  color: string;
  /** Background colours from the element up to the root, in that order. */
  backgrounds: string[];
  /** Whether each of those elements paints a background image. */
  images: boolean[];
  /** Each element's own opacity. */
  opacities: number[];
  fontSizePx: number;
  fontWeight: number;
}

export interface ContrastFinding {
  kind: ContrastSample["kind"];
  text: string;
  path: string;
  ratio: number;
  required: number;
  foreground: string;
  background: string;
}

export interface ContrastResult {
  checked: number;
  failures: ContrastFinding[];
  unverifiable: { text: string; path: string; reason: string }[];
}

/** AA for this sample: 3:1 for glyphs and large text, 4.5:1 otherwise. */
export function requiredRatio(sample: Pick<ContrastSample, "kind" | "fontSizePx" | "fontWeight">) {
  if (sample.kind === "glyph") return glyphMinimum;
  const large = sample.fontSizePx >= 24 || (sample.fontSizePx >= 18.66 && sample.fontWeight >= 700);
  return large ? glyphMinimum : textMinimum;
}

const css = (colour: Rgb) =>
  `rgb(${Math.round(colour.r)}, ${Math.round(colour.g)}, ${Math.round(colour.b)})`;

/**
 * The effective colours of a sample: the background composed from the nearest opaque layer (the
 * window's white when none is) down to the element, and the foreground over it. Null with a reason
 * when that cannot be known.
 */
export function effectiveColours(
  sample: ContrastSample
): { foreground: Rgb; background: Rgb } | { reason: string } {
  const foreground = parseCssColor(sample.color);
  const layers = sample.backgrounds.map(parseCssColor);
  if (!foreground || layers.some((layer) => layer === null))
    return { reason: `unparsed colour (${[sample.color, ...sample.backgrounds].join(" | ")})` };
  const alphaOf = (index: number) => (layers[index] as Rgba).a * (sample.opacities[index] ?? 1);
  let start = layers.findIndex((_layer, index) => alphaOf(index) >= 0.999);
  if (sample.images.slice(0, start === -1 ? undefined : start + 1).some(Boolean))
    return { reason: "background image under the element" };
  let background: Rgb = start === -1 ? white : (layers[start] as Rgba);
  if (start === -1) start = layers.length;
  for (let index = start - 1; index >= 0; index -= 1)
    background = composite({ ...(layers[index] as Rgba), a: alphaOf(index) }, background);
  const opacity = sample.opacities.slice(0, start).reduce((product, value) => product * value, 1);
  return {
    foreground: composite({ ...foreground, a: foreground.a * opacity }, background),
    background
  };
}

export function evaluateSamples(samples: readonly ContrastSample[]): ContrastResult {
  const result: ContrastResult = { checked: 0, failures: [], unverifiable: [] };
  for (const sample of samples) {
    const colours = effectiveColours(sample);
    if ("reason" in colours) {
      result.unverifiable.push({ text: sample.text, path: sample.path, reason: colours.reason });
      continue;
    }
    result.checked += 1;
    const ratio = contrastRatio(colours.foreground, colours.background);
    const required = requiredRatio(sample);
    if (ratio + 1e-9 < required)
      result.failures.push({
        kind: sample.kind,
        text: sample.text,
        path: sample.path,
        ratio: Math.round(ratio * 100) / 100,
        required,
        foreground: css(colours.foreground),
        background: css(colours.background)
      });
  }
  return result;
}

/**
 * Runs in the page: the samples of the visible viewport. Self-contained (Playwright sends its
 * source), so it repeats nothing from Node: colours stay the computed strings.
 */
export function collectInPage(limit: number): ContrastSample[] {
  const samples: ContrastSample[] = [];
  const width = window.innerWidth;
  const height = window.innerHeight;
  const inView = (rect: DOMRect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < height &&
    rect.left < width;
  const visible = (element: Element) => {
    const check = (element as Element & { checkVisibility?: (options: object) => boolean })
      .checkVisibility;
    if (check && !check.call(element, { opacityProperty: true, visibilityProperty: true }))
      return false;
    return inView(element.getBoundingClientRect());
  };
  const exempt = (element: Element) =>
    element.closest(':disabled, [aria-disabled="true"], [inert]') !== null;
  const pathOf = (element: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = element; node && parts.length < 4; node = node.parentElement) {
      const id = node.id ? `#${node.id}` : "";
      const surface = node.getAttribute("data-surface");
      parts.unshift(
        `${node.tagName.toLowerCase()}${id}${surface ? `[data-surface=${surface}]` : ""}`
      );
    }
    return parts.join(" > ");
  };
  const add = (element: Element, kind: "text" | "glyph", text: string, color: string) => {
    const backgrounds: string[] = [];
    const images: boolean[] = [];
    const opacities: number[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      backgrounds.push(style.backgroundColor);
      images.push(style.backgroundImage !== "none" && style.backgroundImage !== "");
      opacities.push(Number(style.opacity));
    }
    const style = getComputedStyle(element);
    samples.push({
      kind,
      text: text.slice(0, 80),
      path: pathOf(element),
      color,
      backgrounds,
      images,
      opacities,
      fontSizePx: Number.parseFloat(style.fontSize),
      fontWeight: Number(style.fontWeight) || 400
    });
  };
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node && samples.length < limit; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? "";
    const parent = node.parentElement;
    if (!text || !parent || seen.has(parent)) continue;
    if (parent.closest("script, style, noscript, template, title")) continue;
    range.selectNodeContents(node);
    if (!inView(range.getBoundingClientRect()) || !visible(parent) || exempt(parent)) continue;
    seen.add(parent);
    const style = getComputedStyle(parent);
    const inSvg = parent.closest("svg") !== null;
    const color = inSvg ? style.fill : style.color;
    if (color === "none") continue;
    add(parent, "text", text, color);
  }
  for (const field of Array.from(document.querySelectorAll("input, textarea, select"))) {
    if (samples.length >= limit) break;
    const input = field as HTMLInputElement;
    const hiddenTypes = ["hidden", "checkbox", "radio", "range", "color", "file", "image"];
    if (hiddenTypes.includes(input.type) || !visible(input) || exempt(input)) continue;
    if (input.value) add(input, "text", input.value, getComputedStyle(input).color);
    else if (input.placeholder)
      add(input, "text", input.placeholder, getComputedStyle(input, "::placeholder").color);
  }
  for (const icon of Array.from(document.querySelectorAll("svg"))) {
    if (samples.length >= limit) break;
    if (icon.parentElement?.closest("svg")) continue;
    const rect = icon.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8 || !visible(icon) || exempt(icon)) continue;
    const style = getComputedStyle(icon);
    const stroke = style.stroke;
    const color = stroke && stroke !== "none" && stroke !== "transparent" ? stroke : style.fill;
    if (!color || color === "none") continue;
    const label =
      icon.getAttribute("aria-label") ??
      icon.closest("[aria-label]")?.getAttribute("aria-label") ??
      "icon";
    add(icon, "glyph", label, color);
  }
  return samples;
}

/** The scan of the page as it is now (the caller sets the theme and waits for it first). */
export async function scanContrast(page: Page, limit = 4_000): Promise<ContrastResult> {
  const samples = await page.evaluate(collectInPage, limit);
  return evaluateSamples(samples);
}
