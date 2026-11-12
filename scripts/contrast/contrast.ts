/**
 * WCAG contrast check for the design tokens in `tokens.css`.
 *
 * The check is a pure function of the stylesheet text: it parses the colour tokens of the light
 * theme, the dark theme and the system (prefers-color-scheme) fallback, then asserts that every
 * foreground/background pair declared in `contract` meets its minimum ratio in both themes.
 * Adding a colour token without covering it by a rule is an error, so the contract cannot drift.
 */

/** Minimum ratio for body text (WCAG 2.x AA, success criterion 1.4.3). */
export const textMinimum = 4.5;
/** Minimum ratio for large text and for glyph/icon/boundary colours (1.4.3 large, 1.4.11). */
export const glyphMinimum = 3;

export type ThemeName = "light" | "dark";

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface ContrastRule {
  readonly id: string;
  readonly description: string;
  readonly foreground: RegExp;
  readonly background: RegExp;
  readonly minimum: number;
}

/**
 * Every pair a token can be drawn in. Text-capable tokens (4.5:1) are checked on every surface
 * they may sit on; glyph tokens (3:1) are object types, relation stances and strong borders.
 */
export const contract: readonly ContrastRule[] = [
  {
    id: "text-on-surface",
    description: "body text on app surfaces",
    foreground: /^--text-(primary|secondary|tertiary)$/u,
    background: /^--surface-[a-z]+$/u,
    minimum: textMinimum
  },
  {
    id: "text-on-tint",
    description: "body text on state tints",
    foreground: /^--text-(primary|secondary|tertiary)$/u,
    background: /^--state-[a-z]+-soft$/u,
    minimum: textMinimum
  },
  {
    id: "accent-on-surface",
    description: "accent as link text, focus ring and glyph on app surfaces",
    foreground: /^--accent(-hover)?$/u,
    background: /^--surface-[a-z]+$/u,
    minimum: textMinimum
  },
  {
    id: "state-on-surface",
    description: "state text and glyphs on app surfaces",
    foreground: /^--state-(info|success|warning|danger)$/u,
    background: /^--surface-[a-z]+$/u,
    minimum: textMinimum
  },
  {
    id: "state-on-tint",
    description: "state text and glyphs on state tints",
    foreground: /^--state-(info|success|warning|danger)$/u,
    background: /^--state-[a-z]+-soft$/u,
    minimum: textMinimum
  },
  {
    id: "text-on-solid",
    description: "text on solid accent and state fills",
    foreground: /^--text-on-solid$/u,
    background: /^--(accent|accent-hover|state-(info|success|warning|danger))$/u,
    minimum: textMinimum
  },
  {
    id: "object-glyph",
    description: "object-type glyphs on app surfaces",
    foreground: /^--object-[a-z]+$/u,
    background: /^--surface-[a-z]+$/u,
    minimum: glyphMinimum
  },
  {
    id: "stance-glyph",
    description: "relation-stance glyphs on app surfaces",
    foreground: /^--stance-[a-z-]+$/u,
    background: /^--surface-[a-z]+$/u,
    minimum: glyphMinimum
  },
  {
    id: "border-strong",
    description: "control boundaries on the surfaces that host controls",
    foreground: /^--border-strong$/u,
    background: /^--surface-(canvas|raised|soft)$/u,
    minimum: glyphMinimum
  },
  {
    id: "graph-topic",
    description: "Map › Grafo topic dots on app surfaces (WCAG 1.4.11)",
    foreground: /^--graph-topic-\d+$/u,
    background: /^--surface-[a-z]+$/u,
    minimum: glyphMinimum
  }
];

/** Colour tokens that are deliberately not part of any pair (decorative separators). */
export const decorativeTokens: ReadonlySet<string> = new Set(["--border-subtle", "--thread"]);

/**
 * Neighbouring topic colours (index i and i + 1, the last and the first) differ by at least this
 * CIEDE2000 distance in each theme, so two sibling topics never read as one *(cal.)*.
 */
export const topicColourMinimumDeltaE = 20;
const topicToken = /^--graph-topic-(\d+)$/u;
const colourFamily = /^--(surface|text|border|accent|object|stance|state|graph)(-|$)/u;
const hexColour = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

export function parseHexColour(value: string): Rgb | null {
  const text = value.trim();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(text)) return null;
  const digits =
    text.length === 4 ? [...text.slice(1)].map((digit) => digit + digit).join("") : text.slice(1);
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16)
  };
}

