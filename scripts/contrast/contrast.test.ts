import { describe, expect, it } from "vitest";

import {
  checkTokens,
  contrastRatio,
  deltaE2000,
  deltaE2000Lab,
  formatReport,
  parseCssBlocks,
  parseHexColour,
  parseTokenSets,
  type ContrastRule
} from "./contrast.ts";

const rules: readonly ContrastRule[] = [
  {
    id: "text",
    description: "text on surfaces",
    foreground: /^--text-[a-z]+$/u,
    background: /^--surface-[a-z]+$/u,
    minimum: 4.5
  },
  {
    id: "glyph",
    description: "glyphs on surfaces",
    foreground: /^--object-[a-z]+$/u,
    background: /^--surface-[a-z]+$/u,
    minimum: 3
  }
];

/** A passing stylesheet: dark text on a light surface, light text on a dark surface. */
function stylesheet(overrides: { light?: string; dark?: string; system?: string } = {}) {
  return `
    :root {
      --surface-canvas: #ffffff;
      --text-primary: #111111;
      --object-source: #6b6b6b;
      --space-1: 0.25rem;
      ${overrides.light ?? ""}
    }
    .dark {
      --surface-canvas: #000000;
      --text-primary: #eeeeee;
      --object-source: #999999;
      ${overrides.dark ?? ""}
    }
    @media (prefers-color-scheme: dark) {
      :root:not(.light):not(.dark) {
        --surface-canvas: #000000;
        --text-primary: #eeeeee;
        --object-source: #999999;
        ${overrides.system ?? ""}
      }
    }
  `;
}

