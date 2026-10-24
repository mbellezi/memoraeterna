import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The first-run view (renderer/components/onboarding) is new code: it follows the frontend rules
// the quality ratchet only lets decrease. These read its sources, so a later edit cannot slip a raw
// colour, a font size outside the scale or a message key built from a variable past review. They
// live beside the main process because the renderer project has no Node types.
const folder = join(import.meta.dirname, "../../../renderer/components/onboarding");
const sources = readdirSync(folder)
  .filter((name) => /\.(ts|tsx)$/u.test(name) && !/\.test\.|fixtures/u.test(name))
  .map((name) => ({ name, text: readFileSync(join(folder, name), "utf8") }));

describe("the onboarding sources", () => {
  it("find the files they are about", () => {
    expect(sources.map((source) => source.name)).toEqual(
      expect.arrayContaining([
        "OnboardingView.tsx",
        "ModeStep.tsx",
        "SetupStep.tsx",
        "LanguagesStep.tsx",
        "ImportEstimateChip.tsx",
        "onboarding-controller.ts"
      ])
    );
  });

  it("use semantic design tokens only: no raw palette class, no hex colour, no arbitrary size", () => {
    const rawPalette =
      /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|rose|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink)-\d{2,3}\b/u;
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(rawPalette);
      expect(text, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
      expect(text, name).not.toMatch(/\btext-\[/u);
    }
  });

  it("build no message key from a variable: every key is a literal or a typed map", () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/\bt\(\s*`/u);
      expect(text, name).not.toMatch(/\bas MessageKey\b/u);
      expect(text, name).not.toMatch(/key:\s*`/u);
    }
  });

  it("keep Electron, the database and the file system out of the renderer", () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/from "(?:electron|node:[a-z/]+|@app\/db|@app\/ai)"/u);
      expect(text, name).not.toMatch(/\/main\//u);
    }
  });

  it("start no timer and poll nothing: progress comes from the pushed events", () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/\bsetInterval\b/u);
      expect(text, name).not.toMatch(/\bwindow\.confirm|\bwindow\.alert|\bwindow\.prompt/u);
    }
  });
});