function linearChannel(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(colour: Rgb): number {
  return (
    0.2126 * linearChannel(colour.r) +
    0.7152 * linearChannel(colour.g) +
    0.0722 * linearChannel(colour.b)
  );
}

export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

interface CssBlock {
  readonly prelude: string;
  readonly declarations: Map<string, string>;
  readonly children: CssBlock[];
}

/** Parses nested CSS blocks, ignoring comments; strings and parentheses may contain `;{}`. */
export function parseCssBlocks(css: string): CssBlock[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const root: CssBlock = { prelude: "", declarations: new Map(), children: [] };
  const stack: CssBlock[] = [root];
  let buffer = "";
  let parentheses = 0;
  let quote: string | null = null;
  const flushDeclaration = () => {
    const declaration = buffer.trim();
    buffer = "";
    const colon = declaration.indexOf(":");
    if (colon <= 0) return;
    const name = declaration.slice(0, colon).trim();
    if (name.startsWith("--"))
      (stack.at(-1) as CssBlock).declarations.set(name, declaration.slice(colon + 1).trim());
  };
  for (const char of text) {
    if (quote) {
      buffer += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
    } else if (char === "(") {
      parentheses += 1;
      buffer += char;
    } else if (char === ")") {
      parentheses -= 1;
      buffer += char;
    } else if (parentheses > 0) {
      buffer += char;
    } else if (char === "{") {
      const block: CssBlock = {
        prelude: buffer.trim().replace(/\s+/gu, " "),
        declarations: new Map(),
        children: []
      };
      buffer = "";
      (stack.at(-1) as CssBlock).children.push(block);
      stack.push(block);
    } else if (char === "}") {
      flushDeclaration();
      if (stack.length > 1) stack.pop();
    } else if (char === ";") {
      flushDeclaration();
    } else {
      buffer += char;
    }
  }
  return root.children;
}

export interface TokenSets {
  /** `:root` declarations. */
  readonly light: Map<string, string>;
  /** Declarations under `.dark` (the explicit dark theme). */
  readonly dark: Map<string, string>;
  /** Declarations under `prefers-color-scheme: dark` for an element with no explicit theme. */
  readonly systemDark: Map<string, string>;
  /** Structural problems found while classifying the blocks. */
  readonly problems: string[];
}

const lightSelectors = new Set([":root", ".light", ":root.light"]);
const systemSelector = ":root:not(.light):not(.dark)";

function isColourToken(name: string, value: string): boolean {
  return colourFamily.test(name) || hexColour.test(value.trim());
}

function selectorsOf(prelude: string): string[] {
  return prelude
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

/** Collects the colour tokens of each theme from the stylesheet text. */
export function parseTokenSets(css: string): TokenSets {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  const systemDark = new Map<string, string>();
  const problems: string[] = [];
  const collect = (into: Map<string, string>, block: CssBlock) => {
    for (const [name, value] of block.declarations)
      if (isColourToken(name, value)) into.set(name, value);
  };
  for (const block of parseCssBlocks(css)) {
    const selectors = selectorsOf(block.prelude);
    const colours = [...block.declarations].filter(([name, value]) => isColourToken(name, value));
    if (block.prelude.startsWith("@media")) {
      if (!/prefers-color-scheme:\s*dark/u.test(block.prelude)) continue;
      for (const child of block.children) {
        if (child.prelude === systemSelector) collect(systemDark, child);
        else if ([...child.declarations].some(([n, v]) => isColourToken(n, v)))
          problems.push(
            `colour tokens under "${child.prelude}" in the dark media query must use "${systemSelector}"`
          );
      }
    } else if (
      selectors.length > 0 &&
      selectors.every((selector) => lightSelectors.has(selector))
    ) {
      collect(light, block);
    } else if (selectors.includes(".dark")) {
      collect(dark, block);
    } else if (colours.length > 0) {
      problems.push(`colour tokens under unclassified selector "${block.prelude}"`);
    }
  }
  return { light, dark, systemDark, problems };
}

export interface PairResult {
  readonly rule: ContrastRule;
  readonly theme: ThemeName;
  readonly foreground: string;
  readonly background: string;
  readonly foregroundValue: string;
  readonly backgroundValue: string;
  readonly ratio: number;
}

export interface CheckResult {
  readonly pairs: PairResult[];
  readonly failures: PairResult[];
  /** Structural problems: bad values, missing tokens, uncovered tokens, theme drift. */
  readonly problems: string[];
}

function effectiveTheme(sets: TokenSets, theme: ThemeName): Map<string, string> {
  return new Map([...sets.light, ...(theme === "dark" ? sets.dark : [])]);
}

function sameMap(first: Map<string, string>, second: Map<string, string>): string[] {
  const differences: string[] = [];
  for (const name of new Set([...first.keys(), ...second.keys()])) {
    if (first.get(name)?.toLowerCase() !== second.get(name)?.toLowerCase()) differences.push(name);
  }
  return differences.sort();
}

/** Checks every contract pair in both themes plus the structural invariants of the token sets. */
export function checkTokens(css: string, rules: readonly ContrastRule[] = contract): CheckResult {
  const sets = parseTokenSets(css);
  const problems = [...sets.problems];
  const pairs: PairResult[] = [];
  if (sets.light.size === 0) problems.push("no colour tokens found under :root");
  if (sets.dark.size === 0) problems.push("no colour tokens found under .dark");

  for (const [name, value] of [...sets.light, ...sets.dark, ...sets.systemDark]) {
    if (!parseHexColour(value))
      problems.push(`${name}: "${value}" is not an opaque #rgb or #rrggbb colour`);
  }

  const lightOnly = [...sets.light.keys()].filter((name) => !sets.dark.has(name));
  for (const name of lightOnly.sort()) problems.push(`${name}: defined for light but not for dark`);
  for (const name of [...sets.dark.keys()].sort()) {
    if (!sets.light.has(name)) problems.push(`${name}: defined for dark but not for light`);
  }

  const dark = effectiveTheme(sets, "dark");
  const systemDark = new Map([...sets.light, ...sets.systemDark]);
  for (const name of sameMap(dark, systemDark))
    problems.push(`${name}: the system dark fallback differs from the .dark theme`);

  for (const theme of ["light", "dark"] as const)
    problems.push(...topicColourProblems(effectiveTheme(sets, theme), theme));

  const covered = new Set<string>();
  for (const theme of ["light", "dark"] as const) {
    const tokens = effectiveTheme(sets, theme);
    for (const rule of rules) {
      const foregrounds = [...tokens.keys()].filter((name) => rule.foreground.test(name));
      const backgrounds = [...tokens.keys()].filter((name) => rule.background.test(name));
      for (const foreground of foregrounds) {
        for (const background of backgrounds) {
          const foregroundValue = tokens.get(foreground) as string;
          const backgroundValue = tokens.get(background) as string;
          const front = parseHexColour(foregroundValue);
          const back = parseHexColour(backgroundValue);
          if (!front || !back) continue;
          covered.add(foreground).add(background);
          pairs.push({
            rule,
            theme,
            foreground,
            background,
            foregroundValue,
            backgroundValue,
            ratio: contrastRatio(front, back)
          });
        }
      }
    }
  }

  for (const name of [...sets.light.keys()].sort()) {
    if (!covered.has(name) && !decorativeTokens.has(name))
      problems.push(`${name}: colour token is not part of any contrast rule`);
  }
  for (const rule of rules) {
    if (!pairs.some((pair) => pair.rule === rule))
      problems.push(`rule "${rule.id}" matched no token pair (renamed tokens?)`);
  }

  const failures = pairs.filter((pair) => pair.ratio < pair.rule.minimum);
  return { pairs, failures, problems };
}

/** CIE L*a*b* (D65) of an sRGB colour. */
export function rgbToLab(colour: Rgb): Lab {
  const r = linearChannel(colour.r);
  const g = linearChannel(colour.g);
  const b = linearChannel(colour.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return { l: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const degrees = (value: number) => {
  const angle = (value * 180) / Math.PI;
  return angle < 0 ? angle + 360 : angle;
};

export interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** The CIEDE2000 colour difference of two sRGB colours. */
export function deltaE2000(first: Rgb, second: Rgb): number {
  return deltaE2000Lab(rgbToLab(first), rgbToLab(second));
}

/** The CIEDE2000 colour difference (Sharma, Wu and Dalal's formulation). */
export function deltaE2000Lab(one: Lab, two: Lab): number {
  const chromaMean = (Math.hypot(one.a, one.b) + Math.hypot(two.a, two.b)) / 2;
  const g = 0.5 * (1 - Math.sqrt(chromaMean ** 7 / (chromaMean ** 7 + 25 ** 7)));
  const a1 = (1 + g) * one.a;
  const a2 = (1 + g) * two.a;
  const c1 = Math.hypot(a1, one.b);
  const c2 = Math.hypot(a2, two.b);
  const h1 = c1 === 0 ? 0 : degrees(Math.atan2(one.b, a1));
  const h2 = c2 === 0 ? 0 : degrees(Math.atan2(two.b, a2));
  const deltaL = two.l - one.l;
  const deltaC = c2 - c1;
  let deltaHue = 0;
  if (c1 * c2 !== 0) {
    deltaHue = h2 - h1;
    if (deltaHue > 180) deltaHue -= 360;
    else if (deltaHue < -180) deltaHue += 360;
  }
  const deltaH = 2 * Math.sqrt(c1 * c2) * Math.sin(radians(deltaHue / 2));
  const lMean = (one.l + two.l) / 2;
  const cMean = (c1 + c2) / 2;
  let hMean = h1 + h2;
  if (c1 * c2 !== 0) {
    hMean = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(radians(hMean - 30)) +
    0.24 * Math.cos(radians(2 * hMean)) +
    0.32 * Math.cos(radians(3 * hMean + 6)) -
    0.2 * Math.cos(radians(4 * hMean - 63));
  const rotation = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cMean;
  const sh = 1 + 0.015 * cMean * t;
  const rt = -Math.sin(radians(2 * rotation)) * rc;
  return Math.sqrt(
    (deltaL / sl) ** 2 +
      (deltaC / sc) ** 2 +
      (deltaH / sh) ** 2 +
      rt * (deltaC / sc) * (deltaH / sh)
  );
}

/**
 * The topic colours of one theme: numbered 1..n with no gap, and each one at least
 * `topicColourMinimumDeltaE` from the next (the last from the first).
 */
export function topicColourProblems(tokens: Map<string, string>, theme: ThemeName): string[] {
  const indices = [...tokens.keys()]
    .map((name) => Number(topicToken.exec(name)?.[1] ?? Number.NaN))
    .filter((index) => Number.isInteger(index))
    .sort((a, b) => a - b);
  if (indices.length === 0) return [];
  const problems: string[] = [];
  indices.forEach((index, position) => {
    if (index !== position + 1)
      problems.push(
        `--graph-topic-${position + 1}: missing in ${theme} (topic colours count from 1)`
      );
  });
  if (problems.length > 0) return problems;
  const colours = indices.map((index) => parseHexColour(tokens.get(`--graph-topic-${index}`)!));
  if (colours.some((colour) => colour === null)) return problems;
  for (let index = 0; index < colours.length; index += 1) {
    const next = (index + 1) % colours.length;
    if (next === index) continue;
    const distance = deltaE2000(colours[index]!, colours[next]!);
    if (distance < topicColourMinimumDeltaE)
      problems.push(
        `${theme} --graph-topic-${index + 1} and --graph-topic-${next + 1}: CIEDE2000 ${distance.toFixed(1)} is below ${topicColourMinimumDeltaE}`
      );
  }
  return problems;
}

function formatRatio(ratio: number): string {
  // Truncate rather than round so 4.499 never prints as a passing 4.50.
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}

function describePair(pair: PairResult): string {
  return `${pair.theme.padEnd(5)} ${pair.foreground} (${pair.foregroundValue}) on ${pair.background} (${pair.backgroundValue}): ${formatRatio(pair.ratio)}`;
}

export function formatReport(result: CheckResult, verbose = false): string {
  const lines: string[] = [];
  if (verbose) {
    for (const pair of result.pairs)
      lines.push(
        `  ${pair.ratio >= pair.rule.minimum ? "ok  " : "FAIL"} ${describePair(pair)} (needs ${pair.rule.minimum}:1, ${pair.rule.id})`
      );
  }
  for (const pair of result.failures)
    if (!verbose)
      lines.push(
        `  FAIL ${describePair(pair)} (needs ${pair.rule.minimum}:1, ${pair.rule.id}: ${pair.rule.description})`
      );
  for (const problem of result.problems) lines.push(`  PROBLEM ${problem}`);
  const failed = result.failures.length + result.problems.length;
  if (failed === 0) {
    const lowest = result.pairs.reduce((worst, pair) =>
      pair.ratio / pair.rule.minimum < worst.ratio / worst.rule.minimum ? pair : worst
    );
    lines.push(
      `Contrast check passed: ${result.pairs.length} pairs across light and dark (tightest margin: ${describePair(lowest)}).`
    );
  } else {
    lines.push(
      `Contrast check failed: ${result.failures.length} failing pair(s), ${result.problems.length} structural problem(s) in ${result.pairs.length} pairs.`
    );
  }
  return lines.join("\n");
}