describe("parseHexColour", () => {
  it("reads #rgb and #rrggbb and rejects everything it cannot check", () => {
    expect(parseHexColour("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColour("#07707F")).toEqual({ r: 7, g: 112, b: 127 });
    expect(parseHexColour("#07707f80")).toBeNull();
    expect(parseHexColour("rgb(0, 0, 0)")).toBeNull();
    expect(parseHexColour("var(--x)")).toBeNull();
    expect(parseHexColour("#ggg")).toBeNull();
  });
});

describe("contrastRatio", () => {
  const colour = (hex: string) => parseHexColour(hex)!;

  it("matches the WCAG reference values", () => {
    expect(contrastRatio(colour("#000000"), colour("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(colour("#ffffff"), colour("#ffffff"))).toBeCloseTo(1, 5);
    // #767676 on white is the well-known smallest grey that passes AA for body text.
    expect(contrastRatio(colour("#767676"), colour("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("does not depend on which colour is the foreground", () => {
    expect(contrastRatio(colour("#07707f"), colour("#f5f7f9"))).toBeCloseTo(
      contrastRatio(colour("#f5f7f9"), colour("#07707f")),
      10
    );
  });
});

describe("parseCssBlocks", () => {
  it("ignores comments and keeps semicolons and braces inside strings and parentheses", () => {
    const [block] = parseCssBlocks(`
      /* :root { --ignored: #000000; } */
      :root { --font: "a;b{c}", serif; --url: url(data:image/png;base64,AAA); --kept: #123456 }
    `);
    expect(block?.prelude).toBe(":root");
    expect([...(block?.declarations.keys() ?? [])]).toEqual(["--font", "--url", "--kept"]);
    expect(block?.declarations.get("--font")).toBe('"a;b{c}", serif');
    expect(block?.declarations.get("--kept")).toBe("#123456");
  });

  it("nests blocks inside at-rules", () => {
    const [media] = parseCssBlocks("@media (a: b) { .x { --y: #fff; } }");
    expect(media?.prelude).toBe("@media (a: b)");
    expect(media?.children[0]?.prelude).toBe(".x");
  });
});

describe("parseTokenSets", () => {
  it("separates the light, dark and system-dark colour tokens and ignores other tokens", () => {
    const sets = parseTokenSets(`
      :root { --surface-canvas: #ffffff; --space-1: 0.25rem; --motion-fast: 120ms; }
      .dark, .graph-surface { --surface-canvas: #000000; }
      @media (prefers-color-scheme: dark) { :root:not(.light):not(.dark) { --surface-canvas: #010101; } }
      @media (prefers-reduced-motion: reduce) { :root { --motion-fast: 0ms; } }
    `);
    expect([...sets.light]).toEqual([["--surface-canvas", "#ffffff"]]);
    expect([...sets.dark]).toEqual([["--surface-canvas", "#000000"]]);
    expect([...sets.systemDark]).toEqual([["--surface-canvas", "#010101"]]);
    expect(sets.problems).toEqual([]);
  });

  it("reports colour tokens under selectors it cannot classify", () => {
    const sets = parseTokenSets(`
      :root { --surface-canvas: #ffffff; }
      .sepia { --surface-canvas: #f4ecd8; }
      @media (prefers-color-scheme: dark) { .x { --surface-canvas: #000000; } }
    `);
    expect(sets.problems).toHaveLength(2);
    expect(sets.problems.join("\n")).toContain('".sepia"');
    expect(sets.problems.join("\n")).toContain("in the dark media query");
  });
});

describe("checkTokens", () => {
  it("passes when every pair meets its minimum in both themes", () => {
    const result = checkTokens(stylesheet(), rules);
    expect(result.failures).toEqual([]);
    expect(result.problems).toEqual([]);
    // text + glyph, each in light and dark.
    expect(result.pairs).toHaveLength(4);
  });

  it("lists a failing light pair with the tokens, colours and ratio", () => {
    const result = checkTokens(stylesheet({ light: "--text-primary: #777777;" }), rules);
    expect(result.failures).toHaveLength(1);
    const [failure] = result.failures;
    expect(failure).toMatchObject({
      theme: "light",
      foreground: "--text-primary",
      background: "--surface-canvas",
      foregroundValue: "#777777"
    });
    expect(failure?.ratio).toBeCloseTo(4.48, 2);
    const report = formatReport(result);
    expect(report).toContain("FAIL");
    expect(report).toContain(
      "light --text-primary (#777777) on --surface-canvas (#ffffff): 4.47:1"
    );
    expect(report).toContain("needs 4.5:1");
    expect(report).toContain("1 failing pair(s)");
  });

  it("checks the dark theme separately from the light theme", () => {
    const result = checkTokens(
      stylesheet({
        dark: "--text-primary: #555555;",
        system: "--text-primary: #555555;"
      }),
      rules
    );
    expect(result.failures.map((failure) => failure.theme)).toEqual(["dark"]);
    expect(result.problems).toEqual([]);
  });

  it("uses the lower glyph minimum only for glyph rules", () => {
    // 3.5:1 passes as a glyph (3:1) but would fail as body text (4.5:1).
    const glyphOnly = checkTokens(stylesheet({ light: "--object-source: #858585;" }), rules);
    expect(glyphOnly.failures).toEqual([]);
    const asText = checkTokens(stylesheet({ light: "--text-primary: #858585;" }), rules);
    expect(asText.failures.map((failure) => failure.foreground)).toEqual(["--text-primary"]);
  });

  it("rejects values the check cannot read", () => {
    const result = checkTokens(
      stylesheet({ light: "--text-secondary: rgb(0, 0, 0); --object-note: #11223380;" }),
      rules
    );
    expect(result.problems.join("\n")).toContain("--text-secondary");
    expect(result.problems.join("\n")).toContain("--object-note");
    expect(result.problems.join("\n")).toContain("opaque");
  });

  it("requires the same colour tokens in both themes", () => {
    const missingDark = checkTokens(stylesheet({ light: "--text-secondary: #222222;" }), rules);
    expect(missingDark.problems).toContain("--text-secondary: defined for light but not for dark");
    const missingLight = checkTokens(
      stylesheet({ dark: "--text-secondary: #dddddd;", system: "--text-secondary: #dddddd;" }),
      rules
    );
    expect(missingLight.problems).toContain("--text-secondary: defined for dark but not for light");
  });

  it("requires the system fallback to match the dark theme", () => {
    const drifted = checkTokens(stylesheet({ system: "--surface-canvas: #0a0a0a;" }), rules);
    expect(drifted.problems).toContain(
      "--surface-canvas: the system dark fallback differs from the .dark theme"
    );
    // Dropping a token from .dark alone leaves both a parity gap and a fallback that differs.
    const missing = checkTokens(stylesheet().replace("--text-primary: #eeeeee;", ""), rules);
    expect(missing.problems).toContain("--text-primary: defined for light but not for dark");
    expect(missing.problems).toContain(
      "--text-primary: the system dark fallback differs from the .dark theme"
    );
  });

  it("flags a colour token that no rule covers, except decorative ones", () => {
    const uncovered = checkTokens(
      stylesheet({
        light: "--accent-soft: #eeeeee; --border-subtle: #dddddd;",
        dark: "--accent-soft: #111111; --border-subtle: #222222;",
        system: "--accent-soft: #111111; --border-subtle: #222222;"
      }),
      rules
    );
    expect(uncovered.problems).toContain(
      "--accent-soft: colour token is not part of any contrast rule"
    );
    expect(uncovered.problems.join("\n")).not.toContain("--border-subtle");
  });

  it("flags a rule that matches no tokens, which means tokens were renamed", () => {
    const result = checkTokens(stylesheet(), [
      ...rules,
      { ...rules[0]!, id: "renamed", foreground: /^--ink-[a-z]+$/u }
    ]);
    expect(result.problems).toContain('rule "renamed" matched no token pair (renamed tokens?)');
  });

  it("asks neighbouring topic colours to differ by CIEDE2000 20, the last against the first", () => {
    const topics = (values: string[]) =>
      values.map((value, index) => `--graph-topic-${index + 1}: ${value};`).join("\n");
    const topicRules: readonly ContrastRule[] = [
      ...rules,
      {
        id: "topic",
        description: "topic dots",
        foreground: /^--graph-topic-\d+$/u,
        background: /^--surface-[a-z]+$/u,
        minimum: 1
      }
    ];
    const apart = topics(["#3d6f9e", "#a0522d", "#3f7f4f"]);
    const sheet = (light: string, dark = apart) => stylesheet({ light, dark, system: dark });
    expect(checkTokens(sheet(apart), topicRules).problems).toEqual([]);
    // Two blues side by side read as one topic.
    expect(
      checkTokens(sheet(topics(["#3d6f9e", "#3f6ea0", "#3f7f4f"])), topicRules).problems
    ).toEqual([
      expect.stringMatching(
        /^light --graph-topic-1 and --graph-topic-2: CIEDE2000 [0-9.]+ is below 20$/u
      )
    ]);
    // The last index sits next to the first when the indices wrap.
    expect(
      checkTokens(sheet(topics(["#3d6f9e", "#a0522d", "#3e6f9f"])), topicRules).problems.join("\n")
    ).toContain("light --graph-topic-3 and --graph-topic-1");
    // A gap in the numbering is named, in the theme where it is.
    const gap = "--graph-topic-1: #3d6f9e;\n--graph-topic-3: #3f7f4f;";
    expect(checkTokens(sheet(gap, gap), topicRules).problems).toContain(
      "--graph-topic-2: missing in light (topic colours count from 1)"
    );
  });
});

describe("deltaE2000", () => {
  it("matches Sharma, Wu and Dalal's reference pairs", () => {
    // Pairs 1, 7, 16 and 25 of the published CIEDE2000 test data.
    expect(
      deltaE2000Lab({ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 })
    ).toBeCloseTo(2.0425, 4);
    expect(deltaE2000Lab({ l: 50, a: 0, b: 0 }, { l: 50, a: -1, b: 2 })).toBeCloseTo(2.3669, 4);
    expect(deltaE2000Lab({ l: 50, a: 2.5, b: 0 }, { l: 56, a: -27, b: -3 })).toBeCloseTo(31.903, 3);
    expect(
      deltaE2000Lab(
        { l: 60.2574, a: -34.0099, b: 36.2677 },
        { l: 60.4626, a: -34.1751, b: 39.4387 }
      )
    ).toBeCloseTo(1.2644, 4);
  });

  it("measures sRGB colours through CIE Lab and is symmetric", () => {
    const blue = parseHexColour("#3d6f9e")!;
    const sienna = parseHexColour("#a0522d")!;
    expect(deltaE2000(blue, blue)).toBe(0);
    expect(deltaE2000(blue, sienna)).toBeCloseTo(deltaE2000(sienna, blue), 10);
    expect(deltaE2000(blue, sienna)).toBeGreaterThan(30);
  });
});

describe("formatReport", () => {
  it("summarizes a passing run with its tightest margin", () => {
    const report = formatReport(checkTokens(stylesheet(), rules));
    expect(report).toContain("Contrast check passed: 4 pairs");
    expect(report).toContain("tightest margin");
  });

  it("lists every pair in verbose mode, passing ones included", () => {
    const report = formatReport(checkTokens(stylesheet(), rules), true);
    expect(report.split("\n").filter((line) => line.trim().startsWith("ok"))).toHaveLength(4);
  });

  it("truncates instead of rounding so a failing ratio never prints as passing", () => {
    // #777777 is 4.478:1; rounding would print 4.48, truncating keeps it visibly below 4.5.
    const report = formatReport(
      checkTokens(stylesheet({ light: "--text-primary: #777777;" }), rules)
    );
    expect(report).toContain("4.47:1");
    expect(report).not.toContain("4.50:1");
  });
});
