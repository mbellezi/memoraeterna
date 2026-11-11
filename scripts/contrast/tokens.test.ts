import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkTokens,
  contrastRatio,
  decorativeTokens,
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

  it("keep the graph token reader's fallback palette equal to the graph tokens (F3 T60g)", () => {
    const reader = read(`${renderer}/components/graph/graph-tokens.ts`);
    const block = /fallbackGraphPalette: GraphPalette = \{([\s\S]*?)\n\};/u.exec(reader)?.[1] ?? "";
    const fallback = (field: string) =>
      new RegExp(`\\b${field}: "(#[0-9a-f]{6})"`, "u").exec(block)?.[1];
    expect(fallback("canvasCenter")).toBe(sets.light.get("--graph-canvas-center"));
    expect(fallback("canvasEdge")).toBe(sets.light.get("--graph-canvas-edge"));
    expect(fallback("label")).toBe(sets.light.get("--graph-label"));
    expect(fallback("labelMuted")).toBe(sets.light.get("--graph-label-muted"));
    expect(fallback("note")).toBe(sets.light.get("--graph-object-note"));
    const stanceBlock = /stance: \{([\s\S]*?)\}/u.exec(block)?.[1] ?? "";
    for (const name of [
      "supports",
      "contradicts",
      "extends",
      "depends_on",
      "example_of",
      "related"
    ])
      expect(new RegExp(`\\b${name}: "(#[0-9a-f]{6})"`, "u").exec(stanceBlock)?.[1], name).toBe(
        sets.light.get(`--graph-stance-${name.replace("_", "-")}`)
      );
  });

  it("leave a suggested relation, drawn softer and dashed, 3:1 against the graph canvas", () => {
    // A suggestion keeps its stance colour at a lower opacity (F3 decision 29); softer is never
    // below the 3:1 a graph line needs, on the canvas edge it is blended with.
    const source = read(`${renderer}/components/graph/ego-graph-sigma.ts`);
    const opacity = Number(/egoSuggestionOpacity = ([0-9.]+)/u.exec(source)?.[1]);
    expect(opacity).toBeGreaterThan(0.5);
    expect(opacity).toBeLessThan(1);
    for (const background of ["--graph-canvas-center", "--graph-canvas-edge"]) {
      const canvas = parseHexColour(sets.light.get(background)!)!;
      for (const name of stances) {
        const base = parseHexColour(sets.light.get(`--graph-stance-${name}`)!)!;
        const blend = (channel: "r" | "g" | "b") =>
          Math.round(base[channel] * opacity + canvas[channel] * (1 - opacity));
        const softened = { r: blend("r"), g: blend("g"), b: blend("b") };
        expect(contrastRatio(softened, canvas), `${name} on ${background}`).toBeGreaterThanOrEqual(
          3
        );
      }
    }
  });
});

