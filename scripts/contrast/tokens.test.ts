import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkTokens,
  contrastRatio,
  formatReport,
  parseCssBlocks,
  parseHexColour,
  parseTokenSets
} from "./contrast.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const renderer = "apps/desktop/src/renderer";

const tokensCss = read(`${renderer}/tokens.css`);
const stylesCss = read(`${renderer}/styles.css`);
const sets = parseTokenSets(tokensCss);

/** Custom properties declared directly under `:root` (all themes share the non-colour ones). */
const rootTokens = parseCssBlocks(tokensCss).find(
  (block) => block.prelude === ":root"
)!.declarations;
const px = (rem: string) => Number.parseFloat(rem) * 16;

const objectTypes = ["source", "note", "topic", "question", "entity"];
const stances = ["supports", "contradicts", "extends", "depends-on", "example-of", "related"];
const states = ["info", "success", "warning", "danger"];

describe("colour tokens", () => {
  it("meet WCAG AA in the light and dark themes", () => {
    const result = checkTokens(tokensCss);
    // On failure the message lists each pair with its ratio, as the CLI does.
    expect(result.failures.length + result.problems.length, formatReport(result)).toBe(0);
  });

  it("define the object-type, relation-stance and state families for both themes", () => {
    const names = [
      ...objectTypes.map((name) => `--object-${name}`),
      ...stances.map((name) => `--stance-${name}`),
      ...states.flatMap((name) => [`--state-${name}`, `--state-${name}-soft`]),
      "--accent",
      "--accent-hover",
      "--text-primary",
      "--text-secondary",
      "--text-tertiary",
      "--text-on-solid",
      "--border-subtle",
      "--border-strong",
      "--surface-canvas",
      "--surface-raised",
      "--surface-soft",
      "--surface-hover",
      "--surface-selected"
    ];
    for (const name of names) {
      expect(sets.light.has(name), `${name} in :root`).toBe(true);
      expect(sets.dark.has(name), `${name} in .dark`).toBe(true);
      expect(sets.systemDark.has(name), `${name} in the system dark fallback`).toBe(true);
    }
  });

  it("use the planned accents with a comfortable margin over AA", () => {
    expect(sets.light.get("--accent")).toBe("#07707f");
    expect(sets.dark.get("--accent")).toBe("#65d6e8");
    const ratio = (foreground: string, background: string) =>
      contrastRatio(parseHexColour(foreground)!, parseHexColour(background)!);
    expect(ratio("#07707f", sets.light.get("--surface-canvas")!)).toBeGreaterThan(5.3);
    expect(ratio("#65d6e8", sets.dark.get("--surface-canvas")!)).toBeGreaterThan(9);
  });

  it("give the system theme the dark values only when no theme is chosen", () => {
    expect(tokensCss).toContain("@media (prefers-color-scheme: dark)");
    expect(tokensCss).toContain(":root:not(.light):not(.dark)");
    expect(sets.systemDark.get("--surface-canvas")).toBe(sets.dark.get("--surface-canvas"));
    // An explicit light theme keeps the light values on a dark OS.
    expect(sets.light.get("--surface-canvas")).not.toBe(sets.dark.get("--surface-canvas"));
    expect(tokensCss).toContain("color-scheme: light dark");
  });

  it("expose the graph palette as theme-invariant variables on a dark canvas", () => {
    for (const name of objectTypes)
      expect(sets.light.get(`--graph-object-${name}`)).toBe(sets.dark.get(`--object-${name}`));
    for (const name of stances)
      expect(sets.light.get(`--graph-stance-${name}`)).toBe(sets.dark.get(`--stance-${name}`));
    expect(sets.dark.has("--graph-canvas-center")).toBe(false);
  });
});

describe("scale tokens", () => {
  it("keep the type scale to fixed rem sizes", () => {
    const sizes = [...rootTokens].filter(
      ([name]) => name.startsWith("--type-") && !name.endsWith("-leading")
    );
    expect(sizes.map(([name]) => name)).toEqual([
      "--type-caption",
      "--type-small",
      "--type-body",
      "--type-lead",
      "--type-title",
      "--type-display",
      "--type-reading"
    ]);
    for (const [name, value] of sizes) expect(value, name).toMatch(/^\d+(\.\d+)?rem$/u);
    // The interface sizes grow monotonically; the reading size sits beside them, not in the ramp.
    const pixels = sizes
      .filter(([name]) => name !== "--type-reading")
      .map(([, value]) => px(value));
    expect(pixels).toEqual([...pixels].sort((a, b) => a - b));
    expect(px(rootTokens.get("--type-reading")!)).toBeGreaterThanOrEqual(16);
  });

  it("follow a 4 px spacing grid", () => {
    const spaces = [...rootTokens].filter(([name]) => name.startsWith("--space-"));
    expect(spaces.length).toBeGreaterThanOrEqual(8);
    for (const [name, value] of spaces) {
      const steps = Number(name.slice("--space-".length));
      expect(px(value), name).toBe(steps * 4);
    }
  });

  it("define radii and weights as plain values", () => {
    for (const [name, value] of rootTokens)
      if (name.startsWith("--radius-")) expect(value, name).toMatch(/^\d+(\.\d+)?rem$/u);
    expect(rootTokens.get("--weight-semibold")).toBe("550");
  });
});