describe("control boundaries", () => {
  const ui = (file: string) => read(`${renderer}/components/ui/${file}`);
  /** Whether a class list holds the utility itself, not a longer one such as `border-border-strong`. */
  const uses = (classes: string, utility: string) =>
    new RegExp(`(^|[\\s"'\`:])${utility}(?=[\\s"'\`/]|$)`, "u").test(classes);
  const secondaryButton = /secondary:\s*"([^"]*)"/u.exec(ui("button.tsx"))?.[1] ?? "";

  it("exempt only the decorative separator tokens from the contrast check", () => {
    expect([...decorativeTokens]).toEqual(["--border-subtle", "--thread"]);
  });

  it("are drawn by Input and the secondary Button with the checked token, never the exempt one", () => {
    expect(secondaryButton).toContain("bg-surface");
    for (const [name, classes] of [
      ["Input", ui("input.tsx")],
      ["secondary Button", secondaryButton]
    ] as const) {
      expect(uses(classes, "border-border-strong"), name).toBe(true);
      expect(uses(classes, "border-border"), name).toBe(false);
    }
    // The utility is the token: border-border-strong is --border-strong, border-border is --border-subtle.
    expect(stylesCss).toContain("--color-border-strong: var(--border-strong);");
    expect(stylesCss).toContain("--color-border: var(--border-subtle);");
  });

  it("keep a solid accent boundary on the pressed secondary Button, checked on every surface", () => {
    const pressed = secondaryButton
      .split(/\s+/u)
      .filter((name) => name.startsWith("aria-pressed:"));
    // The pressed state replaces the border colour, so it must not fall below the unpressed one.
    expect(pressed).toContain("aria-pressed:border-accent");
    expect(pressed.filter((name) => name.startsWith("aria-pressed:border-"))).toEqual([
      "aria-pressed:border-accent"
    ]);
    // No border colour of the secondary Button is translucent: a fraction of a token is not the token.
    expect(secondaryButton).not.toMatch(/(?:^|[\s:])border-[\w-]+\/\d+/u);
    // The pressed fill is the selected surface, and the accent border meets 3:1 on it and on every
    // surface that can host the button, in both themes (the accent-on-surface rule demands 4.5:1).
    expect(pressed).toContain("aria-pressed:bg-accent-soft");
    expect(stylesCss).toContain("--color-accent-soft: var(--surface-selected);");
    const result = checkTokens(tokensCss);
    for (const theme of ["light", "dark"] as const) {
      const accent = result.pairs.filter(
        (pair) => pair.theme === theme && pair.foreground === "--accent"
      );
      expect(accent.map((pair) => pair.background)).toEqual(
        expect.arrayContaining([
          "--surface-selected",
          "--surface-raised",
          "--surface-canvas",
          "--surface-soft"
        ])
      );
      for (const pair of accent)
        expect(pair.ratio, `${theme} accent on ${pair.background}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("meet 3:1 against the fill and the host surface of those controls in both themes", () => {
    const result = checkTokens(tokensCss);
    for (const theme of ["light", "dark"] as const) {
      const pairs = result.pairs.filter(
        (pair) => pair.theme === theme && pair.foreground === "--border-strong"
      );
      // bg-surface (raised) and disabled/hover bg-soft are the fills; the canvas and cards host them.
      expect(pairs.map((pair) => pair.background).sort()).toEqual([
        "--surface-canvas",
        "--surface-raised",
        "--surface-soft"
      ]);
      for (const pair of pairs)
        expect(pair.ratio, `${theme} ${pair.background}`).toBeGreaterThanOrEqual(3);
    }
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

describe("the F5 token additions (T124, design record 4.10)", () => {
  const blocks = parseCssBlocks(tokensCss);
  const darkBlock = blocks.find((block) => block.prelude === ".dark")!.declarations;
  const systemBlock = blocks
    .find((block) => block.prelude.startsWith("@media (prefers-color-scheme: dark)"))
    ?.children.find((child) => child.prelude === ":root:not(.light):not(.dark)")?.declarations;

  it("adds the measure, the two easings, the thread, the scrim and the two shadows", () => {
    for (const name of [
      "--measure",
      "--ease-out",
      "--ease-in-out",
      "--thread",
      "--scrim",
      "--shadow-sheet",
      "--shadow-pop"
    ])
      expect(rootTokens.has(name), `${name} in :root`).toBe(true);
    expect(rootTokens.get("--measure")).toBe("34rem");
    expect(rootTokens.get("--ease-out")).toContain("cubic-bezier(0.2, 0, 0, 1)");
    expect(rootTokens.get("--ease-in-out")).toContain("cubic-bezier(0.4, 0, 0.2, 1)");
  });

  it("gives the thread, the scrim and the shadows a dark value, in .dark and in the system fallback", () => {
    for (const name of ["--thread", "--scrim", "--shadow-sheet", "--shadow-pop"]) {
      expect(darkBlock.get(name), `${name} in .dark`).toBeDefined();
      expect(darkBlock.get(name), `${name} differs from light`).not.toBe(rootTokens.get(name));
      expect(systemBlock?.get(name), `${name} in the system fallback`).toBe(darkBlock.get(name));
    }
    expect(darkBlock.get("--scrim")).toBe("rgba(5, 8, 12, 0.6)");
    expect(rootTokens.get("--scrim")).toBe("rgba(22, 32, 48, 0.32)");
  });

  it("raises the dark strong border to #7a899f and adds no --focus token", () => {
    expect(sets.dark.get("--border-strong")).toBe("#7a899f");
    expect(sets.systemDark.get("--border-strong")).toBe("#7a899f");
    expect(sets.light.get("--border-strong")).toBe("#78859a");
    expect(tokensCss).not.toContain("--focus:");
  });

  it("removes every animation and transition under prefers-reduced-motion", () => {
    const reduced = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none !important/u);
    expect(reduced).toMatch(
      /\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition:\s*none !important/u
    );
  });
});