describe("motion tokens", () => {
  it("are short and drop to zero for prefers-reduced-motion", () => {
    const durations = [...rootTokens].filter(([name]) => name.startsWith("--motion-"));
    expect(durations.map(([name]) => name)).toEqual([
      "--motion-fast",
      "--motion-base",
      "--motion-slow"
    ]);
    for (const [name, value] of durations) {
      expect(value, name).toMatch(/^\d+ms$/u);
      expect(Number.parseInt(value), name).toBeLessThanOrEqual(300);
    }
    const reduced = parseCssBlocks(tokensCss).find((block) =>
      block.prelude.includes("prefers-reduced-motion: reduce")
    );
    const overrides = reduced?.children.find((child) => child.prelude === ":root")?.declarations;
    for (const [name] of durations) expect(overrides?.get(name), name).toBe("0ms");
  });

  it("drive every animation and transition in styles.css", () => {
    const withoutReduced = (stylesCss.split("@media (prefers-reduced-motion")[0] as string).replace(
      /\/\*[\s\S]*?\*\//gu,
      ""
    );
    const timings = withoutReduced.match(/\b(?:animation|transition):[^;]+;/gu) ?? [];
    expect(timings.length).toBeGreaterThanOrEqual(6);
    for (const timing of timings) expect(timing).toMatch(/var\(--motion-(fast|base|slow)\)/u);
    expect(withoutReduced).not.toMatch(/\b\d+ms\b/u);
  });
});

describe("bundled fonts", () => {
  const fonts = [
    { package: "@fontsource-variable/inter", family: "Inter Variable", token: "--font-family-ui" },
    {
      package: "@fontsource-variable/source-serif-4",
      family: "Source Serif 4 Variable",
      token: "--font-family-reading"
    }
  ];

  it("import both families from local packages and never from the network", () => {
    for (const font of fonts) {
      expect(stylesCss).toContain(`@import "${font.package}/wght.css";`);
      expect(rootTokens.get(font.token)).toMatch(new RegExp(`^"${font.family}"`, "u"));
    }
    for (const [path, text] of [
      ["tokens.css", tokensCss],
      ["styles.css", stylesCss],
      ["index.html", read(`${renderer}/index.html`)]
    ] as const)
      expect(text, path).not.toMatch(/https?:\/\//u);
  });

  it("ship @font-face rules that point only at files inside the package", () => {
    for (const font of fonts) {
      const css = read(`node_modules/${font.package}/wght.css`);
      expect(css).toContain(`font-family: '${font.family}'`);
      const urls = [...css.matchAll(/url\(([^)]+)\)/gu)].map((match) => match[1] as string);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).toMatch(/^\.\/files\/[\w-]+\.woff2$/u);
      expect(read(`node_modules/${font.package}/package.json`)).toContain('"OFL-1.1"');
    }
  });

  it("are pinned to exact versions that STACK.md records", () => {
    const desktop = JSON.parse(read("apps/desktop/package.json")) as {
      dependencies: Record<string, string>;
    };
    const stack = read("STACK.md");
    for (const font of fonts) {
      const version = desktop.dependencies[font.package];
      expect(version, font.package).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(stack).toContain(`\`${font.package}\``);
      expect(stack).toContain(`\`${version}\``);
    }
  });
});

describe("Tailwind bridge", () => {
  const theme = /@theme inline \{([\s\S]*?)\n\}/u.exec(stylesCss)?.[1] ?? "";

  it("maps the shadcn theme colours and the new families onto tokens", () => {
    const mapped = (name: string, token: string) =>
      expect(theme, name).toMatch(new RegExp(`--color-${name}: var\\(--${token}\\);`, "u"));
    mapped("background", "surface-canvas");
    mapped("surface", "surface-raised");
    mapped("soft", "surface-soft");
    mapped("foreground", "text-primary");
    mapped("muted-foreground", "text-tertiary");
    mapped("border", "border-subtle");
    mapped("accent", "accent");
    mapped("accent-foreground", "text-on-solid");
    mapped("accent-soft", "surface-selected");
    for (const name of objectTypes) mapped(`object-${name}`, `object-${name}`);
    for (const name of stances) mapped(`stance-${name}`, `stance-${name}`);
    for (const name of states) {
      mapped(name, `state-${name}`);
      mapped(`${name}-soft`, `state-${name}-soft`);
    }
  });

  it("maps fonts, sizes, radii and spacing onto tokens", () => {
    expect(theme).toContain("--font-sans: var(--font-family-ui);");
    expect(theme).toContain("--font-reading: var(--font-family-reading);");
    expect(theme).toContain("--text-reading: var(--type-reading);");
    expect(theme).toContain("--spacing: var(--space-1);");
    expect(theme).toContain("--radius-md: var(--radius-2);");
    expect(theme).toContain("--default-transition-duration: var(--motion-fast);");
  });

  it("defines no colour of its own beyond the legacy slate ramp", () => {
    const withoutRamp = stylesCss.replace(/@theme \{[\s\S]*?\n\}/u, "");
    expect(withoutRamp).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(withoutRamp).not.toMatch(/\b(?:rgba?|hsla?|oklch)\(/u);
  });

  it("draws the graph canvas from the graph tokens", () => {
    expect(stylesCss).toContain("var(--graph-canvas-center)");
    expect(stylesCss).toContain("var(--graph-canvas-edge)");
  });
});
